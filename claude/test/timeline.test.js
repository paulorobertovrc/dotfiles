const test = require("node:test");
const assert = require("node:assert");
const path = require("node:path");
const lib = require("../ctx-lib.js");

const FILE = path.join(__dirname, "fixtures", "home", ".claude", "projects",
  "-fake-proj", "aaaaaaaa-0000-0000-0000-000000000001.jsonl");

test("timeline extrai um ponto por turno de assistant", () => {
  const pts = lib.timeline(FILE);
  assert.strictEqual(pts.length, 1);
  assert.strictEqual(pts[0].ctx, 50000);
  assert.strictEqual(pts[0].compact, false);
});

test("trend calcula tokens/min e ETA", () => {
  const t0 = Date.parse("2026-01-01T00:00:00Z");
  const pts = [
    { ts: t0, ctx: 0 },
    { ts: t0 + 60000, ctx: 10000 }   // +10k em 1 min
  ];
  const r = lib.trend(pts, 200000);
  assert.strictEqual(Math.round(r.tokensPerMin), 10000);
  assert.strictEqual(Math.round(r.etaMinutes), 19);   // (200000-10000)/10000
});

test("trend com contexto estável não projeta ETA", () => {
  const t0 = Date.parse("2026-01-01T00:00:00Z");
  const r = lib.trend([{ ts: t0, ctx: 5000 }, { ts: t0 + 60000, ctx: 5000 }], 200000);
  assert.strictEqual(r.etaMinutes, null);
});

test("costOf retorna null para modelo sem preço verificado", () => {
  assert.strictEqual(lib.costOf({
    "claude-modelo-inexistente": { short: { input: 1, output: 1, cacheRead: 0, cacheCreation5m: 0, cacheCreation1h: 0 } }
  }), null);
});
