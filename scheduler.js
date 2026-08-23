const cron = require('node-cron');
const fs = require('fs');
const path = require('path');
const { buscarTransmissaoAoVivo, buscarUltimaGravacao } = require('./youtube');
const { enviarMensagem, encerrarSessao, estaConectado, enviosConcluidosTardiamente } = require('./whatsapp');
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

// ── Memória de janela em disco ───────────────────────────────────────────────
// O processo morre e renasce por desenho: o desligar() ao fim da janela, o teto de vida de
// 90 min, e o systemd religando tudo com Restart=always. Nada que precise sobreviver a isso
// pode morar em variável — foi a lição do domingo 23/08, quando o link da manhã saiu TRÊS
// vezes: o exit do desligar (que no Fly deixava a máquina desligada, restart policy never)
// virou restart no systemd, e a recuperação de janela perdida, sem memória de "já enviei",
// reexecutava a janela com a live ainda no ar — envio, exit, restart, recuperação, envio.
//
// O arquivo registra o que cada ocorrência de janela (chave + dia no fuso da igreja) já fez:
// o link enviado, o aviso de atraso, a gravação do fallback e o encerramento sem link. A
// recuperação consulta antes de reexecutar, e o monitoramento consulta antes de enviar.
// Falha de leitura vale como "não enviado": na dúvida, é melhor arriscar um reenvio (o dano
// de 23/08) do que uma janela muda.
//
// Existe um arquivo RESERVA dentro do próprio AUTH_DIR. Quando um envio acabou de funcionar,
// aquele diretório comprovadamente aceita escrita (o estado de sinal do Baileys mora nele);
// já o diretório pai pode estar com permissão errada ou read-only sem que nada mais denuncie.
// Sem a reserva, uma falha de escrita repetida degenerava no pior loop possível: envio →
// exit → restart → recuperação sem memória → reenvio, uma dúzia de links até a janela
// expirar — o 23/08 em dobro. A leitura é a UNIÃO dos dois arquivos: marca em qualquer um
// deles vale.
const DIR_AUTH = process.env.AUTH_DIR || '.baileys_auth';
const ARQUIVO_JANELAS = path.join(path.dirname(DIR_AUTH), 'janelas-enviadas.json');
const ARQUIVO_JANELAS_RESERVA = path.join(DIR_AUTH, 'janelas-enviadas.json');

function diaNaIgreja(momento = new Date()) {
  // en-CA formata como YYYY-MM-DD. O dia precisa ser o da igreja, não o do relógio do
  // processo: perto da meia-noite UTC os dois divergem e a chave do registro mudaria de dia.
  return new Intl.DateTimeFormat('en-CA', { timeZone: FUSO, year: 'numeric', month: '2-digit', day: '2-digit' }).format(momento);
}

function lerArquivoDeJanelas(caminho) {
  try {
    return JSON.parse(fs.readFileSync(caminho, 'utf8'));
  } catch {
    return {}; // primeiro uso ou arquivo ilegível
  }
}

function lerJanelasMarcadas() {
  // A reserva entra por baixo e o principal ganha por chave. Para decidir "já enviei hoje?"
  // o que importa é a união: uma marca gravada só na reserva ainda é uma marca.
  return { ...lerArquivoDeJanelas(ARQUIVO_JANELAS_RESERVA), ...lerArquivoDeJanelas(ARQUIVO_JANELAS) };
}

// tmp + rename no mesmo diretório: ou o arquivo antigo continua íntegro, ou o novo aparece
// inteiro. O writeFileSync direto truncava o JSON quando o disco enchia no meio da escrita,
// e um arquivo truncado zera a memória INTEIRA — a leitura ilegível vale como "nunca enviei",
// que é a política certa para primeiro uso e a errada para corrupção.
function gravarAtomico(caminho, conteudo) {
  const tmp = `${caminho}.tmp`;
  fs.writeFileSync(tmp, conteudo);
  fs.renameSync(tmp, caminho);
}

// tipo: 'link' (o envio da janela), 'aviso' (o aviso de atraso), 'gravacao' (o fallback de
// gravação) ou 'encerrada' (a janela rodou até o fim sem link — não deve ser reaberta).
function marcarJanela(tipo, chave, extra = {}, momento = new Date()) {
  let conteudo;
  try {
    const todas = lerJanelasMarcadas();
    todas[`${tipo}:${chave}@${diaNaIgreja(momento)}`] = { em: new Date(momento).toISOString(), ...extra };
    // Poda: só o registro de hoje decide alguma coisa; uma semana ajuda diagnóstico sem o
    // arquivo crescer para sempre.
    const corte = Date.now() - 7 * 24 * 60 * 60 * 1000;
    for (const [k, v] of Object.entries(todas)) {
      if (new Date(v.em).getTime() < corte) delete todas[k];
    }
    conteudo = JSON.stringify(todas, null, 2);
  } catch (err) {
    console.warn(`[Scheduler] Não consegui montar o registro ${tipo} de ${chave}:`, err.message);
    return false;
  }

  try {
    gravarAtomico(ARQUIVO_JANELAS, conteudo);
    return true;
  } catch (err) {
    console.warn(`[Scheduler] Não consegui registrar ${tipo} de ${chave} em ${ARQUIVO_JANELAS}:`, err.message);
  }

  try {
    fs.mkdirSync(DIR_AUTH, { recursive: true });
    gravarAtomico(ARQUIVO_JANELAS_RESERVA, conteudo);
    diagnostico.anotar(`memória de janela: principal falhou, ${tipo}:${chave} gravado na reserva ${ARQUIVO_JANELAS_RESERVA}`);
    return true;
  } catch (err) {
    // Nunca pode derrubar o envio que acabou de acontecer. Mas precisa gritar: sem NENHUMA
    // gravação, o próximo restart reenvia — e sob Restart=always isso não é um reenvio, é
    // um por ciclo até a janela expirar.
    console.error(`[Scheduler] Memória de janela sem nenhuma gravação (${tipo} de ${chave}):`, err.message);
    diagnostico.anotar(`memória de janela: FALHOU nas duas gravações (${tipo}:${chave}) — risco de reenvio a cada restart até a janela expirar`);
    return false;
  }
}

function janelaMarcada(tipo, chave, momento = new Date()) {
  return Boolean(lerJanelasMarcadas()[`${tipo}:${chave}@${diaNaIgreja(momento)}`]);
}

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

  // A memória em disco, não a de processo: se o link desta janela já saiu hoje — por este
  // processo ou por um antecessor que morreu no meio —, não há mais nada a fazer. O null
  // segue o mesmo contrato do guarda acima: quem chama não desliga nem aciona fallback.
  if (janelaMarcada('link', chave)) {
    console.log(`[Scheduler] Janela ${chave} já enviou o link hoje (registro em disco). Nada a fazer.`);
    diagnostico.anotar(`janela ${chave}: ignorada, link de hoje já registrado em disco`);
    return Promise.resolve(null);
  }
  // Janela que já rodou até o fim hoje também não reabre. O janelaPerdida é quem impede isso
  // no caminho normal; este guarda é a segunda defesa, e devolve null pelo mesmo contrato —
  // em especial para o fallback de gravação não rodar uma segunda vez.
  if (janelaMarcada('encerrada', chave)) {
    console.log(`[Scheduler] Janela ${chave} já foi executada até o fim hoje (registro em disco). Nada a fazer.`);
    diagnostico.anotar(`janela ${chave}: ignorada, já encerrada hoje segundo o registro em disco`);
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

      // Envio que estourou o prazo mas completou depois: a mensagem JÁ está no grupo. O
      // comPrazo do enviarMensagem não cancela o envio de baixo, então a tentativa anterior
      // pode ter "falhado" com o link a caminho — reenviar aqui era o único jeito de duplicar
      // sem nenhum restart. O registro do whatsapp.js é evidência concreta (o envio tardio
      // devolveu id); um envio que travou de verdade nunca resolve e não gera registro, e aí
      // o reenvio continua acontecendo, que é o lado escolhido do risco.
      for (const tardio of enviosConcluidosTardiamente(nomeGrupo, inicio)) {
        if (tardio.texto === mensagemAtraso()) {
          if (!avisoEnviado && !janelaMarcada('aviso', chave)) {
            avisoEnviado = true;
            marcarJanela('aviso', chave, { tardio: true, id: tardio.id });
            diagnostico.anotar(`janela ${chave}: aviso de atraso completou num envio tardio (id ${tardio.id}); não será repetido`);
          }
        } else {
          marcarJanela('link', chave, { tardio: true, id: tardio.id });
          console.log(`[Scheduler] ✅ O link já tinha saído num envio tardio (id ${tardio.id}); nada a reenviar.`);
          diagnostico.anotar(`janela ${chave}: link completou num envio tardio (id ${tardio.id}); janela encerrada sem reenvio`);
          delete tentativasAtivas[chave];
          resolve(true);
          return;
        }
      }

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
            // O registro em disco vem logo após o envio: é ele que impede o sucessor deste
            // processo (restart do systemd após o desligar, ou após o teto de vida) de
            // enviar o mesmo link de novo pela recuperação de janela perdida.
            marcarJanela('link', chave, { url: video.url, fonte: video.fonte, tentativa: n });
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
        // O janelaMarcada cobre o processo renascido: sem ele, um restart no meio da janela
        // (teto de vida) perdia o avisoEnviado da memória e o grupo recebia o aviso duas
        // vezes. O avisoEnviado continua existindo para poupar a leitura de disco por
        // tentativa depois que o aviso sai.
        if (avisoAposMin !== null && !avisoEnviado && minutosSemLink >= avisoAposMin && !janelaMarcada('aviso', chave)) {
          try {
            await enviarMensagem(nomeGrupo, mensagemAtraso());
            avisoEnviado = true;
            marcarJanela('aviso', chave);
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
        // A janela rodou até o fim: registra para nenhum restart reabri-la. Sem isto, uma
        // morte abrupta logo após o fallback de gravação reabria a janela pela recuperação
        // (o 'link' nunca foi marcado) e a gravação saía duas vezes.
        marcarJanela('encerrada', chave, { motivo });
        delete tentativasAtivas[chave];
        resolve(false);
        return;
      }

      setTimeout(tentar, INTERVALO_MIN * 60 * 1000);
    }

    tentar();
  });
}

async function enviarGravacao(chave, nomeGrupo, apiKey, channelId) {
  console.log('\n[Scheduler] ▶ Buscando gravação recente do culto...');

  // A gravação tem a mesma memória em disco do link. Sem ela, um restart abrupto logo após o
  // envio reabria a janela pela recuperação (o 'link' nunca foi marcado numa janela sem live)
  // e o fallback mandava a mesma gravação de novo.
  if (janelaMarcada('gravacao', chave)) {
    console.log(`[Scheduler] Gravação de ${chave} já enviada hoje (registro em disco). Nada a fazer.`);
    diagnostico.anotar(`fallback de gravação: ignorado, gravação de hoje já registrada em disco (${chave})`);
    return;
  }

  if (!estaConectado()) {
    console.warn('[Scheduler] WhatsApp não conectado.');
    return;
  }

  try {
    const video = await buscarUltimaGravacao(apiKey, channelId);
    if (video) {
      await enviarMensagem(nomeGrupo, mensagemGravacao(video.titulo, video.url));
      marcarJanela('gravacao', chave, { url: video.url });
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
      await enviarGravacao(janela.chave, nomeGrupo, apiKey, channelId);
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
  // Na VM o systemd religa o processo em seguida (Restart=always) — e pode religar: a
  // memória de janela em disco garante que o sucessor não reenvia nada.
  console.log('Encerrando processo. O systemd religa em seguida; o registro em disco impede reenvio.');
  // Código diferente de zero quando alguma gravação de estado de sinal falhou: o exit code
  // aparece na linha de saída do serviço no `journalctl -u culto-bot` e no
  // `systemctl status culto-bot`, então serve de alerta sem depender do log do bot.
  const codigo = resumo?.falhasDeGravacao > 0 ? 1 : 0;
  setTimeout(() => process.exit(codigo), 3000); // 3s para os logs fluírem
}

/**
 * Registra as janelas no cron e recupera a que já começou, se a máquina subiu atrasada.
 *
 * A recuperação existe porque o cron dispara em UM segundo do dia e não olha para trás: o
 * node-cron transforma o padrão de 5 campos em "segundo 0 do minuto agendado", então quem
 * sobe às 19h01 — ou às 18h59m08s — nunca vê o gatilho das 18h59, e o processo passa a noite
 * inteira de pé sem fazer nada: sem link, sem aviso, e com o socket do WhatsApp aberto
 * segurando a sessão da conta, que é o que emudece o celular do dono.
 *
 * A recuperação NÃO briga com o cron: os dois vivem no mesmo processo, e o guarda síncrono de
 * `tentativasAtivas` no monitorarAoVivo (incrementado antes de qualquer await) faz a segunda
 * entrada receber null e sair sem tocar em nada. O janelaMarcada em disco é a terceira defesa.
 */
function iniciarAgendamentos(config) {
  for (const janela of JANELAS) {
    cron.schedule(
      `${janela.minuto} ${janela.hora} * * ${janela.diaSemana}`,
      () => executarJanela(janela, config),
      // recoverMissedExecutions: o node-cron checa o relógio num tick de ~1s; um tick que
      // pule o segundo 0 (pausa de GC, CPU da e2-micro estrangulada, drift do setTimeout)
      // perdia o gatilho com o processo VIVO, e nada mais chamava a janela — a recuperação
      // da subida só roda no boot. Com a opção ligada, o tick seguinte reconstrói o segundo
      // pulado. Disparo em dobro não acontece: o lastExecution do node-cron impede o mesmo
      // segundo duas vezes, e os guardas do monitorarAoVivo seguram o resto.
      { timezone: FUSO, recoverMissedExecutions: true }
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
 * O piso é atraso ZERO, e isso é deliberado. O node-cron só dispara no segundo 0 do minuto
 * agendado; um processo que renasce DENTRO do minuto do gatilho (o teto de vida ou o fim de
 * uma janela derrubando o processo às 9h53m5x, systemd religando ~12s depois) sobe com o
 * segundo 0 já passado — o cron de hoje nunca mais dispara, e um piso de 1 minuto deixava a
 * janela morrer inteira nessa zona morta de ~59s, sem link e sem aviso, com o log parecendo
 * saudável. Recuperar com atraso 0 não duplica nada: no caso raríssimo de o boot cair no
 * próprio segundo 0 e o cron também disparar, os dois vivem no mesmo processo e o guarda
 * síncrono de tentativasAtivas faz o segundo receber null.
 */
function janelaPerdida(momento = new Date()) {
  const { diaSemana, minutosDoDia } = agoraNaIgreja(momento);

  for (const janela of JANELAS) {
    if (janela.diaSemana !== diaSemana) continue;
    // Janela cujo link já saiu hoje não é "perdida" — está concluída. Sem esta linha, o
    // restart que o systemd faz após o desligar() reentrava aqui com a live ainda no ar e
    // reenviava o link (o triplo envio de 23/08). O guarda dentro do monitorarAoVivo é a
    // segunda defesa; este é o que impede até de reabrir a janela.
    if (janelaMarcada('link', janela.chave, momento)) continue;
    // Janela que rodou até o fim sem link também está concluída. Reabri-la não traria link
    // nenhum (as tentativas do dia já se esgotaram) e podia duplicar a gravação do fallback.
    if (janelaMarcada('encerrada', janela.chave, momento)) continue;
    const atrasoMin = minutosDoDia - inicioEmMinutos(janela);
    if (atrasoMin >= 0 && atrasoMin < janela.maxTentativas) return { janela, atrasoMin };
  }
  return null;
}

// monitorarAoVivo e mensagemAtraso são exportados para permitir testes automatizados
// (ver testes/simular-aviso.js), que rodam a função real com relógio simulado. JANELAS e
// agoraNaIgreja saem junto para o teste da recuperação de janela perdida; marcarJanela e
// janelaMarcada, para os testes da memória de janela em disco; enviarGravacao, para o teste
// de que a gravação do fallback não sai duas vezes.
module.exports = { iniciarAgendamentos, monitorarAoVivo, mensagemAtraso, JANELAS, janelaPerdida, marcarJanela, janelaMarcada, enviarGravacao };
