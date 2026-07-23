const test = require("node:test");
const assert = require("node:assert");
const path = require("node:path");
const lib = require("../ctx-lib.js");

const FILE = path.join(__dirname, "fixtures", "home", ".claude", "projects",
  "-fake-proj", "aaaaaaaa-0000-0000-0000-000000000001.jsonl");
// Fora da árvore fixtures/home/.claude/projects: indexAll() varre TODOS os
// subdiretórios de projeto sob essa raiz, então qualquer lugar dentro dela
// vazaria para o golden snapshot de render.test.js (Task 1), inflando a
// contagem de sessões e quebrando aquele teste. sessionMetrics() lê por
// caminho direto — não depende de estar sob .claude/projects.
const FILE_BUCKETS = path.join(__dirname, "fixtures", "bucket-split",
  "bbbbbbbb-0000-0000-0000-000000000002.jsonl");
const FILE_TWO_MODELS = path.join(__dirname, "fixtures", "two-models",
  "cccccccc-0000-0000-0000-000000000003.jsonl");
const FILE_SYNTH = path.join(__dirname, "fixtures", "synthetic",
  "dddddddd-0000-0000-0000-000000000004.jsonl");
const FILE_ZERO = path.join(__dirname, "fixtures", "zero-usage",
  "eeeeeeee-0000-0000-0000-000000000005.jsonl");

test("sessionMetrics deriva contexto, turnos, cache hit e modo", () => {
  const m = lib.sessionMetrics(FILE);
  assert.strictEqual(m.ctx, 50000);
  assert.strictEqual(m.window, 200000);
  assert.strictEqual(m.turns, 1);
  assert.strictEqual(m.model, "opus-4-8");
  assert.strictEqual(m.permissionMode, "auto");
  assert.strictEqual(m.gitBranch, "main");
  assert.strictEqual(m.totals.output, 100);
  // cacheRead 49990 / (10 + 49990 + 0) = 99.98%
  assert.ok(Math.abs(m.cacheHitPct - 99.98) < 0.01);
  // turno único, total 50000 <=200000 → bucket short
  assert.strictEqual(m.byModel["claude-opus-4-8"].short.output, 100);
  assert.strictEqual(m.byModel["claude-opus-4-8"].long, undefined);
});

test("sessionMetrics separa buckets short/long e TTL de cache write por modelo", () => {
  const m = lib.sessionMetrics(FILE_BUCKETS);
  const b = m.byModel["claude-opus-4-8"];
  assert.strictEqual(b.short.input, 100);
  assert.strictEqual(b.short.cacheCreation5m, 200);
  assert.strictEqual(b.short.cacheCreation1h, 100);
  assert.strictEqual(b.long.input, 50);
  assert.strictEqual(b.long.cacheRead, 250000);
  assert.strictEqual(b.long.cacheCreation5m, 0);
});

test("sessionMetrics.byModel acumula em chaves separadas quando o transcript troca de modelo", () => {
  const m = lib.sessionMetrics(FILE_TWO_MODELS);
  assert.deepStrictEqual(Object.keys(m.byModel).sort(),
    ["claude-haiku-4-5-20251001", "claude-opus-4-8"]);
  assert.strictEqual(m.byModel["claude-opus-4-8"].short.input, 100);
  assert.strictEqual(m.byModel["claude-opus-4-8"].short.output, 50);
  assert.strictEqual(m.byModel["claude-haiku-4-5-20251001"].short.input, 200);
  assert.strictEqual(m.byModel["claude-haiku-4-5-20251001"].short.output, 80);
});

test("sessionMetrics ignora mensagens sintéticas de erro 429 (E4)", () => {
  const m = lib.sessionMetrics(FILE_SYNTH);
  assert.deepStrictEqual(Object.keys(m.byModel), ["claude-opus-4-8"]);
  assert.strictEqual(m.byModel["<synthetic>"], undefined);
  assert.strictEqual(m.totals.output, 50);       // só o turno real conta
  assert.strictEqual(m.turns, 1);                // stub sintético não conta como turno
});

test("sessionMetrics ignora turno real com usage integralmente zero (E4)", () => {
  // A fixture tem o turno real PRIMEIRO e a linha zerada POR ÚLTIMO — o caso
  // perigoso: sem o filtro, "último turno vence" zeraria m.ctx no card.
  const m = lib.sessionMetrics(FILE_ZERO);
  assert.strictEqual(m.ctx, 100);                // linha zerada final não zera o contexto
  assert.strictEqual(m.turns, 1);                // stub zerado não conta como turno
  assert.strictEqual(m.totals.output, 50);
  assert.deepStrictEqual(Object.keys(m.byModel), ["claude-opus-4-8"]);
});
