require('dotenv').config();
const { iniciarCliente, enviarMensagem, listarTodosChats } = require('./whatsapp');
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
  console.log('🙏 Automação de Culto — Iniciando...\n');
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
    process.exit(0);
  }

  if (args.includes('--teste-envio')) {
    console.log('\n📤 Enviando mensagem de teste...\n');
    try {
      await enviarMensagem(config.nomeGrupo, '✅ *Teste da automação do Culto* — tudo funcionando! 🙏');
    } catch (err) {
      console.error('Erro:', err.message);
    }
    process.exit(0);
  }

  iniciarAgendamentos(config);
  console.log('\n✅ Bot rodando! Aguardando os horários agendados...');
  console.log('   (Mantenha este terminal aberto)\n');
}

main().catch(err => {
  console.error('Erro fatal:', err.message);
  process.exit(1);
});
