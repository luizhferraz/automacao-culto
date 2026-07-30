/**
 * Guarda no disco o conteúdo das mensagens que o bot enviou.
 *
 * Por que isso existe: quando o aparelho de alguém não consegue descriptografar uma
 * mensagem, ele não some. O WhatsApp manda de volta um "retry receipt" pedindo que o
 * remetente reenvie aquela mensagem re-encriptada. O Baileys atende esse pedido chamando
 * a função `getMessage` do socket. O padrão dessa função é `async () => undefined`, e
 * quando ela devolve undefined o Baileys só registra "message not available" e desiste.
 * O resultado no celular de quem recebeu é a mensagem eterna "Aguardando mensagem".
 *
 * O Baileys também mantém um cache das mensagens recentes, mas ele é LRU em memória com
 * validade de 5 minutos (ver MessageRetryManager na lib). Como este bot é um processo
 * efêmero que morre logo após o culto, esse cache nunca sobrevive. Guardar em disco, no
 * volume do Fly, permite atender inclusive o pedido de reenvio que só chega dias depois,
 * quando o aparelho do irmão voltar a ficar online: o WhatsApp enfileira esses receipts e
 * entrega no próximo connect (ver offlineNodeProcessor, que trata 'receipt').
 */

const { mkdir, readFile, writeFile, rename } = require('fs/promises');
const path = require('path');
const { proto, BufferJSON } = require('@whiskeysockets/baileys');

const AUTH_DIR = process.env.AUTH_DIR || '.baileys_auth';
const ARQUIVO = path.join(AUTH_DIR, 'mensagens-enviadas.json');

const MAX_GUARDADAS = 200;
const VALIDADE_MS = 30 * 24 * 60 * 60 * 1000; // 30 dias

let cache = null;

async function carregar() {
  if (cache) return cache;
  try {
    const bruto = await readFile(ARQUIVO, 'utf-8');
    const lido = JSON.parse(bruto, BufferJSON.reviver);
    cache = Array.isArray(lido) ? lido : [];
  } catch (err) {
    // Arquivo ainda não existe (primeira execução) ou está corrompido. Em ambos os casos
    // começar do zero é melhor do que derrubar o envio.
    if (err.code !== 'ENOENT') {
      console.warn(`[Mensagens] Não consegui ler ${ARQUIVO} (${err.message}). Recomeçando o histórico.`);
    }
    cache = [];
  }
  return cache;
}

async function gravar(lista) {
  await mkdir(path.dirname(ARQUIVO), { recursive: true });
  const temporario = `${ARQUIVO}.tmp`;
  // Grava em arquivo temporário e renomeia: o rename é atômico, então o processo pode
  // morrer no meio sem nunca deixar um JSON pela metade no volume.
  await writeFile(temporario, JSON.stringify(lista, BufferJSON.replacer));
  await rename(temporario, ARQUIVO);
}

// `conteudo` é o objeto proto.Message que o sendMessage devolveu em `.message`.
async function guardar(id, conteudo) {
  if (!id || !conteudo) return;
  const lista = await carregar();
  const agora = Date.now();
  const mantidas = lista.filter(m => m.id !== id && agora - m.em < VALIDADE_MS);
  mantidas.push({ id, em: agora, conteudo });
  cache = mantidas.slice(-MAX_GUARDADAS);
  await gravar(cache);
}

// Devolve o conteúdo no formato que o Baileys espera para reenviar, ou undefined.
async function buscar(id) {
  if (!id) return undefined;
  const lista = await carregar();
  const achada = lista.find(m => m.id === id);
  if (!achada) return undefined;
  return proto.Message.fromObject(achada.conteudo);
}

// Só para os testes: descarta o cache em memória e força reler o disco.
function esquecerCache() {
  cache = null;
}

module.exports = { guardar, buscar, esquecerCache, ARQUIVO };
