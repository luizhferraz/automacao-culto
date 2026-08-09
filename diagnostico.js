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

const NIVEL_STDOUT = process.env.BAILEYS_LOG_LEVEL || 'warn';

const MAX_ARQUIVOS = Number(process.env.DIAG_MAX_ARQUIVOS || 20);

// Teto por arquivo. Medido em produção: em `debug` puro o Baileys escreve cerca de 1 MB por
// minuto quando drena a fila de uma semana, e a maior parte é falha de descriptografia de
// mensagem RECEBIDA, que não tem nada a ver com o problema de entrega. Uma conexão ociosa de
// um dia encheria o volume inteiro.
const MAX_BYTES = Number(process.env.DIAG_MAX_BYTES || 8 * 1024 * 1024);

// As linhas do Baileys que importam para o diagnóstico de entrega. Todas são nível `debug`,
// então não dá para filtrar por nível: ou se pega pelo texto, ou se paga 1 MB por minuto.
// As de nível `warn` para cima entram sempre, independente desta lista, e é por elas que
// 'Failed to encrypt for recipient' (nível error) aparece.
const FRASES_DE_INTERESSE = [
  'sending new sender key',            // a lista de aparelhos que receberam a chave de grupo
  'Failed to encrypt for recipient',   // quem ficou de fora, com o jid
  'fetching sessions',                 // para quem foi buscado pacote de chaves novo
  'found message via getMessage',      // pedido de reenvio atendido pelo histórico em disco
  'recv retry request, but message not available',
  'prepared session for retry resend',
];

// Níveis do pino: trace 10, debug 20, info 30, warn 40, error 50, fatal 60.
const NIVEIS_SEMPRE = ['"level":40', '"level":50', '"level":60'];

/**
 * Fluxo que só deixa passar o que serve para diagnosticar entrega, com teto de bytes.
 *
 * A comparação é por texto na linha já serializada de propósito: fazer JSON.parse de cada
 * registro para depois jogar 95% fora sairia mais caro do que a economia.
 */
function fluxoFiltrado(destinoArquivo) {
  let escritos = 0;
  let avisouDoTeto = false;

  return {
    write(linha) {
      if (escritos >= MAX_BYTES) {
        if (!avisouDoTeto) {
          avisouDoTeto = true;
          console.warn(`[Diagnóstico] Log atingiu o teto de ${Math.round(MAX_BYTES / 1024 / 1024)} MB e parou de crescer.`);
        }
        return;
      }
      const interessa =
        NIVEIS_SEMPRE.some(n => linha.includes(n)) ||
        FRASES_DE_INTERESSE.some(f => linha.includes(f));
      if (!interessa) return;
      escritos += linha.length;
      destinoArquivo.write(linha);
    },
  };
}

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

/**
 * Silencia um console.info da libsignal que vaza material criptográfico.
 *
 * Em node_modules/libsignal/src/session_record.js a biblioteca faz, ao fechar uma sessão:
 *
 *     console.info("Closing session:", session);
 *
 * O objeto `session` traz o ratchet inteiro, incluindo `ephemeralKeyPair.privKey` e a
 * `rootKey`. Isso vai direto para o stdout, que no Fly vira log retido e transmitido.
 *
 * Fechar sessão é raro no uso normal, então isso passava despercebido. Com FORCAR_SESSOES
 * ligado o bot recria as sessões dos ~850 aparelhos do grupo de uma vez, e aí são 850
 * despejos de chave privada no log, cada um com dezenas de linhas. Além do vazamento, são 850
 * escritas síncronas em stdout numa máquina de 1 vCPU, no minuto mais sensível da janela.
 *
 * Não dá para configurar isso na biblioteca: é console.info direto. A saída é interceptar, e
 * só esta mensagem. Qualquer outro console.info continua passando.
 */
function silenciarVazamentoDeSessao() {
  const original = console.info.bind(console);
  console.info = (...args) => {
    if (typeof args[0] === 'string' && args[0].startsWith('Closing session:')) return;
    original(...args);
  };
}

silenciarVazamentoDeSessao();

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
    // Escrita síncrona de propósito. Com `sync: false` o sonic-boom abre o descritor de forma
    // assíncrona, e um processo que morre logo (erro fatal, SIGTERM apertado) some com o
    // arquivo inteiro, justamente no caso em que o log mais importa. Depois do filtro acima
    // sobram poucas centenas de linhas por janela, então bloquear para escrever não custa nada.
    destino = pino.destination({
      dest: path.join(DIR, `${CARIMBO_EXECUCAO}.log`),
      sync: true,
      mkdir: true,
    });
    loggerCache = pino(
      { level: 'debug' },
      pino.multistream([
        { level: NIVEL_STDOUT, stream: process.stdout },
        { level: 'debug', stream: fluxoFiltrado(destino) },
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
