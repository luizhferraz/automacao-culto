# Automação de Culto: WhatsApp + YouTube

Envia automaticamente os links das transmissões ao vivo (e estreias) para um canal de Avisos no WhatsApp, nos horários agendados. Roda na nuvem via Fly.io, sem precisar deixar o computador ligado.

---

## Como funciona

O bot monitora o canal do YouTube a cada **1 minuto** a partir do horário configurado. Assim que encontra uma transmissão ao vivo ou estreia agendada com título reconhecido, envia o link para o grupo e para de monitorar.

**Títulos reconhecidos:**
- `Culto da Família` (e variações)
- `Culto de Fé` (e variações)
- `Especial de ...` (ex: Especial de Páscoa, Especial de Natal)

**Horários monitorados:**

| Dia | Início | Culto | Janela | Aviso de atraso | Comportamento |
|-----|--------|-------|--------|-----------------|---------------|
| Domingo manhã | 9h54 | 10h00 | até 10h30 | 10h03 | Envia link ao vivo |
| Domingo noite | 18h59 | 19h00 | até 19h30 | 19h03 | Envia link ao vivo; se não encontrar, envia a gravação mais recente (últimas 6h) |
| Quarta-feira | 19h54 | 20h00 | até 20h30 | 20h03 | Envia link ao vivo |

**Aviso de atraso:** se o link ainda não foi encontrado 3 minutos após o horário do culto, o bot
envia uma mensagem ao grupo avisando que a transmissão atrasou. É enviado no máximo uma vez por
janela e não interrompe a busca: se o link aparecer depois, ele é enviado normalmente em seguida.
Se o primeiro envio do aviso falhar, o bot tenta de novo na tentativa seguinte, sem duplicar.

**Ciclo automático (Fly.io + cron externo):**
1. A máquina é ligada 5 min antes de cada janela
2. O bot conecta no WhatsApp já na subida e atende os pedidos de reenvio acumulados na semana
3. Monitora o YouTube a cada 1 minuto
4. Ao encontrar a live → envia o link → encerra o monitoramento
5. Mantém a conexão de pé enquanto chegarem pedidos de reenvio (veja abaixo)
6. Ao fim da janela → a máquina se desliga automaticamente

O bot não anuncia presença (`markOnlineOnConnect: false`), que é o que suprimiria as
notificações no celular. Ficar conectado, por si só, não suprime nada.

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

Isso foi medido no volume no domingo 02/08. De manhã o mapa foi zerado, os 845 aparelhos
entraram na distribuição e todos foram marcados como atendidos. À noite o mapa foi lido cheio,
a lista de destinatários da chave ficou **vazia**, e a mensagem das 18:59 saiu sem distribuir
chave para ninguém. Quem falhou de manhã estava condenado a falhar de novo à noite. Como o
único ponto da biblioteca que limpa esse mapa fica dentro do tratamento do pedido de reenvio,
e isso exige socket vivo, o bloqueio era permanente.

Quatro defesas:

1. **A memória de distribuição é ignorada.** A leitura devolve sempre vazio e a gravação é
   descartada, então **todo envio redistribui a chave para todos os aparelhos**. Quem ficou de
   fora numa semana ganha nova chance na semana seguinte. Não é gambiarra: é o que a própria
   biblioteca faz ao atender um pedido de reenvio, zerando o mapa do grupo inteiro.
2. **Histórico em disco.** Toda mensagem enviada é gravada em `$AUTH_DIR/mensagens-enviadas.json`
   (últimas 200, validade de 30 dias). Se o pedido de reenvio só chegar dias depois, porque o
   celular estava desligado, o WhatsApp o entrega na próxima conexão do bot, e aí ele consegue
   reenviar mesmo tendo sido outra execução do processo.
3. **Conexão na subida.** O socket abre quando o processo sobe, não na hora do envio. Assim os
   ~5 min entre ligar a máquina e o culto servem para drenar a fila de pedidos que o WhatsApp
   acumulou durante a semana, com a conexão ociosa. Cada pedido atendido faz o Baileys recriar
   a sessão daquele aparelho, o que conserta gente travada desde o culto anterior.
4. **Janela de reenvio elástica.** Depois do último envio a conexão fica aberta por pelo menos
   `RETRY_GRACE_MS`, e continua aberta enquanto chegarem pedidos, até o teto de
   `RETRY_GRACE_MAX_MS`. Relógio fixo era a coisa errada: o Baileys abandona em silêncio o que
   sobrou na fila assim que o websocket fecha, então encerrar no meio da fila jogava fora
   exatamente os pedidos que se queria atender.

Existe ainda uma quinta defesa: `FORCAR_SESSOES=1` recria as sessões de sinal em lote **na
subida**, nos minutos ociosos antes do culto. Ela ataca o caso de quem reinstalou o WhatsApp
ou trocou de aparelho, porque nesse cenário a sessão do lado da pessoa foi destruída mas o
arquivo do bot continua intacto no volume, e a validação que o Baileys faz antes de distribuir
a chave é puramente local: não tem como saber que o outro lado apagou a sessão dele.

Não dá para ser cirúrgico aqui. Sessão obsoleta é, por construção, invisível do lado do bot:
não existe log, erro ou sinal que aponte quem está nessa situação. Ou se recria tudo, ou não
se conserta ninguém. Os custos são baixos no uso deste bot: descartar o ratchet não tem efeito
funcional, e a chave de uso único que se consome de cada pessoa é reposta pelo aparelho dela
sozinho (e se acabarem, o servidor devolve a chave assinada e funciona igual). O preparo roda
na conexão da subida justamente para não atrasar o link, e o laço vigia o próprio prazo
(`PREPARO_TIMEOUT_MS`), parando sozinho em vez de continuar rodando em segundo plano durante o
envio. Se o preparo falhar por qualquer motivo, o link sai do mesmo jeito.

### Diagnóstico

Os logs do Fly são só ao vivo: quando a máquina desliga, some tudo. Por isso cada janela grava
em `/data/diagnostico/`:

- `<carimbo>.log`: as linhas do Baileys que decidem o diagnóstico de entrega,
  `sending new sender key` (a lista de aparelhos que receberam a chave) e
  `Failed to encrypt for recipient` (quem ficou de fora, com o jid). A diferença entre as duas
  é a **lista nominal** de quem não recebeu. Tudo de nível `warn` para cima entra também.
- `resumo-<carimbo>.json`: ids e horários dos envios, tamanho do grupo, quantos aparelhos,
  quem confirmou entrega, quantos reenvios foram atendidos e quantas gravações falharam.

O log é filtrado por uma lista de frases, não por nível. Medido em produção: em `debug` puro o
Baileys escreve cerca de **1 MB por minuto** ao drenar a fila de uma semana, e quase tudo é
falha de descriptografia de mensagem *recebida*, que não tem relação com o problema de
entrega. Uma conexão ociosa de um dia encheria o volume de 1 GB. Com o filtro sobram algumas
centenas de linhas por janela, e ainda existe o teto de `DIAG_MAX_BYTES` como rede.

Ficam os 20 mais recentes. Para ler depois do culto:

```bash
fly ssh console --app culto-automacao -C "ls -la /data/diagnostico"
```

Se alguma gravação de estado de sinal falhar, o processo sai com código 1, o que aparece no
`exit_code` do `fly machine status` mesmo depois que os logs somem.

### Nota sobre YouTube API Quota

O bot usa a **YouTube Data API v3** com limite de **10.000 unidades/dia**:
- `search.list` (procurar lives/premieres) = **100 unidades** por chamada
- `playlistItems.list` (buscar em upload playlist) = **1 unidade** por chamada
- `videos.list` (validar tipo de vídeo) = **1 unidade** por chamada

**Consumo máximo em um domingo:** 36 tentativas (manhã) × 201 unidades + 31 tentativas (noite) × 201 unidades ≈ **13.500 unidades** (excede quota).

Porém, **funciona** porque:
1. As buscas por `eventType` têm lag de indexação, então frequentemente retornam nada nas primeiras tentativas
2. O **Método 3** (playlist de uploads com custo de 1 unidade) pega premieres que as buscas caras perdem
3. Na prática, o consumo real fica ~60-70% do pior caso

**Se a quota esgotar:** o bot vai logar `Request failed with status code 403: quotaExceeded` e parar de enviar links naquela janela. Repete na próxima janela (segunda-feira manhã). Para evitar: monitore os logs no Fly.io durante os cultos.

---

## Configuração inicial

### 1. Pré-requisitos

- Conta no [Fly.io](https://fly.io) (free tier)
- Conta no [GitHub](https://github.com)
- [flyctl](https://fly.io/docs/hands-on/install-flyctl/) instalado
- Node.js 20+

### 2. Clonar e instalar

```bash
git clone https://github.com/seu-usuario/culto-automation.git
cd culto-automation
npm install
```

### 3. Configurar o `.env`

```bash
cp .env.example .env
```

Edite o `.env` com seus dados:

```
YOUTUBE_API_KEY=AIzaSy...
YOUTUBE_CHANNEL_ID=UCxxxxxx...
WHATSAPP_GROUP_NAME=120363xxxxxxxxx@g.us
TZ=America/Sao_Paulo
```

**Ajustes opcionais** (todos têm padrão, só defina se precisar mudar):

| Variável | Padrão | Para que serve |
|----------|--------|----------------|
| `RETRY_GRACE_MS` | `120000` | Piso da janela de reenvio: mínimo que a conexão fica aberta após o último envio |
| `RETRY_QUIET_MS` | `45000` | Silêncio necessário para encerrar. Cada pedido de reenvio empurra o fechamento para frente |
| `RETRY_GRACE_MAX_MS` | `600000` | Teto absoluto da janela, para a máquina não ficar de pé indefinidamente |
| `RETRY_GRACE_SIGTERM_MS` | `3000` | Espera curta quando o Fly manda SIGTERM (aí não dá para segurar a janela inteira) |
| `FORCAR_SESSOES` | (desligado) | `1` recria as sessões de sinal em lote na subida. Ver a quinta defesa acima |
| `LOTE_SESSOES` | `50` | Tamanho do lote acima. Um aparelho com erro derruba o lote inteiro, por isso é fatiado |
| `PREPARO_TIMEOUT_MS` | `45000` | Prazo do preparo do grupo. Estourou, para onde está e deixa o envio seguir |
| `BAILEYS_LOG_LEVEL` | `warn` | Nível do log que vai para o stdout (o `fly logs`) |
| `DIAG_DIR` | `/data/diagnostico` | Onde ficam os logs e resumos por janela |
| `DIAG_MAX_ARQUIVOS` | `20` | Quantos logs e quantos resumos manter |
| `DIAG_MAX_BYTES` | `8388608` | Teto por arquivo de log (8 MB), para nunca encher o volume |
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

### 4. Deploy no Fly.io

```bash
fly auth login
fly launch --name culto-automacao --no-deploy
fly volumes create culto_data --size 1 --region iad
fly secrets set YOUTUBE_API_KEY=... YOUTUBE_CHANNEL_ID=... WHATSAPP_GROUP_NAME=...
fly deploy
```

### 5. Parear o WhatsApp via QR Code

```bash
fly logs --app culto-automacao
```

Um QR Code aparecerá nos logs. Escaneie com o WhatsApp:
> WhatsApp → Menu (⋮) → Aparelhos conectados → Conectar aparelho

Após parear, a sessão fica salva no volume `/data/baileys_auth`. Não precisa escanear novamente a menos que o WhatsApp seja resetado.

### 6. Configurar GitHub Actions (ligar a máquina automaticamente)

1. Gere um token do Fly.io:
   ```bash
   fly tokens create deploy -a culto-automacao -n "github-actions"
   ```
2. No repositório GitHub, vá em **Settings → Secrets → Actions**
3. Crie um secret chamado `FLY_API_TOKEN` com o token gerado

O workflow `.github/workflows/start-bot.yml` já está configurado e vai ligar a máquina automaticamente nos horários certos.

---

## Comandos úteis

```bash
# Ver logs em tempo real
fly logs --app culto-automacao

# Verificar status da máquina
fly status --app culto-automacao

# Ligar a máquina manualmente
fly machine start 148ee339cee098 --app culto-automacao

# Desligar a máquina manualmente
fly machine stop 148ee339cee098 --app culto-automacao

# Testar busca no YouTube
node index.js --teste-youtube

# Testar envio no WhatsApp
node index.js --teste-envio

# Listar grupos/canais disponíveis
node index.js --listar-grupos
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

São três suítes, todas rodando o código real com as dependências externas trocadas por
dublês. Nenhuma delas toca no YouTube ou no WhatsApp de verdade.

**`testes/simular-aviso.js`** exercita `monitorarAoVivo` com relógio simulado (sem esperar 36
minutos). Cobre: aviso no minuto certo nas três janelas, aviso suprimido quando o link chega
antes do prazo, aviso seguido do link quando ele chega depois, e reenvio sem duplicação quando
o primeiro envio falha.

**`testes/simular-reenvio.js`** exercita o ciclo de vida da conexão em `whatsapp.js` com um
socket falso, e roda duas vezes, com `FORCAR_SESSOES` desligado e ligado. Cobre: histórico
sobrevivendo em disco com o conteúdo idêntico byte a byte, **nenhum envio enxergando aparelho
já marcado** (mesmo com um mapa velho no armazenamento, que é o bug do domingo 02/08), a
gravação da memória de distribuição sendo descartada sem afetar as sessões de sinal, o
`getMessage` do socket sabendo responder um pedido de reenvio, **a janela se estendendo quando
chega um pedido perto do fim do piso**, o resumo de diagnóstico sendo gravado, as gravações do
estado de sinal drenadas antes da saída, uma queda antes do envio virando erro em vez de
sucesso silencioso, o `conectar()` da subida devolvendo `false` em vez de derrubar o processo,
e as duas mensagens de uma mesma janela reaproveitando uma única conexão.

**`testes/simular-diagnostico.js`** cobre o registro em disco: o filtro descartando o ruído do
Baileys e preservando as linhas que identificam quem não recebeu, a poda tratando logs e
resumos de forma independente, e o resumo da janela voltando legível do disco.

Os testes das correções novas foram verificados revertendo cada correção e conferindo que o
teste correspondente falha.

---

## Estrutura do projeto

```
culto-automation/
├── index.js                # Ponto de entrada, inicialização, SIGTERM e auto-shutdown
├── scheduler.js            # Agendamentos cron e lógica de monitoramento
├── youtube.js              # Busca de transmissões ao vivo via YouTube Data API
├── whatsapp.js             # Conexão e envio via Baileys (sessão única por janela)
├── mensagens-enviadas.js   # Histórico em disco, usado para atender pedidos de reenvio
├── diagnostico.js          # Log filtrado e resumo por janela gravados no volume
├── testes/                 # Aviso de atraso, ciclo de reenvio e registro em disco
├── fly.toml                # Configuração do Fly.io
├── Dockerfile        # Imagem Docker (Node 20 Alpine)
└── .github/
    └── workflows/
        └── start-bot.yml  # GitHub Actions: liga a máquina antes dos cultos
```
