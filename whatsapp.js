const { default: makeWASocket, useMultiFileAuthState, DisconnectReason, fetchLatestBaileysVersion } = require('@whiskeysockets/baileys');
const { Boom } = require('@hapi/boom');
const pino = require('pino');
const qrcode = require('qrcode-terminal');

const AUTH_DIR = process.env.AUTH_DIR || '.baileys_auth';

let sock = null;
let pronto = false;

async function iniciarCliente() {
  const { state, saveCreds } = await useMultiFileAuthState(AUTH_DIR);
  const { version } = await fetchLatestBaileysVersion();

  sock = makeWASocket({
    version,
    auth: state,
    logger: pino({ level: 'silent' }),
    printQRInTerminal: false,
    browser: ['Culto Bot', 'Chrome', '1.0'],
    generateHighQualityLinkPreview: true,
    markOnlineOnConnect: false,  // não marca como online — evita suprimir notificações do celular
    syncFullHistory: false,       // não sincroniza histórico — reduz interferência
  });

  sock.ev.on('creds.update', saveCreds);

  return new Promise((resolve, reject) => {
    let tentativas = 0;
    let qrMostrado = false;

    sock.ev.on('connection.update', async (update) => {
      const { connection, lastDisconnect, qr } = update;

      // Mostra QR Code quando disponível
      if (qr) {
        qrMostrado = true;
        console.log('\n========================================');
        console.log('📱 ESCANEIE O QR CODE COM O WHATSAPP:');
        console.log('   WhatsApp → ⋮ → Aparelhos conectados → Conectar dispositivo');
        console.log('========================================\n');
        qrcode.generate(qr, { small: true });
        console.log('\n(Aponte a câmera do celular para o QR acima)\n');
      }

      if (connection === 'open') {
        console.log('✅ WhatsApp conectado com sucesso!');
        pronto = true;
        tentativas = 0;
        // Anuncia presença como indisponível para não suprimir notificações do celular
        try {
          await sock.sendPresenceUpdate('unavailable');
          console.log('📵 Presença definida como indisponível (notificações do celular preservadas)');
        } catch (e) {
          // ignora erro silenciosamente
        }
        resolve(sock);
      }

      if (connection === 'close') {
        pronto = false;
        const codigo = new Boom(lastDisconnect?.error)?.output?.statusCode;

        // Logout explícito — não tenta reconectar
        if (codigo === DisconnectReason.loggedOut) {
          console.error('❌ Sessão encerrada (logout). Delete /data/baileys_auth e reinicie.');
          process.exit(1);
        }

        tentativas++;

        // Se nunca mostrou QR e já tentou muitas vezes, desiste
        if (!state.creds.registered && !qrMostrado && tentativas > 5) {
          console.error('❌ Não conseguiu conectar após várias tentativas.');
          process.exit(1);
        }

        // Reconecta sempre (inclusive durante o escaneamento do QR)
        if (tentativas > 15) {
          console.error('❌ Muitas tentativas de reconexão. Encerrando.');
          process.exit(1);
        }

        const espera = state.creds.registered
          ? Math.min(tentativas * 5000, 30000)
          : 3000; // reconecta rápido durante pareamento

        console.log(`🔄 Reconectando em ${espera / 1000}s... (tentativa ${tentativas})`);
        setTimeout(() => iniciarCliente().then(resolve).catch(reject), espera);
      }
    });
  });
}

async function enviarMensagem(chatId, mensagem) {
  if (!pronto || !sock) throw new Error('WhatsApp não conectado.');
  await sock.sendMessage(chatId, { text: mensagem });
  console.log(`✅ Mensagem enviada para ${chatId}`);
}

async function listarTodosChats() {
  const grupos = await sock.groupFetchAllParticipating();
  return Object.entries(grupos).map(([id, info]) => ({ id, nome: info.subject }));
}

function estaConectado() { return pronto; }

module.exports = { iniciarCliente, enviarMensagem, estaConectado, listarTodosChats };
