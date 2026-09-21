# Admin das janelas de culto

Página web para criar, editar e excluir as janelas de horário (hoje a tabela `JANELAS_PADRAO`
embutida em `scheduler.js`) sem editar código nem fazer deploy. Roda como um segundo serviço na
mesma VM do bot, escutando **só em `127.0.0.1`** — nunca alcançável da internet, só de dentro
da própria VM.

## Como funciona

- `admin/server.js` é um servidor HTTP simples (sem framework) com cinco rotas:
  `GET/POST /api/janelas`, `PUT/DELETE /api/janelas/:chave`, e a página em `admin/public/index.html`.
- Toda escrita valida com a mesma `validarTabela` que `scheduler.js` usa e grava com a mesma
  escrita atômica (`gravarAtomico`) que `janelas-enviadas.json` já usa — as duas pontas nunca
  discordam sobre o que é uma tabela válida.
- O resultado vai para `janelas-config.json`, no mesmo diretório persistente de
  `janelas-enviadas.json` (ao lado do `AUTH_DIR`, fora do repositório — sobrevive a deploy e a
  `git pull`).
- **O bot só lê esse arquivo na subida.** Editar uma janela aqui não afeta o processo já
  rodando — vale a partir do próximo restart do `culto-bot` (que já acontece sozinho ao fim de
  cada janela e no teto de vida de 90 min; se a mudança for urgente, `sudo systemctl restart
  culto-bot`).
- Sem `janelas-config.json` (instalação nova, ou ninguém nunca editou nada pela UI), tudo cai na
  tabela embutida `JANELAS_PADRAO` de `scheduler.js`, exatamente como hoje.

## O que a UI ainda não expõe

A UI pede nome, início, fim, dias da semana, se avisa atraso no grupo (liga/desliga — quando
ligado usa sempre 8 min, sem campo pra escolher o número) e, opcionalmente, um período de
vigência (a janela só existe entre duas datas; fora delas fica na tabela mas não faz nada — ver
o comentário sobre `vigencia` em `scheduler.js`).

Dois campos da tabela real ainda ficam com valor fixo, em `PADROES_CAMPOS_AVANCADOS` no topo de
`admin/server.js`:

| Campo | Padrão | Para editar de verdade |
|---|---|---|
| `filtroHoras` | `8` | à mão em `janelas-config.json`, ou peça pra eu adicionar na UI |
| `fallbackGravacao` | `false` | idem |

## Instalar na VM

Supõe a VM já configurada como na seção "Configuração inicial" do README principal
(usuário `culto`, código em `/opt/automacao-culto`, `AUTH_DIR=/var/lib/culto/baileys_auth`).

```bash
cd /opt/automacao-culto
sudo -u culto git pull   # traz admin/server.js e admin/public/
```

Unit do systemd, em `/etc/systemd/system/culto-admin.service`:

```ini
[Unit]
Description=Admin web das janelas de culto (só localhost)
After=network.target

[Service]
Type=simple
User=culto
Group=culto
WorkingDirectory=/opt/automacao-culto
Environment=AUTH_DIR=/var/lib/culto/baileys_auth
ExecStart=/usr/bin/node admin/server.js
Restart=always
RestartSec=5
NoNewPrivileges=true

[Install]
WantedBy=multi-user.target
```

`AUTH_DIR` precisa ser o **mesmo valor** que está em `/etc/culto/culto.env` — é o que faz este
serviço e o `culto-bot` concordarem sobre onde fica `janelas-config.json`. Se preferir não
duplicar o valor, troque `Environment=` por `EnvironmentFile=/etc/culto/culto.env` (a unit do
bot já usa esse arquivo).

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now culto-admin
sudo journalctl -u culto-admin -n 20 -o cat   # confirma: "Admin de janelas em http://127.0.0.1:8080"
```

## Acessar (túnel SSH, sem login)

Nenhum login: quem chega na página já passou pela autenticação do SSH. Use o terminal do seu
computador (não o Cloud Shell do navegador — ele é uma máquina remota também, `localhost` lá não
chega ao seu navegador local sem o Web Preview dele). Precisa do `gcloud` CLI instalado
localmente uma vez (`brew install --cask google-cloud-sdk` no macOS, depois `gcloud init`).

```bash
# se a VM é a mesma do "gcloud compute ssh" do README principal:
gcloud compute ssh culto-bot --zone=us-east1-b -- -L 127.0.0.1:8080:localhost:8080

# se o acesso é SSH direto (chave própria, sem gcloud):
ssh -L 127.0.0.1:8080:localhost:8080 usuario@ip-da-vm
```

Deixe esse terminal aberto — é ele que sustenta o túnel — e abra `http://localhost:8080` no
navegador. Fechar o terminal (ou `Ctrl+C`) derruba o túnel e a página para de responder até
abrir de novo.

## Fluxo do dia a dia

Duas rotinas diferentes: editar uma janela (não mexe em código) e atualizar o código deste
projeto (quando uma mudança for enviada pro repositório).

### A. Editar uma janela

1. Abrir o túnel (comando da seção "Acessar" acima) e deixar o terminal aberto.
2. Abrir `http://localhost:8080`, criar/editar/excluir. O toast de sucesso já confirma que a
   gravação em `janelas-config.json` funcionou.
3. Se a mudança precisa valer **agora** (não pode esperar o próximo restart natural do bot):
   ```bash
   sudo systemctl restart culto-bot
   ```
   Sem isso, ainda vale — só que só no fim da janela atual ou no teto de vida de 90 min, o que
   vier primeiro (ver "O bot só lê esse arquivo na subida", acima).
4. Conferir (opcional, só quando quiser ter certeza — véspera de culto, ou depois de mexer em
   algo sensível):
   ```bash
   sudo journalctl -u culto-bot -n 20 -o cat
   ```
   Procure `🗓️ Agendamentos configurados` e a lista de janelas logo abaixo; confirma que o bot
   já está usando a tabela que você acabou de editar.

### B. Atualizar o código

```bash
cd /opt/automacao-culto
sudo -u culto git pull
```

Reinicie só o que mudou — `git pull` mostra quais arquivos vieram:

```bash
# mudou só admin/**:
sudo systemctl restart culto-admin

# mudou scheduler.js, whatsapp.js, youtube.js ou index.js:
sudo systemctl restart culto-bot

# na dúvida, os dois:
sudo systemctl restart culto-bot culto-admin
```

Confira a subida:

```bash
sudo journalctl -u culto-bot -n 20 -o cat     # procure "✅ Credenciais encontradas" — NUNCA
                                                # deve pedir QR Code; se pedir, NÃO escaneie
sudo journalctl -u culto-admin -n 10 -o cat   # procure "Admin de janelas em http://127.0.0.1:8080"
```

Fora de horário de culto por precaução, embora `culto-admin` (ao contrário do `culto-bot`) não
segure nenhuma sessão de WhatsApp.

## Backup

`janelas-config.json` não está no git (é estado, não código — mesma razão de
`janelas-enviadas.json` estar fora). Se quiser histórico de mudanças, o jeito mais simples é
copiar o arquivo pro repositório de vez em quando:

```bash
cat /var/lib/culto/janelas-config.json   # cole/commite manualmente onde preferir
```

Automatizar isso (commit automático a cada edição, ou um serviço de backup) é deliberadamente
fora do escopo por agora — avalie se o volume de edições justifica antes de construir.
