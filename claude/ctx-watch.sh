#!/usr/bin/env bash
# ctx-watch.sh — painel das sessões do Claude ATIVAS no sistema (de qualquer diretório).
#
# "Ativa" = existe um processo `claude` rodando para ela agora (mesmo ociosa,
# esperando input). Isso é mais fiel que olhar mtime do transcript.
#
# Varre TODOS os projetos em ~/.claude/projects e, por garantia, qualquer
# /mnt/<letra>/Users/<user>/.claude/projects (store do host Windows, se existir).
# Cruza com os processos `claude` vivos (ps + /proc/<pid>/cwd; lsof no macOS) e,
# para cada um, lê o transcript p/ a ocupação de contexto do último turno.
#
# A janela (denominador do %) é INFERIDA por sessão: o transcript não guarda esse
# dado, então se a sessão já passou de 200k em algum turno (ou tem preTokens>200k num
# compact), assume-se janela de 1M; senão, 200k. Calculado 1x por sessão e cacheado.
#
# Uso:
#   bash ~/.claude/ctx-watch.sh                 # imprime uma vez (sessões ativas agora)
#   bash ~/.claude/ctx-watch.sh --watch         # ao vivo, dirigido a eventos (alias: ctx)
#   bash ~/.claude/ctx-watch.sh --all           # todas as sessões recentes (ativas marcadas com ●)
#   bash ~/.claude/ctx-watch.sh --all --watch   # ao vivo + todas
#
# O modo --watch redesenha no instante em que um transcript muda (fs.watch), com um
# tick de 2s só p/ atualizar idades e detectar processos que entram/saem — não precisa
# do utilitário `watch`. A ocupação só muda quando a sessão grava um turno no transcript.

node -e '
const fs = require("fs"), path = require("path"), os = require("os"), cp = require("child_process");
const TIERS = [200000, 1000000];  // janelas conhecidas; a real é inferida por sessão
const ALL = process.argv.includes("--all");
const WATCH = process.argv.includes("--watch") || process.argv.includes("-w");
const HOME = os.homedir();

let effortLevel = "";
try {
  const cfg = JSON.parse(fs.readFileSync(path.join(HOME, ".claude", "settings.json"), "utf8"));
  effortLevel = cfg.effortLevel || "";
} catch (e) {}

// ---------- roots de transcripts (WSL + host Windows, se houver) ----------
function roots() {
  const r = [], add = p => { try { if (fs.statSync(p).isDirectory()) r.push(p); } catch {} };
  add(path.join(HOME, ".claude", "projects"));
  for (const d of ["c", "d", "e"]) {
    let us; try { us = fs.readdirSync("/mnt/" + d + "/Users"); } catch { continue; }
    for (const u of us) add("/mnt/" + d + "/Users/" + u + "/.claude/projects");
  }
  return r;
}

// id -> { id, file, projectDir, mtime }
function indexAll() {
  const idx = new Map();
  for (const root of roots()) {
    let projs; try { projs = fs.readdirSync(root); } catch { continue; }
    for (const proj of projs) {
      const pdir = path.join(root, proj);
      let files; try { files = fs.readdirSync(pdir); } catch { continue; }
      for (const f of files) {
        if (!f.endsWith(".jsonl")) continue;
        const full = path.join(pdir, f);
        let m = 0; try { m = fs.statSync(full).mtimeMs; } catch {}
        idx.set(f.slice(0, -6), { id: f.slice(0, -6), file: full, projectDir: pdir, mtime: m });
      }
    }
  }
  return idx;
}

// ---------- processos claude vivos ----------
function fullArgs(pid) {
  try { return fs.readFileSync("/proc/" + pid + "/cmdline", "utf8").replace(/\0/g, " ").trim(); } catch {}
  try { return cp.execSync("ps -ww -p " + pid + " -o args=", { encoding: "utf8" }).trim(); } catch {}
  try { return cp.execSync("ps -p " + pid + " -o args=", { encoding: "utf8" }).trim(); } catch {}
  return "";
}
function procCwd(pid) {
  try { return fs.readlinkSync("/proc/" + pid + "/cwd"); } catch {}
  try {
    const o = cp.execSync("lsof -a -p " + pid + " -d cwd -Fn 2>/dev/null", { encoding: "utf8" });
    const l = o.split("\n").find(x => x[0] === "n"); if (l) return l.slice(1);
  } catch {}
  return "";
}
function liveProcs() {
  let out = ""; try { out = cp.execSync("ps -eo pid=,comm=", { encoding: "utf8" }); } catch { return []; }
  const pids = [];
  for (const line of out.split("\n")) {
    const m = line.match(/^\s*(\d+)\s+(.+?)\s*$/); if (!m) continue;
    if (path.basename(m[2]) === "claude") pids.push(m[1]);
  }
  return pids.map(pid => {
    const a = fullArgs(pid);
    const rm = a.match(/--resume[\s=]+([0-9a-fA-F-]{36})/);
    return { pid, resume: rm ? rm[1] : "", cwd: procCwd(pid) };
  });
}

// ---------- contexto a partir do fim do transcript ----------
function tailRead(full, bytes = 524288) {
  const fd = fs.openSync(full, "r");
  try {
    const size = fs.fstatSync(fd).size, start = Math.max(0, size - bytes);
    const buf = Buffer.alloc(size - start); fs.readSync(fd, buf, 0, buf.length, start);
    let s = buf.toString("utf8"); if (start > 0) s = s.slice(s.indexOf("\n") + 1); return s;
  } finally { fs.closeSync(fd); }
}
function readInfo(file) {
  let lines; try { lines = tailRead(file).split("\n").filter(Boolean); } catch { return null; }
  for (let i = lines.length - 1; i >= 0; i--) {
    let o; try { o = JSON.parse(lines[i]); } catch { continue; }
    const u = o.message && o.message.usage;
    if (u && u.input_tokens != null) {
      return {
        ctx: (u.input_tokens || 0) + (u.cache_read_input_tokens || 0) + (u.cache_creation_input_tokens || 0),
        model: (o.message.model || "").replace("claude-", ""),
        cwd: o.cwd || "", ts: o.timestamp || ""
      };
    }
  }
  return null;
}
function whereName(cwd) {
  if (!cwd) return "—";
  try {
    const top = cp.execSync("git -C " + JSON.stringify(cwd) + " rev-parse --show-toplevel 2>/dev/null",
      { encoding: "utf8" }).trim();
    if (top) return path.basename(top);
  } catch {}
  return path.basename(cwd) || cwd;
}

// ---------- janela de contexto inferida por sessão (cacheada) ----------
const winCache = new Map();           // file -> janela inferida do histórico
function tierFor(peak) {
  for (const t of TIERS) if (peak <= t) return t;
  return Math.ceil(peak / 200000) * 200000;  // defensivo (modelos futuros maiores)
}
function scanWindow(file) {            // varre o arquivo todo 1x; early-exit ao achar >200k
  let peak = 0, txt;
  try { txt = fs.readFileSync(file, "utf8"); } catch { return TIERS[0]; }
  for (const line of txt.split("\n")) {
    if (!line || (line.indexOf("\"usage\"") < 0 && line.indexOf("\"preTokens\"") < 0)) continue;
    let o; try { o = JSON.parse(line); } catch { continue; }
    const u = o.message && o.message.usage;
    if (u && u.input_tokens != null) {
      const t = (u.input_tokens || 0) + (u.cache_read_input_tokens || 0) + (u.cache_creation_input_tokens || 0);
      if (t > peak) peak = t;
    }
    if (o.compactMetadata && o.compactMetadata.preTokens > peak) peak = o.compactMetadata.preTokens;
    if (peak > TIERS[0]) return TIERS[TIERS.length - 1];  // já é janela estendida
  }
  return tierFor(peak);
}
function windowFor(file, currentCtx) {
  let w = winCache.get(file);
  if (w == null) { w = scanWindow(file); winCache.set(file, w); }
  const cur = tierFor(currentCtx);    // sticky upward, caso cresça depois do scan
  if (cur > w) { w = cur; winCache.set(file, w); }
  return w;
}

// ---------- helpers de formatação ----------
const pct = (c, win) => c / win * 100;
const winLabel = w => (w >= 1e6 ? (w / 1e6) + "M" : Math.round(w / 1000) + "k");
const bar = p => "█".repeat(Math.min(Math.round(p / 5), 20)).padEnd(20, "·");
const col = p => (p >= 80 ? 31 : p >= 50 ? 33 : 32);
const age = ms => {
  const s = Math.max(0, (Date.now() - ms) / 1000);
  if (s < 60) return "agora";
  if (s < 3600) return Math.floor(s / 60) + "m";
  if (s < 86400) return Math.floor(s / 3600) + "h";
  return Math.floor(s / 86400) + "d";
};
const trunc = (s, n) => (s.length > n ? s.slice(0, n - 1) + "…" : s);
const clock = () => new Date().toTimeString().slice(0, 8);

// ---------- monta um quadro (string) ----------
function render() {
  const idx = indexAll();
  const liveIds = new Set(), liveCwd = new Map();
  for (const p of liveProcs()) {
    let id = "";
    if (p.resume && idx.has(p.resume)) id = p.resume;
    else if (p.cwd) {
      const enc = p.cwd.replace(/\//g, "-");
      const c = [...idx.values()].filter(r => path.basename(r.projectDir) === enc)
                                 .sort((a, b) => b.mtime - a.mtime)[0];
      if (c) id = c.id;
    }
    if (id) { liveIds.add(id); if (p.cwd) liveCwd.set(id, p.cwd); }
  }

  let pool = ALL ? [...idx.values()] : [...idx.values()].filter(r => liveIds.has(r.id));
  pool.sort((a, b) => b.mtime - a.mtime);

  const rows = [];
  for (const r of pool) {
    const info = readInfo(r.file); if (!info) continue;
    const cwd = liveCwd.get(r.id) || info.cwd || "";
    rows.push({ id: r.id.slice(0, 8), model: info.model, where: whereName(cwd),
                mtime: r.mtime, ctx: info.ctx, win: windowFor(r.file, info.ctx), live: liveIds.has(r.id) });
  }

  if (!rows.length) return (ALL ? "(nenhuma sessão encontrada)" : "(nenhuma sessão ativa do Claude)") + "\n";

  let out = (ALL ? "  " : "") + "sessão    modelo          onde                  últ.ativ.    contexto\n";
  for (const r of rows) {
    const p = pct(r.ctx, r.win), c = col(p);
    const m = ALL ? (r.live ? "\x1b[32m●\x1b[0m " : "  ") : "";
    out += m +
      r.id.padEnd(10) +
      trunc(r.model || "—", 15).padEnd(16) +
      trunc(r.where || "—", 21).padEnd(22) +
      age(r.mtime).padEnd(13) +
      "\x1b[" + c + "m" + bar(p) + " " + String(r.ctx.toLocaleString()).padStart(9) +
      " / " + winLabel(r.win) + " (" + p.toFixed(0) + "%)\x1b[0m\n";
  }
  const n = rows.length, liveN = rows.filter(r => r.live).length;
  const stat = ALL ? (n + " sessões, " + liveN + " ativa(s) ●") : (n + " sessão(ões) ativa(s)");
  const efColor = { low: 32, medium: 33, high: 35 }[effortLevel] || 37;
  const efTag = effortLevel ? " · \x1b[" + efColor + "mef:" + effortLevel + "\x1b[2m" : "";
  out += "\x1b[2m" + stat + efTag + " · janela inferida por sessão" +
         (WATCH ? " · ao vivo " + clock() + " · Ctrl+C p/ sair" : "") + "\x1b[0m\n";
  return out;
}

// ---------- single-shot, ou ao vivo (dirigido a eventos) ----------
if (!WATCH) {
  process.stdout.write(render());
} else {
  // redesenha no instante em que um transcript muda; tick de 2s p/ idades e processos.
  const draw = () => process.stdout.write("\x1b[H" + render() + "\x1b[0J");
  let timer = null;
  const schedule = () => { if (timer) return; timer = setTimeout(() => { timer = null; draw(); }, 200); };
  const watched = new Set();
  function attach() {
    for (const root of roots()) {
      if (!watched.has(root)) { try { fs.watch(root, schedule); watched.add(root); } catch {} }
      let projs = []; try { projs = fs.readdirSync(root); } catch {}
      for (const proj of projs) {
        const d = path.join(root, proj);
        if (!watched.has(d)) { try { fs.watch(d, schedule); watched.add(d); } catch {} }
      }
    }
  }
  process.stdout.write("\x1b[2J");  // limpa a tela ao entrar
  attach();
  draw();
  setInterval(() => { attach(); draw(); }, 2000);
}
' -- "$@"
