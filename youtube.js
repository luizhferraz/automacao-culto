const axios = require('axios');

const BASE_URL = 'https://www.googleapis.com/youtube/v3';

// Normaliza string: minúsculas + remove acentos
function normalizar(str) {
  return str
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

// Palavras-chave normalizadas para identificar os cultos
const PALAVRAS_CULTO = [
  'culto da familia',
  'culto de fe',
  'culto familia',  // variação sem "da"
  'culto fe',       // variação sem "de"
  'especial de',    // cultos especiais: "Especial de Páscoa", "Especial de Natal", etc.
];

function ehCulto(titulo) {
  const norm = normalizar(titulo);
  return PALAVRAS_CULTO.some(p => norm.includes(p));
}

async function buscarTransmissaoAoVivo(apiKey, channelId, filtroHoras = 8) {
  // Método 1: live streams ativos
  // Método 2: transmissões agendadas (upcoming)
  for (const eventType of ['live', 'upcoming']) {
    try {
      const { data } = await axios.get(`${BASE_URL}/search`, {
        params: {
          part: 'snippet',
          channelId,
          type: 'video',
          eventType,
          maxResults: 10,
          key: apiKey,
        },
      });

      const video = data.items?.find(item => ehCulto(item.snippet.title));

      if (video) {
        console.log(`[YouTube] Encontrado como '${eventType}': ${video.snippet.title}`);
        return {
          id: video.id.videoId,
          titulo: video.snippet.title,
          url: `https://www.youtube.com/watch?v=${video.id.videoId}`,
          fonte: 'live',
        };
      }
    } catch (err) {
      console.error(`[YouTube] Erro ao buscar ${eventType}:`, err.message);
    }
  }

  // Método 3: playlist de uploads do canal
  // Estreias/Premieres NÃO aparecem nos filtros live/upcoming da API do YouTube.
  // O filtro de horas é passado pelo scheduler: mais apertado à noite (4h)
  // para não pegar o culto da manhã.
  try {
    const uploadPlaylistId = channelId.replace(/^UC/, 'UU');
    const { data } = await axios.get(`${BASE_URL}/playlistItems`, {
      params: {
        part: 'snippet',
        playlistId: uploadPlaylistId,
        maxResults: 10,
        key: apiKey,
      },
    });

    const limite = new Date(Date.now() - filtroHoras * 60 * 60 * 1000);
    console.log(`[YouTube] Playlist, filtro: últimas ${filtroHoras}h (desde ${limite.toISOString()})`);

    const item = data.items?.find(i =>
      ehCulto(i.snippet.title) &&
      new Date(i.snippet.publishedAt) > limite
    );

    if (item) {
      const videoId = item.snippet.resourceId.videoId;

      // Live real vs estreia: uma transmissão ao vivo em andamento tem
      // contentDetails.duration = 'P0D' (duração indefinida). Uma estreia
      // tem a duração real do arquivo desde o upload, mesmo antes de ir
      // ao ar. liveBroadcastContent NÃO serve aqui: estreias em exibição
      // também retornam 'live'.
      let fonte = 'estreia';
      try {
        const { data: videoData } = await axios.get(`${BASE_URL}/videos`, {
          params: { part: 'contentDetails', id: videoId, key: apiKey },
        });
        const duration = videoData.items?.[0]?.contentDetails?.duration;
        if (duration === 'P0D') fonte = 'live';
        console.log(`[YouTube] Playlist: "${item.snippet.title}" | duration: ${duration} → fonte: ${fonte}`);
      } catch (err) {
        console.warn('[YouTube] Falha ao verificar duração, assumindo estreia:', err.message);
      }

      return {
        id: videoId,
        titulo: item.snippet.title,
        url: `https://www.youtube.com/watch?v=${videoId}`,
        fonte,
      };
    }
  } catch (err) {
    console.error('[YouTube] Erro ao buscar playlist de uploads:', err.message);
  }

  return null;
}

async function buscarUltimaGravacao(apiKey, channelId) {
  try {
    const { data } = await axios.get(`${BASE_URL}/search`, {
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
    // (evita enviar o culto da manhã como fallback do culto da noite)
    const seisHorasAtras = new Date(Date.now() - 6 * 60 * 60 * 1000);
    const video = data.items?.find(item =>
      ehCulto(item.snippet.title) &&
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

module.exports = { buscarTransmissaoAoVivo, buscarUltimaGravacao };
