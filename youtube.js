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

async function buscarTransmissaoAoVivo(apiKey, channelId) {
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
        };
      }
    } catch (err) {
      console.error(`[YouTube] Erro ao buscar ${eventType}:`, err.message);
    }
  }

  // Método 3: playlist de uploads do canal
  // Estreias/Premieres NÃO aparecem nos filtros live/upcoming da API do YouTube.
  // A playlist de uploads lista todos os vídeos recentes, incluindo Estreias.
  // Filtra apenas vídeos adicionados nas últimas 8 horas para evitar
  // retornar o culto da manhã durante a janela da noite.
  try {
    const uploadPlaylistId = channelId.replace(/^UC/, 'UU');
    const { data } = await axios.get(`${BASE_URL}/playlistItems`, {
      params: {
        part: 'snippet',
        playlistId: uploadPlaylistId,
        maxResults: 5,
        key: apiKey,
      },
    });

    const oitoHorasAtras = new Date(Date.now() - 8 * 60 * 60 * 1000);

    const item = data.items?.find(i =>
      ehCulto(i.snippet.title) &&
      new Date(i.snippet.publishedAt) > oitoHorasAtras
    );

    if (item) {
      const videoId = item.snippet.resourceId.videoId;
      console.log(`[YouTube] Estreia encontrada na playlist: ${item.snippet.title}`);
      return {
        id: videoId,
        titulo: item.snippet.title,
        url: `https://www.youtube.com/watch?v=${videoId}`,
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
