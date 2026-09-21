// Servidor da UI admin das janelas de culto: só HTTP local (http puro, sem framework — são
// cinco rotas e um arquivo estático, não vale a dependência extra num processo que já lida com
// a sessão do WhatsApp). Escuta em 127.0.0.1 sempre, sem opção de mudar por env: a garantia de
// segurança inteira deste desenho é "impossível alcançar de fora da VM", e uma variável de
// ambiente mal setada não pode apagar isso. Quem precisa mexer entra por túnel SSH
// (`ssh -L 8080:localhost:8080 usuario@vm`) e usa como se fosse local — ver admin/README.md.
//
// A tabela de janelas em si — formato, validação, onde o arquivo mora — é toda do scheduler.js;
// este servidor só lê, edita e grava de volta usando as mesmas funções que o bot usa para ler,
// para as duas pontas nunca discordarem sobre o que é uma tabela válida.
'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');
const {
  ARQUIVO_CONFIG_JANELAS,
  JANELAS_PADRAO,
  validarTabela,
  gravarAtomico,
  carregarTabelaJanelas,
} = require('../scheduler');

const HOST = '127.0.0.1';
const PORTA = Number(process.env.ADMIN_PORT || 8080);

const ARQUIVO_INDEX = path.join(__dirname, 'public', 'index.html');

// Padrões para os campos que a UI ainda não expõe (ver admin/README.md). São os mesmos valores
// que a maioria das janelas da tabela embutida já usa — não é um chute, é o caso comum.
const PADROES_CAMPOS_AVANCADOS = { filtroHoras: 8, fallbackGravacao: false };

// Quantos minutos o aviso de atraso demora pra sair quando a janela liga o aviso (campo
// "aviso" do payload). É o mesmo valor que domingo-manha, domingo-noite e quarta-noite já
// usam em JANELAS_PADRAO — a UI só liga/desliga, não deixa escolher o número ainda.
const AVISO_MIN_PADRAO = 8;

function paraMinutos(hhmm) {
  const [h, m] = hhmm.split(':').map(Number);
  return h * 60 + m;
}

function diasDaJanela(j) {
  return Array.isArray(j.diaSemana) ? j.diaSemana : [j.diaSemana];
}

// Duas janelas com vigência só podem colidir de verdade se os períodos se cruzarem. Sem isto,
// uma "quarta especial" só válida em dezembro bloquearia para sempre a quarta-noite normal, que
// nunca vai tocar de fato nela. Se qualquer uma das duas vale sempre (sem vigência), os
// períodos sempre se cruzam — é o comportamento de hoje, preservado.
function vigenciasSobrepoem(a, b) {
  if (!a.vigencia || !b.vigencia) return true;
  return a.vigencia.de <= b.vigencia.ate && b.vigencia.de <= a.vigencia.ate;
}

// Sobreposição de horário entre duas janelas que compartilham ao menos um dia da semana (e,
// se as duas tiverem vigência, um período em comum). validarTabela (scheduler.js) não checa
// isto — pro bot, duas janelas ao mesmo tempo são só duas tentativas simultâneas, não um erro.
// Pra uma agenda de cultos, é quase sempre engano.
function conflitam(a, b) {
  const emComum = diasDaJanela(a).some(d => diasDaJanela(b).includes(d));
  if (!emComum) return false;
  if (!vigenciasSobrepoem(a, b)) return false;
  const inicioA = a.hora * 60 + a.minuto, fimA = inicioA + a.maxTentativas;
  const inicioB = b.hora * 60 + b.minuto, fimB = inicioB + b.maxTentativas;
  return inicioA < fimB && inicioB < fimA;
}

function normalizarSlug(texto) {
  return texto
    .normalize('NFD').replace(/[̀-ͯ]/g, '') // remove acento
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

function gerarChave(nome, chavesExistentes) {
  const base = normalizarSlug(nome) || 'janela';
  if (!chavesExistentes.has(base)) return base;
  let n = 2;
  while (chavesExistentes.has(`${base}-${n}`)) n++;
  return `${base}-${n}`;
}

// Converte o payload da UI (nome/início/fim/dias/aviso/vigência) para o formato de linha da
// tabela real. `chave` já existente é passada em edição, para nunca ser regerada a partir do
// nome — trocar o nome de uma janela não pode órfã-la na memória de janelas-enviadas.json, que
// indexa por chave.
function paraLinhaDaTabela(payload, chave) {
  const inicioMin = paraMinutos(payload.inicio);
  const fimMin = paraMinutos(payload.fim);
  const [hora, minuto] = payload.inicio.split(':').map(Number);
  const linha = {
    chave,
    rotulo: payload.nome,
    diaSemana: payload.diasSemana.slice().sort((a, b) => a - b),
    hora,
    minuto,
    maxTentativas: fimMin - inicioMin,
    avisoAposMin: payload.aviso ? AVISO_MIN_PADRAO : null,
    ...PADROES_CAMPOS_AVANCADOS,
  };
  if (payload.vigenciaAtiva) {
    linha.vigencia = { de: payload.vigenciaDe, ate: payload.vigenciaAte };
  }
  return linha;
}

function validarPayload(payload) {
  const erros = [];
  if (typeof payload.nome !== 'string' || !payload.nome.trim()) {
    erros.push('nome é obrigatório');
  }
  if (!/^\d{2}:\d{2}$/.test(payload.inicio || '') || !/^\d{2}:\d{2}$/.test(payload.fim || '')) {
    erros.push('início e fim precisam estar no formato HH:MM');
  } else if (paraMinutos(payload.fim) <= paraMinutos(payload.inicio)) {
    erros.push('fim precisa ser depois do início');
  }
  const dias = payload.diasSemana;
  if (!Array.isArray(dias) || dias.length === 0 || dias.some(d => !Number.isInteger(d) || d < 0 || d > 6)) {
    erros.push('diasSemana precisa ser uma lista não vazia de números de 0 a 6');
  }
  if (typeof payload.aviso !== 'boolean') {
    erros.push('aviso precisa ser verdadeiro ou falso');
  }
  // Datas em si (formato, "de" antes de "ate") são validadas por validarJanela — a mesma
  // checagem que o scheduler.js usa — quando a tabela inteira é salva; aqui só garante que,
  // se a vigência está ligada, as duas datas vieram, pra dar um erro claro em vez de deixar
  // "de: undefined" virar uma mensagem confusa lá na frente.
  if (payload.vigenciaAtiva && (!payload.vigenciaDe || !payload.vigenciaAte)) {
    erros.push('período de vigência precisa de data de início e fim');
  }
  return erros;
}

function responderJson(res, status, corpo) {
  const texto = JSON.stringify(corpo);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': Buffer.byteLength(texto) });
  res.end(texto);
}

function lerCorpo(req) {
  return new Promise((resolve, reject) => {
    let dados = '';
    req.on('data', chunk => {
      dados += chunk;
      if (dados.length > 1_000_000) req.destroy(); // corpo absurdo pra este formulário — corta cedo
    });
    req.on('end', () => {
      try {
        resolve(dados ? JSON.parse(dados) : {});
      } catch {
        reject(new Error('JSON inválido'));
      }
    });
    req.on('error', reject);
  });
}

// Lê a tabela atual do arquivo editável (ou a padrão, se ele ainda não existe) e grava de
// volta com o mesmo par leitura-então-escrita que toda edição usa: nunca a JANELAS já
// carregada em memória pelo processo do bot, que só é atualizada na próxima subida dele.
function lerTabelaAtual() {
  return carregarTabelaJanelas();
}

function salvarTabela(tabela) {
  validarTabela(tabela); // redundante com as validações de payload, mas é a garantia final
  gravarAtomico(ARQUIVO_CONFIG_JANELAS, JSON.stringify(tabela, null, 2));
}

async function tratarApi(req, res, partesUrl) {
  if (req.method === 'GET' && partesUrl.length === 0) {
    return responderJson(res, 200, lerTabelaAtual());
  }

  if (req.method === 'POST' && partesUrl.length === 0) {
    let payload;
    try {
      payload = await lerCorpo(req);
    } catch {
      return responderJson(res, 400, { erro: 'JSON inválido' });
    }
    const errosPayload = validarPayload(payload);
    if (errosPayload.length > 0) return responderJson(res, 400, { erro: errosPayload.join('; ') });

    const tabela = lerTabelaAtual();
    const chave = gerarChave(payload.nome, new Set(tabela.map(j => j.chave)));
    const nova = paraLinhaDaTabela(payload, chave);

    const conflito = tabela.find(j => conflitam(nova, j));
    if (conflito) {
      return responderJson(res, 409, { erro: `Conflito de horário com "${conflito.rotulo}" (chave ${conflito.chave})` });
    }

    const proxima = [...tabela, nova];
    try {
      salvarTabela(proxima);
    } catch (err) {
      return responderJson(res, 400, { erro: err.message });
    }
    return responderJson(res, 201, nova);
  }

  if ((req.method === 'PUT' || req.method === 'DELETE') && partesUrl.length === 1) {
    const chave = decodeURIComponent(partesUrl[0]);
    const tabela = lerTabelaAtual();
    const existente = tabela.find(j => j.chave === chave);
    if (!existente) return responderJson(res, 404, { erro: `Janela "${chave}" não encontrada` });

    if (req.method === 'DELETE') {
      const proxima = tabela.filter(j => j.chave !== chave);
      try {
        salvarTabela(proxima);
      } catch (err) {
        return responderJson(res, 400, { erro: err.message });
      }
      return responderJson(res, 204, null);
    }

    let payload;
    try {
      payload = await lerCorpo(req);
    } catch {
      return responderJson(res, 400, { erro: 'JSON inválido' });
    }
    const errosPayload = validarPayload(payload);
    if (errosPayload.length > 0) return responderJson(res, 400, { erro: errosPayload.join('; ') });

    const atualizada = paraLinhaDaTabela(payload, chave);
    const conflito = tabela.find(j => j.chave !== chave && conflitam(atualizada, j));
    if (conflito) {
      return responderJson(res, 409, { erro: `Conflito de horário com "${conflito.rotulo}" (chave ${conflito.chave})` });
    }

    const proxima = tabela.map(j => (j.chave === chave ? atualizada : j));
    try {
      salvarTabela(proxima);
    } catch (err) {
      return responderJson(res, 400, { erro: err.message });
    }
    return responderJson(res, 200, atualizada);
  }

  return responderJson(res, 404, { erro: 'rota não encontrada' });
}

function servirIndex(res) {
  fs.readFile(ARQUIVO_INDEX, (err, conteudo) => {
    if (err) {
      res.writeHead(500);
      return res.end('Não consegui carregar a página admin.');
    }
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(conteudo);
  });
}

const servidor = http.createServer((req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);

  if (url.pathname.startsWith('/api/janelas')) {
    const partesUrl = url.pathname.replace(/^\/api\/janelas\/?/, '').split('/').filter(Boolean);
    tratarApi(req, res, partesUrl).catch(err => {
      console.error('[Admin] Erro tratando requisição:', err);
      responderJson(res, 500, { erro: 'erro interno' });
    });
    return;
  }

  if (req.method === 'GET' && (url.pathname === '/' || url.pathname === '/index.html')) {
    return servirIndex(res);
  }

  res.writeHead(404);
  res.end('não encontrado');
});

servidor.listen(PORTA, HOST, () => {
  // Se isto nunca aparecer, ou aparecer preso a 0.0.0.0 em algum log de infra, o servidor
  // subiu errado: a garantia de segurança do desenho é só ouvir aqui.
  console.log(`Admin de janelas em http://${HOST}:${PORTA} (alcançável só por túnel SSH)`);
  console.log(`Configuração editável em: ${ARQUIVO_CONFIG_JANELAS}`);
  console.log(`Tabela embutida (semente / fallback) tem ${JANELAS_PADRAO.length} janela(s).`);
});

// Exportado só para o teste (testes/simular-admin.js) poder fechar o servidor ao final; rodado
// via `node admin/server.js`, este export não muda nada.
module.exports = { servidor };
