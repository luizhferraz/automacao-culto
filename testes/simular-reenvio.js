/**
 * Testes da correção do "Aguardando mensagem".
 *
 * O bug: o bot enviava a mensagem e matava o processo 7 segundos depois. Quando um aparelho
 * não conseguia descriptografar, ele pedia o reenvio (retry receipt) e não tinha mais ninguém
 * do outro lado para atender. A pessoa ficava para sempre com "Aguardando mensagem".
 *
 * Aqui roda o whatsapp.js de verdade, trocando só o @whiskeysockets/baileys por um socket
 * falso que o teste controla. Assim dá para verificar o ciclo de vida real: que a mensagem
 * vai para o histórico em disco, que o getMessage do socket sabe respondê-la, que a conexão
 * fica de pé durante a janela de reenvio, e que uma queda antes do envio não vira sucesso.
 *
 * Uso: node testes/simular-reenvio.js
 */

const fs = require('fs');
const os = require('os');
const path = require('path');

// Precisa vir antes de qualquer require do projeto: whatsapp.js e mensagens-enviadas.js
// leem estas variáveis no carregamento do módulo.
const DIR_TEMP = fs.mkdtempSync(path.join(os.tmpdir(), 'culto-teste-'));
process.env.AUTH_DIR = DIR_TEMP;
process.env.RETRY_GRACE_MS = '300';
process.env.RETRY_GRACE_SIGTERM_MS = '50';
process.env.ESPERA_APOS_CONECTAR_MS = '0';
process.env.CONEXAO_TIMEOUT_MS = '2000';
process.env.BAILEYS_LOG_LEVEL = 'silent';

// ── Stub do Baileys ──────────────────────────────────────────────────────────
const CAMINHO_BAILEYS = require.resolve('@whiskeysockets/baileys');
const baileysReal = require('@whiskeysockets/baileys');
const { Boom } = require('@hapi/boom');

let contadorId = 0;
let socketsCriados = [];
// Como o próximo socket deve se comportar: 'abre' (normal) ou 'fecha-antes' (cai sem abrir).
let comportamentoConexao = 'abre';
let gravacoesConcluidas = 0;
let gravacoesIniciadas = 0;

function criarSocketFalso(opcoes) {
  const ouvintes = new Map();

  const sock = {
    opcoes,
    encerrado: false,
    enviadas: [],
    ev: {
      on: (evento, handler) => {
        if (!ouvintes.has(evento)) ouvintes.set(evento, []);
        ouvintes.get(evento).push(handler);
      },
    },
    // O end() do Baileys é async e leva um tempo real. Se o whatsapp.js não aguardar,
    // o encerrarSessao volta com o socket ainda aberto, e o teste pega isso.
    end: async () => {
      await new Promise(r => setTimeout(r, 60));
      sock.encerrado = true;
    },
    groupFetchAllParticipating: async () => ({ 'grupo@g.us': { subject: 'Avisos' } }),
    sendMessage: async (jid, conteudo) => {
      const id = `MSGFALSA${++contadorId}`;
      sock.enviadas.push({ jid, texto: conteudo.text, id });
      // O Baileys de verdade grava o sender-key-memory em disco durante o relay. Reproduzir
      // isso aqui é o que dá sentido ao teste de drenagem: sem esperar essa gravação, o
      // process.exit pode deixar o estado do ratchet defasado no volume.
      opcoes.auth.keys.set({ 'sender-key-memory': { [jid]: { fake: true } } });
      return {
        key: { id, remoteJid: jid, fromMe: true },
        message: { extendedTextMessage: { text: conteudo.text } },
      };
    },
    emitir: (evento, dados) => {
      for (const h of ouvintes.get(evento) || []) h(dados);
    },
  };

  // Os handlers só são registrados depois que makeWASocket retorna, então o evento
  // de conexão precisa sair no próximo tick.
  setImmediate(() => {
    if (comportamentoConexao === 'abre') {
      sock.emitir('connection.update', { connection: 'open' });
    } else if (comportamentoConexao === 'fecha-antes') {
      // Boom de verdade: o whatsapp.js reconstrói o erro com `new Boom(...)`, e um objeto
      // solto viraria 500 (badSession) em vez do código que o teste quer exercitar.
      sock.emitir('connection.update', {
        connection: 'close',
        lastDisconnect: { error: new Boom('conexão perdida', { statusCode: 428 }) }, // connectionClosed
      });
    }
  });

  socketsCriados.push(sock);
  return sock;
}

const estadoFalso = {
  creds: { me: { id: '5519999999999@s.whatsapp.net', name: 'Culto Bot' } },
  keys: {
    get: async () => ({}),
    // Grava devagar de propósito, para provar que o encerrarSessao espera drenar.
    set: async () => {
      gravacoesIniciadas++;
      await new Promise(r => setTimeout(r, 120));
      gravacoesConcluidas++;
    },
  },
};

require.cache[CAMINHO_BAILEYS] = {
  id: CAMINHO_BAILEYS,
  filename: CAMINHO_BAILEYS,
  loaded: true,
  exports: {
    ...baileysReal,
    default: criarSocketFalso,
    useMultiFileAuthState: async () => ({ state: estadoFalso, saveCreds: async () => {} }),
    fetchLatestBaileysVersion: async () => ({ version: [2, 3000, 0] }),
  },
};

// Requerer DEPOIS do stub entrar no cache.
const { proto, BufferJSON } = baileysReal;
const whatsapp = require('../whatsapp');
const mensagens = require('../mensagens-enviadas');

// ── Utilidades ───────────────────────────────────────────────────────────────
let falhas = 0;

function checar(descricao, condicao, detalhe = '') {
  console.log(`${condicao ? '  ✅' : '  ❌'} ${descricao}${detalhe ? ` ${detalhe}` : ''}`);
  if (!condicao) falhas++;
}

function reiniciar() {
  socketsCriados = [];
  comportamentoConexao = 'abre';
  gravacoesConcluidas = 0;
  gravacoesIniciadas = 0;
}

const bytesDe = (m) => Buffer.from(proto.Message.encode(proto.Message.fromObject(m)).finish());

// ── Cenários ─────────────────────────────────────────────────────────────────
async function main() {
  console.log('\n═══ Correção do "Aguardando mensagem" ═══\n');

  // 1: o histórico sobrevive ao processo (é o que atende reenvio de dias depois)
  {
    console.log('▶ histórico em disco: guarda e recupera o conteúdo idêntico');
    const original = { extendedTextMessage: { text: '🔴 *Transmissão ao vivo*\nhttps://youtu.be/abc' } };
    await mensagens.guardar('ID-PERSISTIDO', original);

    // Simula outra execução do bot: esquece a memória e lê do disco.
    mensagens.esquecerCache();
    const recuperada = await mensagens.buscar('ID-PERSISTIDO');

    checar('mensagem encontrada após reler o disco', !!recuperada);
    checar('conteúdo idêntico byte a byte', !!recuperada && bytesDe(original).equals(bytesDe(recuperada)));
    checar('id desconhecido devolve undefined', (await mensagens.buscar('NAO-EXISTE')) === undefined);
    checar('arquivo criado no AUTH_DIR', fs.existsSync(mensagens.ARQUIVO), `→ ${path.basename(mensagens.ARQUIVO)}`);
    console.log('');
  }

  // 2: a memória de distribuição de chave de grupo é limpa uma vez só
  {
    reiniciar();
    console.log('▶ chave de grupo: limpa a memória de distribuição uma única vez');
    const memoria = path.join(DIR_TEMP, 'sender-key-memory-120363351930219320@g.us.json');
    const outroArquivo = path.join(DIR_TEMP, 'session-5519888@s.whatsapp.net.json');
    fs.writeFileSync(memoria, '{"aparelho1":true}');
    fs.writeFileSync(outroArquivo, '{"sessao":"intacta"}');

    await whatsapp.enviarMensagem('grupo@g.us', 'primeiro envio da versão nova');
    checar('memória de distribuição foi apagada', !fs.existsSync(memoria));
    checar('sessão de sinal NÃO foi tocada', fs.existsSync(outroArquivo));
    checar('marca de execução criada', fs.existsSync(path.join(DIR_TEMP, '.chaves-redistribuidas')));

    // Segunda execução: não pode apagar de novo.
    await whatsapp.encerrarSessao();
    reiniciar();
    fs.writeFileSync(memoria, '{"aparelho1":true}');
    await whatsapp.enviarMensagem('grupo@g.us', 'envio seguinte');
    checar('não apaga de novo nas execuções seguintes', fs.existsSync(memoria));
    await whatsapp.encerrarSessao();
    console.log('');
  }

  // 3: envio guarda no histórico, mantém a conexão e o getMessage sabe responder
  {
    reiniciar();
    console.log('▶ envio: guarda no histórico e o socket sabe atender o pedido de reenvio');
    const id = await whatsapp.enviarMensagem('grupo@g.us', 'link do culto');
    const sock = socketsCriados[0];

    checar('um único socket criado', socketsCriados.length === 1);
    checar('mensagem realmente enviada', sock.enviadas.length === 1 && sock.enviadas[0].texto === 'link do culto');
    checar('conexão NÃO foi encerrada após o envio', sock.encerrado === false);

    // Este é o coração da correção: sem getMessage o Baileys devolve undefined e desiste.
    const paraReenvio = await sock.opcoes.getMessage({ id, remoteJid: 'grupo@g.us', fromMe: true });
    checar('getMessage do socket devolve a mensagem para reenvio', !!paraReenvio);
    checar(
      'conteúdo do reenvio bate com o que foi enviado',
      !!paraReenvio && bytesDe({ extendedTextMessage: { text: 'link do culto' } }).equals(bytesDe(paraReenvio))
    );

    const desconhecida = await sock.opcoes.getMessage({ id: 'ID-QUE-NAO-EXISTE' });
    checar('getMessage devolve undefined para id desconhecido', desconhecida === undefined);
    console.log('');
  }

  // 3: encerramento segura a conexão pela janela de reenvio antes de fechar
  {
    console.log('▶ encerramento: segura a conexão durante a janela de reenvio');
    const sock = socketsCriados[0];
    const inicio = Date.now();
    await whatsapp.encerrarSessao();
    const decorrido = Date.now() - inicio;

    checar('esperou a janela de reenvio (300ms)', decorrido >= 300, `→ ${decorrido}ms`);
    checar('conexão encerrada só no fim', sock.encerrado === true);
    checar(
      'houve gravação de estado de sinal para drenar',
      gravacoesIniciadas > 0,
      `→ ${gravacoesIniciadas} gravação(ões)`
    );
    checar(
      'todas as gravações terminaram antes de sair',
      gravacoesConcluidas === gravacoesIniciadas,
      `→ ${gravacoesConcluidas}/${gravacoesIniciadas}`
    );
    checar('encerrar de novo não quebra', await whatsapp.encerrarSessao().then(() => true).catch(() => false));
    console.log('');
  }

  // 4: sem nada enviado não faz sentido segurar a conexão
  {
    reiniciar();
    console.log('▶ sessão sem nenhum envio: encerra na hora, sem segurar a janela');
    const grupos = await whatsapp.listarTodosChats();
    checar('listou os grupos pela sessão compartilhada', grupos.length === 1 && grupos[0].nome === 'Avisos');

    const inicio = Date.now();
    await whatsapp.encerrarSessao();
    const decorrido = Date.now() - inicio;

    checar('não esperou a janela de reenvio', decorrido < 300, `→ ${decorrido}ms`);
    checar('conexão encerrada', socketsCriados[0].encerrado === true);
    console.log('');
  }

  // 5: queda antes de abrir precisa virar erro, não sucesso silencioso
  {
    reiniciar();
    comportamentoConexao = 'fecha-antes';
    console.log('▶ conexão que cai antes de abrir: precisa falhar, não fingir sucesso');

    let erro = null;
    try {
      await whatsapp.enviarMensagem('grupo@g.us', 'mensagem que não deve sair');
    } catch (err) {
      erro = err;
    }

    checar('enviarMensagem rejeitou', erro !== null, erro ? `→ "${erro.message}"` : '');
    checar('nenhuma mensagem foi enviada', socketsCriados.every(s => s.enviadas.length === 0));
    checar(
      'o erro nomeia o código real da desconexão',
      !!erro && erro.message.includes('connectionClosed'),
      erro ? `→ "${erro.message}"` : ''
    );
    console.log('');
  }

  // 6: reconecta na próxima chamada depois de uma queda
  {
    reiniciar();
    console.log('▶ recuperação: depois da queda, o envio seguinte abre uma conexão nova');
    const id = await whatsapp.enviarMensagem('grupo@g.us', 'segunda tentativa');
    checar('mensagem enviada na conexão nova', !!id && socketsCriados.length === 1);
    checar('mensagem foi para o histórico', !!(await mensagens.buscar(id)));
    await whatsapp.encerrarSessao();
    console.log('');
  }

  // 7: sessão reaproveitada entre o aviso de atraso e o link
  {
    reiniciar();
    console.log('▶ duas mensagens na mesma janela reaproveitam uma única conexão');
    const idAviso = await whatsapp.enviarMensagem('grupo@g.us', 'aviso de atraso');
    const idLink = await whatsapp.enviarMensagem('grupo@g.us', 'link do culto');

    checar('um socket só para as duas mensagens', socketsCriados.length === 1, `→ ${socketsCriados.length}`);
    checar('as duas mensagens saíram', socketsCriados[0].enviadas.length === 2);
    checar('as duas estão no histórico', !!(await mensagens.buscar(idAviso)) && !!(await mensagens.buscar(idLink)));
    await whatsapp.encerrarSessao();
    console.log('');
  }

  // 8: SIGTERM no meio da janela de reenvio corta a espera, mas não pula o fechamento
  {
    reiniciar();
    console.log('▶ SIGTERM na janela de reenvio: corta a espera sem pular o fechamento');
    await whatsapp.enviarMensagem('grupo@g.us', 'link do culto');
    const sock = socketsCriados[0];

    const inicio = Date.now();
    const desligamentoNormal = whatsapp.encerrarSessao();          // janela de 300ms
    await new Promise(r => setTimeout(r, 40));
    const sigterm = whatsapp.encerrarSessao({ graca: 0 });         // o Fly mandando parar
    await Promise.all([desligamentoNormal, sigterm]);
    const decorrido = Date.now() - inicio;

    checar('a espera de reenvio foi cortada', decorrido < 300, `→ ${decorrido}ms`);
    checar('mas o socket foi mesmo fechado', sock.encerrado === true);
    checar(
      'e as gravações terminaram antes de sair',
      gravacoesIniciadas > 0 && gravacoesConcluidas === gravacoesIniciadas,
      `→ ${gravacoesConcluidas}/${gravacoesIniciadas}`
    );
    console.log('');
  }

  // ── Resultado ──────────────────────────────────────────────────────────────
  fs.rmSync(DIR_TEMP, { recursive: true, force: true });

  console.log('═══════════════════════════════════');
  if (falhas === 0) {
    console.log('✅ Todos os cenários passaram.\n');
    process.exit(0);
  }
  console.log(`❌ ${falhas} verificação(ões) falharam.\n`);
  process.exit(1);
}

main().catch(err => {
  fs.rmSync(DIR_TEMP, { recursive: true, force: true });
  console.error('Erro na simulação:', err);
  process.exit(1);
});
