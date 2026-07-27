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

// Enviada ao grupo quando o link ainda não saiu alguns minutos após o início do culto.
// Decisão consciente do Luiz: o texto atribui o atraso à internet, mesmo que o bot só
// saiba que a busca voltou vazia (a live pode ter atrasado, o título pode estar fora
// das palavras-chave, ou a quota da API pode ter esgotado). Na prática da igreja o
// motivo costuma ser a conexão, e a redação foi mantida como ele escreveu.
function mensagemAtraso() {
  return (
    '⚠️ *Olá, irmãos!*\n\n' +
    'Estamos com instabilidade na internet e, por esse motivo, o link da transmissão ainda não foi disponibilizado.\n\n' +
    'Já estamos trabalhando para resolver o mais rápido possível e, assim que normalizar, o link será enviado aqui no grupo.\n\n' +
    'Agradecemos a compreensão de todos! 🙏'
  );
}

function mensagemParaVideo(video) {
  if (video.fonte === 'estreia') return mensagemEstreia(video.titulo, video.url);
  return mensagemAoVivo(video.titulo, video.url);
}

// Retorna uma Promise que resolve quando terminar, com um booleano: true se enviou, false se não encontrou.
// Parâmetros em objeto de propósito: filtroHoras e avisoAposMin são dois números
// adjacentes que, trocados por engano, quebrariam a janela em silêncio.
//   avisoAposMin: minutos após o início do monitoramento para avisar o grupo que
//   o link atrasou. Enviado no máximo uma vez por janela; null desativa.
function monitorarAoVivo({ chave, maxTentativas, nomeGrupo, apiKey, channelId, filtroHoras = 8, avisoAposMin = null }) {
  if (tentativasAtivas[chave]) {
    console.log(`[Scheduler] Monitoramento ${chave} já está ativo, ignorando.`);
    return Promise.resolve(false);
  }
  tentativasAtivas[chave] = 0;
  console.log(`\n[Scheduler] ▶ Iniciando monitoramento: ${chave} (máx ${maxTentativas} tentativas)`);

  const inicio = Date.now();
  let avisoEnviado = false;

  return new Promise((resolve) => {
    async function tentar() {
      tentativasAtivas[chave]++;
      const n = tentativasAtivas[chave];

      if (!estaConectado()) {
        console.warn('[Scheduler] WhatsApp não conectado, aguardando...');
      } else {
        console.log(`[Scheduler] Tentativa ${n}/${maxTentativas} — buscando ao vivo...`);
        try {
          const video = await buscarTransmissaoAoVivo(apiKey, channelId, filtroHoras);
          if (video) {
            await enviarMensagem(nomeGrupo, mensagemParaVideo(video));
            console.log(`[Scheduler] ✅ Link enviado (${video.fonte}): ${video.url}`);
            delete tentativasAtivas[chave];
            resolve(true);
            return;
          }
        } catch (err) {
          console.error('[Scheduler] Erro:', err.message);
        }

        // Nada encontrado até aqui. Passado o prazo, avisa o grupo uma única vez.
        // avisoEnviado só vira true se o envio deu certo, então uma falha aqui
        // é reavaliada na próxima tentativa.
        const minutosSemLink = (Date.now() - inicio) / 60000;
        if (avisoAposMin !== null && !avisoEnviado && minutosSemLink >= avisoAposMin) {
          try {
            await enviarMensagem(nomeGrupo, mensagemAtraso());
            avisoEnviado = true;
            console.log(`[Scheduler] ⚠️  Aviso de atraso enviado ao grupo (${minutosSemLink.toFixed(1)} min sem link).`);
          } catch (err) {
            console.error('[Scheduler] Falha ao enviar aviso de atraso:', err.message);
          }
        }
      }

      if (n >= maxTentativas) {
        console.error(`[Scheduler] 🚨 ALERTA: Nenhuma transmissão encontrada em ${chave} após ${maxTentativas} tentativas. NENHUM LINK FOI ENVIADO AO GRUPO.`);
        delete tentativasAtivas[chave];
        resolve(false);
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
  // Culto às 10h00 → aviso de atraso às 10h03 (9 min após o início do monitoramento)
  cron.schedule('54 9 * * 0', async () => {
    await monitorarAoVivo({
      chave: 'domingo-manha', maxTentativas: 36, nomeGrupo, apiKey, channelId,
      filtroHoras: 8, avisoAposMin: 9,
    });
    desligar('Janela da manhã encerrada.');
  }, { timezone: 'America/Sao_Paulo' });

  // ── Domingo noite ──────────────────────────────────────────────────────────
  // Começa às 18h59, verifica a cada 1 min até 19h30 → janela de 31 min → 31 tentativas
  // Culto às 19h00 → aviso de atraso às 19h03 (4 min após o início do monitoramento)
  // (tenta ao vivo primeiro; se não achar, envia gravação como fallback)
  cron.schedule('59 18 * * 0', async () => {
    const enviou = await monitorarAoVivo({
      chave: 'domingo-noite', maxTentativas: 31, nomeGrupo, apiKey, channelId,
      filtroHoras: 7, avisoAposMin: 4,
    });
    if (!enviou) {
      console.log('[Scheduler] Ao vivo não encontrado, tentando gravação recente...');
      await enviarGravacao(nomeGrupo, apiKey, channelId);
    }
    desligar('Janela da noite encerrada.');
  }, { timezone: 'America/Sao_Paulo' });

  // ── Quarta-feira ───────────────────────────────────────────────────────────
  // Começa às 19h54, verifica a cada 1 min até 20h30 → janela de 36 min → 36 tentativas
  // Culto às 20h00 → aviso de atraso às 20h03 (9 min após o início do monitoramento)
  cron.schedule('54 19 * * 3', async () => {
    await monitorarAoVivo({
      chave: 'quarta-noite', maxTentativas: 36, nomeGrupo, apiKey, channelId,
      filtroHoras: 7, avisoAposMin: 9,
    });
    desligar('Janela da quarta encerrada.');
  }, { timezone: 'America/Sao_Paulo' });

  console.log('📅 Agendamentos configurados (America/Sao_Paulo):');
  console.log('   • Domingo     09h54 → verifica a cada 1 min até 10h30 (aviso de atraso às 10h03)');
  console.log('   • Domingo     18h59 → verifica a cada 1 min até 19h30 (aviso às 19h03, fallback: gravação)');
  console.log('   • Quarta-feira 19h54 → verifica a cada 1 min até 20h30 (aviso de atraso às 20h03)');
  console.log('   Títulos aceitos: "Culto da Família", "Culto de Fé", "Especial de..." (e variações)');
}

// monitorarAoVivo e mensagemAtraso são exportados para permitir testes automatizados
// (ver testes/simular-aviso.js), que rodam a função real com relógio simulado.
module.exports = { iniciarAgendamentos, monitorarAoVivo, mensagemAtraso };
