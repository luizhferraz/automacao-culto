const cron = require('node-cron');
const { buscarTransmissaoAoVivo, buscarUltimaGravacao } = require('./youtube');
const { enviarMensagem, encerrarSessao, estaConectado } = require('./whatsapp');
const diagnostico = require('./diagnostico');

// Intervalo entre tentativas (minutos)
const INTERVALO_MIN = 1;

// Folga sobre o número de tentativas antes de a janela desistir pelo relógio. Existe porque
// "36 tentativas" só equivale a 36 minutos enquanto cada tentativa for rápida: com a rede
// ruim, cada uma pode levar bem mais que o intervalo. Sem este teto a janela invadiria a
// noite, e janela aberta é socket aberto segurando a sessão da conta.
const FOLGA_JANELA_MIN = 5;

const FUSO = 'America/Sao_Paulo';

let tentativasAtivas = {};

// ── Janelas ──────────────────────────────────────────────────────────────────
// Uma tabela só, usada pelo cron e pela recuperação de janela perdida da subida. Enquanto
// isto era três chamadas de cron.schedule copiadas, o horário vivia em dois lugares (a
// expressão e o texto do console) e não havia como perguntar "estou dentro de uma janela?".
const JANELAS = [
  {
    chave: 'domingo-manha', rotulo: 'Domingo 09h54', diaSemana: 0, hora: 9, minuto: 54,
    maxTentativas: 36, filtroHoras: 8, avisoAposMin: 9, fallbackGravacao: false,
  },
  {
    chave: 'domingo-noite', rotulo: 'Domingo 18h59', diaSemana: 0, hora: 18, minuto: 59,
    maxTentativas: 31, filtroHoras: 7, avisoAposMin: 4, fallbackGravacao: true,
  },
  {
    chave: 'quarta-noite', rotulo: 'Quarta 19h54', diaSemana: 3, hora: 19, minuto: 54,
    maxTentativas: 36, filtroHoras: 7, avisoAposMin: 9, fallbackGravacao: false,
  },
  {
    // Culto das 19h ainda em fase de teste na igreja, por isso avisoAposMin: null — sábado
    // sem transmissão é resultado esperado, não incidente para anunciar no grupo. A janela
    // abre 11 min antes do culto (as demais abrem de 1 a 6 min antes) porque o horário de
    // sábado ainda oscila; 41 tentativas fecham a janela às 19h30, como nas demais.
    chave: 'sabado-noite', rotulo: 'Sábado 18h49', diaSemana: 6, hora: 18, minuto: 49,
    maxTentativas: 41, filtroHoras: 7, avisoAposMin: null, fallbackGravacao: false,
  },
];

const inicioEmMinutos = (j) => j.hora * 60 + j.minuto;

/**
 * Dia da semana e minuto do dia no fuso da igreja, sem depender do TZ do processo.
 *
 * O cron recebe o fuso explicitamente, então ele acerta o horário mesmo se o TZ do container
 * mudar. A recuperação abaixo compara horários na mão e precisa da mesma garantia: ler a hora
 * local do processo faria a janela ser reconhecida com três horas de diferença num container
 * em UTC.
 */
function agoraNaIgreja(momento = new Date()) {
  // hourCycle h23 e não hour12:false: em algumas versões do ICU o segundo devolve "24" para
  // meia-noite, e o minuto do dia sairia um dia inteiro à frente.
  const partes = new Intl.DateTimeFormat('en-US', {
    timeZone: FUSO, weekday: 'short', hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  }).formatToParts(momento);
  const campo = (tipo) => partes.find(p => p.type === tipo)?.value;
  const dias = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };

  return {
    diaSemana: dias[campo('weekday')],
    minutosDoDia: Number(campo('hour')) * 60 + Number(campo('minute')),
  };
}

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
// saiba que a busca voltou vazia (a live pode ter atrasado, a transmissão pode não ter
// sido criada no canal, ou a quota da API pode ter esgotado). Na prática da igreja o
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

// Retorna uma Promise que resolve quando terminar: true se enviou, false se não encontrou, e
// null se esta janela já estava rodando — que NÃO é a mesma coisa que "não encontrou". Quem
// chama precisa da diferença: tratar as duas como false faria a segunda chamada desligar a
// máquina no meio da janela que a primeira ainda está trabalhando.
// Parâmetros em objeto de propósito: filtroHoras e avisoAposMin são dois números
// adjacentes que, trocados por engano, quebrariam a janela em silêncio.
//   avisoAposMin: minutos após o início do monitoramento para avisar o grupo que
//   o link atrasou. Enviado no máximo uma vez por janela; null desativa.
function monitorarAoVivo({ chave, maxTentativas, nomeGrupo, apiKey, channelId, filtroHoras = 8, avisoAposMin = null }) {
  if (tentativasAtivas[chave]) {
    console.log(`[Scheduler] Monitoramento ${chave} já está ativo, ignorando.`);
    return Promise.resolve(null);
  }
  tentativasAtivas[chave] = 0;
  console.log(`\n[Scheduler] ▶ Iniciando monitoramento: ${chave} (máx ${maxTentativas} tentativas)`);
  diagnostico.anotar(`janela ${chave}: início, até ${maxTentativas} tentativas, filtro ${filtroHoras}h, aviso ${avisoAposMin === null ? 'desligado' : `após ${avisoAposMin} min`}`);

  const inicio = Date.now();
  const prazoJanelaMs = (maxTentativas + FOLGA_JANELA_MIN) * INTERVALO_MIN * 60 * 1000;
  let avisoEnviado = false;

  return new Promise((resolve) => {
    async function tentar() {
      tentativasAtivas[chave]++;
      const n = tentativasAtivas[chave];

      if (!estaConectado()) {
        console.warn('[Scheduler] WhatsApp não conectado, aguardando...');
      } else {
        console.log(`[Scheduler] Tentativa ${n}/${maxTentativas}, buscando ao vivo...`);
        try {
          // O número da tentativa vai junto: as buscas caras do YouTube (search) só rodam a
          // cada CADENCIA_BUSCAS_CARAS tentativas, para o pior domingo caber na quota diária.
          const video = await buscarTransmissaoAoVivo(apiKey, channelId, filtroHoras, n);
          if (video) {
            await enviarMensagem(nomeGrupo, mensagemParaVideo(video));
            console.log(`[Scheduler] ✅ Link enviado (${video.fonte}): ${video.url}`);
            diagnostico.anotar(`janela ${chave}: link enviado na tentativa ${n} (${video.fonte}) ${video.url}`);
            delete tentativasAtivas[chave];
            resolve(true);
            return;
          }
        } catch (err) {
          console.error('[Scheduler] Erro:', err.message);
          // Vai para o volume: no stdout esta linha morre junto com a máquina, e ela é a
          // diferença entre "não achou o vídeo" e "achou e não conseguiu enviar".
          diagnostico.anotar(`janela ${chave}: tentativa ${n} falhou — ${err.message}`);
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
            diagnostico.anotar(`janela ${chave}: aviso de atraso enviado (${minutosSemLink.toFixed(1)} min sem link)`);
          } catch (err) {
            console.error('[Scheduler] Falha ao enviar aviso de atraso:', err.message);
            diagnostico.anotar(`janela ${chave}: aviso de atraso FALHOU — ${err.message}`);
          }
        }
      }

      // O teto de relógio é a rede sobre o contador. Com tentativas mais lentas que o
      // intervalo, contar até maxTentativas deixaria a janela passar do horário de encerrar,
      // e o socket segue aberto enquanto a janela existir.
      const estourouORelogio = Date.now() - inicio >= prazoJanelaMs;
      if (n >= maxTentativas || estourouORelogio) {
        const motivo = estourouORelogio ? `${Math.round((Date.now() - inicio) / 60000)} min de janela` : `${maxTentativas} tentativas`;
        console.error(`[Scheduler] 🚨 ALERTA: Nenhuma transmissão encontrada em ${chave} após ${motivo}. NENHUM LINK FOI ENVIADO AO GRUPO.`);
        diagnostico.anotar(`janela ${chave}: encerrada sem link após ${motivo}`);
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
      diagnostico.anotar(`gravação enviada como fallback: ${video.url}`);
    } else {
      console.warn('[Scheduler] ⚠️  Nenhuma gravação encontrada.');
      diagnostico.anotar('fallback de gravação: nenhuma gravação recente encontrada');
    }
  } catch (err) {
    console.error('[Scheduler] Erro ao enviar gravação:', err.message);
    diagnostico.anotar(`fallback de gravação falhou — ${err.message}`);
  }
}

/**
 * Roda uma janela de ponta a ponta e desliga a máquina no fim.
 *
 * `atrasoMin` é quanto da janela já passou quando ela começa, e só é diferente de zero na
 * recuperação da subida (ver iniciarAgendamentos). Ele encurta as tentativas para o
 * desligamento acontecer no mesmo horário de sempre, e adianta o aviso de atraso: se o culto
 * já começou faz seis minutos e ainda não há link, não faz sentido esperar mais quatro para
 * avisar o grupo.
 */
async function executarJanela(janela, config, atrasoMin = 0) {
  const { apiKey, channelId, nomeGrupo } = config;
  const tentativas = janela.maxTentativas - atrasoMin;

  if (tentativas < 1) {
    console.warn(`[Scheduler] Janela ${janela.chave} já teria terminado (${atrasoMin} min de atraso). Nada a fazer.`);
    diagnostico.anotar(`janela ${janela.chave}: descartada, ${atrasoMin} min de atraso passam do fim da janela`);
    await desligar(`Janela ${janela.chave} já encerrada quando a máquina subiu.`);
    return;
  }

  try {
    const enviou = await monitorarAoVivo({
      chave: janela.chave,
      maxTentativas: tentativas,
      nomeGrupo, apiKey, channelId,
      filtroHoras: janela.filtroHoras,
      avisoAposMin: janela.avisoAposMin === null ? null : Math.max(0, janela.avisoAposMin - atrasoMin),
    });

    // null é "esta janela já estava rodando". Quem está trabalhando nela é que decide o
    // fallback e o desligamento; sair daqui sem tocar em nada é o comportamento certo.
    if (enviou === null) return;

    if (!enviou && janela.fallbackGravacao) {
      console.log('[Scheduler] Ao vivo não encontrado, tentando gravação recente...');
      await enviarGravacao(nomeGrupo, apiKey, channelId);
    }
  } catch (err) {
    // Nada aqui dentro deveria escapar, mas uma exceção solta com o desligar embaixo do try
    // deixaria a máquina de pé até o teto de vida, com o socket segurando a sessão da conta.
    console.error(`[Scheduler] Erro inesperado na janela ${janela.chave}:`, err.message);
    diagnostico.anotar(`janela ${janela.chave}: erro inesperado — ${err.message}`);
  }

  await desligar(`Janela ${janela.chave} encerrada.`);
}

// Precisa ser async e ser aguardado: o encerrarSessao segura a conexão viva por um tempo
// para atender os pedidos de reenvio do WhatsApp. Matar o processo antes disso é o que
// deixava as pessoas com "Aguardando mensagem" na tela.
async function desligar(motivo) {
  console.log(`🛑 ${motivo}`);
  let resumo = null;
  try {
    resumo = await encerrarSessao();
  } catch (err) {
    console.error('[Scheduler] Erro ao encerrar a sessão do WhatsApp:', err.message);
  }
  console.log('Encerrando processo. A máquina será desligada pelo Fly.io.');
  // Código diferente de zero quando alguma gravação de estado de sinal falhou: o exit_code
  // aparece no histórico de eventos do `fly machine status`, então serve de alerta mesmo
  // depois que os logs somem.
  const codigo = resumo?.falhasDeGravacao > 0 ? 1 : 0;
  setTimeout(() => process.exit(codigo), 3000); // 3s para os logs fluírem
}

/**
 * Registra as janelas no cron e recupera a que já começou, se a máquina subiu atrasada.
 *
 * A recuperação existe porque o cron dispara em UM minuto do dia e não olha para trás: quem
 * sobe às 19h01 nunca vê o gatilho das 18h59, e o processo passa a noite inteira de pé sem
 * fazer nada — sem link, sem aviso, e com o socket do WhatsApp aberto segurando a sessão da
 * conta, que é o que emudece o celular do dono.
 *
 * A margem de um minuto é o que impede a recuperação de brigar com o cron: dentro do minuto
 * agendado quem manda é o cron, e a recuperação só entra quando ele já não pode mais disparar
 * hoje. O guarda de `tentativasAtivas` no monitorarAoVivo é a segunda linha de defesa.
 */
function iniciarAgendamentos(config) {
  for (const janela of JANELAS) {
    cron.schedule(
      `${janela.minuto} ${janela.hora} * * ${janela.diaSemana}`,
      () => executarJanela(janela, config),
      { timezone: FUSO }
    );
  }

  console.log(`📅 Agendamentos configurados (${FUSO}):`);
  for (const j of JANELAS) {
    const fim = inicioEmMinutos(j) + j.maxTentativas;
    const hhmm = (min) => `${String(Math.floor(min / 60)).padStart(2, '0')}h${String(min % 60).padStart(2, '0')}`;
    const aviso = j.avisoAposMin === null ? 'sem aviso de atraso' : `aviso de atraso após ${j.avisoAposMin} min`;
    console.log(`   • ${j.rotulo} → verifica a cada ${INTERVALO_MIN} min até ${hhmm(fim)} (${aviso})`);
  }
  console.log('   Qualquer transmissão ao vivo ou estreia do canal conta como culto (sem filtro de título).');

  const perdida = janelaPerdida();
  if (perdida) {
    console.warn(`[Scheduler] ⏱  A máquina subiu ${perdida.atrasoMin} min depois do início de ${perdida.janela.chave}; o cron de hoje já passou. Recuperando a janela agora.`);
    diagnostico.anotar(`janela ${perdida.janela.chave}: recuperada na subida, ${perdida.atrasoMin} min de atraso`);
    executarJanela(perdida.janela, config, perdida.atrasoMin);
  }
}

/**
 * A janela que já começou e cujo gatilho do cron não vai mais disparar hoje, se houver.
 *
 * O piso de 1 minuto é deliberado: dentro do minuto agendado o cron ainda dispara, e
 * recuperar ali daria duas execuções da mesma janela. Acima do minuto, o gatilho de hoje é
 * passado e ninguém mais vai chamá-la.
 */
function janelaPerdida(momento = new Date()) {
  const { diaSemana, minutosDoDia } = agoraNaIgreja(momento);

  for (const janela of JANELAS) {
    if (janela.diaSemana !== diaSemana) continue;
    const atrasoMin = minutosDoDia - inicioEmMinutos(janela);
    if (atrasoMin >= 1 && atrasoMin < janela.maxTentativas) return { janela, atrasoMin };
  }
  return null;
}

// monitorarAoVivo e mensagemAtraso são exportados para permitir testes automatizados
// (ver testes/simular-aviso.js), que rodam a função real com relógio simulado. JANELAS e
// agoraNaIgreja saem junto para o teste da recuperação de janela perdida.
module.exports = { iniciarAgendamentos, monitorarAoVivo, mensagemAtraso, JANELAS, janelaPerdida };
