# Automação de Culto — WhatsApp + YouTube

Envia automaticamente os links das transmissões ao vivo para um grupo do WhatsApp.

## Horários

| Dia | Horário | Tipo |
|-----|---------|------|
| Quarta-feira | 20h | Transmissão ao vivo |
| Domingo | 10h | Transmissão ao vivo |
| Domingo | 19h | Gravação (Estreia) do culto da manhã |

O bot começa a monitorar o YouTube **5 minutos antes** de cada horário e tenta a cada 5 minutos por até 1 hora, caso a live atrase.

---

## Configuração

### 1. Instalar dependências

```bash
cd culto-automation
npm install
```

### 2. Obter a chave da API do YouTube

1. Acesse [Google Cloud Console](https://console.cloud.google.com/)
2. Crie um projeto (ou use um existente)
3. Ative a **YouTube Data API v3**
4. Em "Credenciais", crie uma **Chave de API**
5. Copie a chave

### 3. Obter o ID do canal do YouTube

1. Acesse o canal da sua igreja no YouTube
2. Clique em **Sobre** → **Compartilhar canal** → **Copiar ID do canal**
3. O ID começa com `UC...`

### 4. Configurar o .env

```bash
cp .env.example .env
```

Edite o arquivo `.env` com seus dados:

```
YOUTUBE_API_KEY=AIzaSy...
YOUTUBE_CHANNEL_ID=UCxxxxxx...
WHATSAPP_GROUP_NAME=Nome Exato do Grupo
```

> ⚠️ O nome do grupo deve ser **exatamente igual** ao que aparece no WhatsApp.

---

## Como usar

### Iniciar o bot

```bash
npm start
```

Na primeira vez, um **QR Code** aparecerá no terminal. Escaneie com o WhatsApp:
> WhatsApp → Menu (⋮) → Aparelhos conectados → Conectar aparelho

Depois de escanear, a sessão fica salva e não precisa escanear de novo.

### Testar se o YouTube está funcionando

```bash
node index.js --teste-youtube
```

### Testar o envio no WhatsApp

```bash
node index.js --teste-envio
```

Isso envia uma mensagem de teste para o grupo configurado.

---

## Manter rodando em segundo plano

### Opção simples (macOS) — usando `pm2`

```bash
npm install -g pm2
pm2 start index.js --name culto-bot
pm2 save
pm2 startup   # para iniciar automaticamente ao ligar o Mac
```

Para ver os logs:
```bash
pm2 logs culto-bot
```

---

## Mensagens enviadas

**Transmissão ao vivo (quarta e domingo manhã):**
```
🔴 Transmissão ao vivo

Culto da Família

📺 Assista aqui:
https://www.youtube.com/watch?v=...
```

**Gravação do domingo à noite:**
```
🎬 Culto de Domingo - Tarde

Culto da Família - 11/05/2025

📺 Assista a gravação completa:
https://www.youtube.com/watch?v=...
```
