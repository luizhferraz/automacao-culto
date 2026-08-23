require('dotenv').config();
const { iniciarCliente, conectar, enviarMensagem, encerrarSessao, listarTodosChats, GRACA_SIGTERM_MS } = require('./whatsapp');
const { iniciarAgendamentos } = require('./scheduler');
const { buscarTransmissaoAoVivo, buscarUltimaGravacao } = require('./youtube');

const config = {
  apiKey:    process.env.YOUTUBE_API_KEY,
  channelId: process.env.YOUTUBE_CHANNEL_ID,
  nomeGrupo: process.env.WHATSAPP_GROUP_NAME,
};

// ── Teto de vida do processo ─────────────────────────────────────────────────
// Rede de segurança para o processo nunca passar a noite de pé. O ciclo normal na VM é o
// processo se encerrar sozinho ao fim de cada janela (e o systemd religar); fora de janela,
// é este teto que renova o processo. Qualquer coisa fora disso — uma espera de rede
// pendurada, um gatilho que não disparou — deixava o processo vivo indefinidamente, com o
// socket do WhatsApp aberto. Socket aberto é um aparelho vinculado segurando a sessão da
// conta, e é o que faz o celular do dono parar de receber notificação até alguém notar e
// reiniciar na mão.
const TETO_VIDA_MS = Number(process.env.TETO_VIDA_MS || 90 * 60 * 1000);

function validarConfig() {
  const faltando = Object.entries(config)
    .filter(([, v]) => !v)
    .map(([k]) => k);

  if (faltando.length > 0) {
    console.error('❌ Variáveis de ambiente ausentes no .env:');
    faltando.forEach(k => console.error(`   • ${k}`));
    process.exit(1);
  }
}

async function modoTesteYoutube() {
  console.log('\n🔍 Buscando transmissão ao vivo agora...\n');
  const aoVivo = await buscarTransmissaoAoVivo(config.apiKey, config.channelId);
  if (aoVivo) {
    console.log(`✅ Ao vivo: "${aoVivo.titulo}"\n   ${aoVivo.url}`);
  } else {
    console.log('ℹ️  Nenhuma transmissão ao vivo no momento.');
  }
  const gravacao = await buscarUltimaGravacao(config.apiKey, config.channelId);
  if (gravacao) {
    console.log(`\n✅ Última gravação: "${gravacao.titulo}"\n   ${gravacao.url}`);
  } else {
    console.log('ℹ️  Nenhuma gravação encontrada.');
  }
}

async function main() {
  const args = process.argv.slice(2);
  console.log('🙏 Automação de Culto: iniciando...\n');
  validarConfig();

  if (args.includes('--teste-youtube')) {
    await modoTesteYoutube();
    process.exit(0);
  }

  await iniciarCliente();

  if (args.includes('--listar-grupos')) {
    console.log('\n📋 Grupos encontrados:\n');
    const chats = await listarTodosChats();
    chats.forEach((c, i) => console.log(`  ${i + 1}. "${c.nome}" → ${c.id}`));
    await encerrarSessao();
    process.exit(0);
  }

  if (args.includes('--teste-envio')) {
    console.log('\n📤 Enviando mensagem de teste...\n');
    let falhou = false;
    try {
      await enviarMensagem(config.nomeGrupo, '✅ *Teste da automação do Culto*: tudo funcionando! 🙏');
    } catch (err) {
      falhou = true;
      console.error('Erro:', err.message);
    }
    // Encerra com a mesma espera do envio real, para o teste exercitar o caminho completo,
    // inclusive o atendimento de pedidos de reenvio.
    await encerrarSessao();
    process.exit(falhou ? 1 : 0);
  }

  // ORDEM IMPORTA: primeiro o que garante que a janela acontece e que o processo morre,
  // depois o que depende da rede.
  //
  // Enquanto o `conectar` vinha antes, ele era um ponto único de falha silencioso para o dia
  // inteiro: qualquer coisa pendurada ali — e o Baileys busca a versão do WhatsApp Web com um
  // fetch sem prazo — impedia o cron de ser registrado E o teto de vida de ser armado. O
  // resultado seria a máquina de pé, sem enviar nada e sem se encerrar, exatamente o estado
  // que segura a sessão da conta e emudece o celular do dono. Nada aqui embaixo depende do
  // resultado da conexão, então não há motivo para esperá-la.
  iniciarAgendamentos(config);

  // Os unref garantem que estes relógios nunca sejam o que mantém o processo vivo: no
  // ciclo normal o desligar do scheduler sai muito antes e eles simplesmente não disparam.
  const relogioTeto = setTimeout(() => {
    console.error(`⏰ Processo vivo há ${Math.round(TETO_VIDA_MS / 60000)} min, além de qualquer janela normal. Encerrando por segurança.`);
    encerrarComGraca('Teto de vida');
    // Se até o encerramento estiver pendurado, sai na marra. Perder uma gravação de
    // estado é melhor do que segurar a sessão da conta a noite inteira.
    setTimeout(() => process.exit(1), 60000).unref();
  }, TETO_VIDA_MS);
  relogioTeto.unref();

  console.log('\n✅ Bot rodando! Aguardando os horários agendados...');
  console.log('   (Mantenha este terminal aberto)\n');

  // Conecta já na subida, sem esperar a hora do envio. A máquina liga cerca de 5 min antes
  // do culto, e esse tempo era desperdiçado com o socket fechado. Conectando agora, a fila de
  // pedidos de reenvio que o WhatsApp acumulou durante a semana é entregue e atendida com a
  // conexão ociosa, o que conserta quem ficou travado no culto anterior antes do envio de hoje.
  // O grupo vai junto para o preparo das sessões também caber nesta folga, em vez de atrasar
  // o link na hora do envio.
  //
  // Sem await: é aquecimento, não pré-requisito. Se a hora do envio chegar antes de ele
  // terminar, o abrirSessao do envio espera a MESMA abertura em vez de abrir um segundo
  // socket para a conta.
  conectar(config.nomeGrupo);
}

// O systemd manda SIGTERM ao parar ou reiniciar o serviço. Sem tratar o sinal, o processo
// morre no meio das gravações do estado de sinal do WhatsApp, e a mensagem do culto seguinte
// já sai impossível de descriptografar para quem estava naquela sessão.
let encerrando = false;
async function encerrarComGraca(sinal) {
  if (encerrando) return;
  encerrando = true;
  console.log(`\n${sinal} recebido. Fechando a sessão do WhatsApp antes de sair...`);
  let resumo = null;
  try {
    // Piso e teto iguais e curtos: quem mandou o SIGTERM quer o processo fora (deploy,
    // restart, reboot), e segurar a janela de reenvio inteira aqui atrasaria isso à toa. O
    // TimeoutStopSec do systemd (120s) dá folga larga; quem quiser mais atendimento de
    // reenvio no restart pode subir RETRY_GRACE_SIGTERM_MS no culto.env.
    resumo = await encerrarSessao({ graca: GRACA_SIGTERM_MS, teto: GRACA_SIGTERM_MS });
  } catch (err) {
    console.error('Erro ao encerrar a sessão:', err.message);
  }
  // Sai com código diferente de zero quando alguma gravação de estado de sinal falhou. O
  // exit code aparece na linha de saída do serviço no `journalctl -u culto-bot`, então isso
  // vira alerta sem depender de log nenhum.
  process.exit(resumo?.falhasDeGravacao > 0 ? 1 : 0);
}

process.on('SIGTERM', () => encerrarComGraca('SIGTERM'));
process.on('SIGINT', () => encerrarComGraca('SIGINT'));

main().catch(err => {
  console.error('Erro fatal:', err.message);
  // Descarrega o log em disco antes de sair: numa falha é justamente quando ele importa,
  // e o buffer do pino é assíncrono.
  require('./diagnostico').encerrar();
  process.exit(1);
});
