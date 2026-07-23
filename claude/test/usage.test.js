const test = require("node:test");
const assert = require("node:assert");
const path = require("node:path");
const lib = require("../ctx-lib.js");

const FILE_TWO = path.join(__dirname, "fixtures", "two-models",
  "cccccccc-0000-0000-0000-000000000003.jsonl");
const FILE_SYNTH = path.join(__dirname, "fixtures", "synthetic",
  "dddddddd-0000-0000-0000-000000000004.jsonl");
const FILE_ZERO = path.join(__dirname, "fixtures", "zero-usage",
  "eeeeeeee-0000-0000-0000-000000000005.jsonl");
const FILE_RL = path.join(__dirname, "fixtures", "ratelimit",
  "eeeeeeee-0000-0000-0000-000000000005.jsonl");

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

test("usageEvents filtra turno com usage integralmente zero de um modelo real, mantendo o turno irmão não-zero", () => {
  const evs = lib.usageEvents(FILE_ZERO);
  assert.strictEqual(evs.length, 1);
  assert.strictEqual(evs[0].model, "claude-opus-4-8");
  assert.strictEqual(evs[0].input, 100);
  assert.strictEqual(evs[0].output, 50);
});

test("rateLimitEvents captura só o teto de sessão, ignora rate_limit_error cru", () => {
  const evs = lib.rateLimitEvents(FILE_RL);
  assert.strictEqual(evs.length, 1);
  assert.match(evs[0].text, /session limit/);
  assert.match(evs[0].text, /resets 12:30pm/);
  assert.ok(evs[0].ts > 0);
});

test("PRICES cobre Sonnet 5 → costOf não marca parcial para Sonnet (E7)", () => {
  const byModel = { "claude-sonnet-5": { short:
    { input: 1e6, output: 0, cacheRead: 0, cacheCreation5m: 0, cacheCreation1h: 0 } } };
  const c = lib.costOf(byModel);
  assert.ok(c && c.partial === false, "Sonnet deve ter preço verificado");
  assert.ok(c.usd > 0, "custo do Sonnet deve ser > 0");
});
