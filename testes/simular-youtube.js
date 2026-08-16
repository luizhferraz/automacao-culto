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

const { escolherDaPlaylist } = require('../youtube');
const { JANELAS, janelaPerdida } = require('../scheduler');

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
    return escolherDaPlaylist(entrada, detalhes, janelaPor(chaveDaJanela).filtroHoras);
  } finally {
    Date.now = real;
  }
}

function main() {
  console.log('\n═══ Escolha do vídeo da janela ═══\n');

  // 1: o bug do domingo 16/08, na janela em que ele apareceu
  {
    console.log('▶ domingo-noite às 18h59: estreia das 19h publicada de manhã (o caso de 16/08)');
    const r = escolherEm('2026-08-16T21:59:00.000Z', 'domingo-noite');

    checar('achou um vídeo', !!r, r ? `→ ${r.id}` : '→ nenhum');
    checar('escolheu a estreia da NOITE', r?.id === 'noite1', `→ ${r?.id}`);
    checar('classificou como estreia', r?.fonte === 'estreia', `→ ${r?.fonte}`);
    console.log('');
  }

  // 2: a mesma playlist de manhã não pode mandar o link da noite
  {
    console.log('▶ domingo-manha às 09h54: a estreia da noite já está agendada no canal');
    const r = escolherEm('2026-08-16T12:54:00.000Z', 'domingo-manha');

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

  // 5: sem detalhes (videos.list falhou), vale a regra antiga do upload
  {
    console.log('▶ videos.list indisponível: degrada para a regra antiga (hora do upload)');
    const publicadoAgora = [{ id: 'x', titulo: 'Culto de Fé', publicadoEm: '2026-08-16T21:40:00.000Z' }];
    const r = escolherEm('2026-08-16T21:59:00.000Z', 'domingo-noite', publicadoAgora, null);

    checar('achou pelo upload recente', r?.id === 'x', `→ ${r?.id}`);
    checar('e assumiu estreia', r?.fonte === 'estreia', `→ ${r?.fonte}`);

    // E o upload velho continua sendo recusado, como antes.
    const publicadoOntem = [{ id: 'y', titulo: 'Culto de Fé', publicadoEm: '2026-08-15T21:40:00.000Z' }];
    const antigo = escolherEm('2026-08-16T21:59:00.000Z', 'domingo-noite', publicadoOntem, null);
    checar('upload de ontem continua fora', antigo === null, `→ ${antigo?.id || 'nenhum'}`);
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

  console.log('═══ Recuperação de janela perdida ═══\n');

  // 7: a máquina sobe DEPOIS do minuto do cron
  {
    console.log('▶ máquina sobe às 19h05 de domingo: o gatilho das 18h59 já passou');
    // 19h05 BRT = 22h05 UTC
    const r = janelaPerdida(new Date('2026-08-16T22:05:00.000Z'));

    checar('reconheceu a janela da noite', r?.janela.chave === 'domingo-noite', `→ ${r?.janela.chave}`);
    checar('com o atraso certo', r?.atrasoMin === 6, `→ ${r?.atrasoMin} min`);
    console.log('');
  }

  // 8: subida normal, alguns minutos ANTES — o cron ainda vai disparar
  {
    console.log('▶ máquina sobe às 18h54 de domingo: o cron das 18h59 ainda vai disparar');
    const r = janelaPerdida(new Date('2026-08-16T21:54:00.000Z'));

    checar('não recupera nada (evita janela dupla)', r === null, `→ ${r?.janela.chave || 'nenhuma'}`);
    console.log('');
  }

  // 9: dentro do próprio minuto agendado, quem manda é o cron
  {
    console.log('▶ máquina sobe às 18h59 de domingo, no minuto do gatilho');
    const r = janelaPerdida(new Date('2026-08-16T21:59:30.000Z'));

    checar('deixa o cron trabalhar', r === null, `→ ${r?.janela.chave || 'nenhuma'}`);
    console.log('');
  }

  // 10: tarde demais, a janela já teria terminado
  {
    console.log('▶ máquina sobe às 20h00 de domingo: a janela da noite já acabou');
    const r = janelaPerdida(new Date('2026-08-16T23:00:00.000Z'));

    checar('não recupera nada', r === null, `→ ${r?.janela.chave || 'nenhuma'}`);
    console.log('');
  }

  // 11: dia sem culto
  {
    console.log('▶ máquina sobe numa segunda-feira');
    const r = janelaPerdida(new Date('2026-08-17T22:05:00.000Z'));

    checar('não recupera nada', r === null, `→ ${r?.janela.chave || 'nenhuma'}`);
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
