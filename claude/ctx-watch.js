#!/usr/bin/env node
"use strict";
const fs = require("fs"), path = require("path"), os = require("os");
const lib = require("./ctx-lib.js");

const pct = (c, win) => c / win * 100;
const winLabel = w => (w >= 1e6 ? (w / 1e6) + "M" : Math.round(w / 1000) + "k");
const bar = p => "█".repeat(Math.min(Math.round(p / 5), 20)).padEnd(20, "·");
const col = p => (p >= 80 ? 31 : p >= 50 ? 33 : 32);
const age = (ms, now) => {
  const s = Math.max(0, (now - ms) / 1000);
  if (s < 60) return "agora";
  if (s < 3600) return Math.floor(s / 60) + "m";
  if (s < 86400) return Math.floor(s / 3600) + "h";
  return Math.floor(s / 86400) + "d";
};
const trunc = (s, n) => (s.length > n ? s.slice(0, n - 1) + "…" : s);
const clockOf = now => new Date(now).toTimeString().slice(0, 8);

function readEffort(home) {
  try {
    const cfg = JSON.parse(fs.readFileSync(path.join(home, ".claude", "settings.json"), "utf8"));
    return cfg.effortLevel || "";
  } catch { return ""; }
}

function render(opts = {}) {
  const home = opts.home || os.homedir();
  const now = opts.now || Date.now();
  const ALL = !!opts.all, WATCH = !!opts.watch;
  const effortLevel = opts.effortLevel !== undefined ? opts.effortLevel : readEffort(home);

  const idx = lib.indexAll(home);
  const liveIds = new Set(), liveCwd = new Map();
  for (const p of (opts.procs || lib.liveProcs())) {
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
    const info = lib.readInfo(r.file); if (!info) continue;
    const cwd = liveCwd.get(r.id) || info.cwd || "";
    rows.push({ id: r.id.slice(0, 8), model: info.model, where: lib.whereName(cwd),
                mtime: r.mtime, ctx: info.ctx, win: lib.windowFor(r.file, info.ctx), live: liveIds.has(r.id) });
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
      age(r.mtime, now).padEnd(13) +
      "\x1b[" + c + "m" + bar(p) + " " + String(r.ctx.toLocaleString("en-US")).padStart(9) +
      " / " + winLabel(r.win) + " (" + p.toFixed(0) + "%)\x1b[0m\n";
  }
  const n = rows.length, liveN = rows.filter(r => r.live).length;
  const stat = ALL ? (n + " sessões, " + liveN + " ativa(s) ●") : (n + " sessão(ões) ativa(s)");
  const efColor = { low: 32, medium: 33, high: 35 }[effortLevel] || 37;
  const efTag = effortLevel ? " · \x1b[" + efColor + "mef:" + effortLevel + "\x1b[2m" : "";
  out += "\x1b[2m" + stat + efTag + " · janela inferida por sessão" +
         (WATCH ? " · ao vivo " + clockOf(now) + " · Ctrl+C p/ sair" : "") + "\x1b[0m\n";
  return out;
}

module.exports = { render };

if (require.main === module) {
  const ALL = process.argv.includes("--all");
  const WATCH = process.argv.includes("--watch") || process.argv.includes("-w");
  if (!WATCH) { process.stdout.write(render({ all: ALL })); }
  else {
    const draw = () => process.stdout.write("\x1b[H" + render({ all: ALL, watch: true }) + "\x1b[0J");
    let timer = null;
    const schedule = () => { if (timer) return; timer = setTimeout(() => { timer = null; draw(); }, 200); };
    const watched = new Set();
    function attach() {
      for (const root of lib.roots()) {
        if (!watched.has(root)) { try { fs.watch(root, schedule); watched.add(root); } catch {} }
        let projs = []; try { projs = fs.readdirSync(root); } catch {}
        for (const proj of projs) {
          const d = path.join(root, proj);
          if (!watched.has(d)) { try { fs.watch(d, schedule); watched.add(d); } catch {} }
        }
      }
    }
    process.stdout.write("\x1b[2J");
    attach(); draw();
    setInterval(() => { attach(); draw(); }, 2000);
  }
}
