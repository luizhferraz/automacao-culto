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

**Ciclo automático (Fly.io + GitHub Actions):**
1. GitHub Actions liga a máquina 5 min antes de cada janela
2. Bot monitora o YouTube a cada 1 minuto
3. Ao encontrar a live → envia o link → encerra o monitoramento
4. Mantém a conexão de pé por mais 2 min para atender pedidos de reenvio (veja abaixo)
5. Ao fim da janela → a máquina se desliga automaticamente

O bot fica **offline** fora dos horários de envio para não suprimir as notificações do celular.

### Por que a conexão fica de pé depois do envio

O WhatsApp é criptografado ponta a ponta. Quando o aparelho de alguém não consegue
descriptografar uma mensagem do grupo, ele **não** desiste: manda de volta um pedido de
reenvio (*retry receipt*) e mostra na tela **"Aguardando mensagem. Essa ação pode levar
alguns instantes."** até o remetente responder.

Quem responde esse pedido é o bot. Se o processo já morreu, ninguém responde, e a mensagem
fica travada nesse estado **para sempre** no celular daquela pessoa. Era exatamente o que
acontecia: o bot enviava o link e o processo morria 7 segundos depois.

Três defesas resolvem isso:

1. **Janela de reenvio.** Depois do último envio, a conexão fica aberta por `RETRY_GRACE_MS`
   (padrão 2 min) antes do desligamento. A maioria dos pedidos chega em poucos segundos.
2. **Histórico em disco.** Toda mensagem enviada é gravada em `$AUTH_DIR/mensagens-enviadas.json`
   (últimas 200, validade de 30 dias). Se o pedido de reenvio só chegar horas depois, porque o
   celular estava desligado, o WhatsApp o entrega na próxima conexão do bot, e aí ele consegue
   reenviar mesmo tendo sido outra execução do processo.
3. **Redistribuição da chave de grupo, uma vez só.** Em grupo, o remetente distribui uma
   *sender key* para cada aparelho e anota em disco quem já recebeu. Na biblioteca do WhatsApp
   existe um único lugar que apaga essa anotação, e ele fica justamente dentro do tratamento do
   pedido de reenvio. Como o bot nunca chegava lá, quem perdeu a chave depois de recebê-la
   (trocou de celular, reinstalou o app, restaurou backup) ficava marcado como "já recebeu" para
   sempre. Na primeira execução desta versão o bot apaga essa anotação uma vez, e o envio
   seguinte redistribui a chave para todos. Apagar não perde nada: é só um cache de quem já
   foi avisado, e a marca `.chaves-redistribuidas` no `$AUTH_DIR` impede que se repita.

O log de cada janela informa quantos aparelhos confirmaram a entrega e quantos reenvios foram
atendidos.

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
| `RETRY_GRACE_MS` | `120000` | Quanto tempo a conexão fica aberta após o último envio para atender pedidos de reenvio |
| `RETRY_GRACE_SIGTERM_MS` | `3000` | Mesma espera, mas quando o Fly manda SIGTERM (aí não dá para segurar muito) |
| `BAILEYS_LOG_LEVEL` | `warn` | Nível de log da biblioteca do WhatsApp. Use `debug` para investigar problemas de entrega |
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

São duas suítes, ambas rodando o código real com as dependências externas trocadas por dublês.
Nenhuma delas toca no YouTube ou no WhatsApp de verdade.

**`testes/simular-aviso.js`** exercita `monitorarAoVivo` com relógio simulado (sem esperar 36
minutos). Cobre: aviso no minuto certo nas três janelas, aviso suprimido quando o link chega
antes do prazo, aviso seguido do link quando ele chega depois, e reenvio sem duplicação quando
o primeiro envio falha.

**`testes/simular-reenvio.js`** exercita o ciclo de vida da conexão em `whatsapp.js` com um
socket falso. Cobre: histórico sobrevivendo em disco com o conteúdo idêntico byte a byte, a
limpeza da memória de distribuição de chave acontecendo uma vez só e sem tocar nas sessões, o
`getMessage` do socket sabendo responder um pedido de reenvio, a conexão sendo segurada durante
a janela de reenvio, as gravações do estado de sinal drenadas antes da saída, uma queda de
conexão antes do envio virando erro em vez de sucesso silencioso, e as duas mensagens de uma
mesma janela reaproveitando uma única conexão.

---

## Estrutura do projeto

```
culto-automation/
├── index.js                # Ponto de entrada, inicialização, SIGTERM e auto-shutdown
├── scheduler.js            # Agendamentos cron e lógica de monitoramento
├── youtube.js              # Busca de transmissões ao vivo via YouTube Data API
├── whatsapp.js             # Conexão e envio via Baileys (sessão única por janela)
├── mensagens-enviadas.js   # Histórico em disco, usado para atender pedidos de reenvio
├── testes/                 # Simulações do aviso de atraso e do ciclo de reenvio
├── fly.toml                # Configuração do Fly.io
├── Dockerfile        # Imagem Docker (Node 20 Alpine)
└── .github/
    └── workflows/
        └── start-bot.yml  # GitHub Actions: liga a máquina antes dos cultos
```
