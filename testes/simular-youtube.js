/**
 * Escolha do vídeo da janela (youtube.js) e recuperação de janela perdida (scheduler.js).
 *
 * Por que existe: no domingo 16/08 a estreia das 19h tinha sido publicada de manhã. O filtro
 * da noite só aceitava upload das últimas 7h, o culto ficou invisível para o bot a janela
 * inteira e nenhum link foi enviado. As três vezes anteriores em que isso aconteceu, a
 * resposta foi esticar o filtro de horas — o que só troca de erro, porque esticar até pegar a
 * estreia publicada de manhã é esticar até pegar o culto DA MANHÃ à noite.
 *
 * Os cenários abaixo rodam a função real de escolha, sem rede, com os dois cultos do mesmo
 * domingo na playlist. É o caso que qualquer ajuste de horas erra e que o horário marcado
 * acerta.
 *
 * Uso: node testes/simular-youtube.js
 */

const path = require('path');
const fs = require('fs');
const os = require('os');

// A memória de janela em disco (janelas-enviadas.json) mora ao lado do AUTH_DIR; sem isto o
// teste escreveria o arquivo na raiz do repositório. Precisa vir ANTES do require do scheduler.
process.env.AUTH_DIR = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'culto-youtube-')), 'baileys_auth');

const cron = require('node-cron');
const { escolherPorHorario } = require('../youtube');
const { JANELAS, janelaPerdida, marcarJanela, janelaVigente, validarJanela, validarTabela, expressaoCron } = require('../scheduler');

let falhas = 0;
function checar(descricao, condicao, detalhe = '') {
  console.log(`${condicao ? '  ✅' : '  ❌'} ${descricao}${detalhe ? ` ${detalhe}` : ''}`);
  if (!condicao) falhas++;
}

const janelaPor = (chave) => JANELAS.find(j => j.chave === chave);

// ── Cenário base: o domingo 16/08 ────────────────────────────────────────────
// Os dois vídeos foram publicados de manhã (a igreja sobe os arquivos juntos) e estreiam em
// horários diferentes. Só o horário marcado distingue um do outro.
const MANHA = '2026-08-16T13:00:00.000Z';  // 10h00 BRT
const NOITE = '2026-08-16T22:00:00.000Z';  // 19h00 BRT
const UPLOAD_DA_MANHA = '2026-08-16T11:30:00.000Z'; // 08h30 BRT, os dois arquivos

const candidatos = [
  { id: 'noite1', titulo: 'Culto de Fé', publicadoEm: UPLOAD_DA_MANHA },
  { id: 'manha1', titulo: 'Culto da Família', publicadoEm: UPLOAD_DA_MANHA },
];

// Estreia: duração real do arquivo, mesmo antes de ir ao ar.
const detalhesEstreias = new Map([
  ['noite1', { id: 'noite1', contentDetails: { duration: 'PT1H30M' }, liveStreamingDetails: { scheduledStartTime: NOITE } }],
  ['manha1', { id: 'manha1', contentDetails: { duration: 'PT1H20M' }, liveStreamingDetails: { scheduledStartTime: MANHA } }],
]);

// Congela o relógio num instante, roda a escolha real e devolve o resultado.
function escolherEm(instanteISO, chaveDaJanela, entrada = candidatos, detalhes = detalhesEstreias) {
  const real = Date.now;
  Date.now = () => new Date(instanteISO).getTime();
  try {
    return escolherPorHorario(entrada, detalhes, janelaPor(chaveDaJanela).filtroHoras);
  } finally {
    Date.now = real;
  }
}

// Congela o relógio também para GRAVAR a memória de janela. A poda do marcarJanela apaga
// registro com mais de 7 dias contados do relógio REAL, e os cenários usam datas históricas
// fixas: com o relógio solto, a marca recém-gravada já nascia "velha" e era podada na mesma
// chamada — o teste passava até 7 dias depois da data ancorada e depois quebrava sozinho.
function marcarEm(instanteISO, tipo, chave, extra = {}) {
  const real = Date.now;
  Date.now = () => new Date(instanteISO).getTime();
  try {
    marcarJanela(tipo, chave, extra, new Date(instanteISO));
  } finally {
    Date.now = real;
  }
}

function main() {
  console.log('\n═══ Escolha do vídeo da janela ═══\n');

  // 1: o bug do domingo 16/08, na janela em que ele apareceu
  {
    console.log('▶ domingo-noite às 18h53: estreia das 19h publicada de manhã (o caso de 16/08)');
    const r = escolherEm('2026-08-16T21:53:00.000Z', 'domingo-noite');

    checar('achou um vídeo', !!r, r ? `→ ${r.id}` : '→ nenhum');
    checar('escolheu a estreia da NOITE', r?.id === 'noite1', `→ ${r?.id}`);
    checar('classificou como estreia', r?.fonte === 'estreia', `→ ${r?.fonte}`);
    console.log('');
  }

  // 2: a mesma playlist de manhã não pode mandar o link da noite
  {
    console.log('▶ domingo-manha às 09h53: a estreia da noite já está agendada no canal');
    const r = escolherEm('2026-08-16T12:53:00.000Z', 'domingo-manha');

    checar('escolheu a estreia da MANHÃ', r?.id === 'manha1', `→ ${r?.id}`);
    console.log('');
  }

  // 3: à noite, o culto da manhã não pode ser reenviado
  {
    console.log('▶ domingo-noite às 19h20: só o culto da manhã existe na playlist');
    const soManha = [candidatos[1]];
    const r = escolherEm('2026-08-16T22:20:00.000Z', 'domingo-noite', soManha);

    checar('não enviou nada', r === null, `→ ${r?.id || 'nenhum'}`);
    console.log('');
  }

  // 4: live de verdade continua sendo live (P0D = duração indefinida)
  {
    console.log('▶ transmissão ao vivo em andamento: duração P0D vira fonte "live"');
    const aoVivo = new Map([
      ['noite1', {
        id: 'noite1',
        contentDetails: { duration: 'P0D' },
        liveStreamingDetails: { scheduledStartTime: NOITE, actualStartTime: NOITE },
      }],
    ]);
    const r = escolherEm('2026-08-16T22:05:00.000Z', 'domingo-noite', [candidatos[0]], aoVivo);

    checar('classificou como live', r?.fonte === 'live', `→ ${r?.fonte}`);
    console.log('');
  }

  // 5: sem detalhes (videos.list falhou), a tentativa é descartada
  {
    console.log('▶ videos.list indisponível: tentativa descartada (sem degradar para a hora do upload)');
    // A degradação antiga era protegida pelo filtro de título, que não existe mais: sem os
    // detalhes não há como distinguir o culto de um clipe recém-postado. Melhor perder um
    // minuto (a próxima tentativa refaz a chamada) do que mandar o vídeo errado ao grupo.
    // O publicadoEm recente é deliberado: a regra velha o aceitaria, então reintroduzir a
    // degradação para hora de upload faz este cenário quebrar.
    const publicadoAgora = [{ id: 'x', titulo: 'Culto de Fé', publicadoEm: '2026-08-16T21:40:00.000Z' }];
    const r = escolherEm('2026-08-16T21:59:00.000Z', 'domingo-noite', publicadoAgora, null);

    checar('não enviou nada', r === null, `→ ${r?.id || 'nenhum'}`);
    console.log('');
  }

  // 6: vídeo de um culto que já acabou faz tempo não volta a ser enviado
  {
    console.log('▶ culto da semana passada na playlist: fora da janela');
    const semanaPassada = [{ id: 'v', titulo: 'Culto da Família', publicadoEm: '2026-08-09T11:30:00.000Z' }];
    const detalhes = new Map([['v', {
      id: 'v',
      contentDetails: { duration: 'PT1H' },
      liveStreamingDetails: { scheduledStartTime: '2026-08-09T22:00:00.000Z' },
    }]]);
    const r = escolherEm('2026-08-16T21:59:00.000Z', 'domingo-noite', semanaPassada, detalhes);

    checar('não enviou nada', r === null, `→ ${r?.id || 'nenhum'}`);
    console.log('');
  }

  // 7: rascunho de transmissão sem data (o caso real de sábado 22/08)
  {
    console.log('▶ rascunho de transmissão sem data no canal: rejeitado mesmo recém-criado');
    // Visto no canal em 22/08: a equipe criou a "sala de espera" de uma transmissão sem
    // agendar horário. O vídeo tem P0D (parece live) e publishedAt recente, mas
    // liveStreamingDetails vem sem horário nenhum. Sem filtro de título, a ausência de
    // horário marcado é a única coisa que o segura. O publicadoEm recente (dentro do piso de
    // upload da regra velha) é deliberado: se alguém reintroduzir a degradação para hora de
    // upload, este cenário quebra.
    const rascunho = [{ id: 'r', titulo: 'Culto de Fé| 19/08 | 20h', publicadoEm: '2026-08-22T21:30:00.000Z' }];
    const detalhes = new Map([['r', {
      id: 'r',
      contentDetails: { duration: 'P0D' },
      liveStreamingDetails: {}, // só activeLiveChatId na vida real; nenhum horário
    }]]);
    const r = escolherEm('2026-08-22T22:00:00.000Z', 'sabado-noite', rascunho, detalhes);

    checar('não enviou nada', r === null, `→ ${r?.id || 'nenhum'}`);
    console.log('');
  }

  // 8: upload comum recente (clipe, aviso) não é transmissão
  {
    console.log('▶ upload comum publicado no meio da janela: rejeitado');
    // Sem o filtro de título, um clipe postado às 18h30 de sábado estaria "recente" para
    // qualquer regra de upload. Ele não tem liveStreamingDetails, e é isso que o barra.
    const clipe = [{ id: 'c', titulo: 'Melhores momentos da semana', publicadoEm: '2026-08-22T21:30:00.000Z' }];
    const detalhes = new Map([['c', {
      id: 'c',
      contentDetails: { duration: 'PT2M30S' },
      // upload comum: sem liveStreamingDetails
    }]]);
    const r = escolherEm('2026-08-22T22:00:00.000Z', 'sabado-noite', clipe, detalhes);

    checar('não enviou nada', r === null, `→ ${r?.id || 'nenhum'}`);
    console.log('');
  }

  // 9: sem filtro de título, um culto com nome fora do padrão é aceito
  {
    console.log('▶ live com título fora do padrão antigo: aceita pelo horário');
    const titulo = [{ id: 't', titulo: 'Noite de Adoração e Louvor', publicadoEm: '2026-08-22T20:00:00.000Z' }];
    const detalhes = new Map([['t', {
      id: 't',
      contentDetails: { duration: 'P0D' },
      liveStreamingDetails: { scheduledStartTime: '2026-08-22T22:00:00.000Z', actualStartTime: '2026-08-22T22:01:00.000Z' },
    }]]);
    const r = escolherEm('2026-08-22T22:05:00.000Z', 'sabado-noite', titulo, detalhes);

    checar('achou o vídeo', r?.id === 't', `→ ${r?.id || 'nenhum'}`);
    checar('classificou como live', r?.fonte === 'live', `→ ${r?.fonte}`);
    console.log('');
  }

  // 10: transmissão já encerrada nunca volta a ser enviada
  {
    console.log('▶ transmissão encerrada (actualEndTime): rejeitada mesmo dentro do piso de horas');
    // O search live sabe devolver transmissão recém-encerrada (índice defasado), e um evento
    // da tarde (casamento, ensaio) encerrado às 17h caberia no piso de 7h da janela da
    // noite. Encerrada é papel do fallback de gravação, nunca daqui.
    const evento = [{ id: 'e', titulo: 'Casamento na igreja' }];
    const detalhes = new Map([['e', {
      id: 'e',
      contentDetails: { duration: 'PT2H' },
      liveStreamingDetails: {
        scheduledStartTime: '2026-08-22T18:00:00.000Z',
        actualStartTime: '2026-08-22T18:02:00.000Z',  // 15h02 BRT
        actualEndTime: '2026-08-22T20:00:00.000Z',    // 17h00 BRT
      },
    }]]);
    const r = escolherEm('2026-08-22T22:00:00.000Z', 'sabado-noite', evento, detalhes);

    checar('não enviou nada', r === null, `→ ${r?.id || 'nenhum'}`);
    console.log('');
  }

  // 11: broadcast agendado e abandonado não é o culto
  {
    console.log('▶ agendado para as 14h e nunca iniciado: rejeitado às 18h53');
    // O "upcoming" da API guarda para sempre broadcasts agendados que nunca foram ao ar.
    // Sem início real, a régua é a tolerância de atraso (60 min), não o piso de filtroHoras —
    // senão o agendamento morto da tarde caberia na janela da noite.
    const abandonado = [{ id: 'a', titulo: 'Transmissão da tarde' }];
    const detalhes = new Map([['a', {
      id: 'a',
      contentDetails: { duration: 'P0D' },
      liveStreamingDetails: { scheduledStartTime: '2026-08-22T17:00:00.000Z' }, // 14h00 BRT
    }]]);
    const r = escolherEm('2026-08-22T21:53:00.000Z', 'sabado-noite', abandonado, detalhes);

    checar('não enviou nada', r === null, `→ ${r?.id || 'nenhum'}`);
    console.log('');
  }

  // 12: culto atrasado continua valendo
  {
    console.log('▶ agendado para as 19h, ainda sem início às 19h25: aceito (culto atrasado)');
    const atrasado = [{ id: 'd', titulo: 'Culto de Sábado' }];
    const detalhes = new Map([['d', {
      id: 'd',
      contentDetails: { duration: 'P0D' },
      liveStreamingDetails: { scheduledStartTime: '2026-08-22T22:00:00.000Z' }, // 19h00 BRT
    }]]);
    const r = escolherEm('2026-08-22T22:25:00.000Z', 'sabado-noite', atrasado, detalhes);

    checar('achou o vídeo', r?.id === 'd', `→ ${r?.id || 'nenhum'}`);
    console.log('');
  }

  console.log('═══ Janela de sábado (culto em teste) ═══\n');

  // 13: a configuração da janela nova
  {
    console.log('▶ sábado 18h53 existe na tabela, sem aviso de atraso');
    const sabado = janelaPor('sabado-noite');

    checar('janela registrada', !!sabado);
    checar('começa sábado às 18h53', sabado?.diaSemana === 6 && sabado?.hora === 18 && sabado?.minuto === 53);
    checar('37 tentativas (até 19h30)', sabado?.maxTentativas === 37, `→ ${sabado?.maxTentativas}`);
    checar('filtro de 7h, como as outras janelas da noite', sabado?.filtroHoras === 7, `→ ${sabado?.filtroHoras}`);
    checar('aviso de atraso desligado (culto em teste)', sabado?.avisoAposMin === null, `→ ${sabado?.avisoAposMin}`);
    checar('sem fallback de gravação', sabado?.fallbackGravacao === false);
    console.log('');
  }

  console.log('═══ Recuperação de janela perdida ═══\n');

  // 14: a máquina sobe DEPOIS do minuto do cron
  {
    console.log('▶ máquina sobe às 19h05 de domingo: o gatilho das 18h53 já passou');
    // 19h05 BRT = 22h05 UTC
    const r = janelaPerdida(new Date('2026-08-16T22:05:00.000Z'));

    checar('reconheceu a janela da noite', r?.janela.chave === 'domingo-noite', `→ ${r?.janela.chave}`);
    checar('com o atraso certo', r?.atrasoMin === 12, `→ ${r?.atrasoMin} min`);
    console.log('');
  }

  // 15: subida normal, alguns minutos ANTES — o cron ainda vai disparar
  {
    console.log('▶ máquina sobe às 18h50 de domingo: o cron das 18h53 ainda vai disparar');
    const r = janelaPerdida(new Date('2026-08-16T21:50:00.000Z'));

    checar('não recupera nada (evita janela dupla)', r === null, `→ ${r?.janela.chave || 'nenhuma'}`);
    console.log('');
  }

  // 16: dentro do próprio minuto do gatilho, o segundo 0 já passou — a zona morta
  {
    console.log('▶ máquina sobe às 18h53m30s de domingo, dentro do minuto do gatilho');
    // O node-cron só dispara no segundo 0 do minuto agendado; um boot no segundo 30 nunca
    // vê o gatilho de hoje. O piso antigo de 1 minuto ("deixa o cron trabalhar") transformava
    // esses ~59s numa zona morta que matava a janela inteira em silêncio — bastava o teto de
    // vida derrubar o processo às 18h52m5x. A corrida rara do boot no próprio segundo 0 é
    // absorvida pelo guarda síncrono de tentativasAtivas: a segunda entrada recebe null.
    const r = janelaPerdida(new Date('2026-08-16T21:53:30.000Z'));

    checar('recupera a janela na zona morta do minuto do gatilho', r?.janela.chave === 'domingo-noite', `→ ${r?.janela.chave || 'nenhuma'}`);
    checar('com atraso zero', r?.atrasoMin === 0, `→ ${r?.atrasoMin} min`);
    console.log('');
  }

  // 17: tarde demais, a janela já teria terminado
  {
    console.log('▶ máquina sobe às 20h00 de domingo: a janela da noite já acabou');
    const r = janelaPerdida(new Date('2026-08-16T23:00:00.000Z'));

    checar('não recupera nada', r === null, `→ ${r?.janela.chave || 'nenhuma'}`);
    console.log('');
  }

  // 18: dia sem culto
  {
    console.log('▶ máquina sobe numa segunda-feira');
    const r = janelaPerdida(new Date('2026-08-17T22:05:00.000Z'));

    checar('não recupera nada', r === null, `→ ${r?.janela.chave || 'nenhuma'}`);
    console.log('');
  }

  // 19: a janela nova de sábado também é recuperada
  {
    console.log('▶ máquina sobe às 19h00 de sábado: o gatilho das 18h53 já passou');
    // 19h00 BRT = 22h00 UTC; 22/08/2026 é sábado
    const r = janelaPerdida(new Date('2026-08-22T22:00:00.000Z'));

    checar('reconheceu a janela de sábado', r?.janela.chave === 'sabado-noite', `→ ${r?.janela.chave || 'nenhuma'}`);
    checar('com o atraso certo', r?.atrasoMin === 7, `→ ${r?.atrasoMin} min`);
    console.log('');
  }

  // 20: janela cujo link já saiu hoje não volta como "perdida"
  {
    console.log('▶ link do dia já registrado em disco: a recuperação não reabre a janela');
    // O triplo envio de 23/08 por inteiro: envia → desligar() → exit → systemd religa → a
    // recuperação reentrava aqui com a live ainda no ar e enviava de novo. O registro em
    // disco é o que corta o ciclo — o cenário 14 acima é o mesmo instante SEM o registro.
    marcarEm('2026-08-16T22:05:00.000Z', 'link', 'domingo-noite', { url: 'https://y/x' });
    const r = janelaPerdida(new Date('2026-08-16T22:05:00.000Z'));

    checar('não recupera a janela já enviada', r?.janela?.chave !== 'domingo-noite', `→ ${r?.janela?.chave || 'nenhuma'}`);
    console.log('');
  }

  // 21: janela que rodou até o fim sem link também não volta como "perdida"
  {
    console.log('▶ janela do dia já encerrada sem link: a recuperação não a reabre');
    // Sem isto, um restart abrupto logo após o fallback de gravação reabria a janela (o
    // 'link' nunca foi marcado numa janela sem live) e a gravação saía uma segunda vez.
    marcarEm('2026-08-19T23:10:00.000Z', 'encerrada', 'quarta-noite');
    const r = janelaPerdida(new Date('2026-08-19T23:10:00.000Z')); // quarta 20h10 BRT, atraso 17

    checar('não recupera a janela encerrada', r === null, `→ ${r?.janela?.chave || 'nenhuma'}`);
    console.log('');
  }

  console.log('═══ Janela com vigência ═══\n');
  // Setembro de 2026: 14 é segunda, 16 quarta, 18 sexta, 19 sábado, 21 a segunda seguinte.
  // O Brasil não tem horário de verão desde 2019: 06h30 BRT = 09h30 UTC o ano inteiro.
  //
  // O MECANISMO (vigência, lista de dias, validação) é testado com uma janela própria, a
  // FIXTURE abaixo, somada às janelas fixas da tabela. Assim a entrada temporária
  // 'semana-manha' pode ser removida depois de 18/09 sem derrubar a suíte — só o cenário 22,
  // que confere aquela configuração específica, sai junto com ela (e diz isso em vez de falhar).
  const FIXTURE = {
    chave: 'fixture-semana', rotulo: 'Fixture seg a sex 06h25', diaSemana: [1, 2, 3, 4, 5],
    hora: 6, minuto: 25, maxTentativas: 35, filtroHoras: 7, avisoAposMin: null, fallbackGravacao: false,
    vigencia: { de: '2026-09-14', ate: '2026-09-18' },
  };
  const FIXAS = JANELAS.filter(j => !j.vigencia);
  const TABELA = [...FIXAS, FIXTURE];
  const perdidaEm = (iso) => janelaPerdida(new Date(iso), TABELA);

  // 22: a configuração da janela especial de 14 a 18/09/2026, enquanto ela existir na tabela
  {
    const j = janelaPor('semana-manha');
    if (!j) {
      console.log('▶ semana-manha não está mais na tabela (removida após a vigência): cenário pulado\n');
    } else {
      console.log('▶ semana-manha existe na tabela: seg a sex 06h25, 14 a 18/09/2026, sem aviso');
      checar('segunda a sexta', JSON.stringify(j.diaSemana) === '[1,2,3,4,5]', `→ ${JSON.stringify(j.diaSemana)}`);
      checar('abre às 06h25', j.hora === 6 && j.minuto === 25, `→ ${j.hora}h${j.minuto}`);
      checar('35 tentativas (até 07h00, 30 min depois do culto das 06h30)', j.maxTentativas === 35, `→ ${j.maxTentativas}`);
      checar('aviso de atraso desligado', j.avisoAposMin === null, `→ ${j.avisoAposMin}`);
      checar('sem fallback de gravação', j.fallbackGravacao === false);
      checar('vigência de 14 a 18/09/2026', j.vigencia?.de === '2026-09-14' && j.vigencia?.ate === '2026-09-18', `→ ${JSON.stringify(j.vigencia)}`);
      console.log('');
    }
  }

  // 23: a expressão de cron de cada janela é aceita pelo próprio node-cron
  {
    console.log('▶ o node-cron aceita a expressão de todas as janelas (inclusive a lista de dias)');
    for (const j of TABELA) {
      checar(`${j.chave}: "${expressaoCron(j)}"`, cron.validate(expressaoCron(j)));
    }
    checar('a lista de dias vira "1,2,3,4,5"', expressaoCron(FIXTURE) === '25 6 * * 1,2,3,4,5');
    console.log('');
  }

  // 24: dentro da vigência, a recuperação reconhece a janela
  {
    console.log('▶ máquina sobe segunda 14/09 às 06h30: primeiro dia da vigência, o gatilho das 06h25 já passou');
    const r = perdidaEm('2026-09-14T09:30:00.000Z');

    checar('reconheceu a janela da semana', r?.janela.chave === 'fixture-semana', `→ ${r?.janela?.chave || 'nenhuma'}`);
    checar('com o atraso certo', r?.atrasoMin === 5, `→ ${r?.atrasoMin} min`);
    console.log('');
  }

  // 25: o último dia da vigência é incluso
  {
    console.log('▶ sexta 18/09 às 06h40: último dia da vigência ainda vale');
    const r = perdidaEm('2026-09-18T09:40:00.000Z');

    checar('reconheceu a janela da semana', r?.janela.chave === 'fixture-semana', `→ ${r?.janela?.chave || 'nenhuma'}`);
    checar('com o atraso certo', r?.atrasoMin === 15, `→ ${r?.atrasoMin} min`);
    console.log('');
  }

  // 26: mesma hora, mesmo dia da semana, semana seguinte: a janela não existe
  {
    console.log('▶ segunda 21/09 às 06h30: depois da vigência, a janela não existe mais');
    const r = perdidaEm('2026-09-21T09:30:00.000Z');

    checar('não recupera nada', r === null, `→ ${r?.janela?.chave || 'nenhuma'}`);
    console.log('');
  }

  // 27: e nem na semana anterior
  {
    console.log('▶ segunda 07/09 às 06h30: antes da vigência, a janela ainda não existe');
    const r = perdidaEm('2026-09-07T09:30:00.000Z');

    checar('não recupera nada', r === null, `→ ${r?.janela?.chave || 'nenhuma'}`);
    console.log('');
  }

  // 28: quarta 16/09 tem duas janelas no mesmo dia; cada hora encontra a sua
  {
    console.log('▶ quarta 16/09: 06h30 é a janela da semana, 20h10 é a quarta-noite de sempre');
    const manha = perdidaEm('2026-09-16T09:30:00.000Z');
    const noite = perdidaEm('2026-09-16T23:10:00.000Z');

    checar('06h30 → fixture-semana', manha?.janela.chave === 'fixture-semana', `→ ${manha?.janela?.chave || 'nenhuma'}`);
    checar('20h10 → quarta-noite', noite?.janela.chave === 'quarta-noite', `→ ${noite?.janela?.chave || 'nenhuma'}`);
    console.log('');
  }

  // 29: sábado 19/09 não está na lista de dias (e já está fora da vigência)
  {
    console.log('▶ sábado 19/09 às 06h30: fim de semana não está na lista de dias');
    const r = perdidaEm('2026-09-19T09:30:00.000Z');

    checar('não recupera nada', r === null, `→ ${r?.janela?.chave || 'nenhuma'}`);
    console.log('');
  }

  // 30: uma chave, cinco dias — a memória em disco separa por dia, então o link de segunda
  // não cala a terça. É a premissa que permite diaSemana em lista com uma chave só.
  {
    console.log('▶ mesma chave em dias seguidos: o link de segunda não cala a terça, a janela esgotada de terça não cala a quarta');
    // Segunda 14/09: link saiu às 06h31. A janela de segunda está concluída...
    marcarEm('2026-09-14T09:31:00.000Z', 'link', 'fixture-semana', { url: 'https://y/seg' });
    checar('segunda 06h40, link já saiu: não reabre', perdidaEm('2026-09-14T09:40:00.000Z') === null);
    // ...mas a de terça é outra ocorrência da mesma chave.
    const terca = perdidaEm('2026-09-15T09:30:00.000Z');
    checar('terça 06h30 é recuperada normalmente', terca?.janela.chave === 'fixture-semana' && terca?.atrasoMin === 5, `→ ${terca?.janela?.chave || 'nenhuma'}, ${terca?.atrasoMin} min`);

    // Terça 15/09: a janela rodou até o fim sem link.
    marcarEm('2026-09-15T10:00:00.000Z', 'encerrada', 'fixture-semana');
    checar('terça 06h59, janela esgotada: não reabre', perdidaEm('2026-09-15T09:59:00.000Z') === null);
    checar('quarta 06h30 é recuperada normalmente', perdidaEm('2026-09-16T09:30:00.000Z')?.janela.chave === 'fixture-semana');

    // Quarta 16/09: o link da manhã não afeta a quarta-noite, que é outra chave.
    marcarEm('2026-09-16T09:31:00.000Z', 'link', 'fixture-semana', { url: 'https://y/qua' });
    checar('quarta 20h10 continua sendo a quarta-noite', perdidaEm('2026-09-16T23:10:00.000Z')?.janela.chave === 'quarta-noite');
    console.log('');
  }

  // 31: a vigência é contada no dia da IGREJA, não no dia UTC
  {
    console.log('▶ vigência conta o dia da igreja: às 21h30 de 13/09 já é 14/09 em UTC, e ainda não vale');

    // 2026-09-14T00:30Z = domingo 13/09 21h30 BRT
    checar('13/09 21h30 BRT: fora', janelaVigente(FIXTURE, new Date('2026-09-14T00:30:00.000Z')) === false);
    // 2026-09-19T01:30Z = sexta 18/09 22h30 BRT
    checar('18/09 22h30 BRT: dentro', janelaVigente(FIXTURE, new Date('2026-09-19T01:30:00.000Z')) === true);
    // 2026-09-19T03:00Z = sábado 19/09 00h00 BRT
    checar('19/09 00h00 BRT: fora', janelaVigente(FIXTURE, new Date('2026-09-19T03:00:00.000Z')) === false);
    checar('janela sem vigência vale sempre', janelaVigente(janelaPor('domingo-manha'), new Date('2030-01-01T12:00:00.000Z')) === true);
    console.log('');
  }

  // 32: tabela escrita errada falha na carga, não em silêncio no dia do culto
  {
    console.log('▶ vigência, dia da semana ou chave escritos errado são rejeitados na carga do módulo');
    const erroDe = (fn) => { try { fn(); return null; } catch (e) { return e.message; } };
    const rejeita = (janela) => erroDe(() => validarJanela({ chave: 'teste', diaSemana: 1, ...janela })) !== null;

    const semZero = erroDe(() => validarJanela({ chave: 'teste', diaSemana: 1, vigencia: { de: '2026-9-14', ate: '2026-09-18' } }));
    checar("'2026-9-14' (sem o zero) é rejeitada", semZero !== null);
    const inexistente = erroDe(() => validarJanela({ chave: 'teste', diaSemana: 1, vigencia: { de: '2026-02-30', ate: '2026-03-01' } }));
    checar("'2026-02-30' (dia que não existe) é rejeitada", inexistente !== null);
    checar('e a mensagem diz que o dia não existe, com o campo e o valor', /vigencia\.de = "2026-02-30" não é um dia que existe/.test(inexistente || ''), `→ ${inexistente}`);
    const invertida = erroDe(() => validarJanela({ chave: 'teste', diaSemana: 1, vigencia: { de: '2026-09-18', ate: '2026-09-14' } }));
    checar('de > ate é rejeitada, com mensagem própria', /começa depois de terminar/.test(invertida || ''), `→ ${invertida}`);
    checar('vigência sem "ate" é rejeitada', rejeita({ vigencia: { de: '2026-09-14' } }));
    checar('vigência válida passa', !rejeita({ vigencia: { de: '2026-09-14', ate: '2026-09-18' } }));
    checar('de == ate (um dia só) passa', !rejeita({ vigencia: { de: '2026-09-14', ate: '2026-09-14' } }));
    checar('sem vigência passa', !rejeita({}));
    checar('dia da semana 7 é rejeitado', rejeita({ diaSemana: [1, 7] }));
    checar('lista de dias vazia é rejeitada', rejeita({ diaSemana: [] }));
    checar('chave vazia é rejeitada', rejeita({ chave: '' }));

    // Chave repetida: a segunda janela do dia leria "já enviei o link hoje" da primeira e
    // ficaria muda. É o erro de copiar uma entrada e esquecer de trocar a chave.
    const copia = { ...FIXTURE, hora: 19, minuto: 53, chave: 'quarta-noite' };
    const repetida = erroDe(() => validarTabela([...TABELA, copia]));
    checar('chave repetida na tabela é rejeitada', /chave repetida/.test(repetida || ''), `→ ${repetida}`);
    checar('a tabela real inteira passa', erroDe(() => validarTabela(JANELAS)) === null);
    checar('a tabela de teste inteira passa', erroDe(() => validarTabela(TABELA)) === null);
    console.log('');
  }

  console.log('═══════════════════════════════════');
  if (falhas === 0) {
    console.log('✅ Todos os cenários passaram.\n');
    process.exit(0);
  }
  console.log(`❌ ${falhas} verificação(ões) falharam.\n`);
  process.exit(1);
}

main();
