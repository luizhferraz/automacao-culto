/**
 * O servidor da UI admin (admin/server.js): conversão nome/início/fim/dias → linha da tabela,
 * geração de chave, detecção de conflito de horário e persistência em janelas-config.json.
 *
 * Roda o servidor real, na porta de teste, e bate nele com fetch — sem dublês, porque a única
 * lógica aqui É a conversão de payload e a leitura/escrita do arquivo, e um dublê esconderia
 * justamente o que o teste precisa provar: que o arquivo gravado é o que o scheduler.js
 * carregaria de volta.
 *
 * Uso: node testes/simular-admin.js
 */

const path = require('path');
const fs = require('fs');
const os = require('os');

// Precisa vir ANTES de qualquer require do scheduler/admin: é o que isola o arquivo editável
// (janelas-config.json) numa pasta temporária, em vez de escrever na raiz do repositório.
process.env.AUTH_DIR = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'culto-admin-')), 'baileys_auth');
process.env.ADMIN_PORT = '0'; // porta livre escolhida pelo SO — testes em paralelo não colidem

const { servidor } = require('../admin/server');
const { ARQUIVO_CONFIG_JANELAS, JANELAS_PADRAO, validarTabela } = require('../scheduler');

let falhas = 0;
function checar(descricao, condicao, detalhe = '') {
  console.log(`${condicao ? '  ✅' : '  ❌'} ${descricao}${detalhe ? ` ${detalhe}` : ''}`);
  if (!condicao) falhas++;
}

function aguardarPorta() {
  if (servidor.listening) return Promise.resolve();
  return new Promise(resolve => servidor.once('listening', resolve));
}

async function main() {
  console.log('\n═══ Servidor admin (admin/server.js) ═══\n');
  await aguardarPorta();
  const porta = servidor.address().port;
  const base = `http://127.0.0.1:${porta}`;
  const api = (caminho, opcoes) => fetch(base + '/api/janelas' + caminho, {
    headers: { 'Content-Type': 'application/json' },
    ...opcoes,
  });

  // 1: sem edição nenhuma, a API devolve a tabela embutida
  {
    console.log('▶ GET sem janelas-config.json ainda: cai na tabela embutida');
    const resp = await api('', { method: 'GET' });
    const corpo = await resp.json();
    checar('200 OK', resp.status === 200, `→ ${resp.status}`);
    checar('mesma quantidade da tabela padrão', corpo.length === JANELAS_PADRAO.length, `→ ${corpo.length}`);
    checar('nenhum arquivo gravado ainda', !fs.existsSync(ARQUIVO_CONFIG_JANELAS));
    console.log('');
  }

  // 2: payload inválido é rejeitado antes de tocar o arquivo
  {
    console.log('▶ POST sem nome: 400, nada gravado');
    const resp = await api('', { method: 'POST', body: JSON.stringify({ inicio: '10:00', fim: '11:00', diasSemana: [1] }) });
    const corpo = await resp.json();
    checar('400', resp.status === 400, `→ ${resp.status}`);
    checar('erro menciona nome', corpo.erro.includes('nome'), `→ ${corpo.erro}`);
    checar('ainda nenhum arquivo', !fs.existsSync(ARQUIVO_CONFIG_JANELAS));
    console.log('');
  }

  // 3: criação válida gera chave (slug sem acento), grava atômico, some no GET seguinte
  // Segunda e terça: nenhuma janela padrão cai nesses dias, então não há conflito de horário.
  let chaveCriada;
  {
    console.log('▶ POST "Reunião de Oração" seg/ter 20:00–21:00: cria com chave sem acento');
    const resp = await api('', {
      method: 'POST',
      body: JSON.stringify({ nome: 'Reunião de Oração', inicio: '20:00', fim: '21:00', diasSemana: [1, 2] }),
    });
    const corpo = await resp.json();
    checar('201', resp.status === 201, `→ ${resp.status}`);
    checar('chave sem acento nem espaço', corpo.chave === 'reuniao-de-oracao', `→ ${corpo.chave}`);
    checar('maxTentativas = fim - início em minutos', corpo.maxTentativas === 60, `→ ${corpo.maxTentativas}`);
    checar('hora/minuto extraídos do início', corpo.hora === 20 && corpo.minuto === 0);
    checar('arquivo gravado e válido pelas mesmas regras do bot', (() => {
      const tabela = JSON.parse(fs.readFileSync(ARQUIVO_CONFIG_JANELAS, 'utf8'));
      validarTabela(tabela); // lança se inválida
      return tabela.some(j => j.chave === 'reuniao-de-oracao');
    })());
    chaveCriada = corpo.chave;
    console.log('');
  }

  // 4: segunda janela com nome que gera o mesmo slug ganha sufixo, não sobrescreve a primeira
  {
    console.log('▶ POST outra "Reunião de Oração" (dia diferente): chave ganha sufixo -2');
    const resp = await api('', {
      method: 'POST',
      body: JSON.stringify({ nome: 'Reunião de Oração', inicio: '07:00', fim: '08:00', diasSemana: [6] }),
    });
    const corpo = await resp.json();
    checar('201', resp.status === 201, `→ ${resp.status}`);
    checar('chave com sufixo', corpo.chave === 'reuniao-de-oracao-2', `→ ${corpo.chave}`);
    console.log('');
  }

  // 5: conflito de horário no mesmo dia é bloqueado, mesmo sem colidir com validarTabela
  {
    console.log('▶ POST colidindo com "Reunião de Oração" na segunda: 409, nada gravado a mais');
    const antes = JSON.parse(fs.readFileSync(ARQUIVO_CONFIG_JANELAS, 'utf8')).length;
    const resp = await api('', {
      method: 'POST',
      body: JSON.stringify({ nome: 'Ensaio', inicio: '20:30', fim: '21:30', diasSemana: [1] }),
    });
    const corpo = await resp.json();
    const depois = JSON.parse(fs.readFileSync(ARQUIVO_CONFIG_JANELAS, 'utf8')).length;
    checar('409', resp.status === 409, `→ ${resp.status}`);
    checar('erro cita a janela conflitante', corpo.erro.includes('Reunião de Oração'), `→ ${corpo.erro}`);
    checar('nada foi gravado a mais', depois === antes, `→ antes ${antes}, depois ${depois}`);
    console.log('');
  }

  // 6: edição preserva a chave mesmo trocando o nome
  {
    console.log('▶ PUT na janela criada, com nome novo: chave não muda');
    const resp = await api('/' + encodeURIComponent(chaveCriada), {
      method: 'PUT',
      body: JSON.stringify({ nome: 'Oração de Segunda', inicio: '20:15', fim: '21:00', diasSemana: [1] }),
    });
    const corpo = await resp.json();
    checar('200', resp.status === 200, `→ ${resp.status}`);
    checar('chave permanece a mesma', corpo.chave === chaveCriada, `→ ${corpo.chave}`);
    checar('rótulo atualizado', corpo.rotulo === 'Oração de Segunda');
    checar('dia da semana atualizado (só segunda agora)', JSON.stringify(corpo.diaSemana) === '[1]', `→ ${JSON.stringify(corpo.diaSemana)}`);
    console.log('');
  }

  // 7: PUT em chave inexistente não cria nada
  {
    console.log('▶ PUT em chave que não existe: 404');
    const resp = await api('/nao-existe', {
      method: 'PUT',
      body: JSON.stringify({ nome: 'X', inicio: '10:00', fim: '11:00', diasSemana: [2] }),
    });
    checar('404', resp.status === 404, `→ ${resp.status}`);
    console.log('');
  }

  // 8: exclusão remove do arquivo e some do GET seguinte
  {
    console.log('▶ DELETE na janela criada: some da lista');
    const resp = await api('/' + encodeURIComponent(chaveCriada), { method: 'DELETE' });
    checar('204', resp.status === 204, `→ ${resp.status}`);

    const resp2 = await api('', { method: 'GET' });
    const corpo2 = await resp2.json();
    checar('não aparece mais no GET', !corpo2.some(j => j.chave === chaveCriada));
    console.log('');
  }

  console.log('═══════════════════════════════════');
  servidor.close();
  if (falhas === 0) {
    console.log('✅ Todos os cenários passaram.\n');
    process.exitCode = 0;
    return;
  }
  console.log(`❌ ${falhas} verificação(ões) falharam.\n`);
  process.exitCode = 1;
}

main().catch(err => {
  console.error('Erro na simulação:', err);
  servidor.close();
  process.exitCode = 1;
});
