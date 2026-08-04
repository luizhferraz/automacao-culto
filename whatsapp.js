const { default: makeWASocket, useMultiFileAuthState, DisconnectReason, fetchLatestBaileysVersion } = require('@whiskeysockets/baileys');
const { Boom } = require('@hapi/boom');
const path = require('path');
const { readdir, unlink } = require('fs/promises');
const qrcode = require('qrcode-terminal');
const mensagens = require('./mensagens-enviadas');
const diagnostico = require('./diagnostico');

const AUTH_DIR = process.env.AUTH_DIR || '.baileys_auth';

// ── Janela de reenvio ────────────────────────────────────────────────────────
// Quando o aparelho de alguém não consegue descriptografar, ele manda de volta um pedido de
// reenvio (retry receipt). Se o socket já morreu, ninguém atende e a pessoa fica com
// "Aguardando mensagem". A janela abaixo é o tempo que a conexão fica de pé para atender.
//
// São três números porque um relógio fixo é a coisa errada: o processador de nós offline do
// Baileys abandona em silêncio o que sobrou na fila assim que o websocket fecha
// (offline-node-processor.js: `while (nodes.length && deps.isWsOpen())`). Encerrar no meio da
// fila é jogar fora exatamente os pedidos que se queria atender.
const GRACA_MINIMA_MS = Number(process.env.RETRY_GRACE_MS || 120000);
const GRACA_QUIETUDE_MS = Number(process.env.RETRY_QUIET_MS || 45000);
const GRACA_MAXIMA_MS = Number(process.env.RETRY_GRACE_MAX_MS || 600000);
const PASSO_ESPERA_MS = Number(process.env.RETRY_PASSO_MS || 5000);

// Tempo curto usado quando o Fly manda SIGTERM: ali não dá para segurar a janela inteira.
const GRACA_SIGTERM_MS = Number(process.env.RETRY_GRACE_SIGTERM_MS || 3000);

const TIMEOUT_CONEXAO_MS = Number(process.env.CONEXAO_TIMEOUT_MS || 30000);
const ESPERA_APOS_CONECTAR_MS = Number(process.env.ESPERA_APOS_CONECTAR_MS || 3000);

// ── Sessões de sinal forçadas antes do envio ─────────────────────────────────
// Desligado por padrão. Ver o comentário em garantirSessoesFrescas para o porquê.
const FORCAR_SESSOES = process.env.FORCAR_SESSOES === '1';
const LOTE_SESSOES = Number(process.env.LOTE_SESSOES || 50);
// Teto para a medição e a recriação de sessões. Nada disso pode atrasar o link do culto:
// é remediação, e o link é a razão de o bot existir.
const PRAZO_PREPARO_MS = Number(process.env.PREPARO_TIMEOUT_MS || 45000);

const esperar = (ms) => new Promise(r => setTimeout(r, ms));

// Corre a promessa com prazo. Serve para uma chamada de rede solta, que no pior caso fica
// pendurada sem efeito nenhum. NÃO use para envolver um laço que grava estado: o race não
// cancela o trabalho, e o laço continuaria rodando em segundo plano. Para laço, passe o
// limite adiante e deixe ele parar sozinho (ver prepararGrupo).
function comPrazo(promessa, ms, oQue) {
  let relogio;
  const prazo = new Promise((_, rejeitar) => {
    relogio = setTimeout(() => rejeitar(new Error(`${oQue} passou de ${Math.round(ms / 1000)}s`)), ms);
  });
  return Promise.race([promessa, prazo]).finally(() => clearTimeout(relogio));
}

// Sessão única por execução. Antes cada mensagem abria e fechava o próprio socket, o que
// refazia as sessões de sinal do zero a cada envio e desperdiçava a janela de reenvio.
let sessao = null;

function opcoesSocket(version, state, aoReenviar = () => {}) {
  return {
    version,
    auth: state,
    logger: diagnostico.logger(),
    printQRInTerminal: false,
    browser: ['Culto Bot', 'Chrome', '1.0'],
    // Continua false de propósito: é o que impede o WhatsApp de marcar a conta como online
    // e parar de notificar no celular. Ficar conectado não suprime notificação; anunciar
    // presença é que suprime.
    markOnlineOnConnect: false,
    syncFullHistory: false,
    // Sem isto o Baileys responde todo pedido de reenvio com undefined.
    getMessage: async (chave) => {
      const achada = await mensagens.buscar(chave?.id);
      if (achada) {
        aoReenviar(chave.id);
        console.log(`[WhatsApp] ♻️  Reenviando mensagem ${chave.id} a pedido de um aparelho que não conseguiu abrir.`);
        return achada;
      }
      // O Baileys também chama getMessage para resolver enquetes e eventos criados por
      // outras pessoas, e nesses casos não achar é o normal. Só é sintoma de problema
      // quando pedem de volta uma mensagem que o próprio bot enviou.
      if (chave?.fromMe) {
        console.warn(`[WhatsApp] ⚠️  Pediram reenvio da mensagem ${chave.id}, mas ela não está no histórico local.`);
      }
      return undefined;
    },
  };
}

/**
 * Embrulha o armazenamento de chaves por dois motivos independentes.
 *
 * 1. GRAVAÇÕES EM VOO. O useMultiFileAuthState grava o estado de sinal de forma assíncrona e
 *    o Baileys nem sempre espera terminar. Como o processo chama process.exit logo depois e o
 *    Fly desmonta o volume, uma gravação perdida deixa o ratchet defasado e a PRÓXIMA
 *    mensagem já nasce impossível de descriptografar. O drenar espera tudo antes de sair.
 *
 * 2. MEMÓRIA DE DISTRIBUIÇÃO DA CHAVE DE GRUPO. Esta é a correção do domingo 02/08.
 *    Em grupo, o remetente distribui uma "sender key" para cada aparelho e o Baileys anota em
 *    sender-key-memory-<grupo>.json quem já recebeu. O problema está na ordem em que ele faz
 *    isso (messages-send.js, ramo de grupo do relayMessage):
 *
 *        senderKeyRecipients.push(deviceJid);
 *        senderKeyMap[deviceJid] = true;        // marca ANTES de tentar
 *        ...
 *        await assertSessions(senderKeySessionTargets);
 *        const result = await createParticipantNodes(senderKeyRecipients, ...);
 *        ...
 *        await authState.keys.set({ 'sender-key-memory': { [jid]: senderKeyMap } });  // grava sempre
 *
 *    O aparelho é marcado como "já recebeu" antes de a criptografia acontecer, e o mapa é
 *    gravado no disco mesmo que ela falhe. E a falha por destinatário é engolida: o
 *    createParticipantNodes faz catch, loga e devolve null, e só lança se TODAS falharem.
 *
 *    O efeito prático foi medido no volume. Domingo de manhã a limpeza única esvaziou o mapa,
 *    os 845 aparelhos entraram na distribuição e todos foram marcados como atendidos. À noite
 *    o mapa foi lido com 845 entradas verdadeiras, a lista de destinatários da chave ficou
 *    VAZIA, e a mensagem das 18:59 saiu sem distribuir chave para ninguém. Quem falhou de
 *    manhã estava condenado a falhar de novo à noite.
 *
 *    Em toda a biblioteca existe um único ponto que limpa esse mapa (messages-recv.js, dentro
 *    do tratamento do pedido de reenvio), e ele exige socket vivo. Sem isso, o bloqueio é
 *    permanente.
 *
 *    A saída é não confiar no mapa: a leitura devolve sempre vazio e a gravação é descartada.
 *    Assim todo envio redistribui a chave para todos os aparelhos, e quem ficou de fora numa
 *    semana ganha nova chance na semana seguinte. Não é gambiarra: é o que a própria
 *    biblioteca faz ao atender um pedido de reenvio, zerando o mapa do grupo inteiro.
 */
function rastrearGravacoes(state, saveCreds) {
  const pendentes = new Set();
  let falhasGravacao = 0;

  const acompanhar = (promessa) => {
    const p = Promise.resolve(promessa).catch(err => {
      // Não repropaga: o Baileys chama keys.set sem await em vários pontos, e uma rejeição
      // aqui viraria unhandled rejection no meio do envio. O contador vai para o resumo e
      // muda o código de saída do processo, que é como isto fica visível.
      falhasGravacao++;
      console.error('[WhatsApp] Falha ao gravar estado de sinal:', err.message);
    });
    pendentes.add(p);
    p.finally(() => pendentes.delete(p));
    return p;
  };

  const getOriginal = state.keys.get.bind(state.keys);
  const setOriginal = state.keys.set.bind(state.keys);

  state.keys.get = async (tipo, ids) => {
    if (tipo === 'sender-key-memory') return {};
    return getOriginal(tipo, ids);
  };

  state.keys.set = (dados) => {
    if (dados && 'sender-key-memory' in dados) {
      dados = { ...dados };
      delete dados['sender-key-memory'];
      if (Object.keys(dados).length === 0) return Promise.resolve();
    }
    return acompanhar(setOriginal(dados));
  };

  const salvarCreds = () => acompanhar(saveCreds());

  // Repete enquanto sobrar coisa: fechar o socket dispara gravações novas, e uma única
  // passada só esperaria as que já existiam quando o drenar começou. O limite de voltas
  // é só para nunca travar o desligamento se algo entrar em laço.
  const drenar = async () => {
    for (let volta = 0; volta < 10 && pendentes.size > 0; volta++) {
      await Promise.allSettled([...pendentes]);
    }
  };

  return { salvarCreds, drenar, contarFalhas: () => falhasGravacao };
}

// Remove os arquivos de memória de distribuição que ficaram no volume. Depois da correção
// acima nada mais os lê nem os escreve, então são só lixo enganoso de versões anteriores.
// A marca .chaves-redistribuidas também sai: ela documentava uma limpeza única que virou
// permanente, e deixá-la lá sugeriria que ainda existe algo condicionado a ela.
async function limparMemoriaDeChave() {
  try {
    const arquivos = await readdir(AUTH_DIR);
    const alvos = arquivos.filter(a => a.startsWith('sender-key-memory-') || a === '.chaves-redistribuidas');
    for (const arquivo of alvos) {
      await unlink(path.join(AUTH_DIR, arquivo)).catch(() => {});
    }
    if (alvos.length > 0) {
      console.log(`[WhatsApp] 🔑 Removi ${alvos.length} arquivo(s) de memória de distribuição de chave. Todo envio agora redistribui a chave para todos os aparelhos.`);
    }
  } catch (err) {
    // Falhar aqui não pode impedir o envio do link do culto.
    console.warn('[WhatsApp] Não consegui limpar a memória de distribuição de chaves:', err.message);
  }
}

/**
 * Mede o grupo e, opcionalmente, recria as sessões de sinal antes do envio.
 *
 * A parte de MEDIÇÃO roda sempre e é só leitura: compara quantas pessoas o grupo tem com
 * quantos aparelhos o WhatsApp devolve. É o número que faltava para saber se existe gente
 * que nunca chega a entrar na distribuição da chave.
 *
 * A parte de FORÇAR sessões está atrás de FORCAR_SESSOES=1 e desligada por padrão. Ela ataca
 * a hipótese de sessão obsoleta: quando alguém reinstala o WhatsApp, troca de aparelho ou
 * restaura backup, o Signal do lado da pessoa é destruído mas o session-<jid>.json do bot
 * continua intacto no volume. O assertSessions do fan-out da chave de grupo é chamado sem o
 * segundo argumento, então força é falso, e aí ele consulta validateSession, que é puramente
 * local (carrega do disco e chama haveOpenSession). Não tem como saber que o outro lado
 * apagou a sessão dele. O resultado é a chave de grupo cifrada dentro de uma sessão morta:
 * a pessoa recebe bytes que não consegue abrir, e nada disso lança erro.
 *
 * Com força verdadeira o Baileys pula essa validação local e pede um pacote de chaves novo,
 * recriando a sessão do zero. Está desligado por padrão porque é a mudança menos medida da
 * série: descarta o ratchet de centenas de sessões e consome uma chave de uso único de cada
 * pessoa a cada envio. Os lotes têm try/catch individual, então isto nunca derruba o envio,
 * no máximo deixa de consertar um lote.
 */
async function garantirSessoesFrescas(s, chatId) {
  if (s.medido) return;
  s.medido = true;
  try {
    await prepararGrupo(s, chatId, Date.now() + PRAZO_PREPARO_MS);
  } catch (err) {
    // Diagnóstico e remediação são acessórios: o link do culto tem que sair de qualquer jeito.
    console.warn('[WhatsApp] Preparo do grupo não completou:', err.message);
  }
}

async function prepararGrupo(s, chatId, limite) {
  const restante = () => Math.max(1000, limite - Date.now());

  const meta = await comPrazo(s.sock.groupMetadata(chatId), restante(), 'metadados do grupo');
  const participantes = meta?.participants?.length || 0;
  const aparelhos = await comPrazo(
    s.sock.getUSyncDevices(meta.participants.map(p => p.id), false, false),
    restante(),
    'lista de aparelhos'
  );
  const jids = [...new Set(aparelhos.map(d => d.jid).filter(Boolean))];

  s.grupo = { participantes, aparelhos: jids.length, sessoesForcadas: 0, lotesComFalha: 0, interrompido: false };
  console.log(`[WhatsApp] 👥 Grupo com ${participantes} pessoa(s) e ${jids.length} aparelho(s).`);

  if (!FORCAR_SESSOES) return;

  for (let i = 0; i < jids.length; i += LOTE_SESSOES) {
    // O laço vigia o próprio prazo. Envolvê-lo num Promise.race pareceria equivalente, mas o
    // race não cancela nada: os lotes seguintes continuariam rodando em segundo plano e
    // reescrevendo estado de sessão no meio da criptografia da mensagem.
    if (Date.now() >= limite) {
      s.grupo.interrompido = true;
      console.warn(`[WhatsApp] Preparo passou do prazo; parei em ${i} de ${jids.length} aparelho(s).`);
      break;
    }

    const lote = jids.slice(i, i + LOTE_SESSOES);
    try {
      await s.sock.assertSessions(lote, true);
      s.grupo.sessoesForcadas += lote.length;
    } catch (err) {
      // Um único aparelho com erro derruba o lote inteiro, porque o Baileys valida todos os
      // nós da resposta antes de injetar qualquer sessão. Por isso o fatiamento: limita o
      // estrago a LOTE_SESSOES aparelhos em vez de todos.
      s.grupo.lotesComFalha++;
      console.warn(`[WhatsApp] Lote de ${lote.length} sessão(ões) falhou: ${err.message}`);
    }
  }
  console.log(`[WhatsApp] 🔄 Sessões recriadas para ${s.grupo.sessoesForcadas}/${jids.length} aparelho(s).`);
}

async function abrirSessao() {
  if (sessao && sessao.viva) return sessao;

  const { state, saveCreds } = await useMultiFileAuthState(AUTH_DIR);

  if (!state.creds.me) {
    throw new Error('WhatsApp não pareado. Execute o bot para gerar o QR Code.');
  }

  await limparMemoriaDeChave();

  const { version } = await fetchLatestBaileysVersion();
  const { salvarCreds, drenar, contarFalhas } = rastrearGravacoes(state, saveCreds);

  return new Promise((resolve, reject) => {
    const nova = {
      sock: null,
      drenar,
      contarFalhas,
      viva: false,
      medido: false,
      grupo: null,
      enviadas: [],
      envios: [],
      reenvios: 0,
      reenviados: [],
      confirmacoes: new Set(),
      ultimaAtividade: 0,
      conectadoEm: null,
    };

    const registrarReenvio = (id) => {
      nova.reenvios++;
      nova.reenviados.push(id);
      nova.ultimaAtividade = Date.now();
    };

    const sock = makeWASocket(opcoesSocket(version, state, registrarReenvio));
    nova.sock = sock;

    let concluido = false;
    const prazo = setTimeout(() => {
      finalizar(new Error(`Timeout de ${TIMEOUT_CONEXAO_MS}ms ao conectar no WhatsApp.`));
    }, TIMEOUT_CONEXAO_MS);

    function finalizar(erro) {
      if (concluido) return;
      concluido = true;
      clearTimeout(prazo);
      if (erro) {
        try { sock.end(undefined); } catch { /* socket já morto */ }
        if (sessao === nova) sessao = null;
        reject(erro);
        return;
      }
      sessao = nova;
      resolve(nova);
    }

    sock.ev.on('creds.update', salvarCreds);

    // Em grupo o Baileys não emite messages.update por participante; emite este evento.
    // Serve para saber quantos aparelhos confirmaram entrega, mas atenção: ele NÃO dispara
    // para receipt do tipo retry, então não serve como sinal de atividade da janela.
    sock.ev.on('message-receipt.update', (eventos) => {
      for (const e of eventos) {
        if (nova.enviadas.includes(e.key?.id) && e.receipt?.userJid) {
          nova.confirmacoes.add(e.receipt.userJid);
        }
      }
    });

    sock.ev.on('connection.update', ({ connection, lastDisconnect }) => {
      if (connection === 'open') {
        nova.viva = true;
        nova.conectadoEm = new Date().toISOString();
        // Para o relógio aqui, e não só no finalizar: a conexão já abriu, seria injusto
        // o timeout derrubar tudo por causa da pausa de acomodação logo abaixo.
        clearTimeout(prazo);
        console.log('[WhatsApp] 🔗 Conectado.');
        esperar(ESPERA_APOS_CONECTAR_MS).then(() => finalizar(null));
        return;
      }

      if (connection === 'close') {
        nova.viva = false;
        if (sessao === nova) sessao = null;

        const codigo = new Boom(lastDisconnect?.error)?.output?.statusCode;
        const nomeCodigo = DisconnectReason[codigo] || codigo || 'desconhecido';

        // Precisa ser lido ANTES de chamar finalizar, que sempre marca concluido.
        const jaEstavaPronta = concluido;

        if (codigo === DisconnectReason.loggedOut) {
          finalizar(new Error('Sessão encerrada (logout). Apague o baileys_auth e pareie de novo.'));
          if (jaEstavaPronta) console.error('[WhatsApp] ❌ Logout detectado. Refaça o pareamento por QR Code.');
          return;
        }

        if (jaEstavaPronta) {
          console.warn(`[WhatsApp] Conexão caiu (${nomeCodigo}). O próximo envio abre uma nova.`);
          return;
        }

        // O código antigo dava resolve() aqui para qualquer motivo que não fosse logout.
        // Uma queda ANTES do envio virava sucesso silencioso: o scheduler achava que tinha
        // mandado o link e desligava a máquina sem ninguém ter recebido nada.
        finalizar(new Error(`Conexão fechada antes de ficar pronta (${nomeCodigo}).`));
      }
    });
  });
}

/**
 * Abre a conexão sem enviar nada.
 *
 * Chamado na subida do processo, e não só na hora do envio. A máquina liga cerca de cinco
 * minutos antes do culto, e esse tempo era desperdiçado com o socket fechado. Conectando
 * cedo, a fila de pedidos de reenvio que o WhatsApp acumulou durante a semana é entregue e
 * atendida com o socket ocioso, antes do envio do dia. Cada pedido atendido também faz o
 * Baileys recriar a sessão daquele aparelho, o que conserta gente que estava travada desde
 * o domingo anterior.
 */
async function conectar(chatId) {
  try {
    const s = await abrirSessao();
    // Mede o grupo e, se ligado, recria as sessões AGORA, nos minutos ociosos antes do culto,
    // e não no meio do enviarMensagem. São 17 idas e voltas com o servidor para um grupo deste
    // tamanho: fazer isso na hora do envio atrasaria o link à toa, tendo cinco minutos de
    // folga disponíveis aqui. Se a conexão cair e o envio abrir outra, o preparo roda de novo
    // na sessão nova, porque o controle (`medido`) vive na sessão.
    if (chatId) await garantirSessoesFrescas(s, chatId);
    return true;
  } catch (err) {
    // Não é fatal: o envio abre a conexão de novo quando chegar a hora.
    console.warn('[WhatsApp] Não consegui conectar na subida:', err.message);
    return false;
  }
}

// Envia e devolve o id da mensagem. Não desconecta: quem fecha é o encerrarSessao.
async function enviarMensagem(chatId, mensagem) {
  const s = await abrirSessao();

  if (chatId.endsWith('@g.us')) {
    await garantirSessoesFrescas(s, chatId);
  }

  const enviada = await s.sock.sendMessage(chatId, { text: mensagem });
  const id = enviada?.key?.id;
  if (!id) {
    throw new Error('O WhatsApp não devolveu o id da mensagem; envio não confirmado.');
  }

  // Guarda antes de qualquer outra coisa: se um pedido de reenvio chegar em milissegundos,
  // o histórico já precisa estar no disco.
  await mensagens.guardar(id, enviada.message);
  s.enviadas.push(id);
  s.envios.push({ id, em: new Date().toISOString() });
  s.ultimaAtividade = Date.now();

  console.log(`✅ Mensagem enviada para ${chatId} (id ${id})`);
  return id;
}

// Encerramento em curso, para um segundo pedido conseguir esperar o primeiro em vez de
// achar que não há nada a fazer.
let encerramento = null;
let cortarEspera = null;
let cortado = false;

// Espera que um segundo pedido consegue interromper. É o que deixa o SIGTERM pular o resto
// da janela de reenvio sem pular o fechamento do socket e a drenagem das gravações.
function esperarCortavel(ms) {
  return new Promise((resolve) => {
    const relogio = setTimeout(() => { cortarEspera = null; resolve(); }, ms);
    cortarEspera = () => { clearTimeout(relogio); cortarEspera = null; resolve(); };
  });
}

/**
 * Segura a conexão pela janela de reenvio.
 *
 * Espera pelo menos o piso, depois continua enquanto houver pedidos de reenvio chegando, e
 * corta no teto. Encerrar por relógio fixo no meio da fila abandona a cauda de pedidos sem
 * sequer confirmar o recebimento deles, e essa mesma cauda é abandonada toda semana.
 */
async function aguardarReenvios(s, piso) {
  const inicio = Date.now();
  const teto = Math.max(piso, GRACA_MAXIMA_MS);

  while (!cortado) {
    const decorrido = Date.now() - inicio;
    if (decorrido >= teto) break;
    if (decorrido >= piso && Date.now() - s.ultimaAtividade >= GRACA_QUIETUDE_MS) break;
    await esperarCortavel(Math.min(PASSO_ESPERA_MS, teto - decorrido));
  }

  return Date.now() - inicio;
}

async function fecharSessao(s, piso) {
  let esperou = 0;

  if (s.enviadas.length > 0 && piso > 0) {
    const prazo = piso >= 1000 ? `${Math.round(piso / 1000)}s` : `${piso}ms`;
    console.log(`[WhatsApp] ⏳ Mantendo a conexão por pelo menos ${prazo} para atender pedidos de reenvio...`);
    esperou = await aguardarReenvios(s, piso);
    console.log(`[WhatsApp] 📬 ${s.confirmacoes.size} aparelho(s) confirmaram entrega; ${s.reenvios} reenvio(s) atendido(s) em ${Math.round(esperou / 1000)}s.`);
  }

  // O end() do Baileys é async: fecha o websocket, percorre os handlers de fim e só então
  // emite o connection.update de fechamento. Sem await, o drenar abaixo correria antes
  // disso e uma rejeição escaparia como unhandled rejection.
  try { await s.sock.end(undefined); } catch { /* socket já morto */ }
  await s.drenar();

  const resumo = {
    conectadoEm: s.conectadoEm,
    encerradoEm: new Date().toISOString(),
    esperaDeReenvioMs: esperou,
    envios: s.envios,
    grupo: s.grupo,
    confirmacoes: { total: s.confirmacoes.size, jids: [...s.confirmacoes] },
    reenviosAtendidos: { total: s.reenvios, ids: s.reenviados },
    falhasDeGravacao: s.contarFalhas(),
  };
  const arquivo = diagnostico.gravarResumo(resumo);
  if (arquivo) console.log(`[WhatsApp] 📝 Resumo da janela em ${arquivo}`);

  console.log('[WhatsApp] 📵 Desconectado.');
  diagnostico.encerrar();

  return resumo;
}

async function encerrarSessao({ graca = GRACA_MINIMA_MS } = {}) {
  // Um segundo pedido durante o primeiro é o SIGTERM chegando no meio da janela de reenvio.
  // Sem este ramo ele veria `sessao` já nula, voltaria na hora, e o process.exit de quem
  // chamou mataria o processo com o socket aberto e gravações em voo. Ou seja: alongar a
  // janela só é seguro junto com isto.
  if (encerramento) {
    cortado = true;
    if (cortarEspera) cortarEspera();
    return encerramento;
  }

  const s = sessao;
  if (!s) return;
  sessao = null;

  cortado = false;
  encerramento = fecharSessao(s, graca);
  try {
    return await encerramento;
  } finally {
    encerramento = null;
    cortado = false;
  }
}

// Verifica credenciais na inicialização.
// Se não tiver creds, mostra QR Code para parear e salva.
async function iniciarCliente() {
  const { state, saveCreds } = await useMultiFileAuthState(AUTH_DIR);

  if (state.creds.me) {
    console.log(`✅ Credenciais encontradas para ${state.creds.me.name}. Bot pronto.`);
    return;
  }

  console.log('⚠️  Nenhuma credencial encontrada. Iniciando pareamento via QR Code...');
  const { version } = await fetchLatestBaileysVersion();

  return new Promise((resolve, reject) => {
    const sock = makeWASocket(opcoesSocket(version, state));

    sock.ev.on('creds.update', saveCreds);

    let tentativas = 0;

    sock.ev.on('connection.update', async ({ connection, lastDisconnect, qr }) => {
      if (qr) {
        console.log('\n========================================');
        console.log('📱 ESCANEIE O QR CODE COM O WHATSAPP:');
        console.log('   WhatsApp → ⋮ → Aparelhos conectados → Conectar dispositivo');
        console.log('========================================\n');
        qrcode.generate(qr, { small: true });
        console.log('\n(Aponte a câmera do celular para o QR acima)\n');
      }

      if (connection === 'open') {
        console.log('✅ WhatsApp pareado com sucesso! Desconectando...');
        setTimeout(() => {
          sock.end(undefined);
          console.log('📵 Desconectado. Bot pronto para enviar nos horários agendados.');
          resolve();
        }, 3000);
      }

      if (connection === 'close') {
        const codigo = new Boom(lastDisconnect?.error)?.output?.statusCode;
        if (codigo === DisconnectReason.loggedOut) {
          console.error('❌ Sessão encerrada (logout). Delete /data/baileys_auth e reinicie.');
          process.exit(1);
        }
        if (state.creds.me) {
          resolve();
          return;
        }
        tentativas++;
        if (tentativas > 15) {
          console.error('❌ Muitas tentativas. Encerrando.');
          process.exit(1);
        }
        console.log(`🔄 Reconectando para QR... (tentativa ${tentativas})`);
        setTimeout(() => iniciarCliente().then(resolve).catch(reject), 3000);
      }
    });
  });
}

async function listarTodosChats() {
  const s = await abrirSessao();
  const grupos = await s.sock.groupFetchAllParticipating();
  return Object.entries(grupos).map(([id, info]) => ({ id, nome: info.subject }));
}

// Sempre "pronto": a conexão é preguiçosa e abre no momento do envio. Não inverta isto para
// checar a sessão de verdade. Na primeira tentativa do scheduler a sessão ainda é nula, o
// envio nunca seria chamado, a conexão nunca abriria, e nenhum link sairia.
function estaConectado() { return true; }

module.exports = {
  iniciarCliente,
  conectar,
  enviarMensagem,
  encerrarSessao,
  estaConectado,
  listarTodosChats,
  GRACA_SIGTERM_MS,
};
