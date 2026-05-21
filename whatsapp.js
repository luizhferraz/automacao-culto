const { default: makeWASocket, useMultiFileAuthState, DisconnectReason, fetchLatestBaileysVersion } = require('@whiskeysockets/baileys');
const { Boom } = require('@hapi/boom');
const pino = require('pino');
const qrcode = require('qrcode-terminal');

const AUTH_DIR = process.env.AUTH_DIR || '.baileys_auth';

// Verifica credenciais na inicialização.
// Se não tiver creds, mostra QR Code para parear e salva.
// Depois desconecta — o bot fica offline até precisar enviar.
async function iniciarCliente() {
  const { state, saveCreds } = await useMultiFileAuthState(AUTH_DIR);

  if (state.creds.me) {
    console.log(`✅ Credenciais encontradas para ${state.creds.me.name}. Bot pronto.`);
    console.log('📵 Mantendo desconectado para não suprimir notificações do celular.');
    return;
  }

  // Sem creds: precisa parear via QR Code
  console.log('⚠️  Nenhuma credencial encontrada. Iniciando pareamento via QR Code...');
  const { version } = await fetchLatestBaileysVersion();

  return new Promise((resolve, reject) => {
    const sock = makeWASocket({
      version,
      auth: state,
      logger: pino({ level: 'silent' }),
      printQRInTerminal: false,
      browser: ['Culto Bot', 'Chrome', '1.0'],
      markOnlineOnConnect: false,
      syncFullHistory: false,
    });

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
        // Desconecta logo após parear — fica offline
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
        // Após desconectar voluntariamente (após parear), resolve normalmente
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

// Conecta, envia a mensagem e desconecta imediatamente.
async function enviarMensagem(chatId, mensagem) {
  const { state, saveCreds } = await useMultiFileAuthState(AUTH_DIR);

  if (!state.creds.me) {
    throw new Error('WhatsApp não pareado. Execute o bot para gerar o QR Code.');
  }

  const { version } = await fetchLatestBaileysVersion();

  return new Promise((resolve, reject) => {
    const sock = makeWASocket({
      version,
      auth: state,
      logger: pino({ level: 'silent' }),
      printQRInTerminal: false,
      browser: ['Culto Bot', 'Chrome', '1.0'],
      markOnlineOnConnect: false,
      syncFullHistory: false,
      generateHighQualityLinkPreview: true,
    });

    sock.ev.on('creds.update', saveCreds);

    const timeout = setTimeout(() => {
      sock.end(undefined);
      reject(new Error('Timeout ao conectar para envio.'));
    }, 30000);

    sock.ev.on('connection.update', async ({ connection, lastDisconnect }) => {
      if (connection === 'open') {
        // Aguarda 3s para o WhatsApp processar a conexão e gerar prévia do link
        setTimeout(async () => {
          try {
            await sock.sendMessage(chatId, { text: mensagem });
            console.log(`✅ Mensagem enviada para ${chatId}`);
            clearTimeout(timeout);
            // Desconecta após enviar
            setTimeout(() => {
              sock.end(undefined);
              resolve();
            }, 3000);
          } catch (err) {
            clearTimeout(timeout);
            sock.end(undefined);
            reject(err);
          }
        }, 3000);
      }

      if (connection === 'close') {
        clearTimeout(timeout);
        const codigo = new Boom(lastDisconnect?.error)?.output?.statusCode;
        if (codigo === DisconnectReason.loggedOut) {
          reject(new Error('Sessão encerrada. Delete /data/baileys_auth e reconecte.'));
        } else {
          resolve(); // desconexão após envio — normal
        }
      }
    });
  });
}

async function listarTodosChats() {
  const { state, saveCreds } = await useMultiFileAuthState(AUTH_DIR);
  const { version } = await fetchLatestBaileysVersion();

  return new Promise((resolve, reject) => {
    const sock = makeWASocket({
      version,
      auth: state,
      logger: pino({ level: 'silent' }),
      printQRInTerminal: false,
      browser: ['Culto Bot', 'Chrome', '1.0'],
      markOnlineOnConnect: false,
    });

    sock.ev.on('creds.update', saveCreds);

    sock.ev.on('connection.update', async ({ connection }) => {
      if (connection === 'open') {
        try {
          const grupos = await sock.groupFetchAllParticipating();
          const lista = Object.entries(grupos).map(([id, info]) => ({ id, nome: info.subject }));
          sock.end(undefined);
          resolve(lista);
        } catch (err) {
          sock.end(undefined);
          reject(err);
        }
      }
    });
  });
}

function estaConectado() { return true; } // sempre "pronto" — conecta no momento do envio

module.exports = { iniciarCliente, enviarMensagem, estaConectado, listarTodosChats };
