require('dotenv').config();
const { iniciarCliente, conectar, enviarMensagem, encerrarSessao, listarTodosChats, GRACA_SIGTERM_MS } = require('./whatsapp');
const { iniciarAgendamentos } = require('./scheduler');
const { buscarTransmissaoAoVivo, buscarUltimaGravacao } = require('./youtube');

const config = {
  apiKey:    process.env.YOUTUBE_API_KEY,
  channelId: process.env.YOUTUBE_CHANNEL_ID,
  nomeGrupo: process.env.WHATSAPP_GROUP_NAME,
};

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

  // Conecta já na subida, sem esperar a hora do envio. A máquina liga cerca de 5 min antes
  // do culto, e esse tempo era desperdiçado com o socket fechado. Conectando agora, a fila de
  // pedidos de reenvio que o WhatsApp acumulou durante a semana é entregue e atendida com a
  // conexão ociosa, o que conserta quem ficou travado no culto anterior antes do envio de hoje.
  await conectar();

  iniciarAgendamentos(config);
  console.log('\n✅ Bot rodando! Aguardando os horários agendados...');
  console.log('   (Mantenha este terminal aberto)\n');
}

// O Fly manda SIGTERM quando para a máquina. Sem tratar o sinal, o processo morre no meio
// das gravações do estado de sinal do WhatsApp, e a mensagem do culto seguinte já sai
// impossível de descriptografar para quem estava naquela sessão.
let encerrando = false;
async function encerrarComGraca(sinal) {
  if (encerrando) return;
  encerrando = true;
  console.log(`\n${sinal} recebido. Fechando a sessão do WhatsApp antes de sair...`);
  let resumo = null;
  try {
    resumo = await encerrarSessao({ graca: GRACA_SIGTERM_MS });
  } catch (err) {
    console.error('Erro ao encerrar a sessão:', err.message);
  }
  // Sai com código diferente de zero quando alguma gravação de estado de sinal falhou. O
  // `fly machine status` mostra o exit_code no histórico de eventos, então isso vira alerta
  // sem depender de log nenhum.
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
