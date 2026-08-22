/**
 * A fiação completa de buscarTransmissaoAoVivo e buscarUltimaGravacao, sem rede.
 *
 * Por que existe: a remoção do filtro de título (22/08) mudou o CAMINHO dos três métodos —
 * todos passaram a validar pela régua de horário — e nada disso era exercitado por teste: o
 * simular-youtube.js cobre a régua (escolherPorHorario) isolada, mas não quem a chama. Sem
 * este arquivo, reintroduzir o filtro de título, ou voltar a aceitar o resultado do search
 * cru (o buraco crítico apontado na revisão de 22/08), passaria despercebido pela suíte.
 *
 * O axios é trocado por um dublê ANTES do require de ../youtube, no mesmo padrão de
 * require.cache do simular-aviso.js. Cada cenário define o que a "API" devolve por rota
 * (search live/upcoming/completed, playlistItems, videos) e o teste confere o resultado e
 * as chamadas feitas.
 *
 * Uso: node testes/simular-busca.js
 */

const CAMINHO_AXIOS = require.resolve('axios');

let rotas = {};       // { live, upcoming, completed, playlist, videos } por cenário
let chamadas = [];    // { url, params } de cada GET que o youtube.js fez

function responder(url, params) {
  chamadas.push({ url, params });
  if (url.endsWith('/search')) {
    return { data: { items: rotas[params.eventType] || [] } };
  }
  if (url.endsWith('/playlistItems')) {
    return { data: { items: rotas.playlist || [] } };
  }
  if (url.endsWith('/videos')) {
    const ids = String(params.id).split(',');
    return { data: { items: (rotas.videos || []).filter(v => ids.includes(v.id)) } };
  }
  throw new Error(`URL inesperada no dublê: ${url}`);
}

require.cache[CAMINHO_AXIOS] = {
  id: CAMINHO_AXIOS,
  filename: CAMINHO_AXIOS,
  loaded: true,
  exports: {
    // youtube.js usa axios.create({timeout}).get(url, {params})
    create: () => ({ get: async (url, cfg) => responder(url, cfg?.params) }),
  },
};

// Precisa vir DEPOIS do dublê entrar no require.cache
const { buscarTransmissaoAoVivo, buscarUltimaGravacao } = require('../youtube');

// ── Fábricas dos formatos da API ─────────────────────────────────────────────
const itemBusca = (id, titulo, publicadoEm) => ({
  id: { videoId: id },
  snippet: { title: titulo, publishedAt: publicadoEm },
});
const itemPlaylist = (id, titulo, publicadoEm) => ({
  snippet: { title: titulo, resourceId: { videoId: id }, publishedAt: publicadoEm },
});
const detalhe = (id, duration, liveStreamingDetails) => ({
  id,
  contentDetails: { duration },
  ...(liveStreamingDetails !== undefined ? { liveStreamingDetails } : {}),
});

// Relógio congelado: sábado 22/08 às 19h05 BRT (22h05 UTC), dentro da janela de sábado.
const AGORA = '2026-08-22T22:05:00.000Z';
const relogioReal = Date.now;

let falhas = 0;
function checar(descricao, condicao, detalhe2 = '') {
  console.log(`${condicao ? '  ✅' : '  ❌'} ${descricao}${detalhe2 ? ` ${detalhe2}` : ''}`);
  if (!condicao) falhas++;
}

const buscou = (trecho) => chamadas.some(c => c.url.includes(trecho));
const buscouEvento = (tipo) => chamadas.some(c => c.url.endsWith('/search') && c.params.eventType === tipo);

async function cenario(nome, config, corpo) {
  console.log(`▶ ${nome}`);
  rotas = config;
  chamadas = [];
  Date.now = () => new Date(AGORA).getTime();
  try {
    await corpo();
  } finally {
    Date.now = relogioReal;
  }
  console.log('');
}

async function main() {
  console.log('\n═══ Fiação da busca de transmissão (sem filtro de título) ═══\n');

  // 1: live no ar com título fora do padrão antigo sai pelo Método 1 — e validada
  await cenario('live no ar, título qualquer: Método 1 envia, depois de validar pelo videos.list', {
    live: [itemBusca('L1', 'Noite de Adoração e Louvor')],
    videos: [detalhe('L1', 'P0D', { scheduledStartTime: '2026-08-22T22:00:00.000Z', actualStartTime: '2026-08-22T22:01:00.000Z' })],
  }, async () => {
    const r = await buscarTransmissaoAoVivo('k', 'UCx', 7, 1);
    checar('enviou a live', r?.id === 'L1', `→ ${r?.id || 'nenhum'}`);
    checar('como fonte live', r?.fonte === 'live', `→ ${r?.fonte}`);
    checar('validou no videos.list antes (não aceitou o search cru)', buscou('/videos'));
  });

  // 2: o search live devolve transmissão recém-encerrada (índice defasado) — barrada
  await cenario('search live devolve encerrada: rejeitada, nada é enviado', {
    live: [itemBusca('L2', 'Teste de som')],
    videos: [detalhe('L2', 'P0D', {
      actualStartTime: '2026-08-22T21:00:00.000Z',
      actualEndTime: '2026-08-22T21:40:00.000Z',
    })],
  }, async () => {
    const r = await buscarTransmissaoAoVivo('k', 'UCx', 7, 1);
    checar('não enviou nada', r === null, `→ ${r?.id || 'nenhum'}`);
  });

  // 3: o dia 22/08 de ponta a ponta — só o rascunho sem data existe no canal
  await cenario('rascunho de transmissão sem data na playlist: nada é enviado (o caso 22/08)', {
    playlist: [itemPlaylist('R1', 'Culto de Fé| 19/08 | 20h', '2026-08-22T12:55:00.000Z')],
    videos: [detalhe('R1', 'P0D', {})], // na vida real só vem activeLiveChatId
  }, async () => {
    const r = await buscarTransmissaoAoVivo('k', 'UCx', 7, 1);
    checar('não enviou nada', r === null, `→ ${r?.id || 'nenhum'}`);
  });

  // 4: Método 2 (upcoming) com horário marcado próximo passa; sem filtro de título
  await cenario('upcoming agendado para daqui a 10 min: Método 2 envia como estreia', {
    upcoming: [itemBusca('U1', 'Vigília de Sábado')],
    videos: [detalhe('U1', 'PT1H20M', { scheduledStartTime: '2026-08-22T22:15:00.000Z' })],
  }, async () => {
    const r = await buscarTransmissaoAoVivo('k', 'UCx', 7, 1);
    checar('enviou a estreia agendada', r?.id === 'U1', `→ ${r?.id || 'nenhum'}`);
    checar('como fonte estreia (duração real)', r?.fonte === 'estreia', `→ ${r?.fonte}`);
  });

  // 5: a cadência das buscas caras — tentativa 2 não chama search nenhum
  await cenario('tentativa 2: nenhum search (200 unidades poupadas), playlist basta', {
    live: [itemBusca('L3', 'não deveria nem ser consultado')],
    playlist: [itemPlaylist('P1', 'Culto de Sábado', '2026-08-22T20:00:00.000Z')],
    videos: [detalhe('P1', 'P0D', { scheduledStartTime: '2026-08-22T22:00:00.000Z', actualStartTime: '2026-08-22T22:02:00.000Z' })],
  }, async () => {
    const r = await buscarTransmissaoAoVivo('k', 'UCx', 7, 2);
    checar('nenhuma chamada de search', !buscouEvento('live') && !buscouEvento('upcoming'));
    checar('a playlist rodou', buscou('/playlistItems'));
    checar('e achou o culto', r?.id === 'P1', `→ ${r?.id || 'nenhum'}`);
  });

  // 6: na tentativa 4 as buscas caras voltam
  await cenario('tentativa 4: os search voltam a rodar', {
    live: [itemBusca('L4', 'Culto de Sábado')],
    videos: [detalhe('L4', 'P0D', { actualStartTime: '2026-08-22T22:02:00.000Z' })],
  }, async () => {
    const r = await buscarTransmissaoAoVivo('k', 'UCx', 7, 4);
    checar('o search live rodou', buscouEvento('live'));
    checar('e enviou', r?.id === 'L4', `→ ${r?.id || 'nenhum'}`);
  });

  console.log('═══ Fallback de gravação (piso de duração) ═══\n');

  // 7: teste de som curto não vira "Culto disponível"; o culto de verdade sim
  await cenario('completed recente: teste de som (8 min) rejeitado, culto (1h28) aceito', {
    completed: [
      itemBusca('T1', 'teste de transmissão', '2026-08-22T21:30:00.000Z'),
      itemBusca('G1', 'Culto de Sábado', '2026-08-22T20:30:00.000Z'),
    ],
    videos: [
      detalhe('T1', 'PT8M12S', { actualStartTime: '2026-08-22T21:20:00.000Z', actualEndTime: '2026-08-22T21:29:00.000Z' }),
      detalhe('G1', 'PT1H28M', { actualStartTime: '2026-08-22T19:00:00.000Z', actualEndTime: '2026-08-22T20:28:00.000Z' }),
    ],
  }, async () => {
    const r = await buscarUltimaGravacao('k', 'UCx');
    checar('escolheu o culto, não o teste', r?.id === 'G1', `→ ${r?.id || 'nenhum'}`);
  });

  // 8: só ruído curto disponível → melhor nada do que o vídeo errado
  await cenario('completed recente: só o teste de som existe → nada é enviado', {
    completed: [itemBusca('T2', 'teste de som', '2026-08-22T21:30:00.000Z')],
    videos: [detalhe('T2', 'PT5M', { actualEndTime: '2026-08-22T21:35:00.000Z' })],
  }, async () => {
    const r = await buscarUltimaGravacao('k', 'UCx');
    checar('não enviou nada', r === null, `→ ${r?.id || 'nenhum'}`);
  });

  console.log('═══════════════════════════════════');
  if (falhas === 0) {
    console.log('✅ Todos os cenários passaram.\n');
    process.exit(0);
  }
  console.log(`❌ ${falhas} verificação(ões) falharam.\n`);
  process.exit(1);
}

main().catch(err => {
  Date.now = relogioReal;
  console.error('Erro na simulação:', err);
  process.exit(1);
});
