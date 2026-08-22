const axios = require('axios');

const BASE_URL = 'https://www.googleapis.com/youtube/v3';

// Toda chamada tem prazo. Sem ele, uma conexão pendurada congela o monitoramento inteiro:
// o await da tentativa nunca volta, a próxima nunca é agendada, o desligar do scheduler
// nunca roda e a máquina passa a noite de pé com o socket do WhatsApp aberto — segurando a
// sessão da conta e, com ela, as notificações do celular do dono. O erro de timeout cai no
// try/catch de cada método e a tentativa seguinte, um minuto depois, recomeça do zero.
const http = axios.create({ timeout: Number(process.env.YOUTUBE_TIMEOUT_MS || 15000) });

// Quanto tempo ANTES do horário marcado uma estreia já é aceita. A janela abre poucos minutos
// antes do culto, então o normal é a estreia estar a minutos no futuro. O teto existe para o
// bot da manhã não mandar o link do culto da noite, que costuma já estar agendado no canal.
const TOLERANCIA_FUTURO_MIN = Number(process.env.ESTREIA_FUTURO_MIN || 90);

// ── Sem filtro de título ─────────────────────────────────────────────────────
// Até 22/08 só contavam títulos com palavras-chave ("Culto da Família", "Culto de Fé",
// "Especial de..."). A lista quebrava a cada variação nova de título e foi aposentada junto
// com a entrada da janela de sábado: DENTRO de uma janela de culto, qualquer transmissão do
// canal é o culto. Quem impede o vídeo errado de sair deixou de ser o título e passou a ser
// o horário: só é aceito o que está NO AR agora (Método 1) ou cuja transmissão tem horário
// marcado dentro da janela (Métodos 2 e 3, via escolherPorHorario). Foi exatamente isso que
// segurou o caso de 22/08: um rascunho de transmissão sem data, criado de manhã no canal,
// passaria por qualquer filtro de recência de upload, mas não tem horário marcado.

async function buscarTransmissaoAoVivo(apiKey, channelId, filtroHoras = 8) {
  // Método 1: live streams ativos. eventType=live só devolve o que está DE FATO transmitindo
  // agora, então é o único método que dispensa validação de horário.
  try {
    const { data } = await http.get(`${BASE_URL}/search`, {
      params: {
        part: 'snippet',
        channelId,
        type: 'video',
        eventType: 'live',
        maxResults: 10,
        key: apiKey,
      },
    });

    const video = data.items?.[0];
    if (video?.id?.videoId) {
      console.log(`[YouTube] Encontrado como 'live': ${video.snippet.title}`);
      return {
        id: video.id.videoId,
        titulo: video.snippet.title,
        url: `https://www.youtube.com/watch?v=${video.id.videoId}`,
        fonte: 'live',
      };
    }
  } catch (err) {
    console.error('[YouTube] Erro ao buscar live:', err.message);
  }

  // Método 2: transmissões agendadas (upcoming). Sem o filtro de título este método não pode
  // mais ser aceito cru: "upcoming" devolve tanto o culto que começa em dez minutos quanto o
  // da noite agendado com antecedência — e a régua que separa um do outro é a mesma da
  // playlist, o horário marcado. Por isso os resultados passam pelo escolherPorHorario.
  try {
    const { data } = await http.get(`${BASE_URL}/search`, {
      params: {
        part: 'snippet',
        channelId,
        type: 'video',
        eventType: 'upcoming',
        maxResults: 10,
        key: apiKey,
      },
    });

    const candidatos = (data.items || [])
      .filter(i => i.id?.videoId)
      .map(i => ({ id: i.id.videoId, titulo: i.snippet?.title }));

    if (candidatos.length > 0) {
      const escolha = escolherPorHorario(candidatos, await detalharVideos(candidatos, apiKey), filtroHoras, 'upcoming');
      if (escolha) return escolha;
    }
  } catch (err) {
    console.error('[YouTube] Erro ao buscar upcoming:', err.message);
  }

  // Método 3: playlist de uploads do canal
  // Estreias/Premieres NÃO aparecem nos filtros live/upcoming da API do YouTube.
  try {
    const uploadPlaylistId = channelId.replace(/^UC/, 'UU');
    const { data } = await http.get(`${BASE_URL}/playlistItems`, {
      params: {
        part: 'snippet',
        playlistId: uploadPlaylistId,
        maxResults: 10,
        key: apiKey,
      },
    });

    const candidatos = (data.items || [])
      .filter(i => i.snippet?.resourceId?.videoId)
      .map(i => ({
        id: i.snippet.resourceId.videoId,
        titulo: i.snippet.title,
      }));

    if (candidatos.length === 0) return null;

    return escolherPorHorario(candidatos, await detalharVideos(candidatos, apiKey), filtroHoras, 'playlist');
  } catch (err) {
    console.error('[YouTube] Erro ao buscar playlist de uploads:', err.message);
  }

  return null;
}

/**
 * Uma única chamada a videos.list para todos os candidatos (custa 1 unidade, independente de
 * quantos ids vão junto). Devolve um mapa id → detalhes, ou null se a chamada falhar — e sem
 * detalhes a tentativa é descartada (ver escolherPorHorario).
 *
 * `liveStreamingDetails` é a parte que decide tudo. Ela traz o horário MARCADO da
 * transmissão, que é a única coisa que diz a que culto o vídeo pertence.
 */
async function detalharVideos(candidatos, apiKey) {
  try {
    const { data } = await http.get(`${BASE_URL}/videos`, {
      params: {
        part: 'contentDetails,liveStreamingDetails',
        id: candidatos.map(c => c.id).join(','),
        key: apiKey,
      },
    });
    return new Map((data.items || []).map(v => [v.id, v]));
  } catch (err) {
    console.warn('[YouTube] Falha ao detalhar os vídeos da playlist:', err.message);
    return null;
  }
}

/**
 * Escolhe, entre os candidatos de um método, o vídeo que pertence a ESTA janela.
 *
 * A regra antiga era `publishedAt` nas últimas `filtroHoras`, ou seja, a hora do UPLOAD. Isso
 * confundia duas coisas diferentes: quando o arquivo subiu e quando o culto acontece. Numa
 * estreia elas não têm relação nenhuma — o vídeo é gravado antes e agendado para tocar depois.
 *
 * Foi o que derrubou o domingo 16/08: a estreia das 19h tinha sido publicada de manhã, o
 * filtro da noite só aceitava upload das últimas 7h (desde ~12h), e o culto ficou invisível
 * para o bot a janela inteira. Cada vez que isso aconteceu, a "correção" foi esticar o filtro
 * (4h → 6h → 7h), o que só empurra o problema: esticar o bastante para pegar a estreia
 * publicada de manhã é esticar o bastante para pegar o culto DA MANHÃ à noite.
 *
 * A referência é o horário marcado da transmissão (`scheduledStartTime`, ou
 * `actualStartTime` quando já começou), e `filtroHoras` significa "há quanto tempo, no
 * máximo, o culto pode ter começado". O teto para o futuro (TOLERANCIA_FUTURO_MIN) fecha o
 * outro lado: a estreia da noite costuma já estar agendada no canal de manhã, e sem o teto a
 * janela da manhã mandaria o link do culto da noite.
 *
 * Vídeo sem horário marcado é REJEITADO, e sem os detalhes (videos.list falhou) a tentativa
 * inteira é descartada. Já foi diferente: a regra degradava para a hora do upload. Ela era
 * protegida pelo filtro de título, que não existe mais — sem ele, "qualquer vídeo recente"
 * inclui clipe, aviso e o rascunho de transmissão sem data que apareceu no canal em 22/08.
 * Descartar custa pouco: a tentativa seguinte, um minuto depois, refaz as chamadas.
 */
function escolherPorHorario(candidatos, detalhes, filtroHoras, origem = 'playlist') {
  if (!detalhes) {
    console.warn(`[YouTube] ${origem}: videos.list falhou, sem como validar horário; tentativa descartada.`);
    return null;
  }

  const agora = Date.now();
  const pisoMs = agora - filtroHoras * 60 * 60 * 1000;
  const tetoMs = agora + TOLERANCIA_FUTURO_MIN * 60 * 1000;

  const avaliados = candidatos.map(c => {
    const detalhe = detalhes.get(c.id);

    // Live real vs estreia: uma transmissão ao vivo em andamento tem
    // contentDetails.duration = 'P0D' (duração indefinida). Uma estreia tem a duração real do
    // arquivo desde o upload, mesmo antes de ir ao ar. liveBroadcastContent NÃO serve aqui:
    // estreias em exibição também retornam 'live'.
    const duracao = detalhe?.contentDetails?.duration;
    const fonte = duracao === 'P0D' ? 'live' : 'estreia';

    const marcado = detalhe?.liveStreamingDetails?.actualStartTime
      || detalhe?.liveStreamingDetails?.scheduledStartTime;
    const referencia = marcado ? new Date(marcado).getTime() : NaN;

    return { ...c, fonte, referencia, distancia: Math.abs(referencia - agora) };
  });

  const dentroDaJanela = avaliados.filter(v =>
    Number.isFinite(v.referencia) && v.referencia > pisoMs && v.referencia <= tetoMs
  );

  for (const v of avaliados) {
    const quando = Number.isFinite(v.referencia)
      ? `transmissão ${new Date(v.referencia).toISOString()}`
      : 'sem horário de transmissão';
    const situacao = !Number.isFinite(v.referencia) ? 'rejeitado'
      : dentroDaJanela.includes(v) ? 'na janela' : 'fora da janela';
    console.log(`[YouTube] ${origem}: "${v.titulo}" | ${quando} | ${v.fonte} | ${situacao}`);
  }

  if (dentroDaJanela.length === 0) {
    console.log(`[YouTube] ${origem}: nenhum culto na janela (começou há até ${filtroHoras}h ou começa em até ${TOLERANCIA_FUTURO_MIN} min).`);
    return null;
  }

  // O mais próximo de agora. Com dois cultos do mesmo dia na playlist, é o critério que
  // separa o da manhã do da noite sem depender de nenhum ajuste manual de horas.
  const escolhido = dentroDaJanela.sort((a, b) => a.distancia - b.distancia)[0];
  console.log(`[YouTube] Escolhido: "${escolhido.titulo}" (${escolhido.fonte})`);

  return {
    id: escolhido.id,
    titulo: escolhido.titulo,
    url: `https://www.youtube.com/watch?v=${escolhido.id}`,
    fonte: escolhido.fonte,
  };
}

async function buscarUltimaGravacao(apiKey, channelId) {
  try {
    const { data } = await http.get(`${BASE_URL}/search`, {
      params: {
        part: 'snippet',
        channelId,
        type: 'video',
        eventType: 'completed',
        order: 'date',
        maxResults: 10,
        key: apiKey,
      },
    });

    // Só considera vídeos publicados nas últimas 6 horas
    // (evita enviar o culto da manhã como fallback do culto da noite).
    // eventType=completed garante que foi uma transmissão, então o filtro de título saiu
    // daqui junto com os demais: qualquer transmissão encerrada recente serve de fallback.
    const seisHorasAtras = new Date(Date.now() - 6 * 60 * 60 * 1000);
    const video = data.items?.find(item =>
      new Date(item.snippet.publishedAt) > seisHorasAtras
    );

    if (video) {
      return {
        id: video.id.videoId,
        titulo: video.snippet.title,
        url: `https://www.youtube.com/watch?v=${video.id.videoId}`,
      };
    }

    return null;
  } catch (err) {
    console.error('[YouTube] Erro ao buscar gravação:', err.message);
    return null;
  }
}

// escolherPorHorario é exportada para os testes automatizados rodarem a regra real de escolha
// (ver testes/simular-youtube.js), sem depender da rede.
module.exports = { buscarTransmissaoAoVivo, buscarUltimaGravacao, escolherPorHorario };
