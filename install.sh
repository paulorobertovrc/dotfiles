#!/usr/bin/env bash
# Instala estes dotfiles (por CÓPIA) em ~/.claude e garante o alias no ~/.zshrc.
# Idempotente. Funciona em Linux e macOS. Requer: node (já vem com o Claude Code).
#
# Uso:  ./install.sh
set -euo pipefail

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CLAUDE_DIR="$HOME/.claude"

echo "→ Copiando scripts para $CLAUDE_DIR"
mkdir -p "$CLAUDE_DIR"
cp "$REPO_DIR/claude/statusline-command.sh" "$CLAUDE_DIR/statusline-command.sh"
cp "$REPO_DIR/claude/ctx-watch.sh"          "$CLAUDE_DIR/ctx-watch.sh"

echo "→ Mesclando o bloco statusLine em $CLAUDE_DIR/settings.json (preserva o resto)"
SETTINGS="$CLAUDE_DIR/settings.json" SNIPPET="$REPO_DIR/claude/statusline.settings.json" node -e '
const fs = require("fs");
const sp = process.env.SETTINGS, snp = process.env.SNIPPET;
let cur = {};
try { cur = JSON.parse(fs.readFileSync(sp, "utf8")); } catch (e) {}
const add = JSON.parse(fs.readFileSync(snp, "utf8"));
Object.assign(cur, add); // statusLine entra/sobrescreve; theme/model/effort/etc. ficam
fs.writeFileSync(sp, JSON.stringify(cur, null, 2) + "\n");
console.log("  settings.json atualizado.");
'

echo "→ Garantindo o alias ctx no ~/.zshrc"
ZSHRC="$HOME/.zshrc"
touch "$ZSHRC"
if grep -q "alias ctx=" "$ZSHRC"; then
  echo "  alias ctx já existe — pulando."
else
  {
    printf '\n# Painel de contexto das sessões do Claude (ver ~/.claude/ctx-watch.sh)\n'
    printf "alias ctx='bash ~/.claude/ctx-watch.sh --watch'\n"
  } >> "$ZSHRC"
  echo "  alias adicionado."
fi

echo
echo "✓ Pronto."
echo "  • Abra um terminal novo (ou rode: source ~/.zshrc) e use:  ctx"
echo "  • A status line aparece no modo terminal/CLI do Claude (não no painel gráfico)."
echo "  • 'ctx' mostra as sessões ativas ao vivo (Ctrl+C p/ sair); 'ctx --all' inclui as inativas."
