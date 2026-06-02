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

// Agenda o desligamento automático após a última janela do dia
function agendarDesligamento() {
  const agora = new Date();
  const dia = agora.getDay(); // 0 = domingo, 3 = quarta

  // Domingo: última janela termina às 19h31 (18h59 + 31 min)
  // Quarta:  última janela termina às 20h31 (19h54 + 36 min + 1 min de margem)
  const horarios = { 0: { h: 19, m: 31 }, 3: { h: 20, m: 31 } };
  const horario = horarios[dia];

  if (!horario) return; // não é dia de culto, não agenda desligamento

  const desligamento = new Date(agora);
  desligamento.setHours(horario.h, horario.m, 0, 0);

  const msAteDesligar = desligamento - agora;
  if (msAteDesligar <= 0) return; // horário já passou

  const minutos = Math.round(msAteDesligar / 60000);
  console.log(`⏰ Desligamento automático em ${minutos} min (${horario.h}h${String(horario.m).padStart(2,'0')})`);

  setTimeout(() => {
    console.log('🛑 Missão cumprida! Encerrando até o próximo culto.');
    process.exit(0);
  }, msAteDesligar);
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
  agendarDesligamento();
  console.log('\n✅ Bot rodando! Aguardando os horários agendados...');
  console.log('   (Mantenha este terminal aberto)\n');
}

main().catch(err => {
  console.error('Erro fatal:', err.message);
  process.exit(1);
});
