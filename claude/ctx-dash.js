#!/usr/bin/env node
"use strict";
const http = require("http"), fs = require("fs"), path = require("path"), os = require("os");
const cp = require("child_process");
const lib = require("./ctx-lib.js");

const DEFAULT_PORT = 4791;

function buildSnapshot(home = os.homedir(), opts = {}) {
  const idx = lib.indexAll(home);
  const live = lib.liveSessions(home, opts);
  const liveById = new Map(live.map(s => [s.sessionId, s]));
  const sessions = [];

  for (const r of idx.values()) {
    const m = lib.sessionMetrics(r.file);
    if (!m) continue;
    const l = liveById.get(r.id) || null;
    const pts = lib.timeline(r.file);
    const t = lib.trend(pts, m.window);
    const subs = lib.subagentsFor(r.file);
    sessions.push({
      id: r.id, live: !!l, pid: l ? l.pid : null,
      title: m.aiTitle || (l && l.name) || "", where: lib.whereName(m.cwd), branch: m.gitBranch,
      model: m.model, version: m.version || (l && l.version) || "",
      entrypoint: l ? l.entrypoint : "", status: l ? l.status : null, waitingFor: l ? l.waitingFor : null,
      mtime: r.mtime, lastTs: m.lastTs,
      ctx: m.ctx, window: m.window, pctFull: m.pctFull,
      tokensPerMin: t.tokensPerMin, etaMinutes: t.etaMinutes,
      sparkline: pts.filter(p => !p.compact).slice(-40).map(p => p.ctx),
      turns: m.turns, cacheHitPct: m.cacheHitPct, totals: m.totals,
      cost: lib.costOf(m.byModel),
      permissionMode: m.permissionMode, modeTransitions: m.modeTransitions.length,
      speed: m.speed, serviceTier: m.serviceTier,
      webSearches: m.webSearches, webFetches: m.webFetches,
      tools: m.tools, compacts: m.compacts.length,
      subagents: subs.length, subagentTypes: [...new Set(subs.map(s => s.agentType).filter(Boolean))]
    });
  }
  sessions.sort((a, b) => (b.live - a.live) || (b.mtime - a.mtime));
  return { sessions, jobs: lib.backgroundJobs(home), generatedAt: Date.now() };
}

function sendJson(res, obj, status = 200) {
  const b = Buffer.from(JSON.stringify(obj));
  res.writeHead(status, { "content-type": "application/json; charset=utf-8", "content-length": b.length });
  res.end(b);
}

function createServer(opts = {}) {
  const home = opts.home || os.homedir();
  const clients = new Set();

  const srv = http.createServer((req, res) => {
    if (req.method !== "GET") return sendJson(res, { error: "somente leitura" }, 405);
    const url = new URL(req.url, "http://127.0.0.1");

    if (url.pathname === "/") {
      let html; try { html = fs.readFileSync(path.join(__dirname, "ctx-dash.html")); }
      catch { res.writeHead(500); return res.end("ctx-dash.html ausente"); }
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      return res.end(html);
    }

    if (url.pathname === "/api/sessions") return sendJson(res, buildSnapshot(home, opts));

    const tm = url.pathname.match(/^\/api\/session\/([0-9a-fA-F-]{36})\/timeline$/);
    if (tm) {
      const rec = lib.indexAll(home).get(tm[1]);
      if (!rec) return sendJson(res, { error: "sessão não encontrada" }, 404);
      return sendJson(res, {
        points: lib.timeline(rec.file),
        metrics: lib.sessionMetrics(rec.file),
        subagents: lib.subagentsFor(rec.file),
        workflows: lib.workflowsFor(rec.file)
      });
    }

    if (url.pathname === "/api/events") {
      res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" });
      res.write(": conectado\n\n");
      clients.add(res);
      req.on("close", () => clients.delete(res));
      return;
    }

    res.writeHead(404); res.end("não encontrado");
  });

  // fs.watch nas roots + debounce 200ms (mesmo mecanismo do --watch do terminal)
  let timer = null;
  const notify = () => {
    if (timer) return;
    timer = setTimeout(() => {
      timer = null;
      for (const c of clients) { try { c.write("event: change\ndata: {}\n\n"); } catch {} }
    }, 200);
  };
  const watched = new Map();
  const attach = () => {
    for (const root of lib.roots(home)) {
      if (!watched.has(root)) { try { watched.set(root, fs.watch(root, notify)); } catch {} }
      let projs = []; try { projs = fs.readdirSync(root); } catch {}
      for (const p of projs) {
        const d = path.join(root, p);
        if (!watched.has(d)) { try { watched.set(d, fs.watch(d, notify)); } catch {} }
      }
    }
  };
  attach();
  const iv = setInterval(attach, 5000);
  srv.on("close", () => {
    clearInterval(iv);
    if (timer) clearTimeout(timer);
    for (const w of watched.values()) { try { w.close(); } catch {} }
    watched.clear();
    for (const c of clients) { try { c.end(); } catch {} }
    clients.clear();
  });
  return srv;
}

function openBrowser(url) {
  for (const cmd of [["wslview", url], ["explorer.exe", url], ["xdg-open", url]]) {
    try { cp.execFileSync(cmd[0], [cmd[1]], { stdio: "ignore" }); return true; } catch {}
  }
  return false;
}

function listenWithFallback(srv, port, tries, cb) {
  srv.once("error", e => {
    if (e.code === "EADDRINUSE" && tries > 0) {
      console.error("porta " + port + " ocupada — tentando " + (port + 1));
      listenWithFallback(srv, port + 1, tries - 1, cb);
    } else { throw e; }
  });
  srv.listen(port, "127.0.0.1", () => cb(port));
}

module.exports = { buildSnapshot, createServer, DEFAULT_PORT };

if (require.main === module) {
  const pi = process.argv.indexOf("--port");
  const port = pi >= 0 ? Number(process.argv[pi + 1]) : DEFAULT_PORT;
  const srv = createServer({});
  listenWithFallback(srv, port, 10, p => {
    const url = "http://127.0.0.1:" + p + "/";
    console.log("ctx-dash em " + url + "  (Ctrl+C p/ sair)");
    openBrowser(url);
  });
}
