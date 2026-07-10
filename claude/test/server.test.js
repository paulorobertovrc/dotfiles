const test = require("node:test");
const assert = require("node:assert");
const path = require("node:path");
const { buildSnapshot, createServer } = require("../ctx-dash.js");

const HOME = path.join(__dirname, "fixtures", "home");

test("buildSnapshot inclui a sessão da fixture com métricas e o job", () => {
  const s = buildSnapshot(HOME, { isAlive: () => true });
  const sess = s.sessions.find(x => x.id.startsWith("aaaaaaaa"));
  assert.ok(sess, "sessão da fixture presente");
  assert.strictEqual(sess.ctx, 50000);
  assert.strictEqual(sess.window, 200000);
  assert.strictEqual(sess.permissionMode, "auto");
  assert.strictEqual(s.jobs.length, 1);
});

test("servidor responde /api/sessions com JSON e recusa métodos de escrita", async () => {
  const srv = createServer({ home: HOME, isAlive: () => true });
  await new Promise(r => srv.listen(0, "127.0.0.1", r));
  const port = srv.address().port;

  const res = await fetch(`http://127.0.0.1:${port}/api/sessions`);
  assert.strictEqual(res.status, 200);
  const body = await res.json();
  assert.ok(Array.isArray(body.sessions));

  const post = await fetch(`http://127.0.0.1:${port}/api/sessions`, { method: "POST" });
  assert.strictEqual(post.status, 405);

  await new Promise(r => srv.close(r));
});
