/**
 * Simulação do aviso de atraso, com relógio falso.
 *
 * Roda a função monitorarAoVivo real (não uma cópia), substituindo apenas:
 *   • Date.now e setTimeout  → relógio simulado, para não esperar 36 minutos
 *   • ./youtube e ./whatsapp → stubs que registram o que seria enviado
 *
 * Uso: node testes/simular-aviso.js
 */

const path = require('path');
const fs = require('fs');
const os = require('os');

// A memória de janela em disco (janelas-enviadas.json) mora ao lado do AUTH_DIR; sem isto o
// teste escreveria o arquivo na raiz do repositório. Precisa vir ANTES do require do scheduler.
process.env.AUTH_DIR = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'culto-aviso-')), 'baileys_auth');

const CAMINHO_YOUTUBE = require.resolve('../youtube');
const CAMINHO_WHATSAPP = require.resolve('../whatsapp');

// ── Stubs ────────────────────────────────────────────────────────────────────
let respostaYoutube = () => null;         // reconfigurado por cada cenário
let respostaGravacao = async () => null;  // idem, para o fallback de gravação
let enviados = [];                        // { minuto, texto }

// O scheduler desestrutura enviarMensagem no carregamento do módulo, então o stub
// precisa delegar para esta variável mutável. Trocar o export depois não teria efeito.
const envioPadrao = async (chatId, texto) => {
  enviados.push({ minuto: minutosDecorridos(), texto });
};
let comportamentoEnvio = envioPadrao;
let consultaTardios = () => [];           // envios que estouraram o prazo e completaram depois

require.cache[CAMINHO_YOUTUBE] = {
  id: CAMINHO_YOUTUBE,
  filename: CAMINHO_YOUTUBE,
  loaded: true,
  exports: {
    buscarTransmissaoAoVivo: async (...args) => respostaYoutube(...args),
    buscarUltimaGravacao: async (...args) => respostaGravacao(...args),
  },
};

require.cache[CAMINHO_WHATSAPP] = {
  id: CAMINHO_WHATSAPP,
  filename: CAMINHO_WHATSAPP,
  loaded: true,
  exports: {
    enviarMensagem: async (chatId, texto) => comportamentoEnvio(chatId, texto),
    enviosConcluidosTardiamente: (chatId, desdeMs) => consultaTardios(chatId, desdeMs),
    encerrarSessao: async () => {},
    estaConectado: () => true,
  },
};

// ── Relógio simulado ─────────────────────────────────────────────────────────
const T0 = 1750000000000;
let agora = T0;
const setTimeoutReal = global.setTimeout;

Date.now = () => agora;
global.setTimeout = (fn, ms) => {
  agora += ms;                       // o tempo "passa" instantaneamente
  return setImmediate(fn);
};

function minutosDecorridos() {
  return (agora - T0) / 60000;
}

// scheduler precisa ser carregado DEPOIS dos stubs entrarem no require.cache
const { monitorarAoVivo, mensagemAtraso, marcarJanela, janelaMarcada, enviarGravacao } = require('../scheduler');

const TEXTO_AVISO = mensagemAtraso();
const ehAviso = (e) => e.texto === TEXTO_AVISO;
const ehLink = (e) => !ehAviso(e);

// ── Cenários ─────────────────────────────────────────────────────────────────
const JANELAS = {
  'domingo-manha': { maxTentativas: 36, filtroHoras: 8, avisoAposMin: 9, inicio: '09h54', avisoEsperado: '10h03' },
  'domingo-noite': { maxTentativas: 31, filtroHoras: 7, avisoAposMin: 4, inicio: '18h59', avisoEsperado: '19h03' },
  'quarta-noite':  { maxTentativas: 36, filtroHoras: 7, avisoAposMin: 9, inicio: '19h54', avisoEsperado: '20h03' },
};

const VIDEO_FALSO = { id: 'x', titulo: 'Culto da Família', url: 'https://y/x', fonte: 'live' };

let falhas = 0;

function checar(descricao, condicao, detalhe = '') {
  const marca = condicao ? '  ✅' : '  ❌';
  console.log(`${marca} ${descricao}${detalhe ? ` ${detalhe}` : ''}`);
  if (!condicao) falhas++;
}

async function cenario(nome, janela, chave, configurarYoutube, envio = envioPadrao, tardios = () => []) {
  enviados = [];
  agora = T0;
  respostaYoutube = configurarYoutube;
  comportamentoEnvio = envio;
  consultaTardios = tardios;

  const enviouLink = await monitorarAoVivo({
    chave,
    maxTentativas: janela.maxTentativas,
    nomeGrupo: 'grupo@g.us',
    apiKey: 'fake',
    channelId: 'UCfake',
    filtroHoras: janela.filtroHoras,
    avisoAposMin: janela.avisoAposMin,
  });

  return { enviouLink, avisos: enviados.filter(ehAviso), links: enviados.filter(ehLink) };
}

async function main() {
  console.log('\n═══ Simulação do aviso de atraso ═══\n');

  // Cenário 1: nunca acha o link → aviso sai uma vez, no minuto certo
  for (const [chave, janela] of Object.entries(JANELAS)) {
    console.log(`▶ ${chave}: transmissão nunca aparece (início ${janela.inicio})`);
    const r = await cenario('sem-link', janela, `${chave}-sem-link`, () => null);

    checar('aviso enviado exatamente 1 vez', r.avisos.length === 1, `(enviados: ${r.avisos.length})`);
    if (r.avisos.length > 0) {
      const min = r.avisos[0].minuto;
      const dentroDoPrazo = min >= janela.avisoAposMin && min < janela.avisoAposMin + 1;
      checar(
        `aviso no minuto correto (esperado ${janela.avisoEsperado}, ou seja ${janela.avisoAposMin}min após o início)`,
        dentroDoPrazo,
        `→ saiu em ${min.toFixed(1)}min`
      );
    }
    checar('nenhum link enviado', r.links.length === 0);
    checar('função retornou false', r.enviouLink === false);
    console.log('');
  }

  // Cenário 2: acha o link ANTES do prazo → aviso não sai
  {
    const janela = JANELAS['domingo-manha'];
    console.log('▶ domingo-manha: link aparece na 3ª tentativa (antes do prazo do aviso)');
    let n = 0;
    const r = await cenario('link-cedo', janela, 'manha-link-cedo', () => (++n >= 3 ? VIDEO_FALSO : null));

    checar('nenhum aviso enviado', r.avisos.length === 0, `(enviados: ${r.avisos.length})`);
    checar('link enviado 1 vez', r.links.length === 1);
    checar('função retornou true', r.enviouLink === true);
    console.log('');
  }

  // Cenário 3: acha o link DEPOIS do prazo → aviso sai antes, link depois
  {
    const janela = JANELAS['domingo-noite'];
    console.log('▶ domingo-noite: link só aparece na 15ª tentativa (depois do prazo do aviso)');
    let n = 0;
    const r = await cenario('link-tarde', janela, 'noite-link-tarde', () => (++n >= 15 ? VIDEO_FALSO : null));

    checar('aviso enviado exatamente 1 vez', r.avisos.length === 1, `(enviados: ${r.avisos.length})`);
    checar('link enviado depois do aviso', r.links.length === 1 && r.avisos[0].minuto < r.links[0].minuto);
    checar('função retornou true', r.enviouLink === true);
    console.log('');
  }

  // Cenário 4: envio do aviso falha → tenta de novo na tentativa seguinte, sem duplicar
  {
    const janela = JANELAS['quarta-noite'];
    console.log('▶ quarta-noite: 1º envio do aviso falha (WhatsApp instável)');
    let tentativasDeEnvio = 0;
    const envioQueFalhaUmaVez = async (chatId, texto) => {
      if (++tentativasDeEnvio === 1) throw new Error('socket timeout simulado');
      enviados.push({ minuto: minutosDecorridos(), texto });
    };

    const r = await cenario('aviso-falha', janela, 'quarta-aviso-falha', () => null, envioQueFalhaUmaVez);

    checar('houve 2 tentativas de envio (1 falha + 1 sucesso)', tentativasDeEnvio === 2, `(tentativas: ${tentativasDeEnvio})`);
    checar('aviso entregue 1 vez só', r.avisos.length === 1, `(entregues: ${r.avisos.length})`);
    if (r.avisos.length === 1) {
      checar(
        'reenvio aconteceu na tentativa seguinte (1 min depois)',
        Math.abs(r.avisos[0].minuto - (janela.avisoAposMin + 1)) < 0.01,
        `→ entregue em ${r.avisos[0].minuto.toFixed(1)}min`
      );
    }
    console.log('');
  }

  // Cenário 5: janela com aviso desligado (sábado, culto em teste) → nunca avisa
  {
    console.log('▶ sabado-noite: transmissão nunca aparece e avisoAposMin é null (culto em teste)');
    // O culto de sábado ainda é experimento da igreja: janela vazia é resultado esperado,
    // não incidente. avisoAposMin: null precisa segurar o aviso a janela INTEIRA — o teste
    // roda as 41 tentativas para provar que nenhum minuto dispara a mensagem.
    const janela = { maxTentativas: 41, filtroHoras: 7, avisoAposMin: null };
    const r = await cenario('sem-aviso', janela, 'sabado-sem-aviso', () => null);

    checar('nenhum aviso enviado na janela inteira', r.avisos.length === 0, `(enviados: ${r.avisos.length})`);
    checar('nenhum link enviado', r.links.length === 0);
    checar('função retornou false', r.enviouLink === false);
    console.log('');
  }

  // Cenário 6: o triplo envio de 23/08 — o processo renasce e a janela NÃO reenvia
  {
    const janela = JANELAS['domingo-manha'];
    console.log('▶ mesma janela executada de novo (restart do systemd): registro em disco segura o reenvio');
    // No dia real: link enviado às ~10h, desligar() → exit → systemd religa → recuperação de
    // janela perdida reexecutava com a live ainda no ar → link de novo, três vezes. Aqui as
    // duas execuções usam a MESMA chave, como dois processos sucessivos fariam.
    let n = 0;
    const r1 = await cenario('link-1a-vez', janela, 'manha-restart', () => (++n >= 2 ? VIDEO_FALSO : null));
    checar('primeira execução enviou o link', r1.enviouLink === true && r1.links.length === 1);

    const r2 = await cenario('link-2a-vez', janela, 'manha-restart', () => VIDEO_FALSO);
    checar('segunda execução não enviou NADA', r2.links.length === 0, `(links: ${r2.links.length})`);
    checar('e retornou null (nem desliga, nem fallback)', r2.enviouLink === null, `→ ${r2.enviouLink}`);
    console.log('');
  }

  // Cenário 7: o aviso de atraso também não repete quando o processo renasce
  {
    const janela = JANELAS['quarta-noite'];
    console.log('▶ restart no MEIO da janela: o sucessor reexecuta a janela sem repetir o aviso');
    // O processo anterior morreu no meio da janela (teto de vida, deploy): o aviso já tinha
    // saído e está registrado em disco, mas a janela NÃO terminou — nada de 'encerrada'. O
    // sucessor pode (e deve) reexecutar a janela; só o aviso é que não pode repetir.
    marcarJanela('aviso', 'quarta-restart');
    const r = await cenario('aviso-2a-vez', janela, 'quarta-restart', () => null);
    checar('a execução rodou a janela até o fim', r.enviouLink === false, `→ ${r.enviouLink}`);
    checar('sem repetir o aviso registrado em disco', r.avisos.length === 0, `(avisos: ${r.avisos.length})`);
    console.log('');
  }

  // Cenário 8: janela que rodou ATÉ O FIM sem link não reexecuta (registro 'encerrada')
  {
    const janela = JANELAS['quarta-noite'];
    console.log('▶ janela esgotada reexecutada (restart após o fim): nem reabre');
    // Diferente do cenário 7: aqui a primeira execução esgotou as tentativas e registrou
    // 'encerrada'. Reabrir não traria link (as tentativas do dia acabaram) e podia duplicar
    // a gravação do fallback no domingo à noite.
    const r1 = await cenario('esgotada-1a-vez', janela, 'quarta-esgotada', () => null);
    checar('primeira execução terminou sem link', r1.enviouLink === false, `→ ${r1.enviouLink}`);

    const r2 = await cenario('esgotada-2a-vez', janela, 'quarta-esgotada', () => VIDEO_FALSO);
    checar('segunda execução retornou null (nem reabriu)', r2.enviouLink === null, `→ ${r2.enviouLink}`);
    checar('e não enviou nada', r2.links.length === 0 && r2.avisos.length === 0);
    console.log('');
  }

  // Cenário 9: envio do link estoura o prazo mas completa depois → a tentativa seguinte
  // absorve a conclusão tardia em vez de reenviar (2 links no grupo sem nenhum restart)
  {
    const janela = JANELAS['domingo-manha'];
    console.log('▶ envio do link estoura o prazo e completa depois: a tentativa seguinte NÃO reenvia');
    let tentativasDeEnvio = 0;
    const tardios = [];
    const envioQueEstouraMasCompleta = async (chatId, texto) => {
      tentativasDeEnvio++;
      // O envio "de baixo" completa depois do estouro: é o registro que o whatsapp.js real
      // faz quando o comPrazo rejeita e o sendMessage conclui em seguida.
      tardios.push({ chatId, id: 'TARDIO-LINK', texto, em: Date.now() });
      throw new Error('envio para grupo@g.us passou de 120s');
    };
    const r = await cenario(
      'link-tardio', janela, 'manha-link-tardio', () => VIDEO_FALSO,
      envioQueEstouraMasCompleta,
      (chatId, desde) => tardios.filter(t => t.chatId === chatId && t.em >= desde)
    );

    checar('houve UMA única tentativa de envio', tentativasDeEnvio === 1, `(tentativas: ${tentativasDeEnvio})`);
    checar('a janela terminou como enviada', r.enviouLink === true, `→ ${r.enviouLink}`);
    checar('e o link tardio ficou registrado em disco', janelaMarcada('link', 'manha-link-tardio') === true);
    console.log('');
  }

  // Cenário 10: o aviso de atraso tardio também é absorvido, e o link sai normalmente depois
  {
    const janela = JANELAS['quarta-noite'];
    console.log('▶ aviso de atraso estoura o prazo e completa depois: não repete, e o link sai normalmente');
    let tentativasDeAviso = 0;
    const tardios = [];
    const envio = async (chatId, texto) => {
      if (texto === TEXTO_AVISO) {
        tentativasDeAviso++;
        tardios.push({ chatId, id: 'TARDIO-AVISO', texto, em: Date.now() });
        throw new Error('envio para grupo@g.us passou de 120s');
      }
      enviados.push({ minuto: minutosDecorridos(), texto });
    };
    let n = 0;
    const r = await cenario(
      'aviso-tardio', janela, 'quarta-aviso-tardio', () => (++n >= 15 ? VIDEO_FALSO : null),
      envio,
      (chatId, desde) => tardios.filter(t => t.chatId === chatId && t.em >= desde)
    );

    checar('aviso tentado uma única vez', tentativasDeAviso === 1, `(tentativas: ${tentativasDeAviso})`);
    checar('nenhum aviso repetido', r.avisos.length === 0, `(avisos: ${r.avisos.length})`);
    checar('o link saiu 1 vez', r.links.length === 1 && r.enviouLink === true);
    checar('e o aviso tardio ficou registrado em disco', janelaMarcada('aviso', 'quarta-aviso-tardio') === true);
    console.log('');
  }

  // Cenário 11: o fallback de gravação tem a mesma memória em disco do link
  {
    console.log('▶ fallback de gravação executado duas vezes (restart abrupto): a gravação sai uma só');
    enviados = [];
    comportamentoEnvio = envioPadrao;
    respostaGravacao = async () => ({ id: 'g', titulo: 'Culto da Família', url: 'https://y/gravacao' });

    await enviarGravacao('noite-gravacao', 'grupo@g.us', 'fake', 'UCfake');
    await enviarGravacao('noite-gravacao', 'grupo@g.us', 'fake', 'UCfake');

    checar('gravação enviada exatamente 1 vez', enviados.length === 1, `(enviadas: ${enviados.length})`);
    checar('e registrada em disco', janelaMarcada('gravacao', 'noite-gravacao') === true);
    respostaGravacao = async () => null;
    console.log('');
  }

  // Cenário 12: escrita do registro principal falha → a reserva dentro do AUTH_DIR assume
  {
    console.log('▶ memória de janela: arquivo principal sem escrita, a reserva no AUTH_DIR assume');
    // Sem a reserva, uma falha de escrita repetida virava o pior loop possível: envio → exit
    // → restart → recuperação sem memória → reenvio, até a janela expirar.
    const prefixoPrincipal = path.join(path.dirname(process.env.AUTH_DIR), 'janelas-enviadas.json');
    const writeReal = fs.writeFileSync;
    fs.writeFileSync = (arquivo, ...args) => {
      if (String(arquivo).startsWith(prefixoPrincipal)) throw new Error('EACCES simulado');
      return writeReal.call(fs, arquivo, ...args);
    };
    let marcou;
    try {
      marcou = marcarJanela('link', 'teste-reserva', { url: 'https://y/x' });
    } finally {
      fs.writeFileSync = writeReal;
    }

    checar('marcarJanela reportou sucesso pela reserva', marcou === true, `→ ${marcou}`);
    checar('a marca vale na leitura (união dos dois arquivos)', janelaMarcada('link', 'teste-reserva') === true);
    checar('o arquivo reserva existe dentro do AUTH_DIR', fs.existsSync(path.join(process.env.AUTH_DIR, 'janelas-enviadas.json')));
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

main().catch(err => {
  global.setTimeout = setTimeoutReal;
  console.error('Erro na simulação:', err);
  process.exit(1);
});
