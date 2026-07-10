const test = require("node:test");
const assert = require("node:assert");
const path = require("node:path");
const lib = require("../ctx-lib.js");

const HOME = path.join(__dirname, "fixtures", "home");
const FILE = path.join(HOME, ".claude", "projects", "-fake-proj",
  "aaaaaaaa-0000-0000-0000-000000000001.jsonl");

test("subagentsFor lê jsonl + meta e soma tokens", () => {
  const a = lib.subagentsFor(FILE);
  assert.strictEqual(a.length, 1);
  assert.strictEqual(a[0].agentId, "abc123");
  assert.strictEqual(a[0].agentType, "Explore");
  assert.strictEqual(a[0].model, "haiku-4-5-20251001");
  assert.strictEqual(a[0].tokens.output, 50);
});

test("backgroundJobs lê state.json e extrai o modelo dos respawnFlags", () => {
  const j = lib.backgroundJobs(HOME);
  assert.strictEqual(j.length, 1);
  assert.strictEqual(j[0].state, "done");
  assert.strictEqual(j[0].sessionId, "aaaaaaaa-0000-0000-0000-000000000001");
  assert.strictEqual(j[0].model, "claude-fable-5[1m]");
});

test("workflowsFor tolera ausência de journal", () => {
  assert.deepStrictEqual(lib.workflowsFor(FILE), []);
});
