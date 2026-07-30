const { default: makeWASocket, useMultiFileAuthState, DisconnectReason, fetchLatestBaileysVersion } = require('@whiskeysockets/baileys');
const { Boom } = require('@hapi/boom');
const pino = require('pino');
const path = require('path');
const { readdir, unlink, writeFile, access } = require('fs/promises');
const qrcode = require('qrcode-terminal');
const mensagens = require('./mensagens-enviadas');

const AUTH_DIR = process.env.AUTH_DIR || '.baileys_auth';

// Quanto tempo a conexão fica de pé depois do último envio, antes de desligar.
// Esse tempo não é enfeite: quando um aparelho não consegue descriptografar a mensagem,
// ele manda um pedido de reenvio (retry receipt) alguns segundos depois. Se o socket já
// morreu, ninguém atende, e aquela pessoa fica com "Aguardando mensagem" para sempre.
const GRACA_REENVIO_MS = Number(process.env.RETRY_GRACE_MS || 120000);

// Tempo curto usado quando o Fly manda SIGTERM: ali não dá para segurar dois minutos.
// O Fly derruba o processo 5s depois do sinal, então isto precisa caber com folga
// para ainda sobrar tempo de gravar o estado de sinal no volume.
const GRACA_SIGTERM_MS = Number(process.env.RETRY_GRACE_SIGTERM_MS || 3000);

const TIMEOUT_CONEXAO_MS = Number(process.env.CONEXAO_TIMEOUT_MS || 30000);

// Pausa após a conexão abrir, antes do primeiro envio.
const ESPERA_APOS_CONECTAR_MS = Number(process.env.ESPERA_APOS_CONECTAR_MS || 3000);

// 'silent' escondia inclusive os avisos de ack com erro e de reenvio não atendido, que são
// exatamente os sintomas que precisam aparecer nos logs do Fly quando algo dá errado.
const NIVEL_LOG = process.env.BAILEYS_LOG_LEVEL || 'warn';

const esperar = (ms) => new Promise(r => setTimeout(r, ms));

// Sessão única por execução. Antes cada mensagem abria e fechava o próprio socket, o que
// refazia as sessões de sinal do zero a cada envio e desperdiçava a janela de reenvio.
let sessao = null;

function opcoesSocket(version, state, aoReenviar = () => {}) {
  return {
    version,
    auth: state,
    logger: pino({ level: NIVEL_LOG }),
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
        aoReenviar();
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

// O useMultiFileAuthState grava as chaves de sinal em disco de forma assíncrona, e o Baileys
// nem sempre espera essa gravação terminar. Como o processo chama process.exit logo depois
// e o Fly desmonta o volume, uma gravação perdida deixa o ratchet do remetente defasado, e
// aí a PRÓXIMA mensagem já nasce impossível de descriptografar. Este wrapper permite esperar
// tudo drenar antes de sair.
function rastrearGravacoes(state, saveCreds) {
  const pendentes = new Set();

  const acompanhar = (promessa) => {
    const p = Promise.resolve(promessa).catch(err => {
      console.error('[WhatsApp] Falha ao gravar estado de sinal:', err.message);
    });
    pendentes.add(p);
    p.finally(() => pendentes.delete(p));
    return p;
  };

  const setOriginal = state.keys.set.bind(state.keys);
  state.keys.set = (dados) => acompanhar(setOriginal(dados));

  const salvarCreds = () => acompanhar(saveCreds());

  // Repete enquanto sobrar coisa: fechar o socket dispara gravações novas, e uma única
  // passada só esperaria as que já existiam quando o drenar começou. O limite de voltas
  // é só para nunca travar o desligamento se algo entrar em laço.
  const drenar = async () => {
    for (let volta = 0; volta < 10 && pendentes.size > 0; volta++) {
      await Promise.allSettled([...pendentes]);
    }
  };

  return { salvarCreds, drenar };
}

// Em grupo, o WhatsApp criptografa com uma "sender key" que o remetente precisa distribuir
// uma vez para cada aparelho. O Baileys guarda em disco quem já recebeu, no arquivo
// sender-key-memory-<grupo>.json, e só distribui para quem ainda não está lá.
//
// O problema: em toda a biblioteca existe UM único ponto que limpa essa memória, o
// messages-recv.js:1136, e ele fica dentro do tratamento do pedido de reenvio. Como o bot
// morria antes de processar qualquer reenvio, essa memória nunca era limpa. Quem perdeu a
// chave depois de recebê-la (trocou de aparelho, reinstalou o WhatsApp, restaurou backup)
// continuava marcado como "já recebeu" no volume e nunca mais recebia a chave de novo.
//
// Essa limpeza roda uma vez só, marcada por um arquivo. Apagar não perde nada: é um cache
// de "para quem eu já avisei". O próximo envio simplesmente redistribui a chave para todos.
const MARCA_REDISTRIBUICAO = path.join(AUTH_DIR, '.chaves-redistribuidas');

async function redistribuirChavesUmaVez() {
  try {
    await access(MARCA_REDISTRIBUICAO);
    return;
  } catch { /* ainda não foi feito */ }

  try {
    const arquivos = await readdir(AUTH_DIR);
    const memorias = arquivos.filter(a => a.startsWith('sender-key-memory-'));
    for (const arquivo of memorias) {
      await unlink(path.join(AUTH_DIR, arquivo));
    }
    await writeFile(MARCA_REDISTRIBUICAO, new Date().toISOString());
    if (memorias.length > 0) {
      console.log(`[WhatsApp] 🔑 Limpei ${memorias.length} registro(s) de distribuição de chave de grupo. O próximo envio redistribui a chave para todos os aparelhos.`);
    }
  } catch (err) {
    // Falhar aqui não pode impedir o envio do link do culto. Fica para a próxima execução.
    console.warn('[WhatsApp] Não consegui limpar a memória de distribuição de chaves:', err.message);
  }
}

async function abrirSessao() {
  if (sessao && sessao.viva) return sessao;

  const { state, saveCreds } = await useMultiFileAuthState(AUTH_DIR);

  if (!state.creds.me) {
    throw new Error('WhatsApp não pareado. Execute o bot para gerar o QR Code.');
  }

  await redistribuirChavesUmaVez();

  const { version } = await fetchLatestBaileysVersion();
  const { salvarCreds, drenar } = rastrearGravacoes(state, saveCreds);

  return new Promise((resolve, reject) => {
    const nova = { sock: null, drenar, viva: false, enviadas: [], reenvios: 0, confirmacoes: new Set() };
    const sock = makeWASocket(opcoesSocket(version, state, () => { nova.reenvios++; }));
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
    // Contar as confirmações dá uma noção real de quantos aparelhos abriram a mensagem.
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

// Envia e devolve o id da mensagem. Não desconecta: quem fecha é o encerrarSessao.
async function enviarMensagem(chatId, mensagem) {
  const s = await abrirSessao();

  const enviada = await s.sock.sendMessage(chatId, { text: mensagem });
  const id = enviada?.key?.id;
  if (!id) {
    throw new Error('O WhatsApp não devolveu o id da mensagem; envio não confirmado.');
  }

  // Guarda antes de qualquer outra coisa: se um pedido de reenvio chegar em milissegundos,
  // o histórico já precisa estar no disco.
  await mensagens.guardar(id, enviada.message);
  s.enviadas.push(id);

  console.log(`✅ Mensagem enviada para ${chatId} (id ${id})`);
  return id;
}

// Encerramento em curso, para um segundo pedido conseguir esperar o primeiro em vez de
// achar que não há nada a fazer.
let encerramento = null;
let cortarEspera = null;

// Espera que um segundo pedido consegue interromper. É o que deixa o SIGTERM pular o resto
// da janela de reenvio sem pular o fechamento do socket e a drenagem das gravações.
function esperarCortavel(ms) {
  return new Promise((resolve) => {
    const relogio = setTimeout(() => { cortarEspera = null; resolve(); }, ms);
    cortarEspera = () => { clearTimeout(relogio); cortarEspera = null; resolve(); };
  });
}

async function fecharSessao(s, graca) {
  if (s.enviadas.length > 0 && graca > 0) {
    const prazo = graca >= 1000 ? `${Math.round(graca / 1000)}s` : `${graca}ms`;
    console.log(`[WhatsApp] ⏳ Mantendo a conexão por ${prazo} para atender pedidos de reenvio...`);
    await esperarCortavel(graca);
    console.log(`[WhatsApp] 📬 ${s.confirmacoes.size} aparelho(s) confirmaram entrega; ${s.reenvios} reenvio(s) atendido(s).`);
  }

  // O end() do Baileys é async: fecha o websocket, percorre os handlers de fim e só então
  // emite o connection.update de fechamento. Sem await, o drenar abaixo correria antes
  // disso e uma rejeição escaparia como unhandled rejection.
  try { await s.sock.end(undefined); } catch { /* socket já morto */ }
  await s.drenar();
  console.log('[WhatsApp] 📵 Desconectado.');
}

async function encerrarSessao({ graca = GRACA_REENVIO_MS } = {}) {
  // Um segundo pedido durante o primeiro é o SIGTERM chegando no meio da janela de reenvio.
  // Sem este ramo ele veria `sessao` já nula, voltaria na hora, e o process.exit de quem
  // chamou mataria o processo com o socket aberto e gravações em voo. Ou seja: alongar a
  // janela para 2 min só é seguro junto com isto.
  if (encerramento) {
    if (cortarEspera) cortarEspera();
    return encerramento;
  }

  const s = sessao;
  if (!s) return;
  sessao = null;

  encerramento = fecharSessao(s, graca);
  try {
    await encerramento;
  } finally {
    encerramento = null;
  }
}

// Verifica credenciais na inicialização.
// Se não tiver creds, mostra QR Code para parear e salva.
async function iniciarCliente() {
  const { state, saveCreds } = await useMultiFileAuthState(AUTH_DIR);

  if (state.creds.me) {
    console.log(`✅ Credenciais encontradas para ${state.creds.me.name}. Bot pronto.`);
    console.log('📵 Só conecta na hora de enviar, para não suprimir notificações do celular.');
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

function estaConectado() { return true; } // sempre "pronto" : conecta no momento do envio

module.exports = {
  iniciarCliente,
  enviarMensagem,
  encerrarSessao,
  estaConectado,
  listarTodosChats,
  GRACA_SIGTERM_MS,
};
