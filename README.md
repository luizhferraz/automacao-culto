# Automação de Culto — WhatsApp + YouTube

Envia automaticamente os links das transmissões ao vivo (e estreias) para um canal de Avisos no WhatsApp, nos horários agendados. Roda na nuvem via Fly.io — sem precisar deixar o computador ligado.

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
4. Ao fim da janela → a máquina se desliga automaticamente

O bot fica **offline** fora dos horários de envio para não suprimir as notificações do celular.

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

Roda `testes/simular-aviso.js`, que exercita a função real `monitorarAoVivo` com relógio
simulado (sem esperar 36 minutos e sem tocar no YouTube ou no WhatsApp). Cobre: aviso no
minuto certo nas três janelas, aviso suprimido quando o link chega antes do prazo, aviso
seguido do link quando ele chega depois, e reenvio sem duplicação quando o primeiro envio falha.

---

## Estrutura do projeto

```
culto-automation/
├── index.js          # Ponto de entrada, inicialização e auto-shutdown
├── scheduler.js      # Agendamentos cron e lógica de monitoramento
├── youtube.js        # Busca de transmissões ao vivo via YouTube Data API
├── whatsapp.js       # Envio de mensagens via Baileys (connect-on-demand)
├── fly.toml          # Configuração do Fly.io
├── Dockerfile        # Imagem Docker (Node 20 Alpine)
└── .github/
    └── workflows/
        └── start-bot.yml  # GitHub Actions: liga a máquina antes dos cultos
```
