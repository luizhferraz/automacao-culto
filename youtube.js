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
      const { data } = await http.get(`${BASE_URL}/search`, {
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
      .filter(i => ehCulto(i.snippet?.title) && i.snippet?.resourceId?.videoId)
      .map(i => ({
        id: i.snippet.resourceId.videoId,
        titulo: i.snippet.title,
        publicadoEm: i.snippet.publishedAt,
      }));

    if (candidatos.length === 0) return null;

    return escolherDaPlaylist(candidatos, await detalharVideos(candidatos, apiKey), filtroHoras);
  } catch (err) {
    console.error('[YouTube] Erro ao buscar playlist de uploads:', err.message);
  }

  return null;
}

/**
 * Uma única chamada a videos.list para todos os candidatos da playlist (custa 1 unidade,
 * independente de quantos ids vão junto). Devolve um mapa id → detalhes, ou null se a
 * chamada falhar, que é o sinal para o chamador cair na regra antiga.
 *
 * `liveStreamingDetails` é a parte que faltava. Ela traz o horário MARCADO da estreia, que é
 * a única coisa que diz a que culto o vídeo pertence. Ver escolherDaPlaylist.
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
 * Escolhe, entre os cultos da playlist, o que pertence a ESTA janela.
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
 * Agora a referência é o horário marcado da transmissão (`scheduledStartTime`, ou
 * `actualStartTime` quando já começou), e `filtroHoras` passa a significar "há quanto tempo,
 * no máximo, o culto pode ter começado". A hora do upload só é usada quando o vídeo não tem
 * `liveStreamingDetails` — um upload comum, sem estreia agendada.
 *
 * O teto para o futuro (TOLERANCIA_FUTURO_MIN) corrige de quebra um erro silencioso do outro
 * lado: a estreia da noite costuma já estar agendada no canal de manhã, e a regra antiga
 * aceitava o upload recente sem olhar o horário. A janela da manhã podia mandar o link do
 * culto da noite.
 */
function escolherDaPlaylist(candidatos, detalhes, filtroHoras) {
  const agora = Date.now();
  const pisoMs = agora - filtroHoras * 60 * 60 * 1000;
  const tetoMs = agora + TOLERANCIA_FUTURO_MIN * 60 * 1000;

  const avaliados = candidatos.map(c => {
    const detalhe = detalhes?.get(c.id);

    // Live real vs estreia: uma transmissão ao vivo em andamento tem
    // contentDetails.duration = 'P0D' (duração indefinida). Uma estreia tem a duração real do
    // arquivo desde o upload, mesmo antes de ir ao ar. liveBroadcastContent NÃO serve aqui:
    // estreias em exibição também retornam 'live'.
    const duracao = detalhe?.contentDetails?.duration;
    const fonte = duracao === 'P0D' ? 'live' : 'estreia';

    const marcado = detalhe?.liveStreamingDetails?.actualStartTime
      || detalhe?.liveStreamingDetails?.scheduledStartTime;

    // Sem detalhes (a chamada falhou) ou sem horário marcado (upload comum, sem estreia),
    // vale a regra antiga: a hora do upload. Assim uma falha do videos.list degrada para o
    // comportamento anterior em vez de deixar a janela sem link.
    const referencia = new Date(marcado || c.publicadoEm).getTime();

    return { ...c, fonte, referencia, porHorarioMarcado: !!marcado, distancia: Math.abs(referencia - agora) };
  });

  const dentroDaJanela = avaliados.filter(v =>
    Number.isFinite(v.referencia) && v.referencia > pisoMs && v.referencia <= tetoMs
  );

  for (const v of avaliados) {
    const base = v.porHorarioMarcado ? 'horário marcado' : 'upload';
    const situacao = dentroDaJanela.includes(v) ? 'na janela' : 'fora da janela';
    console.log(`[YouTube] Playlist: "${v.titulo}" | ${base} ${new Date(v.referencia).toISOString()} | ${v.fonte} | ${situacao}`);
  }

  if (dentroDaJanela.length === 0) {
    console.log(`[YouTube] Nenhum culto na janela (começou há até ${filtroHoras}h ou começa em até ${TOLERANCIA_FUTURO_MIN} min).`);
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

// escolherDaPlaylist é exportada para os testes automatizados rodarem a regra real de escolha
// (ver testes/simular-youtube.js), sem depender da rede.
module.exports = { buscarTransmissaoAoVivo, buscarUltimaGravacao, escolherDaPlaylist };
