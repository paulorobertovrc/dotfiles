const test = require("node:test");
const assert = require("node:assert");
const path = require("node:path");
const lib = require("../ctx-lib.js");

// Fixture própria, fora de fixtures/home — a lição da colisão de fixtures:
// nada novo sob fixtures/home/.claude/projects, para não vazar no indexAll().
const HOME = path.join(__dirname, "fixtures", "settings-home");

test("readSettings lê model e effortLevel do settings.json", () => {
  const s = lib.readSettings(HOME);
  assert.strictEqual(s.model, "opus[1m]");
  assert.strictEqual(s.effortLevel, "xhigh");
});

test("readSettings devolve strings vazias quando o settings.json não existe", () => {
  const s = lib.readSettings(path.join(__dirname, "fixtures", "home"));
  assert.strictEqual(s.model, "");
  assert.strictEqual(s.effortLevel, "");
});

test("readSettings devolve strings vazias em JSON corrompido", () => {
  const s = lib.readSettings("/caminho/que/nao/existe/em/lugar/nenhum");
  assert.deepStrictEqual(s, { model: "", effortLevel: "" });
});
