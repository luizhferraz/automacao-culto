require('dotenv').config();
const { iniciarCliente, enviarMensagem, encerrarSessao, listarTodosChats, GRACA_SIGTERM_MS } = require('./whatsapp');
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

  if (args.includes('--diagnostico')) {
    const { diagnosticarDOM } = require('./whatsapp');
    await diagnosticarDOM();
    process.exit(0);
  }

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
  try {
    await encerrarSessao({ graca: GRACA_SIGTERM_MS });
  } catch (err) {
    console.error('Erro ao encerrar a sessão:', err.message);
  }
  process.exit(0);
}

process.on('SIGTERM', () => encerrarComGraca('SIGTERM'));
process.on('SIGINT', () => encerrarComGraca('SIGINT'));

main().catch(err => {
  console.error('Erro fatal:', err.message);
  process.exit(1);
});
