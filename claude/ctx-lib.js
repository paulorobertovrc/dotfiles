"use strict";
const fs = require("fs"), path = require("path"), os = require("os"), cp = require("child_process");

const TIERS = [200000, 1000000];

// Configuração ATIVA do CLI (~/.claude/settings.json). É estado global do
// Claude Code, não propriedade de uma sessão: `model` é o padrão configurado,
// e sessões podem trocar de modelo em runtime via /model (verificado: uma
// sessão real fez opus → fable → opus). Quem exibir isso deve rotular como
// config, nunca como "o modelo desta sessão".
function readSettings(home = os.homedir()) {
  try {
    const cfg = JSON.parse(fs.readFileSync(path.join(home, ".claude", "settings.json"), "utf8"));
    return { model: cfg.model || "", effortLevel: cfg.effortLevel || "" };
  } catch { return { model: "", effortLevel: "" }; }
}

// A varredura de /mnt/{c,d,e}/Users/*/.claude/projects é comportamento de
// PRODUÇÃO (achar sessões do Windows quando rodando em WSL) — só se aplica
// quando `home` é o os.homedir() real (ou não foi passado explicitamente).
// Um `home` de fixture injetado por teste NUNCA deve vazar para /mnt: no dia
// em que essas pastas existirem povoadas de projetos reais nesta máquina, a
// suíte (que depende de fixtures isoladas, incluindo o golden snapshot da
// Task 1) vazaria sessões reais para dentro de resultados esperados de teste.
function roots(home = os.homedir()) {
  const r = [], add = p => { try { if (fs.statSync(p).isDirectory()) r.push(p); } catch {} };
  add(path.join(home, ".claude", "projects"));
  if (home === os.homedir()) {
    for (const d of ["c", "d", "e"]) {
      let us; try { us = fs.readdirSync("/mnt/" + d + "/Users"); } catch { continue; }
      for (const u of us) add("/mnt/" + d + "/Users/" + u + "/.claude/projects");
    }
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

    const msg = o.message;
    const u = msg && msg.usage;
    const isSynthetic = o.isApiErrorMessage || (msg && msg.model === "<synthetic>");
    // E4: usage integralmente zero é stub tanto quanto a sintética — não conta
    // turno, não zera m.ctx ("último turno vence") nem entra em totals/byModel.
    // Mesmos cinco campos de usageEvents, mais cache_creation_input_tokens
    // (que esta função lê e as demais não).
    const cw0 = (u && u.cache_creation) || {};
    const isZeroUsage = !!u && u.input_tokens != null &&
      (u.input_tokens || 0) === 0 && (u.output_tokens || 0) === 0 &&
      (u.cache_read_input_tokens || 0) === 0 &&
      (u.cache_creation_input_tokens || 0) === 0 &&
      (cw0.ephemeral_5m_input_tokens || 0) === 0 &&
      (cw0.ephemeral_1h_input_tokens || 0) === 0;
    if (o.type === "assistant" && !isSynthetic && !isZeroUsage) m.turns++;

    if (msg && Array.isArray(msg.content)) {
      for (const c of msg.content) if (c && c.type === "tool_use") m.tools[c.name] = (m.tools[c.name] || 0) + 1;
    }

    if (u && u.input_tokens != null && !isSynthetic && !isZeroUsage) {
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

const usageEventsCache = new Map();

// usageEvents(file) — um registro por turno REAL (input_tokens != null), com
// timestamp e o split de tokens necessário para precificar. Filtra sintéticas
// (E4): isApiErrorMessage, modelo "<synthetic>" ou usage integralmente zero.
// Cacheado por mtime, como sessionMetrics/timeline.
function usageEvents(file) {
  let mtime = 0; try { mtime = fs.statSync(file).mtimeMs; } catch { return []; }
  const hit = usageEventsCache.get(file);
  if (hit && hit.mtime === mtime) return hit.value;

  const out = [];
  let txt; try { txt = fs.readFileSync(file, "utf8"); } catch { return []; }
  for (const line of txt.split("\n")) {
    if (!line || line.indexOf('"usage"') < 0) continue;
    let o; try { o = JSON.parse(line); } catch { continue; }
    if (o.isApiErrorMessage) continue;
    const msg = o.message; if (!msg || msg.model === "<synthetic>") continue;
    const u = msg.usage; if (!u || u.input_tokens == null) continue;
    const inp = u.input_tokens || 0, out_ = u.output_tokens || 0;
    const cr = u.cache_read_input_tokens || 0;
    const cw = u.cache_creation || {};
    const cc5m = cw.ephemeral_5m_input_tokens || 0, cc1h = cw.ephemeral_1h_input_tokens || 0;
    if (inp === 0 && out_ === 0 && cr === 0 && cc5m === 0 && cc1h === 0) continue;
    out.push({
      ts: Date.parse(o.timestamp || 0) || 0,
      model: msg.model || "unknown",
      input: inp, output: out_, cacheRead: cr, cc5m, cc1h
    });
  }
  usageEventsCache.set(file, { mtime, value: out });
  return out;
}

const rateLimitCache = new Map();

// rateLimitEvents(file) — só o evento sintético de TETO DE SESSÃO (error
// "rate_limit" + isApiErrorMessage + texto legível "…resets HH:MM"). O
// rate_limit_error cru ("Rate limited") é throttling transiente de API → ruído,
// ignorado. Weekly-limit previsto mas formato não observado: capturamos só o
// texto literal, sem codificar estrutura presumida. Cacheado por mtime.
function rateLimitEvents(file) {
  let mtime = 0; try { mtime = fs.statSync(file).mtimeMs; } catch { return []; }
  const hit = rateLimitCache.get(file);
  if (hit && hit.mtime === mtime) return hit.value;

  const out = [];
  let txt; try { txt = fs.readFileSync(file, "utf8"); } catch { return []; }
  for (const line of txt.split("\n")) {
    if (!line || line.indexOf("rate_limit") < 0) continue;
    let o; try { o = JSON.parse(line); } catch { continue; }
    if (o.error !== "rate_limit" || !o.isApiErrorMessage) continue;
    let text = "";
    const content = o.message && o.message.content;
    if (Array.isArray(content)) {
      const t = content.find(c => c && c.type === "text");
      if (t) text = t.text || "";
    }
    out.push({ ts: Date.parse(o.timestamp || 0) || 0, text,
               sessionId: o.sessionId || "", cwd: o.cwd || "" });
  }
  rateLimitCache.set(file, { mtime, value: out });
  return out;
}

// Soma um usageEvent no byModel no formato de sessionMetrics.byModel, escolhendo
// o bucket short/long pelo tamanho de contexto do turno (>200k = long).
function addEventToByModel(byModel, ev) {
  const total = ev.input + ev.cacheRead + ev.cc5m + ev.cc1h;
  const bucketName = total <= 200000 ? "short" : "long";
  const pm = byModel[ev.model] || (byModel[ev.model] = {});
  const b = pm[bucketName] || (pm[bucketName] =
    { input: 0, output: 0, cacheRead: 0, cacheCreation5m: 0, cacheCreation1h: 0 });
  b.input += ev.input; b.output += ev.output; b.cacheRead += ev.cacheRead;
  b.cacheCreation5m += ev.cc5m; b.cacheCreation1h += ev.cc1h;
}

// Chave de dia no fuso LOCAL da máquina (a assinatura reseta em horário local).
function dayKey(ts) {
  const d = new Date(ts);
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  return d.getFullYear() + "-" + mm + "-" + dd;
}

// Só o home REAL (E6): não varre /mnt (leitura via 9p do WSL seria minutos).
function homeProjectFiles(home) {
  const root = path.join(home, ".claude", "projects");
  const out = [];
  let projs; try { projs = fs.readdirSync(root); } catch { return out; }
  for (const proj of projs) {
    const pdir = path.join(root, proj);
    let files; try { files = fs.readdirSync(pdir); } catch { continue; }
    for (const f of files) if (f.endsWith(".jsonl")) out.push(path.join(pdir, f));
  }
  return out;
}

const FIVE_H = 5 * 3600 * 1000, SEVEN_D = 7 * 86400 * 1000, THIRTY_D = 30 * 86400 * 1000;

function aggregateUsage(home = os.homedir(), nowMs = null) {
  const now = nowMs == null ? Date.now() : nowMs;
  const win5h = {}, week7d = {}, allTime = {};
  const byDay = new Map();
  const rateLimits = [];
  let oldestTs = null;

  // Dobra um usageEvent nos 4 buckets de uma vez (acumulado + janelas + dia).
  // Único ponto de bucketing — Task 6 reusa esta mesma closure para os
  // eventos de subagents, em vez de duplicar a lógica.
  const foldEvent = (ev) => {
    if (ev.ts && (oldestTs == null || ev.ts < oldestTs)) oldestTs = ev.ts;
    addEventToByModel(allTime, ev);
    if (now - ev.ts <= FIVE_H) addEventToByModel(win5h, ev);
    if (now - ev.ts <= SEVEN_D) addEventToByModel(week7d, ev);
    if (now - ev.ts <= THIRTY_D) {
      const k = dayKey(ev.ts);
      let bm = byDay.get(k); if (!bm) byDay.set(k, bm = {});
      addEventToByModel(bm, ev);
    }
  };

  for (const file of homeProjectFiles(home)) {
    for (const ev of usageEvents(file)) foldEvent(ev);

    // E1: subagents do mesmo transcript têm usage/modelo próprios.
    const subDir = path.join(transcriptDir(file), "subagents");
    let subFiles = []; try { subFiles = fs.readdirSync(subDir); } catch {}
    for (const sf of subFiles) {
      if (!sf.endsWith(".jsonl")) continue;
      const subFile = path.join(subDir, sf);
      for (const ev of usageEvents(subFile)) foldEvent(ev);
      for (const e of rateLimitEvents(subFile)) rateLimits.push(e);
    }

    for (const e of rateLimitEvents(file)) rateLimits.push(e);
  }

  const daily = [...byDay.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1))
    .map(([date, byModel]) => ({ date, byModel, cost: costOf(byModel) }));

  // Um teto batido com N requests em voo (paralelismo/subagents) grava N linhas
  // sintéticas idênticas — mesmo sessionId, mesmo ts ao milissegundo (observado
  // 6x num único ms no histórico real desta máquina). Sem dedup, um evento vira
  // N marcadores e consome o cap de 50 à toa.
  const seenRl = new Set();
  const rlUnique = rateLimits.filter(e => {
    const k = e.sessionId + " " + e.ts;
    if (seenRl.has(k)) return false;
    seenRl.add(k);
    return true;
  });

  return {
    win5h: { byModel: win5h, cost: costOf(win5h) },
    week7d: { byModel: week7d, cost: costOf(week7d) },
    allTime: { byModel: allTime, cost: costOf(allTime) },
    daily, rateLimits: rlUnique.sort((a, b) => b.ts - a.ts).slice(0, 50),
    oldestTs, generatedAt: now
  };
}

const timelineCache = new Map();

// timeline(file) — extrai um ponto por turno de assistant (mais compactMetadata),
// em ordem cronológica, cacheado por mtime do arquivo (mesmo padrão de sessionMetrics).
function timeline(file) {
  let mtime = 0; try { mtime = fs.statSync(file).mtimeMs; } catch { return []; }
  const hit = timelineCache.get(file);
  if (hit && hit.mtime === mtime) return hit.value;

  const pts = [];
  let txt; try { txt = fs.readFileSync(file, "utf8"); } catch { return []; }
  for (const line of txt.split("\n")) {
    if (!line) continue;
    let o; try { o = JSON.parse(line); } catch { continue; }
    if (o.compactMetadata && o.compactMetadata.preTokens) {
      pts.push({ ts: Date.parse(o.timestamp || 0) || 0, ctx: o.compactMetadata.preTokens,
                 output: 0, model: "", compact: true });
      continue;
    }
    const u = o.message && o.message.usage;
    if (!u || u.input_tokens == null) continue;
    pts.push({
      ts: Date.parse(o.timestamp || 0) || 0,
      ctx: (u.input_tokens || 0) + (u.cache_read_input_tokens || 0) + (u.cache_creation_input_tokens || 0),
      output: u.output_tokens || 0,
      model: (o.message.model || "").replace("claude-", ""),
      compact: false
    });
  }
  pts.sort((a, b) => a.ts - b.ts);
  timelineCache.set(file, { mtime, value: pts });
  return pts;
}

// trend(points, windowTokens) — tendência pela regressão simples entre o primeiro e o
// último ponto da janela recente (últimos 5 pontos não-compact). Compacts quebram
// monotonicidade do contexto, por isso são excluídos da amostra.
function trend(points, windowTokens) {
  const p = points.filter(x => !x.compact).slice(-5);
  if (p.length < 2) return { tokensPerMin: 0, etaMinutes: null };
  const a = p[0], b = p[p.length - 1];
  const dtMin = (b.ts - a.ts) / 60000;
  if (dtMin <= 0) return { tokensPerMin: 0, etaMinutes: null };
  const tokensPerMin = (b.ctx - a.ctx) / dtMin;
  if (tokensPerMin <= 0) return { tokensPerMin, etaMinutes: null };
  const remaining = windowTokens - b.ctx;
  return { tokensPerMin, etaMinutes: remaining > 0 ? remaining / tokensPerMin : 0 };
}

// USD por 1.000.000 de tokens. Preencher SOMENTE com valores verificados na fonte
// oficial. Modelo sem bucket "short" => costOf marca partial e não inventa número.
// Bucket "long" ausente => costOf usa o preço "short" para tokens >200k E marca
// partial (nunca precifica contexto longo em silêncio como se fosse curto).
//
// Fonte: https://platform.claude.com/docs/en/about-claude/pricing
// (redirecionado de https://docs.claude.com/en/docs/about-claude/pricing)
// Verificado em: 2026-07-10
//
// Sobretaxa de contexto longo (>200k tokens de input): a própria fonte, seção
// "Long context pricing", confirma EXPLICITAMENTE que não existe sobretaxa para
// nenhum modelo em uso nesta lib — citação verbatim:
//   "Claude Fable 5, Claude Mythos 5, Claude Mythos Preview, Claude Opus 4.8,
//   Opus 4.7, Opus 4.6, Sonnet 5, and Sonnet 4.6 include the full 1M token
//   context window at standard pricing. (A 900k-token request is billed at
//   the same per-token rate as a 9k-token request.)"
// Por isso os buckets "long" de claude-opus-4-8 e claude-fable-5 abaixo são
// idênticos aos buckets "short" — não é uma estimativa, é o preço confirmado
// (não seria correto marcar partial aqui, já que não há lacuna de informação).
// claude-haiku-4-5-20251001 NÃO tem bucket "long": Haiku 4.5 tem janela de
// contexto de 200K (sem variante 1M), então não há preço de contexto longo
// a verificar para esse modelo — costOf cai no fallback documentado acima
// (usa "short" e marca partial) se um bucket "long" aparecer para ele de
// qualquer forma.
const PRICES = {
  "claude-opus-4-8": {
    short: { input: 5, output: 25, cacheRead: 0.5, cacheWrite5m: 6.25, cacheWrite1h: 10 },
    long:  { input: 5, output: 25, cacheRead: 0.5, cacheWrite5m: 6.25, cacheWrite1h: 10 },
  },
  "claude-fable-5": {
    short: { input: 10, output: 50, cacheRead: 1, cacheWrite5m: 12.5, cacheWrite1h: 20 },
    long:  { input: 10, output: 50, cacheRead: 1, cacheWrite5m: 12.5, cacheWrite1h: 20 },
  },
  // Fonte: https://platform.claude.com/docs/en/about-claude/pricing
  // Verificado em: 2026-07-23.
  // Sonnet 5 tem DUAS faixas datadas na tabela oficial. Citação verbatim da nota
  // de preço introdutório da fonte:
  //   "Introductory pricing of $2/$10 per million input/output tokens is in
  //   effect through August 31, 2026, after which the standard pricing of
  //   $3/$15 per million input/output tokens will take effect."
  // Linhas verbatim da tabela "Model pricing" (Base Input | 5m Cache Writes |
  //   1h Cache Writes | Cache Hits & Refreshes | Output Tokens):
  //   "Claude Sonnet 5 [through August 31, 2026]  $2 / MTok  $2.50 / MTok
  //    $4 / MTok  $0.20 / MTok  $10 / MTok"
  //   "Claude Sonnet 5 starting September 1, 2026  $3 / MTok  $3.75 / MTok
  //    $6 / MTok  $0.30 / MTok  $15 / MTok"
  // DECISÃO (revisável): usamos a faixa INTRODUTÓRIA porque é a que está em vigor
  // hoje (2026-07-23, dentro da janela) e foi a cobrada em TODO o uso de Sonnet 5
  // até agora — o dashboard reflete o custo real incorrido, não um preço futuro.
  // ⚠️ TROCAR para a faixa padrão a partir de 2026-09-01: input 3, output 15,
  //   cacheRead 0.30, cacheWrite5m 3.75, cacheWrite1h 6.
  // Contexto longo: a seção "Long context pricing" da fonte lista Sonnet 5
  // EXPLICITAMENTE entre os modelos com janela de 1M em preço padrão — citação
  // verbatim: "Claude Fable 5, Claude Mythos 5, Claude Mythos Preview, Claude
  //   Opus 4.8, Opus 4.7, Opus 4.6, Sonnet 5, and Sonnet 4.6 include the full
  //   1M token context window at standard pricing." Por isso `long` == `short`
  //   (preço confirmado, não estimativa — mesma cláusula que Opus/Fable).
  "claude-sonnet-5": {
    short: { input: 2, output: 10, cacheRead: 0.2, cacheWrite5m: 2.5, cacheWrite1h: 4 },
    long:  { input: 2, output: 10, cacheRead: 0.2, cacheWrite5m: 2.5, cacheWrite1h: 4 },
  },
  "claude-haiku-4-5-20251001": {
    short: { input: 1, output: 5, cacheRead: 0.1, cacheWrite5m: 1.25, cacheWrite1h: 2 },
  },
};

function costOf(byModel) {
  let usd = 0, partial = false, any = false;
  for (const [model, buckets] of Object.entries(byModel || {})) {
    const price = PRICES[model];
    if (!price) { partial = true; continue; }
    for (const bucketName of ["short", "long"]) {
      const t = buckets[bucketName];
      if (!t) continue;
      const p = price[bucketName] || price.short;
      if (bucketName === "long" && !price.long) partial = true;
      any = true;
      usd += (t.input / 1e6) * p.input
           + (t.output / 1e6) * p.output
           + (t.cacheRead / 1e6) * p.cacheRead
           + (t.cacheCreation5m / 1e6) * p.cacheWrite5m
           + (t.cacheCreation1h / 1e6) * p.cacheWrite1h;
    }
  }
  if (!any) return null;
  return { usd, partial };
}

// O transcript-dir é o diretório irmão com o mesmo nome do .jsonl, sem extensão.
function transcriptDir(file) { return file.replace(/\.jsonl$/, ""); }

function subagentsFor(file) {
  const dir = path.join(transcriptDir(file), "subagents");
  let files; try { files = fs.readdirSync(dir); } catch { return []; }
  const out = [];
  for (const f of files) {
    if (!f.endsWith(".jsonl")) continue;
    const agentId = f.replace(/^agent-/, "").replace(/\.jsonl$/, "");
    let meta = {};
    try { meta = JSON.parse(fs.readFileSync(path.join(dir, "agent-" + agentId + ".meta.json"), "utf8")); } catch {}
    let mtime = 0; try { mtime = fs.statSync(path.join(dir, f)).mtimeMs; } catch {}
    const tokens = { input: 0, output: 0 };
    let model = "";
    let txt; try { txt = fs.readFileSync(path.join(dir, f), "utf8"); } catch { continue; }
    for (const line of txt.split("\n")) {
      if (!line) continue;
      let o; try { o = JSON.parse(line); } catch { continue; }
      const u = o.message && o.message.usage;
      if (u && u.input_tokens != null) {
        tokens.input += (u.input_tokens || 0) + (u.cache_read_input_tokens || 0) + (u.cache_creation_input_tokens || 0);
        tokens.output += u.output_tokens || 0;
        if (o.message.model) model = o.message.model.replace("claude-", "");
      }
    }
    out.push({ agentId, agentType: meta.agentType || "", description: meta.description || "",
               spawnDepth: meta.spawnDepth || 0, model, tokens, mtime });
  }
  return out;
}

function backgroundJobs(home = os.homedir()) {
  const dir = path.join(home, ".claude", "jobs");
  let entries; try { entries = fs.readdirSync(dir); } catch { return []; }
  const out = [];
  for (const id of entries) {
    let s; try { s = JSON.parse(fs.readFileSync(path.join(dir, id, "state.json"), "utf8")); } catch { continue; }
    const flags = s.respawnFlags || [];
    const mi = flags.indexOf("--model");
    out.push({
      id, state: s.state || "", sessionId: s.sessionId || "", name: s.name || "",
      intent: s.intent || "", tokens: s.tokens || 0,
      inFlight: s.inFlight || { tasks: 0, queued: 0 },
      model: mi >= 0 && flags[mi + 1] ? flags[mi + 1] : ""
    });
  }
  return out;
}

// Workflows: o journal.jsonl NÃO foi observado em disco (nenhum workflow rodou
// nesta máquina até 2026-07-10). Descoberta tolerante; o formato deve ser
// validado com um workflow real ANTES de desenhar UI de detalhe.
function workflowsFor(file) {
  const j = path.join(transcriptDir(file), "journal.jsonl");
  let txt; try { txt = fs.readFileSync(j, "utf8"); } catch { return []; }
  const out = [];
  for (const line of txt.split("\n")) {
    if (!line) continue;
    try { out.push(JSON.parse(line)); } catch {}
  }
  return out;
}

module.exports = {
  TIERS, roots, indexAll, liveProcs, readInfo, whereName, tierFor, scanWindow, windowFor, tailRead,
  fullArgs, procCwd, liveSessions, procStartOf, sessionMetrics, usageEvents, rateLimitEvents, timeline, trend,
  PRICES, costOf, aggregateUsage, subagentsFor, backgroundJobs, workflowsFor, transcriptDir, readSettings
};
