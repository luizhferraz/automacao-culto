/**
 * Testes da correção do "Aguardando mensagem".
 *
 * Duas rodadas do bug, duas correções.
 *
 * A primeira: o bot enviava a mensagem e matava o processo 7 segundos depois. Quando um
 * aparelho não conseguia descriptografar, ele pedia o reenvio (retry receipt) e não tinha
 * mais ninguém do outro lado para atender.
 *
 * A segunda, medida no volume no domingo 02/08: o Baileys marca o aparelho como "já recebeu
 * a chave de grupo" ANTES de conseguir cifrar para ele, e grava esse mapa no disco de
 * qualquer jeito. De manhã os 845 aparelhos foram marcados; à noite o mapa foi lido cheio, a
 * lista de destinatários da chave ficou vazia, e a mensagem saiu sem distribuir chave para
 * ninguém. Quem falhou de manhã estava condenado a falhar de novo à noite. A correção é não
 * confiar no mapa: leitura sempre vazia, gravação descartada, todo envio redistribui.
 *
 * Aqui roda o whatsapp.js de verdade, trocando só o @whiskeysockets/baileys por um socket
 * falso que o teste controla.
 *
 * Uso: node testes/simular-reenvio.js          (com FORCAR_SESSOES desligado)
 *      FORCAR_SESSOES=1 node testes/simular-reenvio.js
 */

const fs = require('fs');
const os = require('os');
const path = require('path');

// Precisa vir antes de qualquer require do projeto: os módulos leem estas variáveis no
// carregamento.
const DIR_TEMP = fs.mkdtempSync(path.join(os.tmpdir(), 'culto-teste-'));
process.env.AUTH_DIR = DIR_TEMP;
process.env.WHATSAPP_GROUP_NAME = 'grupo@g.us';
process.env.DIAG_DIR = path.join(DIR_TEMP, 'diagnostico');
// Os tempos são folgados de propósito. O que se mede aqui é diferença de comportamento
// (cortou ou não cortou, esticou ou não esticou), e valores apertados deixariam um pico de
// carga da máquina confundir os dois casos.
process.env.RETRY_GRACE_MS = '1000';      // piso da janela
process.env.RETRY_QUIET_MS = '600';       // silêncio necessário para encerrar
process.env.RETRY_GRACE_MAX_MS = '5000';  // teto
process.env.RETRY_PASSO_MS = '25';        // granularidade da espera
process.env.RETRY_GRACE_SIGTERM_MS = '50';
process.env.ESPERA_APOS_CONECTAR_MS = '0';
process.env.CONEXAO_TIMEOUT_MS = '2000';
process.env.BAILEYS_LOG_LEVEL = 'silent';

const FORCANDO = process.env.FORCAR_SESSOES === '1';

// ── Stub do Baileys ──────────────────────────────────────────────────────────
const CAMINHO_BAILEYS = require.resolve('@whiskeysockets/baileys');
const baileysReal = require('@whiskeysockets/baileys');
const { Boom } = require('@hapi/boom');

let contadorId = 0;
let socketsCriados = [];
// Como o próximo socket deve se comportar: 'abre' (normal) ou 'fecha-antes' (cai sem abrir).
let comportamentoConexao = 'abre';
// Faz o groupMetadata falhar, para provar que o preparo nunca segura o link.
let metadataQuebrado = false;
let gravacoesConcluidas = 0;
let gravacoesIniciadas = 0;
// Categorias que chegaram ao armazenamento de verdade, depois de passar pelo whatsapp.js.
let categoriasGravadas = [];
// Faz o papel do volume: guarda o que foi gravado e devolve nas leituras seguintes. Sem
// isto o teste da memória de distribuição seria vacuoso, porque a segunda leitura nunca
// enxergaria o mapa que a primeira gravou, que é exatamente o bug do domingo 02/08.
let armazenamento = {};

const PARTICIPANTES = ['pessoa1@lid', 'pessoa2@lid', 'pessoa3@lid'];

function criarSocketFalso(opcoes) {
  const ouvintes = new Map();

  const sock = {
    opcoes,
    encerrado: false,
    enviadas: [],
    // Quantos aparelhos o Baileys veria como "já tem a chave" no início de cada envio.
    jaTinhamChave: [],
    sessoesForcadas: [],
    // Quantas vezes o grupo foi medido. Serve para provar que o preparo roda na subida e não
    // se repete no envio, valendo com o FORCAR_SESSOES ligado ou desligado.
    medicoes: 0,
    ev: {
      on: (evento, handler) => {
        if (!ouvintes.has(evento)) ouvintes.set(evento, []);
        ouvintes.get(evento).push(handler);
      },
    },
    // O end() do Baileys é async e leva um tempo real. Se o whatsapp.js não aguardar,
    // o encerrarSessao volta com o socket ainda aberto, e o teste pega isso.
    end: async () => {
      // O resumo precisa já refletir ESTA sessão AQUI. Ele era gravado depois do end e da
      // drenagem, e o Fly matou o processo no meio da drenagem justamente na execução mais
      // interessante, levando o diagnóstico junto. Comparar por id, e não por existência do
      // arquivo: o nome do resumo é o mesmo para o processo inteiro, então um cenário
      // anterior já teria deixado um arquivo lá e a checagem passaria à toa.
      sock.resumoNoEnd = null;
      try {
        const nome = fs.readdirSync(process.env.DIAG_DIR).find(a => a.startsWith('resumo-'));
        if (nome) sock.resumoNoEnd = JSON.parse(fs.readFileSync(path.join(process.env.DIAG_DIR, nome), 'utf-8'));
      } catch { /* ainda não existe */ }
      await new Promise(r => setTimeout(r, 60));
      sock.encerrado = true;
    },
    groupFetchAllParticipating: async () => ({ 'grupo@g.us': { subject: 'Avisos' } }),
    groupMetadata: async () => {
      sock.medicoes++;
      if (metadataQuebrado) throw new Error('grupo indisponível');
      return { participants: PARTICIPANTES.map(id => ({ id })) };
    },
    getUSyncDevices: async (ids) => ids.map(id => ({ jid: id })),
    assertSessions: async (jids, force) => {
      sock.sessoesForcadas.push({ quantidade: jids.length, force: !!force });
    },
    sendMessage: async (jid, conteudo) => {
      const id = `MSGFALSA${++contadorId}`;

      // Reproduz o que o Baileys faz no ramo de grupo do relayMessage: lê a memória de
      // distribuição, decide quem ainda precisa da chave, e grava o mapa de volta.
      const memoria = await opcoes.auth.keys.get('sender-key-memory', [jid]);
      sock.jaTinhamChave.push(Object.keys(memoria?.[jid] || {}).length);
      await opcoes.auth.keys.set({
        'sender-key-memory': { [jid]: Object.fromEntries(PARTICIPANTES.map(p => [p, true])) },
      });

      // O relay também grava estado de sinal de verdade. É o que dá sentido ao teste de
      // drenagem: sem esperar essa gravação, o process.exit deixa o ratchet defasado.
      await opcoes.auth.keys.set({ session: { [`sessao-${id}`]: { ratchet: contadorId } } });

      sock.enviadas.push({ jid, texto: conteudo.text, id });
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

// Estado novo a cada chamada, como o useMultiFileAuthState de verdade. Se devolvesse sempre
// o mesmo objeto, os embrulhos do whatsapp.js se empilhariam entre sessões e o teste
// mediria uma coisa que não acontece em produção.
function criarEstadoFalso() {
  return {
    creds: { me: { id: '5519999999999@s.whatsapp.net', name: 'Culto Bot' } },
    keys: {
      get: async (tipo, ids) => {
        const saida = {};
        for (const id of ids || []) saida[id] = armazenamento[tipo]?.[id];
        return saida;
      },
      // Grava devagar de propósito, para provar que o encerrarSessao espera drenar.
      set: async (dados) => {
        categoriasGravadas.push(...Object.keys(dados));
        for (const categoria of Object.keys(dados)) {
          armazenamento[categoria] = armazenamento[categoria] || {};
          for (const id of Object.keys(dados[categoria])) {
            // Valor falso significa apagar, igual ao useMultiFileAuthState de verdade.
            if (dados[categoria][id]) armazenamento[categoria][id] = dados[categoria][id];
            else delete armazenamento[categoria][id];
          }
        }
        gravacoesIniciadas++;
        await new Promise(r => setTimeout(r, 120));
        gravacoesConcluidas++;
      },
    },
  };
}

require.cache[CAMINHO_BAILEYS] = {
  id: CAMINHO_BAILEYS,
  filename: CAMINHO_BAILEYS,
  loaded: true,
  exports: {
    ...baileysReal,
    default: criarSocketFalso,
    useMultiFileAuthState: async () => ({ state: criarEstadoFalso(), saveCreds: async () => {} }),
    fetchLatestBaileysVersion: async () => ({ version: [2, 3000, 0] }),
  },
};

// Requerer DEPOIS do stub entrar no cache.
const { proto } = baileysReal;
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
  categoriasGravadas = [];
  armazenamento = {};
  metadataQuebrado = false;
}

const bytesDe = (m) => Buffer.from(proto.Message.encode(proto.Message.fromObject(m)).finish());

// ── Cenários ─────────────────────────────────────────────────────────────────
async function main() {
  console.log(`\n═══ Correção do "Aguardando mensagem" ═══`);
  console.log(`    FORCAR_SESSOES=${FORCANDO ? '1 (recria sessões antes do envio)' : '0 (padrão)'}\n`);

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

  // 2: a memória de distribuição de chave de grupo nunca mais é confiada
  {
    reiniciar();
    console.log('▶ chave de grupo: a memória de distribuição é ignorada em todo envio');
    const memoria = path.join(DIR_TEMP, 'sender-key-memory-120363351930219320@g.us.json');
    const marcaAntiga = path.join(DIR_TEMP, '.chaves-redistribuidas');
    const outroArquivo = path.join(DIR_TEMP, 'session-5519888@s.whatsapp.net.json');
    fs.writeFileSync(memoria, '{"aparelho1":true}');
    fs.writeFileSync(marcaAntiga, 'sobra da versão anterior');
    fs.writeFileSync(outroArquivo, '{"sessao":"intacta"}');

    // Mapa velho ainda no armazenamento, como se a limpeza de arquivos tivesse falhado
    // (volume só leitura, permissão, o que for). É o caso que a interceptação da LEITURA
    // cobre sozinha: mesmo com o mapa lá, nenhum aparelho pode ser tratado como atendido.
    armazenamento['sender-key-memory'] = {
      'grupo@g.us': Object.fromEntries(PARTICIPANTES.map(p => [p, true])),
    };

    await whatsapp.enviarMensagem('grupo@g.us', 'primeira mensagem da janela');
    const sock = socketsCriados[0];

    checar('memória de distribuição foi apagada do volume', !fs.existsSync(memoria));
    checar('marca da limpeza única também saiu', !fs.existsSync(marcaAntiga));
    checar('sessão de sinal NÃO foi tocada', fs.existsSync(outroArquivo));

    // O coração da segunda correção: a segunda mensagem da MESMA janela também precisa
    // redistribuir. Era exatamente aqui que a janela da noite de 02/08 saía sem chave.
    await whatsapp.enviarMensagem('grupo@g.us', 'segunda mensagem da janela');

    checar(
      'nenhum envio enxerga aparelho já marcado (todo envio redistribui)',
      sock.jaTinhamChave.length === 2 && sock.jaTinhamChave.every(n => n === 0),
      `→ [${sock.jaTinhamChave.join(', ')}]`
    );
    checar(
      'gravação de sender-key-memory é descartada',
      !categoriasGravadas.includes('sender-key-memory'),
      `→ gravou [${[...new Set(categoriasGravadas)].join(', ')}]`
    );
    checar('gravação de sessão de sinal continua passando', categoriasGravadas.includes('session'));

    // Medição do grupo, que roda com o sinalizador ligado ou desligado.
    checar(
      FORCANDO ? 'sessões recriadas em lote com force' : 'sessões NÃO são recriadas com o sinalizador desligado',
      FORCANDO
        ? sock.sessoesForcadas.length > 0 && sock.sessoesForcadas.every(l => l.force === true)
        : sock.sessoesForcadas.length === 0,
      `→ ${sock.sessoesForcadas.length} lote(s)`
    );
    checar(
      'a medição do grupo roda uma vez só por sessão',
      sock.sessoesForcadas.length <= 1,
      `→ ${sock.sessoesForcadas.length}`
    );

    await whatsapp.encerrarSessao();
    console.log('');
  }

  // 3: o filtro de ruído, que é a correção central
  {
    reiniciar();
    console.log('▶ filtro de ruído: só o grupo de avisos entra na fila');
    await whatsapp.enviarMensagem('grupo@g.us', 'link do culto');
    const filtrar = socketsCriados[0].opcoes.shouldIgnoreJid;

    checar('o Baileys recebeu um filtro', typeof filtrar === 'function');
    checar('o grupo de avisos NÃO é filtrado', filtrar('grupo@g.us') === false);
    checar('outro grupo é filtrado', filtrar('120363415107904841@g.us') === true);
    checar('status@broadcast é filtrado', filtrar('status@broadcast') === true);
    checar('conversa individual continua passando', filtrar('5519999@s.whatsapp.net') === false);
    checar('jid vazio não é filtrado', filtrar(undefined) === false);

    const resumo = await whatsapp.encerrarSessao();
    checar('os descartes vão para o resumo', resumo.nosIgnorados === 2, `→ ${resumo.nosIgnorados}`);
    console.log('');
  }

  // 4: sem grupo configurado o filtro precisa se desligar sozinho
  {
    reiniciar();
    console.log('▶ filtro sem grupo configurado: não pode descartar nada');
    const salvo = process.env.WHATSAPP_GROUP_NAME;
    delete process.env.WHATSAPP_GROUP_NAME;
    delete require.cache[require.resolve('../whatsapp')];
    const semGrupo = require('../whatsapp');

    await semGrupo.enviarMensagem('grupo@g.us', 'link do culto');
    const filtrar = socketsCriados[0].opcoes.shouldIgnoreJid;
    // Sem saber qual é o grupo de avisos, filtrar grupo descartaria os pedidos de reenvio
    // dele junto com o ruído. Preferir não filtrar nada é a falha segura.
    checar('nenhum grupo é filtrado', filtrar('120363415107904841@g.us') === false);
    checar('nem o grupo de avisos', filtrar('grupo@g.us') === false);
    await semGrupo.encerrarSessao();

    process.env.WHATSAPP_GROUP_NAME = salvo;
    delete require.cache[require.resolve('../whatsapp')];
    console.log('');
  }

  // 5: o preparo do grupo acontece na subida, não no meio do envio
  {
    reiniciar();
    console.log('▶ preparo na subida: mede o grupo antes da hora do envio, não durante');

    await whatsapp.conectar('grupo@g.us');
    const sock = socketsCriados[0];

    checar('conectou na subida', socketsCriados.length === 1);
    checar('mediu o grupo já na subida', sock.medicoes === 1, `→ ${sock.medicoes} medição(ões)`);
    checar('mediu antes de qualquer envio', sock.enviadas.length === 0);
    if (FORCANDO) {
      checar('recriou as sessões na subida', sock.sessoesForcadas.length === 1, `→ ${sock.sessoesForcadas.length} lote(s)`);
    }

    // O envio depois disso não pode repetir o preparo, senão o atraso volta para a hora errada.
    await whatsapp.enviarMensagem('grupo@g.us', 'link do culto');
    checar('o envio não repetiu a medição', sock.medicoes === 1, `→ ${sock.medicoes}`);
    checar(
      'o envio não repetiu a recriação de sessões',
      sock.sessoesForcadas.length === (FORCANDO ? 1 : 0),
      `→ ${sock.sessoesForcadas.length} lote(s)`
    );
    await whatsapp.encerrarSessao();
    console.log('');
  }

  // 4: preparo quebrado não pode segurar o link do culto
  {
    reiniciar();
    metadataQuebrado = true;
    console.log('▶ preparo com falha: o link do culto sai mesmo assim');

    await whatsapp.conectar('grupo@g.us');
    const id = await whatsapp.enviarMensagem('grupo@g.us', 'link do culto');

    checar('mensagem enviada apesar do preparo ter falhado', !!id);
    checar('mensagem foi para o histórico', !!(await mensagens.buscar(id)));
    checar('nenhuma sessão foi forçada, já que nem a lista saiu', socketsCriados[0].sessoesForcadas.length === 0);
    await whatsapp.encerrarSessao();
    console.log('');
  }

  // 5: envio guarda no histórico, mantém a conexão e o getMessage sabe responder
  {
    reiniciar();
    console.log('▶ envio: guarda no histórico e o socket sabe atender o pedido de reenvio');
    const id = await whatsapp.enviarMensagem('grupo@g.us', 'link do culto');
    const sock = socketsCriados[0];

    checar('um único socket criado', socketsCriados.length === 1);
    checar('mensagem realmente enviada', sock.enviadas.length === 1 && sock.enviadas[0].texto === 'link do culto');
    checar('conexão NÃO foi encerrada após o envio', sock.encerrado === false);

    // Este é o coração da primeira correção: sem getMessage o Baileys devolve undefined.
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

  // 4: encerramento segura a conexão pela janela de reenvio antes de fechar
  {
    console.log('▶ encerramento: segura a conexão durante a janela de reenvio');
    const sock = socketsCriados[0];
    const inicio = Date.now();
    const resumo = await whatsapp.encerrarSessao();
    const decorrido = Date.now() - inicio;

    checar('esperou o piso da janela (1000ms)', decorrido >= 1000, `→ ${decorrido}ms`);
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

    // O resumo é o que substitui os logs perdidos do domingo.
    checar('resumo da janela devolvido', !!resumo && Array.isArray(resumo.envios) && resumo.envios.length === 1);
    checar('resumo registra o grupo medido', !!resumo?.grupo && resumo.grupo.participantes === PARTICIPANTES.length);
    checar('resumo gravado em disco', fs.readdirSync(process.env.DIAG_DIR).some(a => a.startsWith('resumo-')));
    checar(
      'resumo desta sessão já estava no disco antes de fechar o socket',
      sock.resumoNoEnd?.envios?.[0]?.id === sock.enviadas[0].id,
      `→ resumo tinha ${sock.resumoNoEnd?.envios?.[0]?.id || 'nada'}, sessão enviou ${sock.enviadas[0].id}`
    );
    console.log('');
  }

  // 5: a janela se estende enquanto houver pedidos de reenvio chegando
  {
    reiniciar();
    console.log('▶ janela elástica: continua aberta enquanto chegam pedidos de reenvio');
    const id = await whatsapp.enviarMensagem('grupo@g.us', 'link do culto');
    const sock = socketsCriados[0];

    // Pedido chegando quase no fim do piso (1000ms). Com a quietude de 600ms, o fechamento
    // tem que ser empurrado para depois de 900+600=1500ms. Uma espera de relógio fixo pararia
    // em 1000ms, então o limiar de 1300ms separa os dois comportamentos com folga dos dois lados.
    setTimeout(() => { sock.opcoes.getMessage({ id, remoteJid: 'grupo@g.us', fromMe: true }); }, 900);

    const inicio = Date.now();
    const resumo = await whatsapp.encerrarSessao();
    const decorrido = Date.now() - inicio;

    checar('esperou além do piso por causa do reenvio', decorrido > 1300, `→ ${decorrido}ms`);
    checar('respeitou o teto', decorrido < 5000, `→ ${decorrido}ms`);
    checar('reenvio contabilizado no resumo', resumo?.reenviosAtendidos?.total === 1);
    console.log('');
  }

  // 6: sem nada enviado não faz sentido segurar a conexão
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

  // 7: queda antes de abrir precisa virar erro, não sucesso silencioso
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

    // O conectar() da subida não pode derrubar o processo quando a rede está ruim.
    checar('conectar() devolve false em vez de lançar', (await whatsapp.conectar()) === false);
    console.log('');
  }

  // 8: reconecta na próxima chamada depois de uma queda
  {
    reiniciar();
    console.log('▶ recuperação: depois da queda, o envio seguinte abre uma conexão nova');
    const id = await whatsapp.enviarMensagem('grupo@g.us', 'segunda tentativa');
    checar('mensagem enviada na conexão nova', !!id && socketsCriados.length === 1);
    checar('mensagem foi para o histórico', !!(await mensagens.buscar(id)));
    await whatsapp.encerrarSessao();
    console.log('');
  }

  // 9: sessão reaproveitada entre o aviso de atraso e o link
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

  // 10: SIGTERM no meio da janela de reenvio corta a espera, mas não pula o fechamento
  {
    reiniciar();
    console.log('▶ SIGTERM na janela de reenvio: corta a espera sem pular o fechamento');
    await whatsapp.enviarMensagem('grupo@g.us', 'link do culto');
    const sock = socketsCriados[0];

    const inicio = Date.now();
    const desligamentoNormal = whatsapp.encerrarSessao();          // piso de 1000ms
    await new Promise(r => setTimeout(r, 40));
    const sigterm = whatsapp.encerrarSessao({ graca: 0 });         // o Fly mandando parar
    await Promise.all([desligamentoNormal, sigterm]);
    const decorrido = Date.now() - inicio;

    // Com o corte fica em ~200ms (40 do corte, 60 do end, 120 da drenagem). Sem o corte
    // seriam os 1000ms do piso mais os mesmos 180ms. O limiar de 600ms fica no meio.
    checar('a espera de reenvio foi cortada', decorrido < 600, `→ ${decorrido}ms`);
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
