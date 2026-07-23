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
