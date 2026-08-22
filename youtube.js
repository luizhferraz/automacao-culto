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

// Quanto tempo DEPOIS do horário marcado uma transmissão que AINDA NÃO COMEÇOU continua
// valendo. Culto atrasa (é a razão de existir o aviso de atraso), então horário marcado no
// passado recente ainda é o culto desta janela. Mas o "upcoming" da API guarda para sempre
// broadcasts agendados e abandonados; sem este teto próprio, um "agendado para 14h que nunca
// foi ao ar" caberia no piso de 7h da janela da noite e sairia como link que nunca vai tocar.
// Para transmissão que JÁ COMEÇOU a régua é outra (filtroHoras), porque aí o início real
// existe e diz tudo.
const TOLERANCIA_ATRASO_MIN = Number(process.env.ESTREIA_ATRASO_MIN || 60);

// Piso de duração do fallback de gravação, em minutos. eventType=completed devolve qualquer
// transmissão encerrada — teste de som e evento avulso inclusive, agora que não há filtro de
// título. Culto dura bem mais de meia hora; 20 min barra o ruído sem arriscar recusar culto.
const GRAVACAO_DURACAO_MIN = Number(process.env.GRAVACAO_DURACAO_MIN || 20);

// As buscas caras (search.list, 100 unidades de quota CADA) só rodam a cada N tentativas; a
// playlist (1+1 unidades) roda em todas. Sem a cadência, o pior domingo custava 67 tentativas
// × ~203 ≈ 13,7 mil unidades — acima do teto diário de 10 mil, com a quota morrendo no meio
// da janela da noite e levando junto o fallback de gravação. Com N=3 o mesmo pior caso fica
// em ~5 mil. O preço é um atraso de até 2 min para uma live que SÓ a busca enxerga — e a
// experiência registrada no README é a oposta: a busca é que costuma atrasar, a playlist vê
// primeiro.
const CADENCIA_BUSCAS_CARAS = 3;

// ── Sem filtro de título ─────────────────────────────────────────────────────
// Até 22/08 só contavam títulos com palavras-chave ("Culto da Família", "Culto de Fé",
// "Especial de..."). A lista quebrava a cada variação nova de título e foi aposentada junto
// com a entrada da janela de sábado: DENTRO de uma janela de culto, qualquer transmissão do
// canal é o culto. Quem impede o vídeo errado de sair deixou de ser o título e passou a ser
// o horário: TODO método passa pelo escolherPorHorario, inclusive o eventType=live — o índice
// do search é cacheado e sabe devolver transmissão que acabou de encerrar, e antes o filtro
// de título era a segunda barreira que segurava isso. Foi essa régua que barrou o caso de
// 22/08: um rascunho de transmissão sem data, criado de manhã no canal, passaria por
// qualquer filtro de recência de upload, mas não tem horário marcado.

async function buscarTransmissaoAoVivo(apiKey, channelId, filtroHoras = 8, tentativa = 1) {
  const buscasCaras = (tentativa - 1) % CADENCIA_BUSCAS_CARAS === 0;

  // Métodos 1 e 2: search por live e por upcoming. Caros (100 unidades cada), então só nas
  // tentativas 1, 4, 7... — ver CADENCIA_BUSCAS_CARAS. A validação é a mesma dos demais:
  // nada do que o search devolve é aceito sem passar pela régua de horário.
  if (buscasCaras) {
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

        const candidatos = (data.items || [])
          .filter(i => i.id?.videoId)
          .map(i => ({ id: i.id.videoId, titulo: i.snippet?.title }));

        if (candidatos.length > 0) {
          const escolha = escolherPorHorario(candidatos, await detalharVideos(candidatos, apiKey), filtroHoras, eventType);
          if (escolha) return escolha;
        }
      } catch (err) {
        console.error(`[YouTube] Erro ao buscar ${eventType}:`, err.message);
      }
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
    console.warn('[YouTube] Falha ao detalhar os vídeos candidatos:', err.message);
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
 * A referência é o horário da transmissão: `actualStartTime` quando já começou (e aí vale
 * `filtroHoras`: "há quanto tempo, no máximo, o culto pode ter começado"), ou
 * `scheduledStartTime` quando ainda não (e aí a régua é mais curta — atraso até
 * TOLERANCIA_ATRASO_MIN, futuro até TOLERANCIA_FUTURO_MIN). O teto para o futuro fecha um
 * erro silencioso: a estreia da noite costuma já estar agendada no canal de manhã, e sem o
 * teto a janela da manhã mandaria o link do culto da noite.
 *
 * Rejeições sem apelação: transmissão já ENCERRADA (actualEndTime — gravação é papel do
 * fallback, e o search live sabe devolver recém-encerrada por índice defasado) e vídeo SEM
 * horário de transmissão (upload comum, ou o rascunho sem data que apareceu no canal em
 * 22/08). Sem os detalhes (videos.list falhou), a tentativa inteira é descartada. Já foi
 * diferente: a regra degradava para a hora do upload — mas ela era protegida pelo filtro de
 * título, que não existe mais. Descartar custa pouco: a tentativa seguinte, um minuto
 * depois, refaz as chamadas.
 */
function escolherPorHorario(candidatos, detalhes, filtroHoras, origem = 'playlist') {
  if (!detalhes) {
    console.warn(`[YouTube] ${origem}: videos.list falhou, sem como validar horário; tentativa descartada.`);
    return null;
  }

  const agora = Date.now();

  const avaliados = candidatos.map(c => {
    const detalhe = detalhes.get(c.id);

    // Live real vs estreia: uma transmissão ao vivo em andamento tem
    // contentDetails.duration = 'P0D' (duração indefinida). Uma estreia tem a duração real do
    // arquivo desde o upload, mesmo antes de ir ao ar. liveBroadcastContent NÃO serve aqui:
    // estreias em exibição também retornam 'live'.
    const duracao = detalhe?.contentDetails?.duration;
    const fonte = duracao === 'P0D' ? 'live' : 'estreia';

    const inicioReal = detalhe?.liveStreamingDetails?.actualStartTime;
    const agendado = detalhe?.liveStreamingDetails?.scheduledStartTime;
    const encerrada = Boolean(detalhe?.liveStreamingDetails?.actualEndTime);

    // Três situações, três réguas:
    //   • encerrada (actualEndTime): nunca. O search live devolve transmissão recém-encerrada
    //     (índice cacheado), e o piso de filtroHoras engoliria um evento da tarde inteiro.
    //     Gravação de culto é papel do fallback (buscarUltimaGravacao), não daqui.
    //   • já começou (actualStartTime): o início real diz tudo — vale filtroHoras. É também o
    //     que barra encoder esquecido ligado: live "no ar" há mais de filtroHoras não é o
    //     culto desta janela.
    //   • só agendada (scheduledStartTime): futuro até TOLERANCIA_FUTURO_MIN, atraso até
    //     TOLERANCIA_ATRASO_MIN. O atraso curto cobre culto atrasado; o teto curto barra o
    //     broadcast agendado e abandonado, que fica "upcoming" para sempre na API.
    //   • sem horário nenhum: nunca. Upload comum ou rascunho de transmissão sem data (o
    //     caso de 22/08).
    let situacao;
    const referencia = new Date(inicioReal || agendado || NaN).getTime();
    if (encerrada) {
      situacao = 'rejeitada: já encerrada';
    } else if (inicioReal) {
      situacao = referencia > agora - filtroHoras * 60 * 60 * 1000 && referencia <= agora + TOLERANCIA_FUTURO_MIN * 60 * 1000
        ? 'na janela' : 'fora da janela';
    } else if (agendado) {
      situacao = referencia > agora - TOLERANCIA_ATRASO_MIN * 60 * 1000 && referencia <= agora + TOLERANCIA_FUTURO_MIN * 60 * 1000
        ? 'na janela' : 'fora da janela';
    } else {
      situacao = 'rejeitada: sem horário de transmissão';
    }

    return { ...c, fonte, referencia, situacao, distancia: Math.abs(referencia - agora) };
  });

  const dentroDaJanela = avaliados.filter(v => v.situacao === 'na janela');

  for (const v of avaliados) {
    const quando = Number.isFinite(v.referencia)
      ? `transmissão ${new Date(v.referencia).toISOString()}`
      : 'sem horário';
    console.log(`[YouTube] ${origem}: "${v.titulo}" | ${quando} | ${v.fonte} | ${v.situacao}`);
  }

  if (dentroDaJanela.length === 0) {
    console.log(`[YouTube] ${origem}: nenhum culto na janela (no ar tendo começado há até ${filtroHoras}h, ou agendado de ${TOLERANCIA_ATRASO_MIN} min atrás até ${TOLERANCIA_FUTURO_MIN} min à frente).`);
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
    // eventType=completed garante que foi uma transmissão, mas sem o filtro de título isso
    // inclui teste de som e evento avulso da tarde. O piso de duração é o que separa: culto
    // dura bem mais que GRAVACAO_DURACAO_MIN, ruído não.
    const seisHorasAtras = new Date(Date.now() - 6 * 60 * 60 * 1000);
    const recentes = (data.items || [])
      .filter(i => i.id?.videoId && new Date(i.snippet?.publishedAt) > seisHorasAtras)
      .map(i => ({ id: i.id.videoId, titulo: i.snippet?.title }));

    if (recentes.length === 0) return null;

    const detalhes = await detalharVideos(recentes, apiKey);
    if (!detalhes) {
      // Mesma filosofia do escolherPorHorario: sem como validar, não envia. O fallback roda
      // uma vez só, no fim da janela — mandar a transmissão errada aqui não tem correção.
      console.warn('[YouTube] gravação: videos.list falhou, sem como validar duração; fallback descartado.');
      return null;
    }

    for (const c of recentes) {
      const minutos = minutosDeDuracao(detalhes.get(c.id)?.contentDetails?.duration);
      const serve = minutos >= GRAVACAO_DURACAO_MIN;
      console.log(`[YouTube] gravação: "${c.titulo}" | ${Math.round(minutos)} min | ${serve ? 'aceita' : `rejeitada: menos de ${GRAVACAO_DURACAO_MIN} min`}`);
      if (serve) {
        return { id: c.id, titulo: c.titulo, url: `https://www.youtube.com/watch?v=${c.id}` };
      }
    }

    return null;
  } catch (err) {
    console.error('[YouTube] Erro ao buscar gravação:', err.message);
    return null;
  }
}

// Converte a duração ISO 8601 do videos.list ("PT1H28M30S") em minutos. "P0D" (transmissão
// sem duração definida, ainda processando) vira 0, o que o piso do fallback rejeita sozinho.
function minutosDeDuracao(iso) {
  const m = /^PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?$/.exec(iso || '');
  if (!m) return 0;
  return Number(m[1] || 0) * 60 + Number(m[2] || 0) + Number(m[3] || 0) / 60;
}

// escolherPorHorario é exportada para os testes automatizados rodarem a regra real de escolha
// (ver testes/simular-youtube.js), sem depender da rede.
module.exports = { buscarTransmissaoAoVivo, buscarUltimaGravacao, escolherPorHorario };
