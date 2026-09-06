/**
 * O gatilho do cron e a vigência (scheduler.js, iniciarAgendamentos).
 *
 * Por que existe: "depois do último dia a janela cala sozinha" depende, na operação normal,
 * de UMA linha — o `if (!janelaVigente(janela)) return;` dentro do callback registrado no
 * node-cron. A recuperação de janela perdida (coberta em testes/simular-youtube.js) só entra
 * quando o processo sobe DENTRO da janela; todo dia útil às 6h25 com o bot já de pé, quem
 * decide é o callback. Antes deste teste, apagar a checagem passava a suíte inteira.
 *
 * Roda o iniciarAgendamentos real com:
 *   • node-cron → dublê que só guarda o callback de cada janela (nada dispara sozinho)
 *   • ./youtube e ./whatsapp → dublês que registram buscas e envios
 *   • relógio congelado no Date INTEIRO (não só Date.now), porque o callback chama
 *     janelaVigente(janela) sem argumento e a recuperação da subida usa new Date()
 * e dispara os callbacks à mão, em dias dentro e fora da vigência.
 *
 * Uso: node testes/simular-agendamento.js
 */

const path = require('path');
const fs = require('fs');
const os = require('os');

process.env.AUTH_DIR = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'culto-agendamento-')), 'baileys_auth');

// ── Relógio congelado ────────────────────────────────────────────────────────
const DateReal = Date;
let agoraFixo = DateReal.parse('2026-09-13T15:00:00.000Z'); // domingo 13/09 12h00 BRT, fora de janela
global.Date = class extends DateReal {
  constructor(...args) {
    if (args.length === 0) super(agoraFixo); else super(...args);
  }
  static now() { return agoraFixo; }
};
const congelarEm = (iso) => { agoraFixo = DateReal.parse(iso); };

// ── Dublês ───────────────────────────────────────────────────────────────────
const registrados = [];  // { expr, fn, opts } por cron.schedule
const CAMINHO_CRON = require.resolve('node-cron');
require.cache[CAMINHO_CRON] = {
  id: CAMINHO_CRON, filename: CAMINHO_CRON, loaded: true,
  exports: { schedule: (expr, fn, opts) => { registrados.push({ expr, fn, opts }); return { stop() {} }; } },
};

let buscas = 0;
const CAMINHO_YOUTUBE = require.resolve('../youtube');
require.cache[CAMINHO_YOUTUBE] = {
  id: CAMINHO_YOUTUBE, filename: CAMINHO_YOUTUBE, loaded: true,
  exports: {
    buscarTransmissaoAoVivo: async () => { buscas++; return { id: 'x', titulo: 'Culto', url: 'https://y/x', fonte: 'live' }; },
    buscarUltimaGravacao: async () => null,
  },
};

const enviados = [];
let encerramentos = 0;
const CAMINHO_WHATSAPP = require.resolve('../whatsapp');
require.cache[CAMINHO_WHATSAPP] = {
  id: CAMINHO_WHATSAPP, filename: CAMINHO_WHATSAPP, loaded: true,
  exports: {
    enviarMensagem: async (chatId, texto) => { enviados.push({ chatId, texto }); },
    enviosConcluidosTardiamente: () => [],
    encerrarSessao: async () => { encerramentos++; return null; },
    estaConectado: () => true,
  },
};

// O desligar() do scheduler agenda process.exit; aqui ele só é anotado.
const exitReal = process.exit;
const saidas = [];
process.exit = (codigo) => { saidas.push(codigo); };

// As linhas do scheduler vão para um vetor (para checar o log do gatilho) em vez da tela.
const linhas = [];
const logReal = console.log;
console.log = (...args) => { linhas.push(args.join(' ')); };
const dizer = (texto) => logReal(texto);

const { iniciarAgendamentos, JANELAS, janelaMarcada } = require('../scheduler');

let falhas = 0;
function checar(descricao, condicao, detalhe = '') {
  dizer(`${condicao ? '  ✅' : '  ❌'} ${descricao}${detalhe ? ` ${detalhe}` : ''}`);
  if (!condicao) falhas++;
}

// Deixa as promessas do executarJanela (busca → envio → registro → desligar) correrem.
const assentar = () => new Promise(r => setTimeout(r, 30));

// A janela do mecanismo, própria do teste: não depende da entrada temporária da tabela.
const FIXTURE = {
  chave: 'fixture-semana', rotulo: 'Fixture seg a sex 06h25', diaSemana: [1, 2, 3, 4, 5],
  hora: 6, minuto: 25, maxTentativas: 35, filtroHoras: 7, avisoAposMin: null, fallbackGravacao: false,
  vigencia: { de: '2026-09-14', ate: '2026-09-18' },
};
const FIXAS = JANELAS.filter(j => !j.vigencia);
const CONFIG = { apiKey: 'fake', channelId: 'UCfake', nomeGrupo: 'grupo@g.us' };

// Só a linha do GATILHO: o log de subida também diz "fora da vigência hoje", e não é ele.
const linhasForaDaVigencia = () => linhas.filter(l => l.includes('Gatilho de') && l.includes('fora da vigência')).length;

async function main() {
  dizer('\n═══ Gatilho do cron e vigência ═══\n');

  // 1: a subida registra uma tarefa por janela, com a expressão e as opções certas
  {
    dizer('▶ subida no domingo 13/09 ao meio-dia: registra as janelas, não recupera nenhuma');
    iniciarAgendamentos(CONFIG, [...FIXAS, FIXTURE]);
    await assentar();

    checar('uma tarefa de cron por janela', registrados.length === FIXAS.length + 1, `→ ${registrados.length}`);
    const fixture = registrados.find(r => r.expr === '25 6 * * 1,2,3,4,5');
    checar('a fixture foi registrada com a lista de dias', !!fixture);
    checar('com o fuso da igreja e recoverMissedExecutions', fixture?.opts?.timezone === 'America/Sao_Paulo' && fixture?.opts?.recoverMissedExecutions === true, `→ ${JSON.stringify(fixture?.opts)}`);
    checar('nenhuma busca na subida (fora de qualquer janela)', buscas === 0, `→ ${buscas}`);
    checar('o log de subida mostra a vigência da fixture', linhas.some(l => l.includes('Fixture seg a sex 06h25') && l.includes('só de 2026-09-14 a 2026-09-18') && l.includes('fora da vigência hoje')));
    dizer('');
  }

  const gatilho = registrados.find(r => r.expr === '25 6 * * 1,2,3,4,5').fn;
  // O node-cron passa a data casada como argumento do callback.
  const disparar = (iso) => { congelarEm(iso); gatilho(new Date(iso)); };

  // 2: gatilho ANTES da vigência: nada
  {
    dizer('▶ segunda 07/09 às 06h25, antes da vigência: o gatilho não abre a janela');
    disparar('2026-09-07T09:25:00.000Z');
    await assentar();

    checar('nenhuma busca', buscas === 0, `→ ${buscas}`);
    checar('nada enviado', enviados.length === 0);
    checar('uma linha no journal explicando', linhasForaDaVigencia() === 1, `→ ${linhasForaDaVigencia()}`);
    dizer('');
  }

  // 3: gatilho no PRIMEIRO dia da vigência: a janela roda de ponta a ponta
  {
    dizer('▶ segunda 14/09 às 06h25, primeiro dia da vigência: a janela abre, acha o culto e envia');
    disparar('2026-09-14T09:25:00.000Z');
    await assentar();

    checar('uma busca no YouTube', buscas === 1, `→ ${buscas}`);
    checar('o link foi enviado uma vez', enviados.length === 1 && enviados[0].texto.includes('https://y/x'), `→ ${enviados.length}`);
    checar('registrado na memória em disco do dia 14', janelaMarcada('link', 'fixture-semana', new Date('2026-09-14T09:25:00.000Z')) === true);
    checar('e a janela desligou o processo ao terminar', encerramentos === 1, `→ ${encerramentos}`);
    dizer('');
  }

  // 4: o node-cron 3.0.3 com recoverMissedExecutions pode chamar o mesmo segundo duas vezes.
  // A segunda chamada não pode virar outra janela (nem outra linha no journal).
  {
    dizer('▶ o mesmo segundo entregue duas vezes pelo node-cron: só a primeira conta');
    congelarEm('2026-09-15T09:25:00.400Z');
    gatilho(new Date('2026-09-15T09:25:00.400Z'));
    gatilho(new Date('2026-09-15T09:25:00.900Z'));
    await assentar();

    checar('terça 15/09: uma busca só para as duas chamadas', buscas === 2, `→ ${buscas}`);
    checar('um envio só', enviados.length === 2, `→ ${enviados.length}`);

    const antes = linhasForaDaVigencia();
    congelarEm('2026-09-21T09:25:00.100Z');
    gatilho(new Date('2026-09-21T09:25:00.100Z'));
    gatilho(new Date('2026-09-21T09:25:00.700Z'));
    await assentar();
    checar('fora da vigência, duas chamadas no mesmo segundo geram uma linha só', linhasForaDaVigencia() === antes + 1, `→ ${linhasForaDaVigencia() - antes}`);
    dizer('');
  }

  // 5: gatilho no ÚLTIMO dia da vigência ainda roda; no dia seguinte da lista, não
  {
    dizer('▶ sexta 18/09 roda; segunda 21/09 e sexta 25/09, depois da vigência, não');
    disparar('2026-09-18T09:25:00.000Z');
    await assentar();
    checar('sexta 18/09: busca e envio', buscas === 3 && enviados.length === 3, `→ buscas ${buscas}, envios ${enviados.length}`);

    disparar('2026-09-21T09:25:00.000Z');
    disparar('2026-09-25T09:25:00.000Z');
    await assentar();
    checar('21/09 e 25/09: nenhuma busca a mais', buscas === 3, `→ ${buscas}`);
    checar('nenhum envio a mais', enviados.length === 3, `→ ${enviados.length}`);
    dizer('');
  }

  // 6: janela sem vigência dispara sempre — a checagem não pode calar as janelas fixas
  {
    dizer('▶ domingo 20/09 às 09h53: a janela fixa da manhã dispara normalmente');
    const manha = registrados.find(r => r.expr === '53 9 * * 0').fn;
    congelarEm('2026-09-20T12:53:00.000Z');
    manha(new Date('2026-09-20T12:53:00.000Z'));
    await assentar();

    checar('uma busca a mais', buscas === 4, `→ ${buscas}`);
    checar('um envio a mais', enviados.length === 4, `→ ${enviados.length}`);
    dizer('');
  }

  dizer('═══════════════════════════════════');
  if (falhas === 0) {
    dizer('✅ Todos os cenários passaram.\n');
    exitReal(0);
  }
  dizer(`❌ ${falhas} verificação(ões) falharam.\n`);
  exitReal(1);
}

main().catch(err => {
  console.log = logReal;
  console.error('Erro na simulação:', err);
  exitReal(1);
});
