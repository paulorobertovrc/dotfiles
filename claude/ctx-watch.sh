#!/usr/bin/env bash
# ctx-watch.sh — painel de ocupação de contexto das sessões do Claude num projeto.
# Lê os transcripts .jsonl e mostra, para cada sessão, o contexto do ÚLTIMO turno.
# É um snapshot (só muda quando a sessão faz um request), lendo formato interno
# não-oficial do Claude Code. Denominador assumido: 200k tokens.
#
# Uso:
#   bash ~/.claude/ctx-watch.sh                 # print único
#   watch -n 5 -c bash ~/.claude/ctx-watch.sh   # ao vivo, atualiza a cada 5s
#   bash ~/.claude/ctx-watch.sh <PROJECT_DIR>   # outro projeto

# Descobre o diretório de transcripts do projeto (portável, sem caminho fixo):
#   1) argumento explícito, se passado;
#   2) deriva do diretório atual (encoding do Claude: cada "/" vira "-");
#   3) se esse não existir, cai no projeto com o transcript mais recente.
PROJ="$1"
if [ -z "$PROJ" ]; then
  enc=$(printf '%s' "$PWD" | sed 's#/#-#g')
  PROJ="$HOME/.claude/projects/$enc"
  [ -d "$PROJ" ] || PROJ=$(dirname "$(ls -t "$HOME"/.claude/projects/*/*.jsonl 2>/dev/null | head -1)" 2>/dev/null)
fi

node -e '
const fs = require("fs"), path = require("path");
const dir = process.argv[1];
const MAX = 200000;

// lê só o final do arquivo (transcripts ficam enormes; o último usage está no fim)
function tailRead(full, bytes = 524288) {
  const fd = fs.openSync(full, "r");
  try {
    const size = fs.fstatSync(fd).size;
    const start = Math.max(0, size - bytes);
    const buf = Buffer.alloc(size - start);
    fs.readSync(fd, buf, 0, buf.length, start);
    let s = buf.toString("utf8");
    if (start > 0) s = s.slice(s.indexOf("\n") + 1); // descarta 1a linha parcial
    return s;
  } finally { fs.closeSync(fd); }
}

let files;
try { files = fs.readdirSync(dir).filter(f => f.endsWith(".jsonl")); }
catch { console.log("dir não encontrado:", dir); process.exit(1); }

const rows = [];
for (const f of files) {
  const full = path.join(dir, f);
  const mtime = fs.statSync(full).mtimeMs;
  let lines;
  try { lines = tailRead(full).split("\n").filter(Boolean); } catch { continue; }
  let ctx = null, model = "", branch = "", ts = "";
  for (let i = lines.length - 1; i >= 0; i--) {
    let o; try { o = JSON.parse(lines[i]); } catch { continue; }
    const u = o.message && o.message.usage;
    if (u && u.input_tokens != null) {
      ctx = (u.input_tokens||0) + (u.cache_read_input_tokens||0) + (u.cache_creation_input_tokens||0);
      model  = (o.message.model || "").replace("claude-", "");
      branch = o.gitBranch || "";
      ts     = o.timestamp || "";
      break;
    }
  }
  if (ctx == null) continue;
  rows.push({ id: f.slice(0, 8), model, branch, ts, ctx, mtime });
}
rows.sort((a, b) => b.mtime - a.mtime); // sessão mais ativa primeiro

const pct   = c => c / MAX * 100;
const bar   = p => "█".repeat(Math.min(Math.round(p/5), 20)).padEnd(20, "·");
const color = p => (p >= 80 ? 31 : p >= 50 ? 33 : 32);
const clock = iso => iso ? new Date(iso).toLocaleTimeString() : "—";

if (!rows.length) { console.log("(nenhuma sessão com usage encontrada)"); process.exit(0); }
console.log("sessão    modelo        branch    últ.ativ.    contexto");
for (const r of rows) {
  const p = pct(r.ctx), c = color(p);
  process.stdout.write(
    r.id.padEnd(10) +
    r.model.padEnd(14) +
    (r.branch || "—").padEnd(10) +
    clock(r.ts).padEnd(13) +
    `\x1b[${c}m${bar(p)} ${r.ctx.toLocaleString().padStart(9)} (${p.toFixed(0)}%)\x1b[0m\n`
  );
}
' "$PROJ"
