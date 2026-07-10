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

test("srv.close() encerra mesmo com cliente SSE conectado (não trava)", async () => {
  const srv = createServer({ home: HOME, isAlive: () => true });
  await new Promise(r => srv.listen(0, "127.0.0.1", r));
  const port = srv.address().port;

  // Abre uma conexão SSE e a mantém aberta — não consome/espera o body terminar.
  const res = await fetch(`http://127.0.0.1:${port}/api/events`);
  assert.strictEqual(res.status, 200);
  assert.match(res.headers.get("content-type") || "", /text\/event-stream/);

  const closed = await Promise.race([
    new Promise(r => srv.close(() => r(true))),
    new Promise(r => setTimeout(() => r(false), 2000))
  ]);

  assert.strictEqual(closed, true, "srv.close() deve chamar o callback mesmo com SSE aberto, sem travar");

  try { res.body && res.body.cancel && res.body.cancel(); } catch {}
});
