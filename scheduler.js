const cron = require('node-cron');
const { buscarTransmissaoAoVivo, buscarUltimaGravacao } = require('./youtube');
const { enviarMensagem, estaConectado } = require('./whatsapp');

// Intervalo entre tentativas (minutos)
const INTERVALO_MIN = 5;

let tentativasAtivas = {};

function mensagemAoVivo(titulo, url) {
  return `🔴 *Transmissão ao vivo agora!*\n${url}`;
}

function mensagemGravacao(titulo, url) {
  return `🎬 *Culto disponível para assistir:*\n${url}`;
}

/**
 * Monitora transmissão ao vivo a cada 5 min até encontrar ou esgotar o tempo.
 * @param {string} chave       - identificador único do agendamento
 * @param {number} maxTentativas - quantas vezes tentar (5 min cada)
 * @param {string} nomeGrupo
 * @param {string} apiKey
 * @param {string} channelId
 */
async function monitorarAoVivo(chave, maxTentativas, nomeGrupo, apiKey, channelId) {
  if (tentativasAtivas[chave]) {
    console.log(`[Scheduler] Monitoramento ${chave} já está ativo, ignorando.`);
    return;
  }
  tentativasAtivas[chave] = 0;
  console.log(`\n[Scheduler] ▶ Iniciando monitoramento: ${chave} (máx ${maxTentativas} tentativas)`);

  async function tentar() {
    tentativasAtivas[chave]++;
    const n = tentativasAtivas[chave];

    if (!estaConectado()) {
      console.warn('[Scheduler] WhatsApp não conectado, aguardando...');
    } else {
      console.log(`[Scheduler] Tentativa ${n}/${maxTentativas} — buscando ao vivo...`);
      try {
        const video = await buscarTransmissaoAoVivo(apiKey, channelId);
        if (video) {
          await enviarMensagem(nomeGrupo, mensagemAoVivo(video.titulo, video.url));
          console.log(`[Scheduler] ✅ Link ao vivo enviado: ${video.url}`);
          delete tentativasAtivas[chave];
          return; // encerra o monitoramento
        }
      } catch (err) {
        console.error('[Scheduler] Erro:', err.message);
      }
    }

    if (n >= maxTentativas) {
      console.warn(`[Scheduler] ⚠️  Nenhuma transmissão encontrada em ${chave}. Encerrando.`);
      delete tentativasAtivas[chave];
      return;
    }

    // Agenda próxima tentativa
    setTimeout(tentar, INTERVALO_MIN * 60 * 1000);
  }

  // Primeira tentativa imediata
  await tentar();
}

async function enviarGravacao(nomeGrupo, apiKey, channelId) {
  console.log('\n[Scheduler] ▶ Buscando gravação recente do culto...');

  if (!estaConectado()) {
    console.warn('[Scheduler] WhatsApp não conectado.');
    return;
  }

  try {
    const video = await buscarUltimaGravacao(apiKey, channelId);
    if (video) {
      await enviarMensagem(nomeGrupo, mensagemGravacao(video.titulo, video.url));
      console.log(`[Scheduler] ✅ Gravação enviada: ${video.url}`);
    } else {
      console.warn('[Scheduler] ⚠️  Nenhuma gravação encontrada.');
    }
  } catch (err) {
    console.error('[Scheduler] Erro ao enviar gravação:', err.message);
  }
}

function iniciarAgendamentos(config) {
  const { apiKey, channelId, nomeGrupo } = config;

  // ── Domingo manhã ──────────────────────────────────────────────────────────
  // Começa às 09h54, monitora até 10h30 → janela de 36 min → 8 tentativas
  cron.schedule('54 9 * * 0', () => {
    monitorarAoVivo('domingo-manha', 8, nomeGrupo, apiKey, channelId);
  }, { timezone: 'America/Sao_Paulo' });

  // ── Domingo noite ──────────────────────────────────────────────────────────
  // Começa às 18h55, monitora até 19h30 → janela de 35 min → 8 tentativas
  // (tenta ao vivo primeiro; se não achar, envia gravação na última tentativa)
  cron.schedule('55 18 * * 0', async () => {
    const encontrou = await new Promise(resolve => {
      const chave = 'domingo-noite';
      let tentativas = 0;
      const maxT = 7;

      if (tentativasAtivas[chave]) { resolve(false); return; }
      tentativasAtivas[chave] = 0;

      console.log(`\n[Scheduler] ▶ Iniciando monitoramento: ${chave}`);

      async function tentar() {
        tentativas++;
        tentativasAtivas[chave] = tentativas;

        if (estaConectado()) {
          console.log(`[Scheduler] Tentativa ${tentativas}/${maxT} — buscando ao vivo...`);
          try {
            const video = await buscarTransmissaoAoVivo(apiKey, channelId);
            if (video) {
              await enviarMensagem(nomeGrupo, mensagemAoVivo(video.titulo, video.url));
              console.log(`[Scheduler] ✅ Ao vivo enviado: ${video.url}`);
              delete tentativasAtivas[chave];
              resolve(true);
              return;
            }
          } catch (err) {
            console.error('[Scheduler] Erro:', err.message);
          }
        }

        if (tentativas >= maxT) {
          // Última tentativa: envia gravação recente
          console.log('[Scheduler] Ao vivo não encontrado, enviando gravação recente...');
          delete tentativasAtivas[chave];
          await enviarGravacao(nomeGrupo, apiKey, channelId);
          resolve(false);
          return;
        }

        setTimeout(tentar, INTERVALO_MIN * 60 * 1000);
      }

      tentar();
    });
  }, { timezone: 'America/Sao_Paulo' });

  // ── Quarta-feira ───────────────────────────────────────────────────────────
  // Começa às 19h55, monitora até 20h30 → janela de 35 min → 8 tentativas
  cron.schedule('55 19 * * 3', () => {
    monitorarAoVivo('quarta-noite', 8, nomeGrupo, apiKey, channelId);
  }, { timezone: 'America/Sao_Paulo' });

  console.log('📅 Agendamentos configurados (America/Sao_Paulo):');
  console.log('   • Domingo     09h54 → monitora ao vivo até 10h30');
  console.log('   • Domingo     18h55 → monitora ao vivo até 19h30 (fallback: gravação)');
  console.log('   • Quarta-feira 19h55 → monitora ao vivo até 20h30');
  console.log('   Títulos aceitos: "Culto da Família", "Culto de Fé" (e variações)');
}

module.exports = { iniciarAgendamentos };
