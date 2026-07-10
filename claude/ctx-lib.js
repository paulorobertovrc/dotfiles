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

module.exports = { TIERS, roots, indexAll, liveProcs, readInfo, whereName, tierFor, scanWindow, windowFor, tailRead };
