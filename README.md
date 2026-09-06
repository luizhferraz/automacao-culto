# Automação de Culto: WhatsApp + YouTube

Envia automaticamente os links das transmissões ao vivo (e estreias) para um canal de Avisos no WhatsApp, nos horários agendados. Roda 24/7 numa VM `e2-micro` do Google Cloud (free tier, custo zero), como serviço do systemd — sem precisar deixar nenhum computador ligado. Migrado do Fly.io em 22/08/2026, quando o modelo liga-desliga por culto foi aposentado.

---

## Como funciona

O bot monitora o canal do YouTube a cada **1 minuto** a partir do horário configurado. Assim que encontra uma transmissão ao vivo ou estreia do canal, envia o link para o grupo e para de monitorar.

**Sem filtro de título** (desde 22/08): dentro de uma janela de culto, **qualquer** transmissão
do canal é o culto — a lista de palavras-chave ("Culto da Família", "Culto de Fé",
"Especial de...") quebrava a cada variação nova de nome e foi aposentada. Quem impede o vídeo
errado de sair passou a ser o **horário**: só é aceito o que está de fato no ar agora, ou cuja
transmissão tem horário marcado dentro da janela. Upload comum (clipe, aviso) e rascunho de
transmissão sem data não passam — nenhum dos dois tem horário de transmissão.

**Horários monitorados:**

| Dia | Início | Culto | Janela | Aviso de atraso | Comportamento |
|-----|--------|-------|--------|-----------------|---------------|
| Domingo manhã | 9h53 | 10h00 | até 10h30 | 10h03 | Envia link ao vivo |
| Domingo noite | 18h53 | 19h00 | até 19h30 | 19h03 | Envia link ao vivo; se não encontrar, envia a gravação mais recente (últimas 6h) |
| Quarta-feira | 19h53 | 20h00 | até 20h30 | 20h03 | Envia link ao vivo |
| Sábado | 18h53 | 19h00 | até 19h30 | — | Envia link ao vivo. Culto em teste na igreja: **sem** aviso de atraso |
| Segunda a sexta, **só de 14 a 18/09/2026** | 6h25 | 6h30 | até 7h00 | — | Envia link ao vivo. Semana especial com vigência: fora dessas datas a janela não existe |

As janelas fixas abrem **7 minutos antes** do culto e fecham 30 minutos depois dele. Os 7 min
foram padronizados em 25/08 (antes era uma mistura de 1, 6 e 11): tecnicamente a antecedência
é indiferente, então ficou o número bíblico da completude. Em dia de estreia o vídeo costuma já
estar publicado quando a janela abre, então a abertura é, na prática, a hora em que o link sai
no grupo — ele chega ~7 min antes do culto, apontando para a contagem regressiva.

**Janela com vigência:** uma entrada de `JANELAS` pode declarar `vigencia: { de, ate }` (datas
em `YYYY-MM-DD`, no fuso da igreja, as duas inclusas) e `diaSemana` como lista. Fora da
vigência a janela fica na tabela mas não faz nada: o cron interno dispara, deixa uma linha no
journal ("Gatilho de semana-manha fora da vigência ... nada a fazer") e sai, e a recuperação
de janela perdida não a reabre. É assim que a semana de 14 a 18/09 entrou sem depender de
alguém lembrar de remover a entrada na sexta — a alternativa, entradas temporárias, era o bot
procurando culto às 6h25 todo dia útil até alguém notar. Data escrita errada (`2026-9-14` sem o
zero, `2026-02-30`, `de` depois de `ate`) e chave repetida entre duas janelas derrubam a carga
do módulo, cada uma com a própria mensagem: o `npm test` acusa antes do deploy, e na VM o
serviço nem sobe, em vez de uma janela que simplesmente não abre. Depois do dia 18 a entrada
pode ser removida a qualquer momento, como limpeza: os testes do mecanismo usam uma janela
própria e continuam passando sem ela (só o cenário que confere aquela configuração se anuncia
como pulado).

Para operar: o cron só lê a tabela na subida do processo, então a entrada precisa estar em
produção (`git pull` + `systemctl restart culto-bot`, fora de horário de culto) **antes** da
primeira janela. A conferência é o log de subida (`journalctl -u culto-bot -n 20`): a janela
tem que aparecer na lista, com a vigência — e, antes do primeiro dia, com o sufixo "fora da
vigência hoje". Se a linha não aparecer, o código novo não chegou à VM.

**Aviso de atraso:** se o link ainda não foi encontrado 3 minutos após o horário do culto, o bot
envia uma mensagem ao grupo avisando que a transmissão atrasou. É enviado no máximo uma vez por
janela e não interrompe a busca: se o link aparecer depois, ele é enviado normalmente em seguida.
Se o primeiro envio do aviso falhar, o bot tenta de novo na tentativa seguinte, sem duplicar.
A janela de sábado não tem aviso (`avisoAposMin: null`): enquanto o culto de sábado for
experimento, sábado sem transmissão é resultado esperado, não incidente para anunciar no grupo.

**Memória de janela em disco:** o que cada janela já fez hoje — link enviado, aviso dado,
gravação do fallback enviada, janela esgotada sem link — fica registrado em
`janelas-enviadas.json`, ao lado do diretório de credenciais. O processo morre e renasce por
desenho (fim de janela, teto de vida de 90 min, systemd religando com `Restart=always`), e
nada disso pode apagar a memória do que já foi enviado: no domingo **23/08**, sem esse
registro, o link da manhã saiu repetido — o exit do fim da janela (que no Fly deixava a
máquina desligada) virou restart no systemd, e a recuperação de janela perdida reexecutava a
janela com a live ainda no ar. A recuperação consulta o registro antes de reabrir a janela,
e o monitoramento consulta antes de enviar.

Três reforços do mesmo registro:

- **Escrita atômica** (arquivo temporário + rename): disco cheio no meio da escrita não pode
  truncar o JSON — arquivo ilegível vale como "nunca enviei", que é a política certa para
  primeiro uso e a errada para corrupção.
- **Arquivo reserva dentro do `AUTH_DIR`**: se a gravação principal falhar (permissão errada
  no diretório pai, fs read-only), a marca vai para `$AUTH_DIR/janelas-enviadas.json` — um
  diretório que, se o envio acabou de funcionar, comprovadamente aceita escrita. A leitura é
  a união dos dois arquivos. Sem isso, uma falha de escrita repetida era o pior loop
  possível: envio → exit → restart → recuperação sem memória → reenvio, a cada ~3 min até a
  janela expirar.
- **Envios tardios**: o prazo de 2 min do envio não cancela o envio de baixo — um envio que
  estoura o prazo e completa depois entra no grupo com o laço achando que falhou. A conclusão
  tardia fica registrada, e a tentativa seguinte a absorve (marca a janela e encerra) em vez
  de reenviar. Era o único jeito de duplicar o link sem nenhum restart.

**Ciclo automático (VM no GCP + systemd):**
1. A VM fica ligada 24/7; o bot roda como serviço (`culto-bot.service`) com `Restart=always`
2. A cada subida, o bot registra os horários e arma o teto de vida **antes** de qualquer coisa que dependa da rede
3. Conecta no WhatsApp já na subida e atende os pedidos de reenvio pendentes
4. No horário de cada janela, o cron interno dispara e o YouTube é monitorado a cada 1 minuto
5. Ao encontrar a live → envia o link → registra na memória de janela → encerra o monitoramento
6. Mantém a conexão de pé enquanto chegarem pedidos de reenvio (veja abaixo)
7. Ao fim da janela o processo se encerra — e o systemd o religa em ~10 s, reconectando. O
   mesmo vale para o teto de vida (90 min): o processo se renova o dia inteiro nesse ciclo,
   e a memória de janela em disco garante que nenhum renascimento repete envio

A ordem do passo 2 não é estética. Enquanto a conexão da subida era aguardada antes do
registro dos horários, ela era um **ponto único de falha silencioso**: qualquer coisa
pendurada ali impedia ao mesmo tempo o agendamento da janela e o armamento do teto de vida.
O resultado seria o processo de pé, sem enviar nada e sem se renovar — que é exatamente o
estado que segura a sessão da conta e emudece o celular do dono. Hoje a conexão da subida é
aquecimento, não pré-requisito: ela não é aguardada, e se a hora do envio chegar antes de ela
terminar, o envio espera a **mesma** abertura em vez de abrir um segundo socket.

> **A era Fly foi encerrada em 06/09/2026.** A máquina do Fly (`culto-automacao`) tinha
> volume próprio de credenciais do WhatsApp — um segundo aparelho vinculado, com o código
> antigo — e era ligada minutos antes de cada culto pelo **cron-job.org**, um agendador
> externo que a migração para a VM não tinha desligado. Foi a explicação mais provável para o
> envio extra de 23/08 que o journal da VM não mostrava. Em 06/09 o Luiz confirmou que a
> máquina do Fly e os jobs do cron-job.org foram desligados; desde então o único agendador é
> o cron interno deste bot (`scheduler.js`), e os três workflows do GitHub da era Fly já
> tinham saído do repositório. Dois restos que só existem fora do repositório e que vale
> conferir uma vez, se ainda não foram feitos:
>
> - **WhatsApp** (celular do dono): Aparelhos conectados → o aparelho da era Fly pode ainda
>   aparecer na lista, porque o registro na conta sobrevive à destruição da máquina. Se
>   aparecer, desvincular — com cuidado para **não** desvincular o aparelho da VM.
> - **GitHub e Fly**: o secret `FLY_API_TOKEN` do repositório e o token correspondente no
>   Fly (`fly tokens revoke`). Nada mais usa; token vivo é credencial solta.

> **⚠️ Na VM de hoje, o estado do bot mora em `/opt/automacao-culto`, não em `/var/lib/culto`.**
> Conferido em 06/09/2026: o `/etc/culto/culto.env` tem só `YOUTUBE_API_KEY`,
> `YOUTUBE_CHANNEL_ID`, `WHATSAPP_GROUP_NAME` e `TZ`. Sem a linha `AUTH_DIR`, o código usa o
> padrão `.baileys_auth`, relativo ao `WorkingDirectory` do serviço. Resultado: a sessão do
> WhatsApp (e o histórico de mensagens enviadas) está em `/opt/automacao-culto/.baileys_auth`,
> a memória de janela em `/opt/automacao-culto/janelas-enviadas.json` e o diagnóstico em
> `/opt/automacao-culto/diagnostico/`; `/var/lib/culto` está vazio. Todo comando deste README
> que aponta para `/var/lib/culto` responde "No such file" até a migração abaixo. O bot
> funciona assim, mas código e dados misturados têm dois riscos: um `git clean` ou um clone
> novo destrói a sessão (parear de novo pelo QR) e a memória de envios do dia; e o
> `git status` mostrava os dois arquivos como sujeira a cada deploy — por isso os dois entraram
> no `.gitignore`.
>
> **Migração, a fazer fora de horário de culto e depois da semana de 14 a 18/09** (mexe na
> sessão do WhatsApp da conta; com o serviço parado, é mover três itens e uma linha no env):
>
> ```bash
> sudo systemctl stop culto-bot
> sudo mv /opt/automacao-culto/.baileys_auth /var/lib/culto/baileys_auth
> sudo mv /opt/automacao-culto/janelas-enviadas.json /var/lib/culto/
> sudo mv /opt/automacao-culto/diagnostico /var/lib/culto/diagnostico
> sudo chown -R culto:culto /var/lib/culto
> echo 'AUTH_DIR=/var/lib/culto/baileys_auth' | sudo tee -a /etc/culto/culto.env
> sudo systemctl start culto-bot
> journalctl -u culto-bot -n 20
> ```
>
> A conferência é a linha "Credenciais encontradas" no log de subida, sem pedido de QR code, e
> o `/var/lib/culto/janelas-enviadas.json` ganhando a marca da janela seguinte. Se o log pedir
> QR, a sessão não foi encontrada: pare o serviço e confira o caminho na linha `AUTH_DIR`.
> Feita a migração, este aviso pode ser removido.

**Se o processo subir atrasado** — um restart (teto de vida, deploy, reboot da VM) caindo
depois do **segundo 0** do minuto agendado de uma janela —, o cron daquele dia já passou e
não dispara mais (o node-cron só dispara no segundo 0). O bot detecta isso na subida e
**recupera a janela**, com as tentativas descontadas do atraso e o aviso de atraso adiantado,
desde que o link do dia não esteja registrado em disco e a janela não tenha sido esgotada
hoje. A recuperação vale **desde o atraso zero**: um boot dentro do próprio minuto do gatilho
(9h53m08s, digamos) também já perdeu o cron do dia, e o piso antigo de 1 minuto transformava
esses ~59 segundos numa zona morta que matava a janela inteira em silêncio. O cron ainda roda
com `recoverMissedExecutions`, para um tick que pule o segundo 0 (pausa de GC, CPU da
e2-micro estrangulada) não perder o gatilho com o processo vivo.

### Notificação no celular do dono

O bot é um aparelho vinculado à conta pessoal, então enquanto o socket está de pé o WhatsApp
precisa decidir para onde mandar o push. **Duas** coisas precisam estar certas, e por muito
tempo só uma estava:

1. **Presença.** `markOnlineOnConnect: false` faz o Baileys anunciar `presence: unavailable` ao
   abrir a conexão. Essa metade sempre esteve correta.
2. **Sessão ativa.** No login (`CB:success`) o Baileys manda também, **incondicionalmente e sem
   sequer consultar `markOnlineOnConnect`**, `<iq xmlns="passive"><active/></iq>`. É o mesmo iq
   que o WhatsApp Web usa para dizer que a aba está em foco (`active`) ou foi para segundo plano
   (`passive`), e a própria biblioteca não sabe explicar por que o manda: o comentário no fonte
   é *"i have no idea why this exists. pls enlighten me"*. Está assim tanto na `7.0.0-rc11`
   (a versão travada no `package-lock.json`) quanto na `rc14`.

Ou seja: o bot dizia "indisponível" na presença e, milissegundos depois, se declarava a sessão
**ativa** da conta. Por isso o `anunciarSessaoPassiva` manda o iq inverso logo após o
`connection: open`, e a ordem na rede fica `active` (lib) → `unavailable` (lib) → `passive`
(nosso). O anúncio ainda é **reforçado** a cada `PASSIVO_REANUNCIO_MS` (5 min) enquanto a
conexão viver: se o primeiro iq falhar, a volta seguinte conserta em vez de deixar a conta
ativa pela janela inteira, e qualquer reativação vinda do servidor no meio dos ~50 minutos de
socket aberto é desfeita. O resumo registra o total em `anunciosPassivos`.

Na era Fly o socket abria ~50 minutos, três vezes por semana. Na VM ele fica aberto
**praticamente o tempo todo** (em ciclos de até 90 min, renovados pelo teto de vida), o que
torna o anúncio de sessão passiva — e o seu reforço periódico — a peça central da proteção:
é ele que permite um aparelho vinculado permanentemente online sem emudecer o celular do dono.

Se o celular voltar a não notificar, confira nesta ordem:

1. **`sessaoPassiva` no resumo da última janela** (falso = a conta passou a janela inteira
   marcada como sessão ativa).
2. **O ciclo de vida está girando?** `systemctl status culto-bot` mostra desde quando o
   processo atual está de pé; mais de ~95 min sem renovar é sinal de teto de vida travado, e
   processo pendurado é o estado que historicamente segurava a sessão da conta. O
   `journalctl -u culto-bot` mostra os pares "Encerrando/Started" do ciclo normal.
3. **Variáveis em `/etc/culto/culto.env` sobrepondo o código** (ver o quadro de cuidado mais
   abaixo — o incidente aconteceu na era Fly, mas o mecanismo é o mesmo).
4. Se tudo acima estiver certo e o celular continuar mudo, o estado preso é do **próprio
   aparelho**: abra o WhatsApp em primeiro plano (ou force o fechamento e abra de novo) para
   ele voltar a se registrar como a sessão ativa da conta. Em último caso, desvincule o
   "Culto Bot" em Aparelhos conectados e pareie de novo pelo QR.

### O problema do "Aguardando mensagem"

O WhatsApp é criptografado ponta a ponta. Quando o aparelho de alguém não consegue
descriptografar uma mensagem do grupo, ele **não** desiste: manda de volta um pedido de
reenvio (*retry receipt*) e mostra na tela **"Aguardando mensagem. Essa ação pode levar
alguns instantes."** até o remetente responder.

Em grupo, a mensagem em si vai criptografada com uma *sender key*, e o remetente precisa
distribuir essa chave para cada aparelho. O Baileys anota em `sender-key-memory-<grupo>.json`
quem já recebeu, e só distribui para quem ainda não está lá. **O problema está na ordem**: ele
marca o aparelho como atendido *antes* de conseguir criptografar para ele, e grava esse mapa
no disco mesmo quando a criptografia falha. Falha por destinatário é engolida em silêncio, e
o envio só é considerado quebrado se falhar para **todos**.

Isso foi medido em produção no domingo 02/08. De manhã o mapa foi zerado, os 845 aparelhos
entraram na distribuição e todos foram marcados como atendidos. À noite o mapa foi lido cheio,
a lista de destinatários da chave ficou **vazia**, e a mensagem das 18:59 saiu sem distribuir
chave para ninguém. Quem falhou de manhã estava condenado a falhar de novo à noite. Como o
único ponto da biblioteca que limpa esse mapa fica dentro do tratamento do pedido de reenvio,
e isso exige socket vivo, o bloqueio era permanente.

### A causa raiz: a fila de entrada entupida

Tudo acima é verdade, e mesmo assim não era o principal. O bot é um **aparelho vinculado à
conta pessoal**, então recebe toda a conversa do dono, não só o grupo de avisos. Como fica
offline quase a semana inteira, o WhatsApp acumula esse tráfego e despeja tudo de uma vez na
reconexão. Medido no log da quarta 05/08:

| | |
|---|---|
| Mensagens indecifráveis processadas | 2887, **todas de outros grupos** (zero do grupo de avisos) |
| Vazão | **7 nós por segundo** (cada falha custa transação, rollback e disco) |
| Última processada | 22:56:03, **o instante exato em que o socket fechou** |

Ou seja: a janela inteira de reenvio foi gasta processando mensagem de grupo que não
interessa, e o processador de nós offline abandona em silêncio o que sobrou quando o
websocket fecha (`while (nodes.length && deps.isWsOpen())`).

O pedido de reenvio do grupo de avisos estava nessa fila e **nunca chegou a ser lido**. É por
isso que o resumo daquela janela registrou zero reenvios atendidos e zero confirmações de
entrega: não é que ninguém pediu, é que o bot nunca chegou lá. E como o único ponto da
biblioteca que limpa a memória de distribuição de chave fica dentro desse tratamento, ele
nunca rodou nem uma vez na vida deste bot.

O `getMessage`, o histórico em disco e a janela elástica estavam corretos, e todos inúteis,
porque a fila nunca chegava neles.

Cinco defesas:

1. **Filtro de ruído (`shouldIgnoreJid`).** Tudo que não é o grupo de avisos é descartado com
   ack **antes de entrar na fila**, sem nem tentar descriptografar. A fila passa a conter só
   o que interessa e drena em segundos, então os pedidos de reenvio chegam ao tratamento e o
   ciclo de autocorreção da biblioteca finalmente roda. Conversa individual continua passando,
   por segurança; o volume mora nos grupos. Se `WHATSAPP_GROUP_NAME` não estiver definido o
   filtro se desliga sozinho, porque sem saber qual é o grupo ele descartaria o alvo junto.
2. **A memória de distribuição é ignorada.** A leitura devolve sempre vazio e a gravação é
   descartada, então **todo envio redistribui a chave para todos os aparelhos**. Quem ficou de
   fora numa semana ganha nova chance na semana seguinte. Não é gambiarra: é o que a própria
   biblioteca faz ao atender um pedido de reenvio, zerando o mapa do grupo inteiro.
3. **Histórico em disco.** Toda mensagem enviada é gravada em `$AUTH_DIR/mensagens-enviadas.json`
   (últimas 200, validade de 30 dias). Se o pedido de reenvio só chegar dias depois, porque o
   celular estava desligado, o WhatsApp o entrega na próxima conexão do bot, e aí ele consegue
   reenviar mesmo tendo sido outra execução do processo.
4. **Conexão na subida.** O socket abre quando o processo sobe, não na hora do envio. Cada
   renascimento (fim de janela, teto de vida) reconecta e drena o que o WhatsApp tiver
   enfileirado — e como o processo agora vive em ciclos de no máximo 90 min, a fila
   praticamente não acumula: um pedido de reenvio espera minutos, não uma semana como na era
   Fly. Cada pedido atendido faz o Baileys recriar a sessão daquele aparelho, o que conserta
   gente travada desde o culto anterior.
5. **Janela de reenvio elástica.** Depois do último envio a conexão fica aberta por pelo menos
   `RETRY_GRACE_MS`, e continua aberta enquanto chegarem pedidos, até o teto de
   `RETRY_GRACE_MAX_MS`. Relógio fixo era a coisa errada: o Baileys abandona em silêncio o que
   sobrou na fila assim que o websocket fecha, então encerrar no meio da fila jogava fora
   exatamente os pedidos que se queria atender.

Existe ainda uma sexta defesa, **desligada por padrão**: `FORCAR_SESSOES=1` recria as sessões
de sinal em lote **na subida**, nos minutos ociosos antes do culto. Ela ataca o caso de quem
reinstalou o WhatsApp ou trocou de aparelho, porque nesse cenário a sessão do lado da pessoa
foi destruída mas o arquivo do bot continua intacto em disco, e a validação que o Baileys faz
antes de distribuir a chave é puramente local: não tem como saber que o outro lado apagou a
sessão dele.

Ela foi ligada uma vez, na quarta 05/08, e o quadro **piorou**: gente que recebia normalmente
passou a não receber. O log mostra que ela fez exatamente o que prometia (860 sessões
recriadas, 18 lotes, zero falha), o que reforça que o problema estava na fila de entrada e não
nas sessões. Está desligada de novo. Com o filtro de ruído no lugar, a recriação de sessão
passa a acontecer sozinha e de forma **dirigida**: cada pedido de reenvio atendido faz o
Baileys recriar a sessão daquele aparelho específico. Só volte a ligá-la com evidência nova.

> **Cuidado com variáveis de ambiente esquecidas.** A configuração efetiva é a soma do código
> com o `/etc/culto/culto.env` (que o systemd injeta via `EnvironmentFile`), e variável
> esquecida sobrepõe o padrão do código em silêncio. O incidente que ensinou isso foi na era
> Fly: "desligada de novo" acima era verdade no código desde 06/08, mas o `FORCAR_SESSOES=1`
> de um experimento continuou como secret valendo em produção até 13/08 — o resumo de cada
> janela entregava a prova (`sessoesForcadas: 856`) sem ninguém notar. Um
> `RETRY_GRACE_MS=1200000` da mesma época segurava o socket aberto 20 minutos em toda janela.
> A VM foi montada do zero só com o necessário (as sobras ficaram para trás na migração);
> para auditar o que está valendo: `sudo cat /etc/culto/culto.env`.

Não dá para ser cirúrgico aqui. Sessão obsoleta é, por construção, invisível do lado do bot:
não existe log, erro ou sinal que aponte quem está nessa situação. Ou se recria tudo, ou não
se conserta ninguém. Os custos são baixos no uso deste bot: descartar o ratchet não tem efeito
funcional, e a chave de uso único que se consome de cada pessoa é reposta pelo aparelho dela
sozinho (e se acabarem, o servidor devolve a chave assinada e funciona igual). O preparo roda
na conexão da subida justamente para não atrasar o link, e o laço vigia o próprio prazo
(`PREPARO_TIMEOUT_MS`), parando sozinho em vez de continuar rodando em segundo plano durante o
envio. Se o preparo falhar por qualquer motivo, o link sai do mesmo jeito.

### Diagnóstico

O diagnóstico nasceu na era Fly, quando os logs eram só ao vivo e evaporavam com a máquina.
Na VM o `journalctl -u culto-bot` persiste tudo, mas o registro estruturado por janela
continua sendo o que responde rápido às perguntas que importam — por isso cada janela grava
em `/var/lib/culto/diagnostico/` (derivado do `AUTH_DIR`):

- `<carimbo>.log`: as linhas do Baileys que decidem o diagnóstico de entrega,
  `sending new sender key` (a lista de aparelhos que receberam a chave) e
  `Failed to encrypt for recipient` (quem ficou de fora, com o jid). A diferença entre as duas
  é a **lista nominal** de quem não recebeu. Tudo de nível `warn` para cima entra também.
- `resumo-<carimbo>.json`: ids e horários dos envios, tamanho do grupo, quantos aparelhos,
  quem confirmou entrega, quantos reenvios foram atendidos, quantas gravações falharam,
  `sessaoPassiva` (falso significa que a conta passou a janela inteira com um aparelho
  vinculado ativo, e o celular do dono provavelmente ficou sem notificação) e `notas`.
- `notas` é a linha do tempo do que o **bot decidiu**, que é diferente do que a biblioteca
  fez: início de cada janela, tentativas que falharam com o motivo, aviso de atraso enviado ou
  não, e por que a janela terminou. No journal essas linhas existem, mas misturadas a tudo o
  mais; aqui elas vêm por janela e prontas para ler.

O resumo é gravado **mesmo quando não houve sessão viva**, com `semSessao: true`. Antes, o
encerramento sem sessão saía calado, e foi exatamente o que aconteceu no domingo 16/08: o
socket da subida caiu antes da janela, nada foi enviado, o `sessao` já era nulo quando o
SIGTERM chegou, o processo saiu em 677 ms — e a janela mais interessante do dia foi a **única
sem resumo nenhum** em disco.

O log é filtrado por uma lista de frases, não por nível. Medido em produção: em `debug` puro o
Baileys escreve cerca de **1 MB por minuto** ao drenar uma fila acumulada, e quase tudo é
falha de descriptografia de mensagem *recebida*, que não tem relação com o problema de
entrega. Com o filtro sobram algumas centenas de linhas por janela, e ainda existe o teto de
`DIAG_MAX_BYTES` como rede.

Ficam os 20 mais recentes. Para ler depois do culto (dentro da VM):

```bash
ls -la /var/lib/culto/diagnostico
cat /var/lib/culto/diagnostico/resumo-<carimbo>.json
```

Se alguma gravação de estado de sinal falhar, o processo sai com código 1 — visível no
`journalctl -u culto-bot` (linha de saída do serviço) e no `systemctl status culto-bot`.

### Qual vídeo é o culto de agora

Estreias (premieres) **não aparecem** nos filtros `live` e `upcoming` da API, então elas são
achadas na playlist de uploads do canal (Método 3). O problema é decidir, entre os cultos que
estão lá, qual pertence à janela que está rodando.

A regra antiga era a hora do **upload** (`publishedAt`) nas últimas `filtroHoras`. Ela confunde
duas coisas que numa estreia não têm relação nenhuma: quando o arquivo subiu e quando o culto
acontece — o vídeo é gravado antes e agendado para tocar depois.

Foi o que derrubou o domingo **16/08**: a estreia das 19h tinha sido publicada de manhã, o
filtro da noite só aceitava upload das últimas 7h (desde ~12h), e o culto ficou **invisível**
para o bot durante a janela inteira. Nas vezes anteriores em que isso apareceu, a resposta foi
esticar o filtro (4h → 6h → 7h), o que só troca de erro: esticar o bastante para pegar a
estreia publicada de manhã é esticar o bastante para mandar o culto **da manhã** à noite.

Hoje a referência é o **horário da transmissão**, lido de `liveStreamingDetails` na mesma
chamada ao `videos.list` que já era feita para separar live de estreia. Desde 22/08, com o fim
do filtro de título, essa régua (`escolherPorHorario`) vale para **tudo** — inclusive os
resultados dos search por `live` e `upcoming`, que antes eram aceitos crus (o índice do search
é cacheado e sabe devolver transmissão recém-encerrada). As regras:

- transmissão **já encerrada** (`actualEndTime`) é rejeitada sempre — gravação é papel do
  fallback, e sem isso um evento da tarde caberia no piso de horas da janela da noite;
- transmissão **no ar** (`actualStartTime`): vale `filtroHoras` — "há quanto tempo, no máximo,
  o culto pode ter começado". Também barra encoder esquecido ligado por dias;
- transmissão **só agendada** (`scheduledStartTime`): futuro até `ESTREIA_FUTURO_MIN` (90 min,
  para a manhã não mandar o link da noite) e atraso até `ESTREIA_ATRASO_MIN` (60 min, cobre
  culto atrasado sem engolir o broadcast agendado de tarde e abandonado, que fica "upcoming"
  para sempre na API);
- vídeo **sem horário de transmissão** é rejeitado: upload comum (clipe, aviso) ou rascunho
  de sala de espera sem data (o caso de 22/08);
- havendo mais de um candidato na janela, ganha o **mais próximo de agora**, que é o que separa
  o da manhã do da noite sem nenhum ajuste manual de horas;
- se o `videos.list` falhar, a tentativa é **descartada** — sem os detalhes não há como validar
  horário, e a degradação antiga para a hora do upload só era segura quando o filtro de título
  existia. A tentativa seguinte, um minuto depois, refaz as chamadas.

### Nota sobre YouTube API Quota

O bot usa a **YouTube Data API v3** com limite de **10.000 unidades/dia**:
- `search.list` (procurar lives/premieres) = **100 unidades** por chamada
- `playlistItems.list` (buscar em upload playlist) = **1 unidade** por chamada
- `videos.list` (validar tipo de vídeo) = **1 unidade** por chamada

Desde 22/08 as buscas caras (os dois `search.list`) rodam só **a cada 3 tentativas**
(tentativas 1, 4, 7...); a playlist + `videos.list` (2-3 unidades) rodam em todas. Antes da
cadência, o pior domingo — nenhuma transmissão encontrada em nenhuma janela — custava
67 tentativas × ~203 ≈ **13,7 mil unidades**, acima do teto, com a quota morrendo no meio da
janela da noite e levando junto o fallback de gravação. Com a cadência, o pior domingo de hoje
(duas janelas de 37 tentativas) fica em **~5,5 mil unidades**, e o sábado vazio (resultado
esperado do culto em teste) em ~2,7 mil. O
preço é um atraso de até 2 min para uma live que só o search enxerga — e a experiência aqui
registrada é a oposta: o search é que atrasa, a playlist vê primeiro.

**Se a quota esgotar:** o bot vai logar `Request failed with status code 403: quotaExceeded`;
o caminho da playlist (barato) continua tentando. Para conferir depois: `journalctl -u
culto-bot` na VM.

---

## Configuração inicial

### 1. Pré-requisitos

- Conta no [Google Cloud](https://console.cloud.google.com) com faturamento ativado (o free
  tier exige cartão cadastrado, mas a configuração abaixo custa R$ 0/mês)
- Conta no [GitHub](https://github.com)
- Node.js 20+ (na VM; instruções abaixo)

### 2. Clonar e instalar

```bash
git clone https://github.com/seu-usuario/culto-automation.git
cd culto-automation
npm install
```

### 3. Configuração

Para rodar **localmente** (testes, desenvolvimento), use um `.env` na raiz:

```bash
cp .env.example .env
```

Na **VM**, a configuração vive em `/etc/culto/culto.env` (o systemd a injeta via
`EnvironmentFile` — o `.env` local não é usado lá). Conteúdo mínimo:

```
YOUTUBE_API_KEY=AIzaSy...
YOUTUBE_CHANNEL_ID=UCxxxxxx...
WHATSAPP_GROUP_NAME=120363xxxxxxxxx@g.us
TZ=America/Sao_Paulo
AUTH_DIR=/var/lib/culto/baileys_auth
BAILEYS_LOG_LEVEL=warn
```

**Ajustes opcionais** (todos têm padrão, só defina se precisar mudar):

| Variável | Padrão | Para que serve |
|----------|--------|----------------|
| `RETRY_GRACE_MS` | `120000` | Piso da janela de reenvio: mínimo que a conexão fica aberta após o último envio |
| `RETRY_QUIET_MS` | `45000` | Silêncio necessário para encerrar. Cada pedido de reenvio empurra o fechamento para frente |
| `RETRY_GRACE_MAX_MS` | `600000` | Teto absoluto da janela, para o socket não ficar aberto indefinidamente |
| `RETRY_GRACE_SIGTERM_MS` | `3000` | Espera curta quando o systemd manda SIGTERM (parada/restart do serviço; aí não dá para segurar a janela inteira) |
| `FORCAR_SESSOES` | (desligado) | `1` recria as sessões de sinal em lote na subida. Ver a quinta defesa acima |
| `LOTE_SESSOES` | `50` | Tamanho do lote acima. Um aparelho com erro derruba o lote inteiro, por isso é fatiado |
| `PREPARO_TIMEOUT_MS` | `45000` | Prazo do preparo do grupo. Estourou, para onde está e deixa o envio seguir |
| `PASSIVO_TIMEOUT_MS` | `10000` | Prazo do iq que devolve a sessão ao estado passivo. Ver "Notificação no celular do dono" |
| `PASSIVO_REANUNCIO_MS` | `300000` | Intervalo do reforço desse anúncio enquanto a conexão viver. Conserta um primeiro iq que falhou e desfaz reativação vinda do servidor |
| `ENVIO_TIMEOUT_MS` | `120000` | Prazo de ponta a ponta de um envio. Existe para travamento virar erro (que o laço retenta) em vez de congelar a janela inteira em silêncio |
| `VERSAO_TIMEOUT_MS` | `10000` | Prazo da busca da versão do WhatsApp Web. O Baileys faz esse `fetch` **sem timeout nenhum**, e ele roda antes de existir qualquer relógio de segurança |
| `ESTREIA_FUTURO_MIN` | `90` | Quanto antes do horário marcado uma estreia já é aceita. Ver "Qual vídeo é o culto de agora" |
| `TETO_VIDA_MS` | `5400000` | Teto de vida do processo (90 min). Rede de segurança: se nada encerrou o processo até aí, ele se encerra sozinho em vez de passar a noite com o socket aberto segurando a sessão da conta |
| `YOUTUBE_TIMEOUT_MS` | `15000` | Prazo de cada chamada à API do YouTube. Sem ele, uma conexão pendurada congelava o monitoramento e o desligamento nunca acontecia |
| `BAILEYS_LOG_LEVEL` | `warn` | Nível do log que vai para o stdout (o `journalctl`) |
| `DIAG_DIR` | `<pai do AUTH_DIR>/diagnostico` | Onde ficam os logs e resumos por janela (na VM: `/var/lib/culto/diagnostico`) |
| `DIAG_MAX_ARQUIVOS` | `20` | Quantos logs e quantos resumos manter |
| `DIAG_MAX_BYTES` | `8388608` | Teto por arquivo de log (8 MB), para nunca encher o disco |
| `AUTH_DIR` | `.baileys_auth` | Onde ficam a sessão do WhatsApp e o histórico de mensagens enviadas |

> **Como obter o `YOUTUBE_API_KEY`:**
> 1. Acesse o [Google Cloud Console](https://console.cloud.google.com/)
> 2. Crie um projeto e ative a **YouTube Data API v3**
> 3. Em "Credenciais", crie uma **Chave de API**

> **Como obter o `YOUTUBE_CHANNEL_ID`:**
> Acesse o canal no YouTube → Sobre → Compartilhar canal → Copiar ID do canal (começa com `UC...`)

> **Como obter o `WHATSAPP_GROUP_NAME` (JID do grupo):**
> Após parear o WhatsApp (passo 5), rode:
> ```bash
> node index.js --listar-grupos
> ```
> Copie o ID no formato `120363xxxxxxxxx@g.us` do grupo correto.

### 4. Criar a VM no GCP (free tier)

O que garante o custo zero: **e2-micro**, região **us-east1/us-central1/us-west1**, disco
**Standard** (não Balanced!) de até 30 GB, provisionamento padrão (não Spot), IP efêmero.

```bash
gcloud compute instances create culto-bot \
  --zone=us-east1-b \
  --machine-type=e2-micro \
  --provisioning-model=STANDARD \
  --image-family=debian-12 --image-project=debian-cloud \
  --boot-disk-size=30GB --boot-disk-type=pd-standard
```

Dentro da VM (`gcloud compute ssh culto-bot --zone=us-east1-b`):

```bash
# Swap de 2 GB: com 1 GB de RAM, é o colchão contra o OOM killer
sudo fallocate -l 2G /swapfile && sudo chmod 600 /swapfile && sudo mkswap /swapfile && sudo swapon /swapfile
echo '/swapfile none swap sw 0 0' | sudo tee -a /etc/fstab

# Node 20, fuso e usuário dedicado
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash - && sudo apt-get install -y nodejs git
sudo timedatectl set-timezone America/Sao_Paulo
sudo useradd --system --create-home --home /var/lib/culto --shell /usr/sbin/nologin culto

# Código e dependências
sudo git clone https://github.com/luizhferraz/automacao-culto.git /opt/automacao-culto
sudo chown -R culto:culto /opt/automacao-culto
cd /opt/automacao-culto
sudo -u culto npm install --omit=dev

# Dados e configuração
sudo mkdir -p /var/lib/culto/baileys_auth && sudo chown -R culto:culto /var/lib/culto
sudo mkdir -p /etc/culto && sudo nano /etc/culto/culto.env   # conteúdo do passo 3
sudo chmod 600 /etc/culto/culto.env
```

A unit do systemd, em `/etc/systemd/system/culto-bot.service`:

```ini
[Unit]
Description=Bot de automacao do culto (WhatsApp + YouTube)
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=culto
Group=culto
WorkingDirectory=/opt/automacao-culto
EnvironmentFile=/etc/culto/culto.env
ExecStart=/usr/bin/node index.js
Restart=always
RestartSec=10
TimeoutStopSec=120
MemoryMax=700M
NoNewPrivileges=true

[Install]
WantedBy=multi-user.target
```

O `Restart=always` é deliberado e obrigatório: o bot se encerra sozinho ao fim de cada janela
e no teto de vida, contando com o systemd para renascer. A memória de janela em disco é quem
garante que renascer nunca duplica envio.

```bash
sudo systemctl daemon-reload
sudo systemctl enable culto-bot
```

### 5. Parear o WhatsApp via QR Code

```bash
sudo systemctl start culto-bot
sudo journalctl -u culto-bot -f -o cat
```

Um QR Code aparecerá no log. Escaneie com o WhatsApp:
> WhatsApp → Menu (⋮) → Aparelhos conectados → Conectar aparelho

Após parear, a sessão fica salva em `/var/lib/culto/baileys_auth`. Não precisa escanear
novamente a menos que o aparelho seja desvinculado.

### 6. Atualizar o bot (deploy)

Não há deploy automatizado: atualização é `git pull` + restart, feita de propósito **fora**
dos horários de culto (um deploy no meio de uma janela derruba o socket com o link a caminho;
a recuperação de janela cobre, mas não há motivo para arriscar).

```bash
cd /opt/automacao-culto
sudo -u culto git pull
sudo systemctl restart culto-bot
sudo journalctl -u culto-bot -n 20 -o cat   # conferir a subida
```

---

## Comandos úteis

Todos dentro da VM (`gcloud compute ssh culto-bot --zone=us-east1-b`):

```bash
# Ver logs em tempo real
sudo journalctl -u culto-bot -f -o cat

# Últimas N linhas do log
sudo journalctl -u culto-bot -n 50 -o cat

# Status do serviço (desde quando o processo atual está de pé, últimas linhas)
sudo systemctl status culto-bot

# Parar / iniciar / reiniciar o serviço
sudo systemctl stop culto-bot
sudo systemctl start culto-bot
sudo systemctl restart culto-bot

# O que cada janela já enviou hoje (memória de janela)
cat /var/lib/culto/janelas-enviadas.json

# Resumos de diagnóstico por janela
ls -la /var/lib/culto/diagnostico

# Testar busca no YouTube (não envia nada; carrega o env da VM)
sudo bash -c 'set -a; . /etc/culto/culto.env; set +a; cd /opt/automacao-culto && node index.js --teste-youtube'

# Listar grupos/canais da conta pareada (precisa rodar como o usuário culto)
sudo systemctl stop culto-bot   # evita duas conexões da mesma sessão
cd /opt/automacao-culto && sudo -u culto env $(sudo grep -v '^#' /etc/culto/culto.env | xargs) node index.js --listar-grupos
sudo systemctl start culto-bot
```

---

## Exemplo de mensagens enviadas

**Transmissão ao vivo:**
```
🔴 Transmissão ao vivo

Culto da Família | 01/06 | 10h

🖥️ Assista aqui:
https://www.youtube.com/watch?v=...
```

**Gravação (fallback domingo noite):**
```
🎬 Culto disponível para assistir

Culto da Família | 01/06 | 10h

🖥️ Assista aqui:
https://www.youtube.com/watch?v=...
```

**Aviso de atraso (3 min após o início do culto, se o link não foi encontrado):**
```
⚠️ Olá, irmãos!

Estamos com instabilidade na internet e, por esse motivo, o link da
transmissão ainda não foi disponibilizado.

Já estamos trabalhando para resolver o mais rápido possível e, assim que
normalizar, o link será enviado aqui no grupo.

Agradecemos a compreensão de todos! 🙏
```

---

## Testes

```bash
npm test
```

São cinco suítes, todas rodando o código real com as dependências externas trocadas por
dublês. Nenhuma delas toca no YouTube ou no WhatsApp de verdade.

**`testes/simular-aviso.js`** exercita `monitorarAoVivo` com relógio simulado (sem esperar 37
minutos). Cobre: aviso no minuto certo nas janelas que o têm, aviso suprimido quando o link
chega antes do prazo, aviso seguido do link quando ele chega depois, reenvio sem duplicação
quando o primeiro envio falha, a janela **sem** aviso (sábado, `avisoAposMin: null`)
segurando a mensagem pelas 37 tentativas completas, e a memória de janela em disco: a mesma
janela executada de novo (o restart do systemd de 23/08) **não** reenvia o link nem repete o
aviso de atraso; a janela **esgotada** sem link nem chega a reabrir; o envio que estoura o
prazo e completa depois é **absorvido** na tentativa seguinte (link e aviso) em vez de
reenviado; a gravação do fallback executada duas vezes sai **uma** só; e a falha de escrita
do registro principal cai no arquivo **reserva** dentro do `AUTH_DIR`.

**`testes/simular-youtube.js`** roda a regra real de escolha do vídeo, sem rede, com os **dois
cultos do mesmo domingo** na playlist — o caso que qualquer ajuste de horas erra. Cobre: a
estreia das 19h publicada de manhã sendo achada à noite (o bug de 16/08), a mesma playlist
escolhendo o culto da manhã na janela da manhã, o culto da manhã **não** sendo reenviado à
noite, live de verdade continuando a ser classificada como live pela duração `P0D`, a
tentativa sendo **descartada** quando o `videos.list` falha (a degradação antiga para hora de
upload saiu junto com o filtro de título), o rascunho de transmissão sem data rejeitado (o
caso de 22/08), o upload comum rejeitado, o título fora do padrão antigo aceito, a
transmissão **encerrada** rejeitada, o agendamento **abandonado** da tarde rejeitado e o
culto **atrasado** (até 60 min) aceito. Cobre também a configuração da janela de sábado e a
recuperação de janela perdida: processo subindo atrasado é recuperado (inclusive no sábado, e
inclusive **dentro do minuto do gatilho** — a zona morta em que o segundo 0 do cron já passou),
subindo **antes** do horário **não** é, para não rodar a janela duas vezes, e nem a janela
cujo link de hoje já está registrado em disco (o triplo envio de 23/08) nem a que já se
esgotou sem link são reabertas pela recuperação. Cobre ainda a janela **com vigência**, com
uma janela própria do teste (a entrada real de 14 a 18/09 só é conferida enquanto existir):
a expressão de cron de cada janela validada pelo próprio `node-cron`, a recuperação
reconhecendo a janela no primeiro e no último dia da vigência e ignorando a mesma hora na
semana anterior e na seguinte, a quarta 16/09 com duas janelas no mesmo dia, a mesma chave em
dias seguidos (o link de segunda **não** cala a terça, porque a memória em disco separa por
dia), a vigência contada no dia da **igreja** e não no dia UTC, e a tabela escrita errada
(data sem zero, dia inexistente, `de` depois de `ate`, dia da semana fora de 0..6, chave
vazia ou **repetida**) sendo rejeitada na carga do módulo, cada erro com a própria mensagem.

**`testes/simular-agendamento.js`** roda o `iniciarAgendamentos` real com o `node-cron`
trocado por um dublê que só guarda o callback de cada janela, e o relógio congelado no `Date`
inteiro. É o teste do **gatilho do cron**, que é quem decide, todo dia útil com o bot já de pé,
se a janela com vigência abre ou não — a recuperação de janela perdida só entra quando o
processo sobe dentro da janela. Cobre: a subida registrando uma tarefa por janela com fuso e
`recoverMissedExecutions`; o gatilho antes da vigência não abrindo nada (só uma linha no
journal); o gatilho no primeiro e no último dia rodando a janela de ponta a ponta (busca,
envio, registro em disco, desligamento); o gatilho depois da vigência calado; o mesmo segundo
entregue **duas vezes** pelo `node-cron` 3.0.3 com `recoverMissedExecutions` (ele trunca o
`lastExecution` e reavalia o segundo casado no tick seguinte) contando uma vez só; e a janela
fixa sem vigência disparando sempre. Sem este teste, apagar a checagem de vigência do callback
passava a suíte inteira.

**`testes/simular-busca.js`** exercita a fiação completa de `buscarTransmissaoAoVivo` e
`buscarUltimaGravacao` com o axios trocado por dublê: o Método 1 validando o resultado do
search no `videos.list` em vez de aceitá-lo cru, a live recém-encerrada devolvida pelo índice
defasado do search sendo barrada, o caso 22/08 de ponta a ponta, o Método 2 aceitando estreia
agendada próxima, a cadência das buscas caras (tentativa 2 sem nenhum `search.list`, tentativa
4 com), e o fallback de gravação rejeitando teste de som pelo piso de duração.

**`testes/simular-reenvio.js`** exercita o ciclo de vida da conexão em `whatsapp.js` com um
socket falso, e roda duas vezes, com `FORCAR_SESSOES` desligado e ligado. Cobre: histórico
sobrevivendo em disco com o conteúdo idêntico byte a byte, **nenhum envio enxergando aparelho
já marcado** (mesmo com um mapa velho no armazenamento, que é o bug do domingo 02/08), a
gravação da memória de distribuição sendo descartada sem afetar as sessões de sinal, o
`getMessage` do socket sabendo responder um pedido de reenvio, **a janela se estendendo quando
chega um pedido perto do fim do piso**, **o iq de sessão passiva saindo com o filho
`<passive/>`** ao abrir a conexão (e o link do culto saindo mesmo quando esse iq falha),
o resumo de diagnóstico sendo gravado, as gravações do
estado de sinal drenadas antes da saída, uma queda antes do envio virando erro em vez de
sucesso silencioso, o `conectar()` da subida devolvendo `false` em vez de derrubar o processo,
e as duas mensagens de uma mesma janela reaproveitando uma única conexão. Cobre ainda os três
travamentos silenciosos do domingo 16/08: **envio pendurado virando erro** (com a tentativa
seguinte enviando normalmente), **a busca da versão do WhatsApp Web pendurada não impedindo o
link de sair**, **a conexão da subida em curso não gerando um segundo socket** quando o envio
chega junto, e o **resumo sendo gravado mesmo sem sessão viva**. E o primo do envio pendurado:
o envio que estoura o prazo mas **completa depois** fica registrado como conclusão tardia,
com o texto e o id — é o registro que o scheduler consulta antes de reenviar.

**`testes/simular-diagnostico.js`** cobre o registro em disco: o filtro descartando o ruído do
Baileys e preservando as linhas que identificam quem não recebeu, a poda tratando logs e
resumos de forma independente, e o resumo da janela voltando legível do disco.

Os testes das correções novas foram verificados revertendo cada correção e conferindo que o
teste correspondente falha.

---

## Estrutura do projeto

```
culto-automation/
├── index.js                # Ponto de entrada, inicialização, SIGTERM e teto de vida
├── scheduler.js            # Agendamentos cron, monitoramento e memória de janela em disco
├── youtube.js              # Busca de transmissões ao vivo via YouTube Data API
├── whatsapp.js             # Conexão e envio via Baileys (sessão única por janela)
├── mensagens-enviadas.js   # Histórico em disco, usado para atender pedidos de reenvio
├── diagnostico.js          # Log filtrado e resumo por janela gravados em disco
├── testes/                 # Aviso de atraso, escolha do vídeo, gatilho do cron, fiação da busca, reenvio e diagnóstico
├── fly.toml                # Era Fly.io — aposentado na migração de 22/08, mantido como histórico
└── Dockerfile              # Imagem Docker (Node 20 Alpine) — não usada na VM, que roda node direto
```

Os workflows do GitHub da era Fly (start-bot, deploy, diagnostico) foram **removidos** em
23/08: cada um era um botão de um clique que ligava a máquina antiga — um segundo aparelho
WhatsApp que enviaria o link em duplicata (ver o quadro de cuidado em "Como funciona"). Na
VM o deploy é `git pull` + `systemctl restart`; os YAMLs seguem no histórico do git.

A unit do systemd (`culto-bot.service`) e a configuração (`/etc/culto/culto.env`) não vivem
no repositório — vivem na VM. O conteúdo de ambas está na seção "Configuração inicial".
