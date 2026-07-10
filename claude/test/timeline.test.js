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

test("costOf soma só o modelo precificado e marca partial quando há um modelo desconhecido junto", () => {
  // claude-opus-4-8 short: input $5/1M — 1M tokens de input, resto zero => usd = 5.
  // claude-modelo-inexistente não tem preço em PRICES: contribui 0 e força partial=true.
  const r = lib.costOf({
    "claude-opus-4-8": {
      short: { input: 1000000, output: 0, cacheRead: 0, cacheCreation5m: 0, cacheCreation1h: 0 }
    },
    "claude-modelo-inexistente": {
      short: { input: 1000000, output: 1, cacheRead: 0, cacheCreation5m: 0, cacheCreation1h: 0 }
    }
  });
  assert.ok(r, "não deve ser null: há ao menos um modelo precificado");
  assert.strictEqual(r.usd, 5);
  assert.strictEqual(r.partial, true);
});

test("costOf usa o preço short como fallback para bucket long sem preço confirmado e marca partial", () => {
  // claude-haiku-4-5-20251001 não tem bucket "long" em PRICES (janela 200K, sem variante 1M).
  // Bucket long populado com 1M tokens de input deve cair no fallback do preço short: $1/1M.
  const r = lib.costOf({
    "claude-haiku-4-5-20251001": {
      long: { input: 1000000, output: 0, cacheRead: 0, cacheCreation5m: 0, cacheCreation1h: 0 }
    }
  });
  assert.ok(r, "não deve ser null: preço short existe como fallback");
  assert.strictEqual(r.usd, 1);
  assert.strictEqual(r.partial, true);
});
