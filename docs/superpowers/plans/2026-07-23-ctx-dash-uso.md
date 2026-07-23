# ctx-dash — Seção de uso agregado — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Adicionar ao ctx-dash uma aba "Uso" com consumo agregado (total, por-modelo, janelas 5h/7d/30d-diário/acumulado, em tokens e $) e marcadores dos eventos reais de rate-limit.

**Architecture:** Estende `ctx-lib.js` com extração por-turno (`usageEvents`), detecção de rate-limit (`rateLimitEvents`) e agregação temporal (`aggregateUsage`), tudo cacheado por mtime como o resto da lib. O servidor ganha `/api/usage` com compute assíncrono e invalidação por evento. A página ganha uma aba que alterna com o grid e renderiza os agregados em SVG à mão.

**Tech Stack:** Node.js ≥18, zero dependências externas, `node:test` nativo (`node --test`, sem argumento, rodado da raiz do repo — descoberta recursiva automática), `node:http`, SVG à mão. Fonte de dados: transcripts `~/.claude/projects/*/*.jsonl` + `subagents/agent-*.jsonl`.

## Global Constraints

- **Zero dependências externas** — nada de npm install; só stdlib do Node.
- **Somente leitura** — nenhuma escrita em disco; servidor recusa métodos ≠ GET (405).
- **Regra de verdade** — $ só para modelos com preço **verificado na fonte oficial**; modelo sem preço → badge "parcial", nunca $ chutado. Nenhum "% de limite do plano" (sem fonte local).
- **Rótulos honestos** — "últimas 5h (móvel)", "últimos 7 dias", "acumulado (transcripts retidos desde …)"; nunca fingir a mecânica exata do plano.
- **Agregado lê só o home real** — `path.join(home, ".claude", "projects")`, **não** `/mnt` (E6). Difere de `roots()`, que varre `/mnt` para descoberta ao vivo.
- **Sintéticas filtradas** — linhas com `isApiErrorMessage` ou `model === "<synthetic>"` ou usage integralmente zero não entram em nenhum agregado nem no `sessionMetrics` (E4).
- **Testes rodam com** `node --test` (sem argumento de caminho — `node --test claude/test` **falha sempre** neste ambiente, tratando o diretório como script de entrada em vez de acionar a descoberta recursiva; use arquivo explícito para um teste isolado, ou `node --test` puro da raiz do repo para a suíte inteira).

---

### Task 1: Filtrar mensagens sintéticas do `sessionMetrics` (E4)

Corrige bug latente: linhas de erro 429 (`model: "<synthetic>"`, `isApiErrorMessage: true`, usage todo-zero mas `input_tokens: 0` ≠ null) hoje entram no `byModel` como modelo sem preço e acenderiam o badge "parcial" à toa.

**Files:**
- Create: `claude/test/fixtures/synthetic/dddddddd-0000-0000-0000-000000000004.jsonl`
- Modify: `claude/ctx-lib.js:234-235` (guarda do bloco de usage em `sessionMetrics`)
- Test: `claude/test/metrics.test.js`

**Interfaces:**
- Consumes: `lib.sessionMetrics(file)` (existente).
- Produces: nada novo; garante que `sessionMetrics().byModel` nunca contém a chave `"<synthetic>"`.

- [ ] **Step 1: Criar a fixture com uma linha real + uma sintética**

Criar `claude/test/fixtures/synthetic/dddddddd-0000-0000-0000-000000000004.jsonl` com exatamente estas 2 linhas (uma linha por objeto, sem quebra interna):

```
{"type":"assistant","timestamp":"2026-01-01T00:00:00.000Z","message":{"role":"assistant","model":"claude-opus-4-8","usage":{"input_tokens":100,"output_tokens":50,"cache_read_input_tokens":0,"cache_creation_input_tokens":0,"cache_creation":{"ephemeral_5m_input_tokens":0,"ephemeral_1h_input_tokens":0}}}}
{"type":"assistant","timestamp":"2026-01-01T00:01:00.000Z","error":"rate_limit","isApiErrorMessage":true,"apiErrorStatus":429,"message":{"role":"assistant","model":"<synthetic>","content":[{"type":"text","text":"You've hit your session limit · resets 12:30pm (America/Cuiaba)"}],"usage":{"input_tokens":0,"output_tokens":0,"cache_read_input_tokens":0,"cache_creation_input_tokens":0,"cache_creation":{"ephemeral_5m_input_tokens":0,"ephemeral_1h_input_tokens":0}}}}
```

- [ ] **Step 2: Escrever o teste que falha**

Adicionar ao fim de `claude/test/metrics.test.js`:

```js
const FILE_SYNTH = path.join(__dirname, "fixtures", "synthetic",
  "dddddddd-0000-0000-0000-000000000004.jsonl");

test("sessionMetrics ignora mensagens sintéticas de erro 429 (E4)", () => {
  const m = lib.sessionMetrics(FILE_SYNTH);
  assert.deepStrictEqual(Object.keys(m.byModel), ["claude-opus-4-8"]);
  assert.strictEqual(m.byModel["<synthetic>"], undefined);
  assert.strictEqual(m.totals.output, 50);       // só o turno real conta
});
```

- [ ] **Step 3: Rodar o teste e ver falhar**

Run: `node --test claude/test/metrics.test.js`
Expected: FAIL — `byModel` contém `"<synthetic>"` (chave extra), `deepStrictEqual` quebra.

- [ ] **Step 4: Aplicar a guarda em `sessionMetrics`**

Em `claude/ctx-lib.js`, no corpo do loop de `sessionMetrics`, trocar a condição do bloco de usage (hoje `if (u && u.input_tokens != null) {`) por:

```js
    const u = msg && msg.usage;
    if (u && u.input_tokens != null && !o.isApiErrorMessage && msg.model !== "<synthetic>") {
```

- [ ] **Step 5: Rodar o teste e ver passar**

Run: `node --test claude/test/metrics.test.js`
Expected: PASS (todos os testes do arquivo, inclusive os antigos).

- [ ] **Step 6: Commit**

```bash
git add claude/ctx-lib.js claude/test/metrics.test.js claude/test/fixtures/synthetic/
git commit -m "fix(ctx-dash): sessionMetrics ignora mensagens sintéticas 429 (E4)"
```

---

### Task 2: `usageEvents(file)` — extração por-turno cacheada

Base comum de agregação: um registro por turno real, com timestamp e o split de tokens necessário para precificar. Filtra sintéticas (E4). Cacheada por mtime.

**Files:**
- Modify: `claude/ctx-lib.js` (nova função + entrada em `module.exports`)
- Test: `claude/test/usage.test.js` (novo)

**Interfaces:**
- Consumes: nada novo.
- Produces: `usageEvents(file) -> Array<{ts:number, model:string, input:number, output:number, cacheRead:number, cc5m:number, cc1h:number}>`. `ts` em ms (epoch); ordem de arquivo (cronológica no transcript).

- [ ] **Step 1: Escrever o teste que falha**

Criar `claude/test/usage.test.js`:

```js
const test = require("node:test");
const assert = require("node:assert");
const path = require("node:path");
const lib = require("../ctx-lib.js");

const FILE_TWO = path.join(__dirname, "fixtures", "two-models",
  "cccccccc-0000-0000-0000-000000000003.jsonl");
const FILE_SYNTH = path.join(__dirname, "fixtures", "synthetic",
  "dddddddd-0000-0000-0000-000000000004.jsonl");

test("usageEvents extrai um registro por turno com split de tokens", () => {
  const evs = lib.usageEvents(FILE_TWO);
  assert.strictEqual(evs.length, 2);
  assert.strictEqual(evs[0].model, "claude-opus-4-8");
  assert.strictEqual(evs[0].input, 100);
  assert.strictEqual(evs[0].output, 50);
  assert.strictEqual(evs[1].model, "claude-haiku-4-5-20251001");
  assert.strictEqual(evs[1].input, 200);
  assert.ok(evs[0].ts > 0);
});

test("usageEvents filtra sintéticas/zeradas (E4)", () => {
  const evs = lib.usageEvents(FILE_SYNTH);
  assert.strictEqual(evs.length, 1);
  assert.strictEqual(evs[0].model, "claude-opus-4-8");
});
```

- [ ] **Step 2: Rodar e ver falhar**

Run: `node --test claude/test/usage.test.js`
Expected: FAIL — `lib.usageEvents is not a function`.

- [ ] **Step 3: Implementar `usageEvents`**

Em `claude/ctx-lib.js`, após `sessionMetrics` (antes de `timeline`), adicionar:

```js
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
```

E acrescentar `usageEvents` ao objeto `module.exports`.

- [ ] **Step 4: Rodar e ver passar**

Run: `node --test claude/test/usage.test.js`
Expected: PASS (2 testes).

- [ ] **Step 5: Commit**

```bash
git add claude/ctx-lib.js claude/test/usage.test.js
git commit -m "feat(ctx-dash): usageEvents — extração por-turno cacheada por mtime"
```

---

### Task 3: Preço do Sonnet 5 na tabela `PRICES` (E7)

O histórico contém `claude-sonnet-*`; sem o preço, todo agregado que inclua Sonnet acende "parcial". **Os números vêm da fonte oficial, não são inventados.**

**Files:**
- Modify: `claude/ctx-lib.js` (objeto `PRICES`)
- Test: `claude/test/usage.test.js`

**Interfaces:**
- Consumes: `lib.costOf(byModel)` (existente).
- Produces: `PRICES["claude-sonnet-5"]` com buckets `short`/`long` verificados.

- [ ] **Step 1: Obter os preços na fonte oficial**

**REQUIRED SUB-SKILL:** invocar a skill `claude-api` (ou abrir `https://platform.claude.com/docs/en/about-claude/pricing`) e ler a linha do **Claude Sonnet 5**: input, output, cache read, cache write 5m e 1h (USD por 1M tokens), e confirmar se há preço de contexto longo (>200k) distinto. Anotar os valores verificados. **Não** prosseguir com números de memória.

- [ ] **Step 2: Escrever o teste que falha (estrutura, não número)**

Adicionar a `claude/test/usage.test.js`:

```js
test("PRICES cobre Sonnet 5 → costOf não marca parcial para Sonnet (E7)", () => {
  const byModel = { "claude-sonnet-5": { short:
    { input: 1e6, output: 0, cacheRead: 0, cacheCreation5m: 0, cacheCreation1h: 0 } } };
  const c = lib.costOf(byModel);
  assert.ok(c && c.partial === false, "Sonnet deve ter preço verificado");
  assert.ok(c.usd > 0, "custo do Sonnet deve ser > 0");
});
```

- [ ] **Step 3: Rodar e ver falhar**

Run: `node --test claude/test/usage.test.js`
Expected: FAIL — `costOf` retorna `partial: true` (Sonnet ausente de `PRICES`) ou `null`.

- [ ] **Step 4: Inserir o preço verificado**

Em `claude/ctx-lib.js`, dentro de `PRICES`, adicionar a entrada do Sonnet 5 **preenchida com os valores lidos no Step 1**, espelhando a estrutura do Opus e seguindo a disciplina de comentário datado da tabela. Modelo com janela 1M sem sobretaxa → `long` idêntico a `short` (como Opus/Fable). Exemplo de forma (substituir `<…>` pelos números da fonte):

```js
  // Fonte: https://platform.claude.com/docs/en/about-claude/pricing — verificado em <DATA>.
  // Sonnet 5 inclui a janela de 1M em preço padrão (mesma cláusula que Opus/Fable),
  // por isso `long` == `short` — preço confirmado, não estimativa.
  "claude-sonnet-5": {
    short: { input: <IN>, output: <OUT>, cacheRead: <CR>, cacheWrite5m: <CW5>, cacheWrite1h: <CW1> },
    long:  { input: <IN>, output: <OUT>, cacheRead: <CR>, cacheWrite5m: <CW5>, cacheWrite1h: <CW1> },
  },
```

- [ ] **Step 5: Rodar e ver passar**

Run: `node --test claude/test/usage.test.js`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add claude/ctx-lib.js claude/test/usage.test.js
git commit -m "feat(ctx-dash): preço verificado do Sonnet 5 na tabela PRICES (E7)"
```

---

### Task 4: `rateLimitEvents(file)` — só o teto de sessão real

Detecta a mensagem sintética de teto batido (429 + texto legível). Ignora `rate_limit_error` cru (throttling transiente).

**Files:**
- Modify: `claude/ctx-lib.js` (nova função + export)
- Create: `claude/test/fixtures/ratelimit/eeeeeeee-0000-0000-0000-000000000005.jsonl`
- Test: `claude/test/usage.test.js`

**Interfaces:**
- Produces: `rateLimitEvents(file) -> Array<{ts:number, text:string, sessionId:string, cwd:string}>`.

- [ ] **Step 1: Criar a fixture com um evento de sessão + ruído a ignorar**

Criar `claude/test/fixtures/ratelimit/eeeeeeee-0000-0000-0000-000000000005.jsonl` com exatamente estas 2 linhas:

```
{"type":"assistant","timestamp":"2026-06-30T16:24:42.055Z","error":"rate_limit","isApiErrorMessage":true,"apiErrorStatus":429,"sessionId":"3b012c6a-3106-474c-8fd2-85cda73b565c","cwd":"/home/prvrc/dev/controle-processos","message":{"role":"assistant","model":"<synthetic>","content":[{"type":"text","text":"You've hit your session limit · resets 12:30pm (America/Cuiaba)"}]}}
{"type":"user","timestamp":"2026-06-30T16:25:00.000Z","message":{"role":"user","content":[{"type":"tool_result","content":"{\"type\":\"error\",\"error\":{\"type\":\"rate_limit_error\",\"message\":\"Rate limited\"},\"request_id\":\"req_x\"}"}]}}
```

- [ ] **Step 2: Escrever o teste que falha**

Adicionar a `claude/test/usage.test.js`:

```js
const FILE_RL = path.join(__dirname, "fixtures", "ratelimit",
  "eeeeeeee-0000-0000-0000-000000000005.jsonl");

test("rateLimitEvents captura só o teto de sessão, ignora rate_limit_error cru", () => {
  const evs = lib.rateLimitEvents(FILE_RL);
  assert.strictEqual(evs.length, 1);
  assert.match(evs[0].text, /session limit/);
  assert.match(evs[0].text, /resets 12:30pm/);
  assert.ok(evs[0].ts > 0);
});
```

- [ ] **Step 3: Rodar e ver falhar**

Run: `node --test claude/test/usage.test.js`
Expected: FAIL — `lib.rateLimitEvents is not a function`.

- [ ] **Step 4: Implementar `rateLimitEvents`**

Em `claude/ctx-lib.js`, após `usageEvents`, adicionar (e exportar):

```js
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
```

- [ ] **Step 5: Rodar e ver passar**

Run: `node --test claude/test/usage.test.js`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add claude/ctx-lib.js claude/test/usage.test.js claude/test/fixtures/ratelimit/
git commit -m "feat(ctx-dash): rateLimitEvents — detecta teto de sessão, ignora ruído"
```

---

### Task 5: `aggregateUsage(home, nowMs)` — buckets, por-modelo, custo, oldestTs

O núcleo. Varre só o home real (E6), soma `usageEvents` nas janelas 5h/7d/30d-diário/acumulado por-modelo, precifica com `costOf`, reporta o timestamp mais antigo.

**Files:**
- Modify: `claude/ctx-lib.js` (helpers + `aggregateUsage` + export)
- Create: `claude/test/fixtures/usage-home/.claude/projects/-fake/ffffffff-0000-0000-0000-000000000006.jsonl`
- Test: `claude/test/usage.test.js`

**Interfaces:**
- Consumes: `usageEvents`, `costOf`, `PRICES` (Sonnet já presente após Task 3).
- Produces:
  `aggregateUsage(home, nowMs) -> {`
  `  win5h:{byModel, cost}, week7d:{byModel, cost}, allTime:{byModel, cost},`
  `  daily:Array<{date:string, byModel, cost}>, rateLimits:Array<…>, oldestTs:number|null, generatedAt:number }`.
  `byModel` tem o formato de `sessionMetrics.byModel`: `{ [model]: { short:{input,output,cacheRead,cacheCreation5m,cacheCreation1h}, long:{…} } }`.

- [ ] **Step 1: Criar a fixture com timestamps relativos a um `now` fixo**

`now` do teste = `Date.parse("2026-07-23T12:00:00.000Z")`. Criar `claude/test/fixtures/usage-home/.claude/projects/-fake/ffffffff-0000-0000-0000-000000000006.jsonl` com 3 turnos reais (A: −1h, B: −2 dias, C: −40 dias) + 1 sintética (ignorada):

```
{"type":"assistant","timestamp":"2026-07-23T11:00:00.000Z","message":{"role":"assistant","model":"claude-opus-4-8","usage":{"input_tokens":1000,"output_tokens":100,"cache_read_input_tokens":500,"cache_creation_input_tokens":200,"cache_creation":{"ephemeral_5m_input_tokens":200,"ephemeral_1h_input_tokens":0}}}}
{"type":"assistant","timestamp":"2026-07-21T12:00:00.000Z","message":{"role":"assistant","model":"claude-sonnet-5","usage":{"input_tokens":2000,"output_tokens":200,"cache_read_input_tokens":0,"cache_creation_input_tokens":0,"cache_creation":{"ephemeral_5m_input_tokens":0,"ephemeral_1h_input_tokens":0}}}}
{"type":"assistant","timestamp":"2026-06-13T12:00:00.000Z","message":{"role":"assistant","model":"claude-haiku-4-5-20251001","usage":{"input_tokens":300,"output_tokens":30,"cache_read_input_tokens":0,"cache_creation_input_tokens":0,"cache_creation":{"ephemeral_5m_input_tokens":0,"ephemeral_1h_input_tokens":0}}}}
{"type":"assistant","timestamp":"2026-07-23T09:00:00.000Z","error":"rate_limit","isApiErrorMessage":true,"message":{"role":"assistant","model":"<synthetic>","content":[{"type":"text","text":"You've hit your session limit · resets 1:00pm"}]}}
```

- [ ] **Step 2: Escrever o teste que falha**

Adicionar a `claude/test/usage.test.js`:

```js
const USAGE_HOME = path.join(__dirname, "fixtures", "usage-home");
const NOW = Date.parse("2026-07-23T12:00:00.000Z");

test("aggregateUsage separa janelas 5h/7d/acumulado por-modelo (E4/E6)", () => {
  const a = lib.aggregateUsage(USAGE_HOME, NOW);
  // 5h: só o turno de -1h (opus). Sonnet(-2d) e haiku(-40d) fora; sintética fora.
  assert.deepStrictEqual(Object.keys(a.win5h.byModel), ["claude-opus-4-8"]);
  assert.strictEqual(a.win5h.byModel["claude-opus-4-8"].short.input, 1000);
  // 7d: opus + sonnet; haiku(-40d) fora.
  assert.deepStrictEqual(Object.keys(a.week7d.byModel).sort(),
    ["claude-opus-4-8", "claude-sonnet-5"]);
  // acumulado: os 3 modelos reais, nunca "<synthetic>".
  assert.deepStrictEqual(Object.keys(a.allTime.byModel).sort(),
    ["claude-haiku-4-5-20251001", "claude-opus-4-8", "claude-sonnet-5"]);
  assert.strictEqual(a.allTime.byModel["<synthetic>"], undefined);
});

test("aggregateUsage: série diária dentro de 30d, oldestTs e custo não-parcial", () => {
  const a = lib.aggregateUsage(USAGE_HOME, NOW);
  // dias distintos em 30d: -1h e -2d (o de -40d fica fora).
  assert.strictEqual(a.daily.length, 2);
  assert.strictEqual(a.oldestTs, Date.parse("2026-06-13T12:00:00.000Z"));
  // opus + sonnet + haiku todos com preço → parcial falso.
  assert.strictEqual(a.allTime.cost.partial, false);
  assert.ok(a.allTime.cost.usd > 0);
});
```

- [ ] **Step 3: Rodar e ver falhar**

Run: `node --test claude/test/usage.test.js`
Expected: FAIL — `lib.aggregateUsage is not a function`.

- [ ] **Step 4: Implementar helpers + `aggregateUsage`**

Em `claude/ctx-lib.js`, após `rateLimitEvents`, adicionar (e exportar `aggregateUsage`):

```js
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
  let oldestTs = null;

  for (const file of homeProjectFiles(home)) {
    for (const ev of usageEvents(file)) {
      if (ev.ts && (oldestTs == null || ev.ts < oldestTs)) oldestTs = ev.ts;
      addEventToByModel(allTime, ev);
      if (now - ev.ts <= FIVE_H) addEventToByModel(win5h, ev);
      if (now - ev.ts <= SEVEN_D) addEventToByModel(week7d, ev);
      if (now - ev.ts <= THIRTY_D) {
        const k = dayKey(ev.ts);
        let bm = byDay.get(k); if (!bm) byDay.set(k, bm = {});
        addEventToByModel(bm, ev);
      }
    }
  }

  const daily = [...byDay.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1))
    .map(([date, byModel]) => ({ date, byModel, cost: costOf(byModel) }));

  return {
    win5h: { byModel: win5h, cost: costOf(win5h) },
    week7d: { byModel: week7d, cost: costOf(week7d) },
    allTime: { byModel: allTime, cost: costOf(allTime) },
    daily, rateLimits: [], oldestTs, generatedAt: now
  };
}
```

(`rateLimits` fica `[]` por ora — preenchido na Task 7.)

- [ ] **Step 5: Rodar e ver passar**

Run: `node --test claude/test/usage.test.js`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add claude/ctx-lib.js claude/test/usage.test.js claude/test/fixtures/usage-home/
git commit -m "feat(ctx-dash): aggregateUsage — janelas 5h/7d/30d/acumulado por-modelo"
```

---

### Task 6: Somar subagents ao agregado (E1)

Subagents rodam em `<transcript-dir>/subagents/agent-*.jsonl` com usage (e modelo) próprios. Sem eles, o total subconta silenciosamente.

**Files:**
- Modify: `claude/ctx-lib.js` (`aggregateUsage`)
- Create: `claude/test/fixtures/usage-home/.claude/projects/-fake/ffffffff-0000-0000-0000-000000000006/subagents/agent-sub1.jsonl`
- Test: `claude/test/usage.test.js`

**Interfaces:**
- Consumes: `usageEvents`, `transcriptDir` (existente).
- Produces: mesmo shape; agora inclui tokens dos subagents nos buckets.

- [ ] **Step 1: Criar a fixture do subagent (turno em −1h, modelo haiku)**

Criar `claude/test/fixtures/usage-home/.claude/projects/-fake/ffffffff-0000-0000-0000-000000000006/subagents/agent-sub1.jsonl` com 1 linha:

```
{"isSidechain":true,"agentId":"sub1","type":"assistant","timestamp":"2026-07-23T11:00:00.000Z","message":{"role":"assistant","model":"claude-haiku-4-5-20251001","usage":{"input_tokens":100,"output_tokens":50,"cache_read_input_tokens":1000,"cache_creation_input_tokens":0,"cache_creation":{"ephemeral_5m_input_tokens":0,"ephemeral_1h_input_tokens":0}}}}
```

- [ ] **Step 2: Escrever o teste que falha**

Adicionar a `claude/test/usage.test.js`:

```js
test("aggregateUsage inclui tokens de subagents (E1)", () => {
  const a = lib.aggregateUsage(USAGE_HOME, NOW);
  // subagent haiku (-1h) entra na 5h ao lado do opus.
  assert.deepStrictEqual(Object.keys(a.win5h.byModel).sort(),
    ["claude-haiku-4-5-20251001", "claude-opus-4-8"]);
  assert.strictEqual(a.win5h.byModel["claude-haiku-4-5-20251001"].short.input, 100);
  assert.strictEqual(a.win5h.byModel["claude-haiku-4-5-20251001"].short.cacheRead, 1000);
});
```

Nota: o teste do acumulado da Task 5 continua válido — haiku já constava (turno de −40d); agora soma 300+100=400 de input, mas aquele teste só checa as chaves, não muda.

- [ ] **Step 3: Rodar e ver falhar**

Run: `node --test claude/test/usage.test.js`
Expected: FAIL — `win5h.byModel` só tem opus (subagent ignorado).

- [ ] **Step 4: Varrer subagents no `aggregateUsage`**

Em `aggregateUsage`, dentro do loop `for (const file of homeProjectFiles(home))`, após o loop de `usageEvents(file)`, acrescentar:

```js
    // E1: subagents do mesmo transcript têm usage/modelo próprios.
    const subDir = path.join(transcriptDir(file), "subagents");
    let subFiles = []; try { subFiles = fs.readdirSync(subDir); } catch {}
    for (const sf of subFiles) {
      if (!sf.endsWith(".jsonl")) continue;
      for (const ev of usageEvents(path.join(subDir, sf))) {
        if (ev.ts && (oldestTs == null || ev.ts < oldestTs)) oldestTs = ev.ts;
        addEventToByModel(allTime, ev);
        if (now - ev.ts <= FIVE_H) addEventToByModel(win5h, ev);
        if (now - ev.ts <= SEVEN_D) addEventToByModel(week7d, ev);
        if (now - ev.ts <= THIRTY_D) {
          const k = dayKey(ev.ts);
          let bm = byDay.get(k); if (!bm) byDay.set(k, bm = {});
          addEventToByModel(bm, ev);
        }
      }
    }
```

- [ ] **Step 5: Rodar e ver passar**

Run: `node --test claude/test/usage.test.js`
Expected: PASS (todos).

- [ ] **Step 6: Commit**

```bash
git add claude/ctx-lib.js claude/test/usage.test.js claude/test/fixtures/usage-home/
git commit -m "feat(ctx-dash): agrega tokens de subagents no uso (E1)"
```

---

### Task 7: Anexar eventos de rate-limit ao agregado

Preenche `rateLimits` no retorno de `aggregateUsage`, ordenado do mais recente.

**Files:**
- Modify: `claude/ctx-lib.js` (`aggregateUsage`)
- Modify: `claude/test/fixtures/usage-home/.claude/projects/-fake/ffffffff-0000-0000-0000-000000000006.jsonl` (a linha sintética já existe da Task 5 — nenhuma edição necessária)
- Test: `claude/test/usage.test.js`

**Interfaces:**
- Consumes: `rateLimitEvents`.
- Produces: `aggregateUsage(...).rateLimits: Array<{ts,text,sessionId,cwd}>` (mais recente primeiro, no máx. 50).

- [ ] **Step 1: Escrever o teste que falha**

Adicionar a `claude/test/usage.test.js`:

```js
test("aggregateUsage anexa eventos de rate-limit (mais recente primeiro)", () => {
  const a = lib.aggregateUsage(USAGE_HOME, NOW);
  assert.strictEqual(a.rateLimits.length, 1);
  assert.match(a.rateLimits[0].text, /session limit/);
});
```

- [ ] **Step 2: Rodar e ver falhar**

Run: `node --test claude/test/usage.test.js`
Expected: FAIL — `rateLimits` é `[]`.

- [ ] **Step 3: Preencher `rateLimits`**

Em `aggregateUsage`: declarar `const rateLimits = [];` junto dos outros acumuladores; dentro do loop de arquivos, após varrer subagents, acrescentar:

```js
    for (const e of rateLimitEvents(file)) rateLimits.push(e);
```

E trocar `rateLimits: []` no objeto de retorno por:

```js
    rateLimits: rateLimits.sort((a, b) => b.ts - a.ts).slice(0, 50),
```

- [ ] **Step 4: Rodar e ver passar**

Run: `node --test claude/test/usage.test.js`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add claude/ctx-lib.js claude/test/usage.test.js
git commit -m "feat(ctx-dash): anexa eventos de rate-limit ao agregado de uso"
```

---

### Task 8: Endpoint `/api/usage` com compute assíncrono e invalidação

Primeira chamada dispara o parse (~3s no histórico real) em background e responde `{computing:true}`; ao terminar, avisa via SSE. Mudança de arquivo invalida o cache.

**Files:**
- Modify: `claude/ctx-dash.js` (`createServer`)
- Test: `claude/test/server.test.js`

**Interfaces:**
- Consumes: `lib.aggregateUsage(home)`.
- Produces: `GET /api/usage` → `{computing:true}` OU o objeto de `aggregateUsage`.

- [ ] **Step 1: Escrever o teste que falha**

Adicionar a `claude/test/server.test.js`:

```js
test("/api/usage computa assíncrono e depois serve o agregado", async () => {
  const srv = createServer({ home: HOME, isAlive: () => true });
  await new Promise(r => srv.listen(0, "127.0.0.1", r));
  const port = srv.address().port;

  const first = await (await fetch(`http://127.0.0.1:${port}/api/usage`)).json();
  assert.strictEqual(first.computing, true);

  // Espera o compute (setImmediate) concluir, com poll curto.
  let data = null;
  for (let i = 0; i < 50 && !data; i++) {
    const d = await (await fetch(`http://127.0.0.1:${port}/api/usage`)).json();
    if (!d.computing) data = d; else await new Promise(r => setTimeout(r, 20));
  }
  assert.ok(data, "usage deve ficar pronto");
  assert.ok(data.allTime && data.win5h && Array.isArray(data.daily));

  await new Promise(r => srv.close(r));
});
```

- [ ] **Step 2: Rodar e ver falhar**

Run: `node --test claude/test/server.test.js`
Expected: FAIL — `/api/usage` cai no 404, `first.computing` é `undefined`.

- [ ] **Step 3: Implementar o endpoint + invalidação**

Em `claude/ctx-dash.js`, dentro de `createServer`, logo após `const clients = new Set();`, adicionar o estado e o compute:

```js
  let usageCache = null, usageComputing = false;
  const computeUsage = () => {
    usageComputing = true;
    setImmediate(() => {
      try { usageCache = lib.aggregateUsage(home); } catch { usageCache = null; }
      usageComputing = false;
      notify();   // avisa SSE → cliente re-busca /api/usage
    });
  };
```

No handler, antes do `res.writeHead(404)` final, adicionar a rota:

```js
    if (url.pathname === "/api/usage") {
      if (usageCache) return sendJson(res, usageCache);
      if (!usageComputing) computeUsage();
      return sendJson(res, { computing: true });
    }
```

Invalidação: trocar a callback do `fs.watch` para limpar o cache. Definir, logo após `computeUsage`:

```js
  const onWatch = () => { usageCache = null; notify(); };
```

e, em `attach()`, usar `onWatch` no lugar de `notify` nas duas chamadas `fs.watch(...)`:

```js
      if (!watched.has(root)) { try { watched.set(root, fs.watch(root, onWatch)); } catch {} }
      ...
        if (!watched.has(d)) { try { watched.set(d, fs.watch(d, onWatch)); } catch {} }
```

(`notify` continua sendo o empurrão de SSE; `computeUsage` o chama sem re-invalidar, evitando laço.)

- [ ] **Step 4: Rodar e ver passar**

Run: `node --test claude/test/server.test.js`
Expected: PASS (todos, inclusive os antigos).

- [ ] **Step 5: Rodar a suíte inteira**

Run: `node --test` (sem argumento, da raiz do repo — descoberta recursiva automática)
Expected: PASS em todos os arquivos.

- [ ] **Step 6: Commit**

```bash
git add claude/ctx-dash.js claude/test/server.test.js
git commit -m "feat(ctx-dash): endpoint /api/usage assíncrono com invalidação por evento"
```

---

### Task 9: UI — aba "Uso" (toggle + estado computing + tiles)

Adiciona a navegação Sessões↔Uso, alterna as views, busca `/api/usage` e renderiza os três tiles (5h / 7d / acumulado) com rótulos honestos. Sem runner de DOM no repo → **verificação manual** (curl + browser), coerente com o resto da página.

**Files:**
- Modify: `claude/ctx-dash.html` (header, CSS, JS de view/fetch/render)

**Interfaces:**
- Consumes: `GET /api/usage`.
- Produces: funções JS `renderUsage(u)`, `sumTokens(byModel)`, `fmtTokens(n)`, `fmtUsd(cost)` (usadas também na Task 10).

- [ ] **Step 1: Adicionar a navegação no header e o container da view**

Em `claude/ctx-dash.html`, no `<header>`, após o `<h1>ctx-dash</h1>`, inserir o toggle de abas:

```html
  <nav id="tabs">
    <button type="button" class="tab active" data-view="sessions">Sessões</button>
    <button type="button" class="tab" data-view="usage">Uso</button>
  </nav>
```

Após o bloco `<div id="grid"></div>` / `<div id="empty">…</div>`, envolver a view de sessões e adicionar a de uso:

```html
<section id="usageView" hidden>
  <div class="usage-tiles" id="usageTiles"></div>
  <div id="usageComputing" class="empty-note">calculando uso do histórico…</div>
  <div id="usageBody"></div>
</section>
```

- [ ] **Step 2: CSS dos tiles**

No `<style>`, adicionar:

```css
#tabs { display: flex; gap: 4px; margin-left: 12px; }
.tab { background: none; border: 1px solid var(--muted); color: var(--muted);
  border-radius: 6px; padding: 3px 10px; cursor: pointer; font-size: 0.85rem; }
.tab.active { color: var(--fg); border-color: var(--fg); }
.usage-tiles { display: flex; flex-wrap: wrap; gap: 12px; margin: 12px 0; }
.usage-tile { border: 1px solid var(--muted); border-radius: 8px; padding: 10px 14px; min-width: 160px; }
.usage-tile .label { color: var(--muted); font-size: 0.78rem; }
.usage-tile .big { font-family: var(--font-data); font-variant-numeric: tabular-nums;
  font-size: 1.4rem; }
.usage-tile .usd { color: var(--fg); font-size: 0.9rem; }
.usage-tile .partial { color: var(--warn, #d0a000); font-size: 0.72rem; }
```

- [ ] **Step 3: Helpers + render dos tiles + troca de view (JS)**

No `<script>`, antes de `async function refresh()`, adicionar:

```js
let currentView = "sessions";
let usageData = null;

function sumTokens(byModel) {
  let t = 0;
  for (const buckets of Object.values(byModel || {}))
    for (const b of Object.values(buckets))
      t += (b.input || 0) + (b.output || 0) + (b.cacheRead || 0)
         + (b.cacheCreation5m || 0) + (b.cacheCreation1h || 0);
  return t;
}
function fmtTokens(n) {
  if (n >= 1e9) return (n / 1e9).toFixed(1) + "B";
  if (n >= 1e6) return (n / 1e6).toFixed(1) + "M";
  if (n >= 1e3) return (n / 1e3).toFixed(1) + "k";
  return String(n);
}
function fmtUsd(cost) {
  if (!cost) return "—";
  return "$" + cost.usd.toFixed(2) + (cost.partial ? " ⚠" : "");
}
function usageTile(label, period) {
  const cost = period.cost;
  return `<div class="usage-tile">
    <div class="label">${esc(label)}</div>
    <div class="big num">${fmtTokens(sumTokens(period.byModel))}</div>
    <div class="usd num">${fmtUsd(cost)}</div>
    ${cost && cost.partial ? '<div class="partial">$ parcial (modelo sem preço)</div>' : ""}
  </div>`;
}
function renderUsage(u) {
  const oldest = u.oldestTs ? new Date(u.oldestTs).toLocaleDateString() : "—";
  document.getElementById("usageTiles").innerHTML =
    usageTile("últimas 5h (móvel)", u.win5h)
    + usageTile("últimos 7 dias", u.week7d)
    + usageTile("acumulado (retido desde " + esc(oldest) + ")", u.allTime);
}

async function refreshUsage() {
  const computing = document.getElementById("usageComputing");
  try {
    const d = await (await fetch("/api/usage")).json();
    if (d.computing) { computing.style.display = "block"; return; }
    computing.style.display = "none";
    usageData = d;
    renderUsage(d);
  } catch {}
}

function setView(view) {
  currentView = view;
  document.querySelectorAll(".tab").forEach(t =>
    t.classList.toggle("active", t.dataset.view === view));
  document.getElementById("grid").hidden = view !== "sessions";
  document.getElementById("empty").hidden = view !== "sessions";
  document.getElementById("usageView").hidden = view !== "usage";
  if (view === "usage") refreshUsage();
}
document.getElementById("tabs").addEventListener("click", e => {
  const btn = e.target.closest(".tab"); if (btn) setView(btn.dataset.view);
});
```

Nota: `#empty`/`#grid` passam a usar `hidden` — remover qualquer `display` inline conflitante em `render()` (a linha `empty.style.display` já existente continua válida para o caso "sem sessões" dentro da view Sessões).

- [ ] **Step 4: Ligar o SSE ao refresh de uso**

Trocar a linha `new EventSource("/api/events").addEventListener("change", refresh);` por um handler que atualiza a view ativa:

```js
try {
  new EventSource("/api/events").addEventListener("change", () => {
    refresh();
    if (currentView === "usage") refreshUsage();
  });
} catch {}
```

- [ ] **Step 5: Verificação manual**

Run: `node claude/ctx-dash.js --port 4791` (Ctrl+C ao terminar).
Em outro terminal: `curl -s http://127.0.0.1:4791/api/usage` → primeiro `{"computing":true}`, depois (repetir) o JSON com `win5h`/`week7d`/`allTime`/`daily`.
No browser (abre sozinho): clicar em **Uso** → aparece "calculando…" e então os três tiles com tokens e $. Conferir que o tile "acumulado" traz a data de retenção. Voltar em **Sessões** → grid intacto.

- [ ] **Step 6: Commit**

```bash
git add claude/ctx-dash.html
git commit -m "feat(ctx-dash): aba Uso com tiles 5h/7d/acumulado e estado computing"
```

---

### Task 10: UI — série diária 30d, quebra por-modelo e faixa de eventos

Completa a aba: barras por dia (empilhadas por modelo), barras por-modelo do acumulado e a faixa de eventos de rate-limit.

**Files:**
- Modify: `claude/ctx-dash.html` (CSS + render)

**Interfaces:**
- Consumes: `usageData` (`daily`, `allTime.byModel`, `rateLimits`), helpers da Task 9.
- Produces: `renderDailySeries(daily)`, `renderModelBreakdown(byModel)`, `renderRateLimits(events)`.

- [ ] **Step 1: CSS da série, barras e faixa**

No `<style>`, adicionar:

```css
.usage-section-title { color: var(--muted); font-size: 0.8rem; margin: 16px 0 6px; }
.model-row { display: flex; align-items: center; gap: 8px; font-size: 0.82rem; margin: 2px 0; }
.model-row .name { width: 180px; color: var(--fg); }
.model-row .bar { height: 10px; background: var(--accent, #4a90d9); border-radius: 3px; }
.rl-event { font-size: 0.82rem; color: var(--warn, #d0a000); margin: 2px 0; }
.rl-event .when { color: var(--muted); }
```

- [ ] **Step 2: Render da série diária (SVG à mão), por-modelo e eventos**

No `<script>`, adicionar as três funções:

```js
function renderModelBreakdown(byModel) {
  const rows = Object.entries(byModel || {})
    .map(([m, buckets]) => [m, sumTokens({ x: buckets })])
    .sort((a, b) => b[1] - a[1]);
  const max = rows.length ? rows[0][1] : 0;
  return rows.map(([m, t]) =>
    `<div class="model-row"><span class="name">${esc(m.replace("claude-", ""))}</span>` +
    `<span class="bar" style="width:${max ? Math.max(2, t / max * 320) : 2}px"></span>` +
    `<span class="num">${fmtTokens(t)}</span></div>`).join("");
}

function renderDailySeries(daily) {
  if (!daily.length) return '<div class="empty-note">sem atividade nos últimos 30 dias</div>';
  const vals = daily.map(d => sumTokens(d.byModel));
  const max = Math.max(...vals, 1);
  const w = 640, h = 120, bw = Math.max(2, w / daily.length - 2);
  const bars = daily.map((d, i) => {
    const bh = sumTokens(d.byModel) / max * h;
    const x = i * (w / daily.length);
    return `<rect x="${x.toFixed(1)}" y="${(h - bh).toFixed(1)}" width="${bw.toFixed(1)}" ` +
      `height="${bh.toFixed(1)}" fill="var(--accent,#4a90d9)"><title>${esc(d.date)}: ` +
      `${fmtTokens(sumTokens(d.byModel))} · ${fmtUsd(d.cost)}</title></rect>`;
  }).join("");
  return `<svg viewBox="0 0 ${w} ${h}" width="100%" height="${h}" preserveAspectRatio="none">${bars}</svg>`;
}

function renderRateLimits(events) {
  if (!events || !events.length) return '<div class="empty-note">nenhum teto de sessão atingido no histórico retido</div>';
  return events.map(e =>
    `<div class="rl-event"><span class="when">${esc(new Date(e.ts).toLocaleString())}</span> — ` +
    `${esc(e.text || "limite de sessão")}</div>`).join("");
}
```

- [ ] **Step 3: Montar o corpo da aba em `renderUsage`**

Estender `renderUsage(u)` (da Task 9), acrescentando ao final, antes de fechar a função:

```js
  document.getElementById("usageBody").innerHTML =
    '<div class="usage-section-title">série diária (30d, tokens/dia)</div>'
    + renderDailySeries(u.daily)
    + '<div class="usage-section-title">acumulado por modelo</div>'
    + renderModelBreakdown(u.allTime.byModel)
    + '<div class="usage-section-title">tetos de sessão atingidos</div>'
    + renderRateLimits(u.rateLimits);
```

- [ ] **Step 4: Verificação manual**

Run: `node claude/ctx-dash.js --port 4791`.
No browser, aba **Uso**: conferir (a) a série diária como barras com tooltip por dia (data · tokens · $); (b) as barras por-modelo ordenadas; (c) a faixa de eventos — se houver 429 no histórico, aparece "\<data\> — You've hit your session limit …". Passar o mouse nas barras mostra o `<title>`.

- [ ] **Step 5: Rodar a suíte inteira (garante que nada de lib/servidor regrediu)**

Run: `node --test` (sem argumento, da raiz do repo — descoberta recursiva automática)
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add claude/ctx-dash.html
git commit -m "feat(ctx-dash): série diária 30d, quebra por-modelo e faixa de tetos de sessão"
```

---

## Self-Review

**Cobertura do spec (seção → task):**
- Escopo "uso + eventos, sem % do plano" → Tasks 5–7, 10; nenhuma task computa % de plano. ✔
- 4 períodos (5h/7d/30d-diário/acumulado) → Task 5 (buckets) + Tasks 9/10 (UI). ✔
- Aba dedicada Sessões↔Uso → Task 9. ✔
- Abordagem A (ao vivo + cache mtime) → `usageEvents`/`rateLimitEvents` cacheados (Tasks 2/4); `/api/usage` assíncrono + invalidação (Task 8). ✔
- E1 subagents → Task 6. ✔
- E2 rótulo "retido desde" → Task 9 (tile acumulado usa `oldestTs`). ✔
- E3 rótulo "últimas 5h (móvel)" / "últimos 7 dias" → Task 9. ✔
- E4 filtro de sintéticas → Task 1 (sessionMetrics) + Task 2 (usageEvents). ✔
- E5 cache pré-bucketado / perf SSE → `usageEvents` por-arquivo cacheado por mtime; re-agregação soma arrays cacheados; `/api/usage` invalida só no evento (Task 8). ✔ (persistência em disco fica fora de escopo — YAGNI.)
- E6 home-only → `homeProjectFiles` (Task 5). ✔
- E7 preço do Sonnet → Task 3. ✔
- Regra de verdade ($ parcial) → `fmtUsd`/tile "parcial" (Task 9); costOf reutilizado. ✔
- Verificação (testes unit + endpoint + cross-check + UI manual) → Tasks 1–8 (testes), 9–10 (manual). ✔

**Nota sobre cross-check `stats-cache.json`:** o spec pede conferir totais contra ele como *sanidade*. Não é automatizável (defasado/só-tokens) — fica como passo manual opcional na verificação da Task 10, não como teste. Registrado aqui para não parecer lacuna.

**Placeholder scan:** o único `<…>` do plano é o preço do Sonnet (Task 3), que é **requisito de verificação na fonte**, não placeholder de conveniência — o teste valida estrutura (partial=false, usd>0) sem número inventado. Demais steps têm código completo. ✔

**Consistência de tipos:** `byModel` tem o mesmo shape (`{model:{short|long:{input,output,cacheRead,cacheCreation5m,cacheCreation1h}}}`) em `sessionMetrics`, `addEventToByModel`, `costOf` e no consumo da UI (`sumTokens`). `usageEvents` retorna `{ts,model,input,output,cacheRead,cc5m,cc1h}` consumido igual em Tasks 5/6. `aggregateUsage` retorna o mesmo objeto consumido por `/api/usage` (Task 8) e `renderUsage` (Tasks 9/10). ✔
