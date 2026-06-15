const cron = require('node-cron');
const { buscarTransmissaoAoVivo, buscarUltimaGravacao } = require('./youtube');
const { enviarMensagem, estaConectado } = require('./whatsapp');

// Intervalo entre tentativas (minutos)
const INTERVALO_MIN = 1;

let tentativasAtivas = {};

function mensagemAoVivo(titulo, url) {
  return `🔴 *Transmissão ao vivo*\n\n*${titulo}*\n\n🖥️ Assista aqui:\n${url}`;
}

function mensagemEstreia(titulo, url) {
  return `🔵 *Culto disponível para assistir*\n\n*${titulo}*\n\n🖥️ Assista aqui:\n${url}`;
}

function mensagemGravacao(titulo, url) {
  return `🎬 *Culto disponível para assistir*\n\n*${titulo}*\n\n🖥️ Assista aqui:\n${url}`;
}

function mensagemParaVideo(video) {
  if (video.fonte === 'estreia') return mensagemEstreia(video.titulo, video.url);
  return mensagemAoVivo(video.titulo, video.url);
}

// Retorna uma Promise que resolve quando o monitoramento terminar
// (enviou o link OU esgotou todas as tentativas)
function monitorarAoVivo(chave, maxTentativas, nomeGrupo, apiKey, channelId) {
  if (tentativasAtivas[chave]) {
    console.log(`[Scheduler] Monitoramento ${chave} já está ativo, ignorando.`);
    return Promise.resolve();
  }
  tentativasAtivas[chave] = 0;
  console.log(`\n[Scheduler] ▶ Iniciando monitoramento: ${chave} (máx ${maxTentativas} tentativas)`);

  return new Promise((resolve) => {
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
            await enviarMensagem(nomeGrupo, mensagemParaVideo(video));
            console.log(`[Scheduler] ✅ Link enviado (${video.fonte}): ${video.url}`);
            delete tentativasAtivas[chave];
            resolve();
            return;
          }
        } catch (err) {
          console.error('[Scheduler] Erro:', err.message);
        }
      }

      if (n >= maxTentativas) {
        console.warn(`[Scheduler] ⚠️  Nenhuma transmissão encontrada em ${chave}. Encerrando.`);
        delete tentativasAtivas[chave];
        resolve();
        return;
      }

      setTimeout(tentar, INTERVALO_MIN * 60 * 1000);
    }

    tentar();
  });
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

function desligar(motivo) {
  console.log(`🛑 ${motivo} Encerrando processo — máquina será desligada pelo Fly.io.`);
  setTimeout(() => process.exit(0), 3000); // 3s para logs fluírem
}

function iniciarAgendamentos(config) {
  const { apiKey, channelId, nomeGrupo } = config;

  // ── Domingo manhã ──────────────────────────────────────────────────────────
  // Começa às 09h54, verifica a cada 1 min até 10h30 → janela de 36 min → 36 tentativas
  cron.schedule('54 9 * * 0', async () => {
    await monitorarAoVivo('domingo-manha', 36, nomeGrupo, apiKey, channelId);
    desligar('Janela da manhã encerrada.');
  }, { timezone: 'America/Sao_Paulo' });

  // ── Domingo noite ──────────────────────────────────────────────────────────
  // Começa às 18h59, verifica a cada 1 min até 19h30 → janela de 31 min → 31 tentativas
  // (tenta ao vivo primeiro; se não achar, envia gravação na última tentativa)
  cron.schedule('59 18 * * 0', async () => {
    const chave = 'domingo-noite';
    const maxT = 31;

    if (tentativasAtivas[chave]) {
      console.log(`[Scheduler] Monitoramento ${chave} já está ativo, ignorando.`);
      return;
    }
    tentativasAtivas[chave] = 0;
    console.log(`\n[Scheduler] ▶ Iniciando monitoramento: ${chave} (máx ${maxT} tentativas)`);

    await new Promise((resolve) => {
      async function tentar() {
        tentativasAtivas[chave]++;
        const n = tentativasAtivas[chave];

        if (estaConectado()) {
          console.log(`[Scheduler] Tentativa ${n}/${maxT} — buscando ao vivo...`);
          try {
            const video = await buscarTransmissaoAoVivo(apiKey, channelId);
            if (video) {
              await enviarMensagem(nomeGrupo, mensagemParaVideo(video));
              console.log(`[Scheduler] ✅ Link enviado (${video.fonte}): ${video.url}`);
              delete tentativasAtivas[chave];
              resolve();
              return;
            }
          } catch (err) {
            console.error('[Scheduler] Erro:', err.message);
          }
        }

        if (n >= maxT) {
          console.log('[Scheduler] Ao vivo não encontrado, enviando gravação recente...');
          delete tentativasAtivas[chave];
          await enviarGravacao(nomeGrupo, apiKey, channelId);
          resolve();
          return;
        }

        setTimeout(tentar, INTERVALO_MIN * 60 * 1000);
      }

      tentar();
    });

    desligar('Janela da noite encerrada.');
  }, { timezone: 'America/Sao_Paulo' });

  // ── Quarta-feira ───────────────────────────────────────────────────────────
  // Começa às 19h54, verifica a cada 1 min até 20h30 → janela de 36 min → 36 tentativas
  cron.schedule('54 19 * * 3', async () => {
    await monitorarAoVivo('quarta-noite', 36, nomeGrupo, apiKey, channelId);
    desligar('Janela da quarta encerrada.');
  }, { timezone: 'America/Sao_Paulo' });

  console.log('📅 Agendamentos configurados (America/Sao_Paulo):');
  console.log('   • Domingo     09h54 → verifica a cada 1 min até 10h30');
  console.log('   • Domingo     18h59 → verifica a cada 1 min até 19h30 (fallback: gravação)');
  console.log('   • Quarta-feira 19h54 → verifica a cada 1 min até 20h30');
  console.log('   Títulos aceitos: "Culto da Família", "Culto de Fé", "Especial de..." (e variações)');
}

module.exports = { iniciarAgendamentos };
