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

const CAMINHO_YOUTUBE = require.resolve('../youtube');
const CAMINHO_WHATSAPP = require.resolve('../whatsapp');

// ── Stubs ────────────────────────────────────────────────────────────────────
let respostaYoutube = () => null;   // reconfigurado por cada cenário
let enviados = [];                  // { minuto, texto }

// O scheduler desestrutura enviarMensagem no carregamento do módulo, então o stub
// precisa delegar para esta variável mutável. Trocar o export depois não teria efeito.
const envioPadrao = async (chatId, texto) => {
  enviados.push({ minuto: minutosDecorridos(), texto });
};
let comportamentoEnvio = envioPadrao;

require.cache[CAMINHO_YOUTUBE] = {
  id: CAMINHO_YOUTUBE,
  filename: CAMINHO_YOUTUBE,
  loaded: true,
  exports: {
    buscarTransmissaoAoVivo: async (...args) => respostaYoutube(...args),
    buscarUltimaGravacao: async () => null,
  },
};

require.cache[CAMINHO_WHATSAPP] = {
  id: CAMINHO_WHATSAPP,
  filename: CAMINHO_WHATSAPP,
  loaded: true,
  exports: {
    enviarMensagem: async (chatId, texto) => comportamentoEnvio(chatId, texto),
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
const { monitorarAoVivo, mensagemAtraso } = require('../scheduler');

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

async function cenario(nome, janela, chave, configurarYoutube, envio = envioPadrao) {
  enviados = [];
  agora = T0;
  respostaYoutube = configurarYoutube;
  comportamentoEnvio = envio;

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
