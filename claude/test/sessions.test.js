const test = require("node:test");
const assert = require("node:assert");
const path = require("node:path");
const lib = require("../ctx-lib.js");

const HOME = path.join(__dirname, "fixtures", "home");

test("liveSessions lê o registro e aplica o guard de procStart", () => {
  const alive = lib.liveSessions(HOME, { isAlive: (pid, ps) => pid === 999999 && ps === "41448" });
  assert.strictEqual(alive.length, 1);
  assert.strictEqual(alive[0].sessionId, "aaaaaaaa-0000-0000-0000-000000000001");
  assert.strictEqual(alive[0].name, "fake-proj-1");
});

test("liveSessions descarta órfão quando procStart não bate (PID reusado)", () => {
  const alive = lib.liveSessions(HOME, { isAlive: (pid, ps) => ps === "OUTRO" });
  assert.strictEqual(alive.length, 0);
});
