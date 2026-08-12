const {
  default: makeWASocket,
  useMultiFileAuthState,
  DisconnectReason,
  fetchLatestBaileysVersion,
  isJidGroup,
  isJidStatusBroadcast,
  isJidNewsletter,
  S_WHATSAPP_NET,
} = require('@whiskeysockets/baileys');
const { Boom } = require('@hapi/boom');
const path = require('path');
const { readdir, unlink } = require('fs/promises');
const qrcode = require('qrcode-terminal');
const mensagens = require('./mensagens-enviadas');
const diagnostico = require('./diagnostico');

const AUTH_DIR = process.env.AUTH_DIR || '.baileys_auth';

// O grupo de avisos. É a única conversa que este bot precisa enxergar, e saber disso é o que
// torna possível o filtro de ruído logo abaixo.
const GRUPO_ALVO = process.env.WHATSAPP_GROUP_NAME || '';

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

// Prazo do iq que devolve a sessão para o estado passivo. Ver anunciarSessaoPassiva.
const PRAZO_PASSIVO_MS = Number(process.env.PASSIVO_TIMEOUT_MS || 10000);

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

/**
 * Descarta o tráfego que não é do grupo de avisos, antes de ele entrar na fila.
 *
 * ESTA É A CORREÇÃO CENTRAL, e ela explica por que nenhuma das anteriores funcionou.
 *
 * O bot é um aparelho vinculado à conta pessoal do Luiz, então recebe TODA a conversa dele,
 * não só o grupo de avisos. Como fica offline quase a semana inteira, o WhatsApp acumula
 * isso e despeja tudo de uma vez na reconexão. Medido no log da quarta 05/08:
 *
 *   2887 mensagens indecifráveis, TODAS de outros grupos (zero do grupo de avisos)
 *   vazão de 7 nós por segundo, porque cada falha custa transação, rollback e disco
 *   a fila ainda estava drenando às 22:56:03, o instante exato em que o socket fechou
 *
 * Ou seja: os 2 minutos de janela de reenvio foram gastos inteiros processando mensagem de
 * grupo que não interessa. E o processador de nós offline abandona em silêncio o que sobrou
 * quando o websocket fecha (`while (nodes.length && deps.isWsOpen())`).
 *
 * O pedido de reenvio do nosso grupo estava nessa fila e nunca chegou a ser lido. Por isso
 * o resumo daquela janela registrou zero reenvios atendidos e zero confirmações de entrega:
 * não é que ninguém pediu, é que o bot nunca chegou lá. E como o ÚNICO ponto da biblioteca
 * que limpa a memória de distribuição de chave fica dentro desse tratamento, ele nunca rodou
 * nem uma vez em toda a vida deste bot.
 *
 * O getMessage, o histórico em disco e a janela elástica estavam corretos, e todos inúteis,
 * porque a fila nunca chegava neles.
 *
 * O Baileys filtra por este callback em processNode, ANTES de enfileirar, e ainda manda o ack
 * para o servidor não reenviar depois. Um pedido de reenvio de grupo chega com `from` sendo o
 * jid do grupo, então o nosso passa e os outros não.
 */
function criarFiltroDeRuido(aoIgnorar = () => {}) {
  // Sem grupo configurado não dá para saber o que é ruído, e filtrar por engano descartaria
  // justamente os pedidos de reenvio do grupo de avisos. Na dúvida, não filtra nada.
  if (!GRUPO_ALVO) {
    console.warn('[WhatsApp] WHATSAPP_GROUP_NAME não definido: o filtro de ruído fica desligado.');
    return () => false;
  }

  return (jid) => {
    if (!jid || jid === GRUPO_ALVO) return false;
    // Conservador de propósito: só descarta conversa de muitos participantes, que é onde o
    // volume mora. Conversa individual continua passando, custa pouco e evita surpresa com
    // algum nó de protocolo que chegue por um jid inesperado.
    const ruido = !!isJidGroup(jid) || !!isJidStatusBroadcast(jid) || !!isJidNewsletter(jid);
    if (ruido) aoIgnorar();
    return ruido;
  };
}

function opcoesSocket(version, state, aoReenviar = () => {}, aoIgnorar = () => {}) {
  return {
    shouldIgnoreJid: criarFiltroDeRuido(aoIgnorar),
    version,
    auth: state,
    logger: diagnostico.logger(),
    printQRInTerminal: false,
    browser: ['Culto Bot', 'Chrome', '1.0'],
    // Continua false de propósito, mas resolve só METADE do problema da notificação: esta
    // opção governa apenas a presença. O outro lado é o iq de sessão ativa que o Baileys
    // manda sozinho no login, e que só o anunciarSessaoPassiva desfaz.
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

/**
 * Desfaz o `active` que o Baileys anuncia por conta própria no login.
 *
 * `markOnlineOnConnect: false` cobre só a metade visível do problema. Ela governa a
 * PRESENÇA: com a opção desligada, o Baileys manda `presence: unavailable` ao abrir
 * (chats.js, no tratamento de `connection.update`). Essa parte sempre esteve certa.
 *
 * A metade que faltava é que, no `CB:success` do login, o Baileys manda TAMBÉM
 * `<iq xmlns="passive"><active/></iq>` — incondicionalmente, sem sequer consultar
 * `markOnlineOnConnect` (socket.js, tanto na 7.0.0-rc11 quanto na rc14). É o mesmo iq que o
 * WhatsApp Web usa para dizer que a aba está em foco (`active`) ou foi para segundo plano
 * (`passive`), e a própria biblioteca não sabe explicar por que o manda: o comentário no
 * fonte é "i have no idea why this exists. pls enlighten me".
 *
 * Ou seja, o bot dizia "indisponível" na presença e, milissegundos depois, se declarava a
 * sessão ATIVA da conta. Enquanto isso vale, o WhatsApp tem um aparelho vinculado ativo e
 * para de mandar push para o celular do dono, que é o sintoma relatado.
 *
 * Ficar de pé deixou de ser inofensivo quando o tempo de socket aberto cresceu: entre a
 * conexão na subida, a janela de monitoramento e a janela elástica de reenvio, são perto de
 * 50 min seguidos, três vezes por semana.
 *
 * O iq inverso vai DEPOIS do `connection: open`, que o Baileys emite depois do `active`, e
 * depois do `unavailable`, porque o ouvinte do chats.js foi registrado antes deste. A ordem
 * na rede fica: active (lib) → unavailable (lib) → passive (aqui).
 */
async function anunciarSessaoPassiva(s) {
  try {
    await s.sock.query({
      tag: 'iq',
      attrs: { to: S_WHATSAPP_NET, xmlns: 'passive', type: 'set' },
      content: [{ tag: 'passive', attrs: {} }],
    }, PRAZO_PASSIVO_MS);
    s.passiva = true;
    console.log('[WhatsApp] 🔕 Sessão anunciada como passiva.');
  } catch (err) {
    // Nunca fatal: no pior caso o celular fica sem notificação durante a janela, e o link do
    // culto, que é a razão de o bot existir, sai do mesmo jeito. O resumo registra a falha.
    console.warn('[WhatsApp] Não consegui anunciar a sessão como passiva:', err.message);
  }
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
      ignorados: 0,
      retriesRecebidos: [],
      ultimaAtividade: 0,
      conectadoEm: null,
      passiva: false,
    };

    const registrarReenvio = (id) => {
      nova.reenvios++;
      nova.reenviados.push(id);
      nova.ultimaAtividade = Date.now();
    };

    const sock = makeWASocket(
      opcoesSocket(version, state, registrarReenvio, () => { nova.ignorados++; })
    );
    nova.sock = sock;

    // O sinal de atividade da janela precisa ser "CHEGOU pedido de reenvio", não "consegui
    // atendê-lo". A versão anterior só atualizava o relógio dentro do getMessage, quando a
    // mensagem era achada no histórico, e na prática quase nenhum pedido é desse tipo: no
    // culto de 09/08 foram 388 pedidos e só 1 servido. Com o relógio congelado no envio, a
    // condição de quietude já estava satisfeita quando o piso vencia, e a janela dita
    // elástica saía sempre no piso exato. Os eventos CB: são emitidos num EventEmitter comum
    // com limite de ouvintes desativado, então este ouvinte extra não interfere no do Baileys.
    // De quebra, registra QUEM pediu reenvio de QUAL mensagem, que é o dado que faltava para
    // separar "ninguém pediu" de "pediram e não foi atendido".
    sock.ws?.on?.('CB:receipt', (no) => {
      if (no?.attrs?.type !== 'retry') return;
      nova.ultimaAtividade = Date.now();
      nova.retriesRecebidos.push({
        id: no.attrs.id,
        de: no.attrs.participant || no.attrs.from,
        em: new Date().toISOString(),
      });
    });

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
        // Antes da pausa de acomodação, para a conta passar o mínimo de tempo possível
        // marcada como sessão ativa. O anúncio nunca rejeita.
        anunciarSessaoPassiva(nova)
          .then(() => esperar(ESPERA_APOS_CONECTAR_MS))
          .then(() => finalizar(null));
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
async function aguardarReenvios(s, piso, teto) {
  const inicio = Date.now();
  // O teto vem de quem chamou, e não de uma constante global. Derivá-lo com
  // Math.max(piso, GRACA_MAXIMA_MS) parecia inofensivo e era um bug: no caminho do SIGTERM o
  // piso é de 3s, mas o teto virava os 10 minutos do envio normal. Como a condição de saída
  // exige silêncio de GRACA_QUIETUDE_MS e os pedidos de reenvio agora realmente chegam, o
  // laço não sairia, o processo passaria do kill_timeout e levaria SIGKILL no meio das
  // gravações de estado de sinal. Exatamente o que o caminho do SIGTERM existe para evitar.
  teto = Math.max(piso, teto);

  while (!cortado) {
    const decorrido = Date.now() - inicio;
    if (decorrido >= teto) break;
    if (decorrido >= piso && Date.now() - s.ultimaAtividade >= GRACA_QUIETUDE_MS) break;
    await esperarCortavel(Math.min(PASSO_ESPERA_MS, teto - decorrido));
  }

  return Date.now() - inicio;
}

async function fecharSessao(s, piso, teto) {
  let esperou = 0;

  if (s.enviadas.length > 0 && piso > 0) {
    const prazo = piso >= 1000 ? `${Math.round(piso / 1000)}s` : `${piso}ms`;
    console.log(`[WhatsApp] ⏳ Mantendo a conexão por pelo menos ${prazo} para atender pedidos de reenvio...`);
    esperou = await aguardarReenvios(s, piso, teto);
    console.log(`[WhatsApp] 📬 ${s.confirmacoes.size} aparelho(s) confirmaram entrega; ${s.reenvios} reenvio(s) atendido(s) em ${Math.round(esperou / 1000)}s.`);
    console.log(`[WhatsApp] 🧹 ${s.ignorados} nó(s) de outras conversas descartados sem entrar na fila.`);
  }

  const montarResumo = () => ({
    conectadoEm: s.conectadoEm,
    encerradoEm: new Date().toISOString(),
    esperaDeReenvioMs: esperou,
    // Falso aqui significa que a conta passou a janela inteira com um aparelho vinculado
    // ativo, e é a primeira coisa a conferir se o celular voltar a não notificar.
    sessaoPassiva: s.passiva,
    envios: s.envios,
    grupo: s.grupo,
    confirmacoes: { total: s.confirmacoes.size, jids: [...s.confirmacoes] },
    reenviosAtendidos: { total: s.reenvios, ids: s.reenviados },
    // Todos os pedidos de reenvio que CHEGARAM, atendidos ou não, com quem pediu e o id
    // pedido. É o que separa "ninguém pediu a mensagem de hoje" de "pediram e não atendi".
    retriesRecebidos: { total: s.retriesRecebidos.length, pedidos: s.retriesRecebidos },
    // Quanto ruído de outras conversas foi barrado antes da fila. Enquanto isso não existia,
    // a fila levava a janela inteira para drenar e os pedidos de reenvio nunca eram lidos.
    nosIgnorados: s.ignorados,
    falhasDeGravacao: s.contarFalhas(),
  });

  // Grava ANTES de fechar e drenar. O drenar pode demorar quando a janela atendeu muitos
  // pedidos de reenvio, e o Fly mata o processo alguns segundos depois do SIGTERM: já
  // aconteceu de o resumo se perder exatamente na execução mais interessante de todas.
  // Depois da drenagem ele é regravado com os números finais.
  diagnostico.gravarResumo(montarResumo());

  // O end() do Baileys é async: fecha o websocket, percorre os handlers de fim e só então
  // emite o connection.update de fechamento. Sem await, o drenar abaixo correria antes
  // disso e uma rejeição escaparia como unhandled rejection.
  try { await s.sock.end(undefined); } catch { /* socket já morto */ }
  await s.drenar();

  const resumo = montarResumo();
  const arquivo = diagnostico.gravarResumo(resumo);
  if (arquivo) console.log(`[WhatsApp] 📝 Resumo da janela em ${arquivo}`);

  console.log('[WhatsApp] 📵 Desconectado.');
  diagnostico.encerrar();

  return resumo;
}

// `graca` é o piso da janela de reenvio e `teto` é o limite duro dela. Quem encerra por
// SIGTERM precisa passar os dois e mantê-los curtos: ali o Fly já está contando o
// kill_timeout, e passar dele é levar SIGKILL com gravações em voo.
async function encerrarSessao({ graca = GRACA_MINIMA_MS, teto = GRACA_MAXIMA_MS } = {}) {
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
  encerramento = fecharSessao(s, graca, teto);
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
