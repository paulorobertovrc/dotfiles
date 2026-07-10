"use strict";
const fs = require("fs"), path = require("path"), os = require("os"), cp = require("child_process");

const TIERS = [200000, 1000000];

function roots(home = os.homedir()) {
  const r = [], add = p => { try { if (fs.statSync(p).isDirectory()) r.push(p); } catch {} };
  add(path.join(home, ".claude", "projects"));
  for (const d of ["c", "d", "e"]) {
    let us; try { us = fs.readdirSync("/mnt/" + d + "/Users"); } catch { continue; }
    for (const u of us) add("/mnt/" + d + "/Users/" + u + "/.claude/projects");
  }
  return r;
}

function indexAll(home) {
  const idx = new Map();
  for (const root of roots(home)) {
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

const winCache = new Map();
function tierFor(peak) {
  for (const t of TIERS) if (peak <= t) return t;
  return Math.ceil(peak / 200000) * 200000;
}
function scanWindow(file) {
  let peak = 0, txt;
  try { txt = fs.readFileSync(file, "utf8"); } catch { return TIERS[0]; }
  for (const line of txt.split("\n")) {
    if (!line || (line.indexOf('"usage"') < 0 && line.indexOf('"preTokens"') < 0)) continue;
    let o; try { o = JSON.parse(line); } catch { continue; }
    const u = o.message && o.message.usage;
    if (u && u.input_tokens != null) {
      const t = (u.input_tokens || 0) + (u.cache_read_input_tokens || 0) + (u.cache_creation_input_tokens || 0);
      if (t > peak) peak = t;
    }
    if (o.compactMetadata && o.compactMetadata.preTokens > peak) peak = o.compactMetadata.preTokens;
    if (peak > TIERS[0]) return TIERS[TIERS.length - 1];
  }
  return tierFor(peak);
}
function windowFor(file, currentCtx) {
  let w = winCache.get(file);
  if (w == null) { w = scanWindow(file); winCache.set(file, w); }
  const cur = tierFor(currentCtx);
  if (cur > w) { w = cur; winCache.set(file, w); }
  return w;
}

// Lê /proc/<pid>/stat campo 22 (starttime). Guard contra reuso de PID:
// ~/.claude/sessions/ acumula órfãos (7 de 14 na inspeção de 2026-07-10).
function procStartOf(pid) {
  try {
    const st = fs.readFileSync("/proc/" + pid + "/stat", "utf8");
    return st.slice(st.lastIndexOf(")") + 2).split(" ")[19];
  } catch { return null; }
}

function defaultIsAlive(pid, procStart) {
  const real = procStartOf(pid);
  if (real == null) return false;
  return procStart == null || String(real) === String(procStart);
}

function liveSessions(home = os.homedir(), opts = {}) {
  const isAlive = opts.isAlive || defaultIsAlive;
  const dir = path.join(home, ".claude", "sessions");
  let files; try { files = fs.readdirSync(dir); } catch { return []; }
  const out = [];
  for (const f of files) {
    if (!f.endsWith(".json")) continue;
    let o; try { o = JSON.parse(fs.readFileSync(path.join(dir, f), "utf8")); } catch { continue; }
    if (!o || !o.pid || !o.sessionId) continue;
    if (!isAlive(o.pid, o.procStart)) continue;
    out.push({
      pid: o.pid, sessionId: o.sessionId, cwd: o.cwd || "", name: o.name || "",
      version: o.version || "", entrypoint: o.entrypoint || "", kind: o.kind || "",
      startedAt: o.startedAt || 0,
      // status/waitingFor são gravados de forma esporádica (1 de 14 arquivos em
      // 2026-07-10) — tratar como enriquecimento best-effort, nunca como base.
      status: o.status || null, waitingFor: o.waitingFor || null
    });
  }
  return out;
}

// Varredura única do transcript: deriva contexto, turnos, cache hit, transições de modo
// e custo acumulado por-modelo. Cacheada por mtimeMs — releitura só quando o arquivo muda.
const metricsCache = new Map(); // file -> {mtime, value}

function sessionMetrics(file) {
  let mtime = 0; try { mtime = fs.statSync(file).mtimeMs; } catch { return null; }
  const hit = metricsCache.get(file);
  if (hit && hit.mtime === mtime) return hit.value;

  const m = {
    ctx: 0, window: TIERS[0], pctFull: 0, model: "", turns: 0,
    totals: { input: 0, output: 0, cacheRead: 0, cacheCreation: 0 },
    cacheHitPct: null, permissionMode: null, modeTransitions: [],
    gitBranch: null, aiTitle: null, version: null, cwd: "", lastTs: "",
    speed: null, serviceTier: null, webSearches: 0, webFetches: 0,
    tools: {}, compacts: [], byModel: {}
  };
  let txt; try { txt = fs.readFileSync(file, "utf8"); } catch { return null; }
  let peak = 0, prevMode = null;

  for (const line of txt.split("\n")) {
    if (!line) continue;
    let o; try { o = JSON.parse(line); } catch { continue; }

    if (o.gitBranch) m.gitBranch = o.gitBranch;
    if (o.aiTitle) m.aiTitle = o.aiTitle;
    if (o.version) m.version = o.version;
    if (o.cwd) m.cwd = o.cwd;
    if (o.timestamp) m.lastTs = o.timestamp;

    if (o.permissionMode) {
      if (prevMode && prevMode !== o.permissionMode) {
        m.modeTransitions.push({ at: o.timestamp || "", from: prevMode, to: o.permissionMode });
      }
      prevMode = o.permissionMode;
      m.permissionMode = o.permissionMode;
    }

    if (o.compactMetadata && o.compactMetadata.preTokens) {
      m.compacts.push({ at: o.timestamp || "", preTokens: o.compactMetadata.preTokens });
      if (o.compactMetadata.preTokens > peak) peak = o.compactMetadata.preTokens;
    }

    if (o.type === "assistant") m.turns++;

    const msg = o.message;
    if (msg && Array.isArray(msg.content)) {
      for (const c of msg.content) if (c && c.type === "tool_use") m.tools[c.name] = (m.tools[c.name] || 0) + 1;
    }

    const u = msg && msg.usage;
    if (u && u.input_tokens != null) {
      const inp = u.input_tokens || 0, cr = u.cache_read_input_tokens || 0, cc = u.cache_creation_input_tokens || 0;
      const total = inp + cr + cc;
      if (total > peak) peak = total;
      m.ctx = total;                       // último turno vence
      m.model = (msg.model || "").replace("claude-", "");
      m.totals.input += inp; m.totals.output += u.output_tokens || 0;
      m.totals.cacheRead += cr; m.totals.cacheCreation += cc;
      if (u.speed) m.speed = u.speed;
      if (u.service_tier) m.serviceTier = u.service_tier;
      if (u.server_tool_use) {
        m.webSearches += u.server_tool_use.web_search_requests || 0;
        m.webFetches += u.server_tool_use.web_fetch_requests || 0;
      }
      const key = msg.model || "unknown";
      const bucketName = total <= 200000 ? "short" : "long";
      const perModel = m.byModel[key] || (m.byModel[key] = {});
      const b = perModel[bucketName] || (perModel[bucketName] =
        { input: 0, output: 0, cacheRead: 0, cacheCreation5m: 0, cacheCreation1h: 0 });
      const cw = u.cache_creation || {};
      b.input += inp; b.output += u.output_tokens || 0; b.cacheRead += cr;
      b.cacheCreation5m += cw.ephemeral_5m_input_tokens || 0;
      b.cacheCreation1h += cw.ephemeral_1h_input_tokens || 0;
    }
  }

  m.window = peak > TIERS[0] ? TIERS[TIERS.length - 1] : tierFor(peak);
  if (tierFor(m.ctx) > m.window) m.window = tierFor(m.ctx);
  m.pctFull = m.window ? m.ctx / m.window * 100 : 0;
  const inTot = m.totals.input + m.totals.cacheRead + m.totals.cacheCreation;
  m.cacheHitPct = inTot > 0 ? m.totals.cacheRead / inTot * 100 : null;

  metricsCache.set(file, { mtime, value: m });
  return m;
}

module.exports = {
  TIERS, roots, indexAll, liveProcs, readInfo, whereName, tierFor, scanWindow, windowFor, tailRead,
  fullArgs, procCwd, liveSessions, procStartOf, sessionMetrics
};
