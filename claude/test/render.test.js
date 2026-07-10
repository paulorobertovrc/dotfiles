const test = require("node:test");
const assert = require("node:assert");
const path = require("node:path");
const fs = require("node:fs");
const { render } = require("../ctx-watch.js");

const HOME = path.join(__dirname, "fixtures", "home");
const NOW = Date.parse("2026-01-01T00:01:30.000Z");  // 30s após o último turno → "agora"

// procs: [] torna o teste determinístico — sem ele, render() chamaria
// liveProcs() e leria os processos reais da máquina.
const BASE = { home: HOME, now: NOW, watch: false, effortLevel: "", procs: [] };

test("render --all bate exatamente com o golden fixture", () => {
  const out = render({ ...BASE, all: true });
  const golden = fs.readFileSync(
    path.join(__dirname, "fixtures", "golden", "render-all.txt"), "utf8");
  assert.strictEqual(out, golden);
});

test("render sem --all e sem processos vivos retorna vazio", () => {
  const out = render({ ...BASE, all: false });
  assert.match(out, /nenhuma sessão ativa do Claude/);
});
