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
  try {
    const { data } = await axios.get(`${BASE_URL}/search`, {
      params: {
        part: 'snippet',
        channelId,
        type: 'video',
        eventType: 'live',
        maxResults: 10,
        key: apiKey,
      },
    });

    const video = data.items?.find(item => ehCulto(item.snippet.title));

    if (video) {
      return {
        id: video.id.videoId,
        titulo: video.snippet.title,
        url: `https://www.youtube.com/watch?v=${video.id.videoId}`,
      };
    }

    return null;
  } catch (err) {
    console.error('[YouTube] Erro ao buscar transmissão ao vivo:', err.message);
    return null;
  }
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

    const video = data.items?.find(item => ehCulto(item.snippet.title));

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
