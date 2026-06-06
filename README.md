# dotfiles

Configurações pessoais, sincronizadas entre máquinas (WSL/Linux e macOS).
Instalação **por cópia**: o repo é a fonte; rode `./install.sh` para aplicar.

## Instalar

```bash
git clone <este-repo> ~/dev/dotfiles
cd ~/dev/dotfiles
./install.sh
```

Pré-requisitos: `node` (já vem com o Claude Code) e, para o alias `ctx`, o utilitário
`watch` (Linux já tem; no macOS: `brew install watch`).

## Conteúdo

### `claude/` — Claude Code

| Arquivo | O que é | Vai para |
|---|---|---|
| `statusline-command.sh` | Status line: `modelo · ctx% · 5h% · [git] · path`, com cores por limiar. Parseia o JSON com `node` (não depende de `jq`). | `~/.claude/statusline-command.sh` |
| `ctx-watch.sh` | Painel que mostra a ocupação de contexto de todas as sessões do Claude de um projeto (lendo os transcripts). Detecta o projeto pelo diretório atual. | `~/.claude/ctx-watch.sh` |
| `statusline.settings.json` | Só o bloco `statusLine`. O `install.sh` o **mescla** no `~/.claude/settings.json` sem apagar o resto. | (merge) |

Alias adicionado ao `~/.zshrc`: `ctx` → painel de contexto ao vivo (`Ctrl+C` para sair).

## Notas

- A status line **só renderiza no modo terminal/CLI** do Claude, não no painel gráfico
  da extensão (o painel tem o próprio indicador de contexto na caixa de prompt).
- `ctx-watch.sh` lê o formato interno dos transcripts (`~/.claude/projects/...`), que é
  não-oficial e pode mudar entre versões do Claude Code.
