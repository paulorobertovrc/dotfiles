# dotfiles

Configurações pessoais, sincronizadas entre máquinas (WSL/Linux e macOS).
Instalação **por cópia**: o repo é a fonte; rode `./install.sh` para aplicar.

## Instalar

```bash
git clone <este-repo> ~/dev/dotfiles
cd ~/dev/dotfiles
./install.sh
```

Pré-requisito: `node` (já vem com o Claude Code).

## Conteúdo

### `claude/` — Claude Code

| Arquivo | O que é | Vai para |
|---|---|---|
| `CLAUDE.md` | Diretrizes globais (user-scope) de trabalho, **agnósticas de domínio** — valem em todo projeto. O CLAUDE.md de cada repo apenas soma o específico dele. | `~/.claude/CLAUDE.md` |
| `statusline-command.sh` | Status line: `modelo · ctx% · 5h% · [git] · path`, com cores por limiar. Parseia o JSON com `node` (não depende de `jq`). | `~/.claude/statusline-command.sh` |
| `ctx-watch.sh` | Painel ao vivo do contexto de **todas as sessões ativas** do Claude no sistema (de qualquer diretório). Mostra modelo, repo/pasta, idade e % de uso — com a janela (200k/1M) **inferida por sessão**. | `~/.claude/ctx-watch.sh` |
| `ctx-lib.js` | Lib de coleta compartilhada por `ctx-watch.js` e `ctx-dash.js` (descoberta de sessões, métricas, timeline, subagents, custo). | `~/.claude/ctx-lib.js` |
| `ctx-watch.js` | Implementação Node do `ctx-watch.sh` (terminal). | `~/.claude/ctx-watch.js` |
| `ctx-dash.js` | Servidor HTTP sob demanda do dashboard visual (grid + drill-down por sessão), bind em `127.0.0.1`, somente leitura (GET + SSE). | `~/.claude/ctx-dash.js` |
| `ctx-dash.html` | Página única self-contained (CSS/JS inline, sem CDN) servida pelo `ctx-dash.js`. | `~/.claude/ctx-dash.html` |
| `statusline.settings.json` | Só o bloco `statusLine`. O `install.sh` o **mescla** no `~/.claude/settings.json` sem apagar o resto. | (merge) |

Aliases adicionados ao `~/.zshrc`:

- `ctx` → painel ao vivo no terminal (`Ctrl+C` para sair). `ctx --all` inclui as sessões inativas.
- `ctxd` → sobe o dashboard visual em `http://127.0.0.1:4791` e abre no navegador. Sob demanda
  (não é daemon/serviço), bind **somente em `127.0.0.1`** (nunca exposto na LAN), API **somente
  leitura** — sem qualquer escrita ou controle de sessão. Spec completa em
  [`docs/superpowers/specs/2026-07-10-ctx-dash-design.md`](docs/superpowers/specs/2026-07-10-ctx-dash-design.md).

## Notas

- A status line **só renderiza no modo terminal/CLI** do Claude, não no painel gráfico
  da extensão (o painel tem o próprio indicador de contexto na caixa de prompt).
- `ctx-watch.sh` lê o formato interno dos transcripts (`~/.claude/projects/...`), que é
  não-oficial e pode mudar entre versões do Claude Code.
- O `ctx` é dirigido a eventos (`fs.watch`): atualiza no instante em que uma sessão grava
  um turno — não depende do utilitário `watch`. A janela do % é inferida por sessão (o
  transcript não guarda esse dado): 1M se a sessão já passou de 200k, senão 200k.
