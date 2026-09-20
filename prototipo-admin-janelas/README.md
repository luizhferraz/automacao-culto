# Protótipo: Admin de Janelas de Culto

Prova de conceito de uma interface web para gerenciar as janelas de horário de
transmissão dos cultos, hoje fixas em `JANELAS` dentro de `scheduler.js`.

Este protótipo é **independente do sistema principal**: não lê nem escreve
nada do bot em produção. Serve para validar a interação (criar, editar,
excluir, detectar conflito de horário) antes de decidir como isso se conecta
de verdade ao `scheduler.js`.

## Como testar localmente

Não precisa de servidor nem de instalar nada.

1. Abra `prototipo-admin-janelas/index.html` diretamente no navegador
   (duplo clique, ou `Ctrl+O` no navegador e escolha o arquivo).
2. Ou, se preferir servir por HTTP (mais fiel a um ambiente real):
   ```bash
   cd prototipo-admin-janelas
   python3 -m http.server 8080
   # abra http://localhost:8080
   ```
3. Os dados ficam salvos no `localStorage` do navegador, na chave
   `culto-janelas-prototipo-v1`. Para resetar para os dados de exemplo,
   limpe o site data da aba ou rode no console:
   ```js
   localStorage.removeItem('culto-janelas-prototipo-v1');
   ```

## O que dá para testar

- Criar uma nova janela (nome, início, fim, dias da semana).
- Editar uma janela existente.
- Excluir uma janela (com confirmação).
- Tentar criar/editar uma janela que colide em horário e dia com outra já
  cadastrada — a validação bloqueia o salvamento e aponta com qual janela
  o conflito ocorre.
- Recarregar a página: os dados persistem via `localStorage`.
- Redimensionar para largura de celular: o layout se adapta.

## Estrutura de dados usada no protótipo

```json
{
  "id": "janela-abc123",
  "nome": "Domingo manhã",
  "inicio": "09:55",
  "fim": "11:30",
  "diasSemana": [0]
}
```

`diasSemana` usa a mesma convenção do sistema atual: `0` = domingo ...
`6` = sábado.

## Mapeamento para o formato real (`scheduler.js`)

A tabela `JANELAS` em `scheduler.js` **não guarda um horário de fim**: ela
guarda um horário de início (`hora`/`minuto`) e um número de tentativas
(`maxTentativas`, uma por minuto), e o "fim" é derivado disso na prática.
Campos hoje existentes que este protótipo ainda não cobre:

| Campo real (`scheduler.js`) | O que faz                                              | No protótipo hoje |
|---|---|---|
| `chave`                     | id estável usado na memória em disco e nos logs         | gerado como `id`, mas não é "amigável" como `chave` |
| `rotulo`                    | texto exibido no log                                    | equivalente a `nome` |
| `hora` / `minuto`           | início da janela                                        | campo `inicio` (`HH:MM`) |
| `diaSemana`                 | número ou lista de números (0–6)                        | campo `diasSemana` (lista) |
| `maxTentativas`              | quantos minutos a janela fica tentando (define o "fim") | aproximado por `fim`, mas precisa virar `maxTentativas = fim - inicio` na integração |
| `filtroHoras`                | idade máxima do vídeo aceito como "ao vivo"              | não existe no protótipo |
| `avisoAposMin`               | minutos até avisar atraso no grupo (`null` = sem aviso)  | não existe no protótipo |
| `fallbackGravacao`           | se busca gravação quando não acha live                  | não existe no protótipo |
| `vigencia` (opcional)        | intervalo de datas em que a janela vale                 | não existe no protótipo |

Antes de integrar de verdade, decidir:

1. **`fim` vira `maxTentativas`?** Provavelmente sim (`(fim - inicio)` em
   minutos), mantendo a granularidade de 1 tentativa/minuto que o
   `scheduler.js` já usa.
2. **Os campos operacionais** (`filtroHoras`, `avisoAposMin`,
   `fallbackGravacao`, `vigencia`) precisam de algum lugar na UI — mesmo que
   como uma seção "avançado" recolhida por padrão, já que a maioria das
   janelas não muda esses valores.
3. **Onde a tabela edita de verdade.** Hoje `JANELAS` é uma constante no
   código-fonte; qualquer edição via UI implica passar a carregá-la de um
   arquivo/serviço em vez de hardcoded, com a mesma validação que
   `validarTabela` já faz (chave única, `diaSemana` válido, `vigencia`
   coerente) — essa validação deve rodar tanto ao salvar pela UI quanto ao
   subir o serviço.
4. **Efeito em produção.** `iniciarAgendamentos` registra os `cron.schedule`
   uma vez, na subida do processo. Mudar a tabela em tempo de execução exige
   ou reiniciar o serviço após salvar, ou reescrever essa parte para
   recarregar os agendamentos dinamicamente.

## Arquivos

- `index.html` — página única (HTML + CSS + JS), sem dependências externas.
