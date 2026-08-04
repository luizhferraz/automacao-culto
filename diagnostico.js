/**
 * Registro em disco do que aconteceu em cada janela de envio.
 *
 * Por que isso existe: no domingo 02/08 o bot rodou exatamente como projetado e mesmo assim
 * houve gente sem receber o link. Não deu para saber qual dos mecanismos falhou porque os
 * logs tinham ido para o stdout de uma máquina que já estava desligada. O `fly logs` só
 * mostra o fluxo ao vivo, e não há shipping configurado, então a evidência simplesmente
 * evaporou junto com o processo.
 *
 * Aqui o log da biblioteca do WhatsApp vai para um arquivo no volume, em nível `debug`,
 * junto com um resumo estruturado por janela. As linhas que decidem o diagnóstico são:
 *
 *   'sending new sender key'            → a lista de aparelhos que receberam a chave de grupo
 *   'Failed to encrypt for recipient'   → quem ficou de fora, com o jid, um por linha
 *   'found message via getMessage'      → pedido de reenvio atendido pelo histórico em disco
 *   'recv retry request, but message not available' → pedido que chegou sem a mensagem
 *
 * Comparar a primeira com a segunda dá a lista nominal de quem não recebeu.
 */

const fs = require('fs');
const path = require('path');
const pino = require('pino');

const AUTH_DIR = process.env.AUTH_DIR || '.baileys_auth';
const DIR = process.env.DIAG_DIR || path.join(path.dirname(AUTH_DIR), 'diagnostico');

// Nível do arquivo. 'debug' é o que faz aparecer a lista de aparelhos da sender key; o
// stdout continua no nível enxuto, para o `fly logs` seguir legível durante o culto.
const NIVEL_ARQUIVO = process.env.DIAG_LOG_LEVEL || 'debug';
const NIVEL_STDOUT = process.env.BAILEYS_LOG_LEVEL || 'warn';

const MAX_ARQUIVOS = Number(process.env.DIAG_MAX_ARQUIVOS || 20);

// Carimbo de tempo em horário local, seguro para nome de arquivo: 2026-08-09_09-54-01
function carimbo(momento = new Date()) {
  const p = (n) => String(n).padStart(2, '0');
  return (
    `${momento.getFullYear()}-${p(momento.getMonth() + 1)}-${p(momento.getDate())}` +
    `_${p(momento.getHours())}-${p(momento.getMinutes())}-${p(momento.getSeconds())}`
  );
}

// Mantém só os arquivos mais recentes. O volume tem 1 GB, mas deixar crescer para sempre é
// como se perde disco sem perceber.
//
// Os dois tipos são rotacionados separadamente de propósito: os nomes são `<carimbo>.log` e
// `resumo-<carimbo>.json`, então uma ordenação única colocaria TODOS os logs antes de
// qualquer resumo, e a poda apagaria os logs mais novos enquanto guardava resumos velhos.
function limparAntigos() {
  try {
    const todos = fs.readdirSync(DIR);
    const grupos = [
      todos.filter(a => a.endsWith('.log')),
      todos.filter(a => a.startsWith('resumo-') && a.endsWith('.json')),
    ];
    for (const grupo of grupos) {
      // O carimbo é ordenável como texto, então ordenar já é ordenar por data.
      const ordenados = grupo.sort();
      for (let i = 0; i < ordenados.length - MAX_ARQUIVOS; i++) {
        fs.unlinkSync(path.join(DIR, ordenados[i]));
      }
    }
  } catch { /* diagnóstico nunca pode derrubar o envio */ }
}

const CARIMBO_EXECUCAO = carimbo();

let destino = null;
let loggerCache = null;

/**
 * Logger para passar ao Baileys. Criado uma vez só por processo: o `opcoesSocket` é chamado
 * mais de uma vez (envio e pareamento), e criar o destino lá dentro daria um arquivo por
 * socket, cada um com um pedaço da história.
 */
function logger() {
  if (loggerCache) return loggerCache;

  try {
    fs.mkdirSync(DIR, { recursive: true });
    limparAntigos();
    destino = pino.destination({
      dest: path.join(DIR, `${CARIMBO_EXECUCAO}.log`),
      sync: false,
      mkdir: true,
    });
    loggerCache = pino(
      { level: 'debug' },
      pino.multistream([
        { level: NIVEL_STDOUT, stream: process.stdout },
        { level: NIVEL_ARQUIVO, stream: destino },
      ])
    );
  } catch (err) {
    // Volume cheio, somente leitura, o que for. Sem diagnóstico é ruim; sem envio é pior.
    console.warn(`[Diagnóstico] Não consegui abrir o log em disco (${err.message}). Seguindo só com stdout.`);
    loggerCache = pino({ level: NIVEL_STDOUT });
  }

  return loggerCache;
}

/** Resumo estruturado da janela, para responder na segunda-feira sem reconstituir nada. */
function gravarResumo(resumo) {
  try {
    fs.mkdirSync(DIR, { recursive: true });
    const arquivo = path.join(DIR, `resumo-${CARIMBO_EXECUCAO}.json`);
    fs.writeFileSync(arquivo, JSON.stringify(resumo, null, 2));
    return arquivo;
  } catch (err) {
    console.warn(`[Diagnóstico] Não consegui gravar o resumo (${err.message}).`);
    return null;
  }
}

/**
 * Descarrega o que está no buffer do pino. Precisa ser síncrono: o processo chama
 * process.exit logo em seguida e o Fly desmonta o volume, então uma escrita assíncrona
 * pendente some justamente na hora em que ela mais importa.
 */
function encerrar() {
  try { destino?.flushSync(); } catch { /* nada a fazer se já fechou */ }
}

module.exports = { logger, gravarResumo, encerrar, DIR, CARIMBO_EXECUCAO };
