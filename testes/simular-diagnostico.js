/**
 * Testes do registro em disco (diagnostico.js).
 *
 * Por que existem: a primeira versão deste módulo gravava o log da biblioteca em nível
 * `debug` inteiro. Medido em produção, isso deu cerca de 1 MB por minuto enquanto o bot
 * drenava a fila de uma semana, e quase tudo era falha de descriptografia de mensagem
 * RECEBIDA, que não tem relação nenhuma com o problema de entrega. Uma conexão ociosa de um
 * dia encheria o volume de 1 GB e derrubaria o bot por falta de disco.
 *
 * Uso: node testes/simular-diagnostico.js
 */

const fs = require('fs');
const os = require('os');
const path = require('path');

const DIR_TEMP = fs.mkdtempSync(path.join(os.tmpdir(), 'culto-diag-'));
process.env.DIAG_DIR = DIR_TEMP;
process.env.BAILEYS_LOG_LEVEL = 'silent'; // silencia o stdout, o teste olha o arquivo

const diagnostico = require('../diagnostico');

let falhas = 0;
function checar(descricao, condicao, detalhe = '') {
  console.log(`${condicao ? '  ✅' : '  ❌'} ${descricao}${detalhe ? ` ${detalhe}` : ''}`);
  if (!condicao) falhas++;
}

const arquivoLog = () => {
  const nome = fs.readdirSync(DIR_TEMP).find(a => a.endsWith('.log'));
  return nome ? path.join(DIR_TEMP, nome) : null;
};

function main() {
  console.log('\n═══ Registro em disco ═══\n');

  // 1: o filtro guarda o sinal e joga fora o ruído
  {
    console.log('▶ filtro: descarta o ruído do Baileys e preserva o que diagnostica entrega');
    const log = diagnostico.logger();

    // As três linhas que dominaram o log real de produção.
    for (let i = 0; i < 500; i++) log.debug({ i }, 'failed to decrypt message');
    for (let i = 0; i < 500; i++) log.info({ i }, 'sent ack');
    for (let i = 0; i < 200; i++) log.debug({ i }, 'bulk device migration - loading all user devices');

    // As que decidem o diagnóstico.
    log.debug({ senderKeyJids: ['a@lid', 'b@lid'] }, 'sending new sender key');
    log.error({ jid: 'vitima@lid' }, 'Failed to encrypt for recipient');
    log.debug({ jid: 'g@g.us', id: 'X1' }, 'found message via getMessage');
    log.debug({ jid: 'g@g.us', id: 'X2' }, 'recv retry request, but message not available');
    log.warn({ x: 1 }, 'aviso qualquer da biblioteca');

    diagnostico.encerrar();

    const arquivo = arquivoLog();
    checar('arquivo de log criado', !!arquivo);

    const linhas = fs.readFileSync(arquivo, 'utf-8').trim().split('\n');
    const mensagens = linhas.map(l => JSON.parse(l).msg);

    checar('só as linhas relevantes foram gravadas', linhas.length === 5, `→ ${linhas.length} de 1205`);
    checar('a lista de aparelhos da chave de grupo sobreviveu', mensagens.includes('sending new sender key'));
    checar('quem ficou de fora sobreviveu', mensagens.includes('Failed to encrypt for recipient'));
    checar('reenvio atendido sobreviveu', mensagens.includes('found message via getMessage'));
    checar('reenvio sem mensagem sobreviveu', mensagens.includes('recv retry request, but message not available'));
    checar('avisos de nível warn sobrevivem sem estar na lista', mensagens.includes('aviso qualquer da biblioteca'));
    checar('ruído de descriptografia descartado', !mensagens.includes('failed to decrypt message'));
    checar('ruído de ack descartado', !mensagens.includes('sent ack'));

    // O jid do prejudicado precisa estar legível, é a razão de guardar essa linha.
    const falhaDeCifra = linhas.map(l => JSON.parse(l)).find(j => j.msg === 'Failed to encrypt for recipient');
    checar('o jid do prejudicado está no registro', falhaDeCifra?.jid === 'vitima@lid', `→ ${falhaDeCifra?.jid}`);

    checar('arquivo bem menor que o log cru', fs.statSync(arquivo).size < 4096, `→ ${fs.statSync(arquivo).size} bytes`);
    console.log('');
  }

  // 1b: o vazamento de chave privada da libsignal precisa ser barrado
  {
    console.log('▶ vazamento: o despejo de sessão da libsignal não pode ir para o stdout');

    // Captura a saída real dos dois descritores. O console.info vai para o stdout e o
    // console.warn vai para o stderr, então olhar só um deixaria metade do teste cego.
    let capturado = '';
    const originais = {};
    for (const canal of ['stdout', 'stderr']) {
      originais[canal] = process[canal].write.bind(process[canal]);
      process[canal].write = (pedaco, ...resto) => {
        capturado += String(pedaco);
        return originais[canal](pedaco, ...resto);
      };
    }

    // Exatamente o que libsignal/src/session_record.js faz nos quatro pontos que despejam
    // o objeto de sessão (linhas 270, 273, 281 e 301).
    const sessaoFalsa = {
      registrationId: 1773441846,
      currentRatchet: { ephemeralKeyPair: { privKey: Buffer.from('SEGREDOPRIVADO') }, rootKey: Buffer.from('CHAVERAIZ') },
    };
    console.info('Closing session:', sessaoFalsa);
    console.info('Opening session:', sessaoFalsa);
    console.info('Removing old closed session:', sessaoFalsa);
    console.warn('Session already closed', sessaoFalsa);
    const depoisDoVazamento = capturado;

    console.info('mensagem normal da biblioteca');
    console.warn('aviso normal da biblioteca');
    const depoisDoNormal = capturado;

    process.stdout.write = originais.stdout;
    process.stderr.write = originais.stderr;

    checar('nenhum dos quatro despejos chegou à saída', depoisDoVazamento === '');
    checar('a chave privada não aparece em lugar nenhum', !capturado.includes('SEGREDOPRIVADO'));
    checar('a chave raiz também não', !capturado.includes('CHAVERAIZ'));
    checar('console.info comum continua passando', depoisDoNormal.includes('mensagem normal da biblioteca'));
    checar('console.warn comum continua passando', depoisDoNormal.includes('aviso normal da biblioteca'));
    console.log('');
  }

  // 2: rotação trata os dois tipos separadamente
  {
    console.log('▶ rotação: poda logs e resumos de forma independente');
    const dir2 = fs.mkdtempSync(path.join(os.tmpdir(), 'culto-rot-'));
    for (let i = 1; i <= 25; i++) {
      const n = String(i).padStart(2, '0');
      fs.writeFileSync(path.join(dir2, `2026-08-04_10-00-${n}.log`), 'x');
      fs.writeFileSync(path.join(dir2, `resumo-2026-08-04_10-00-${n}.json`), '{}');
    }

    // Módulo novo, apontando para o outro diretório.
    delete require.cache[require.resolve('../diagnostico')];
    process.env.DIAG_DIR = dir2;
    process.env.DIAG_MAX_ARQUIVOS = '20';
    require('../diagnostico').logger();

    const restantes = fs.readdirSync(dir2);
    const logs = restantes.filter(a => a.endsWith('.log')).sort();
    const resumos = restantes.filter(a => a.startsWith('resumo-'));

    // 25 logs viram 20 podados mais o novo desta execução.
    checar('logs podados até o limite', logs.length === 21, `→ ${logs.length}`);
    checar('resumos podados até o limite', resumos.length === 20, `→ ${resumos.length}`);
    // O ponto do teste: ordenar tudo junto poria todos os logs antes de qualquer resumo,
    // e a poda apagaria os logs MAIS NOVOS enquanto guardava resumos velhos.
    checar('os logs mantidos são os mais recentes', logs[0] === '2026-08-04_10-00-06.log', `→ ${logs[0]}`);
    checar('o resumo mais antigo mantido é o esperado', resumos.sort()[0] === 'resumo-2026-08-04_10-00-06.json');

    fs.rmSync(dir2, { recursive: true, force: true });
    console.log('');
  }

  // 3: o resumo da janela é gravado e volta legível
  {
    console.log('▶ resumo: grava o JSON da janela em disco');
    const dir3 = fs.mkdtempSync(path.join(os.tmpdir(), 'culto-res-'));
    delete require.cache[require.resolve('../diagnostico')];
    process.env.DIAG_DIR = dir3;
    const d = require('../diagnostico');

    const resumo = {
      envios: [{ id: 'ABC', em: '2026-08-05T23:00:00.000Z' }],
      grupo: { participantes: 477, aparelhos: 845 },
      reenviosAtendidos: { total: 2, ids: ['ABC', 'DEF'] },
    };
    const arquivo = d.gravarResumo(resumo);

    checar('resumo gravado', !!arquivo && fs.existsSync(arquivo));
    const lido = JSON.parse(fs.readFileSync(arquivo, 'utf-8'));
    checar('conteúdo do resumo preservado', lido.grupo.aparelhos === 845 && lido.reenviosAtendidos.total === 2);

    fs.rmSync(dir3, { recursive: true, force: true });
    console.log('');
  }

  fs.rmSync(DIR_TEMP, { recursive: true, force: true });

  console.log('═══════════════════════════════════');
  if (falhas === 0) {
    console.log('✅ Todos os cenários passaram.\n');
    process.exit(0);
  }
  console.log(`❌ ${falhas} verificação(ões) falharam.\n`);
  process.exit(1);
}

try {
  main();
} catch (err) {
  fs.rmSync(DIR_TEMP, { recursive: true, force: true });
  console.error('Erro na simulação:', err);
  process.exit(1);
}
