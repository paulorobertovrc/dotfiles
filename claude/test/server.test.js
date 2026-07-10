const test = require("node:test");
const assert = require("node:assert");
const path = require("node:path");
const http = require("node:http");
const { buildSnapshot, createServer, listenWithFallback } = require("../ctx-dash.js");

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

test("servidor rejeita Host forjado (403) e aceita Host 127.0.0.1 normal (200) — defesa DNS rebinding", async () => {
  const srv = createServer({ home: HOME, isAlive: () => true });
  await new Promise(r => srv.listen(0, "127.0.0.1", r));
  const port = srv.address().port;

  // fetch (undici) proíbe sobrescrever o header Host — ele é silenciosamente
  // ignorado/realinhado com a URL real, então não simula o ataque. Só o
  // http.request de baixo nível, com setHost:false, consegue de fato mandar
  // um Host arbitrário na requisição — o mesmo vetor que um DNS rebinding
  // exploraria (o browser resolve um domínio atacante para 127.0.0.1, mas o
  // header Host chega com o nome do atacante).
  const evilStatus = await new Promise((resolve, reject) => {
    const req = http.request({
      host: "127.0.0.1", port, path: "/api/sessions", method: "GET",
      setHost: false, headers: { Host: "evil.com" }
    }, res => { res.resume(); resolve(res.statusCode); });
    req.on("error", reject);
    req.end();
  });
  assert.strictEqual(evilStatus, 403);

  // fetch batendo direto em http://127.0.0.1:<porta>/... já envia Host: 127.0.0.1:<porta>
  // por padrão — sem override, exercitando o caminho normal.
  const ok = await fetch(`http://127.0.0.1:${port}/api/sessions`);
  assert.strictEqual(ok.status, 200);

  await new Promise(r => srv.close(r));
});

test("listenWithFallback chama o callback UMA vez, com a porta realmente aberta", async () => {
  // Ocupa uma porta efêmera para forçar o EADDRINUSE.
  const blocker = http.createServer(() => {});
  await new Promise(r => blocker.listen(0, "127.0.0.1", r));
  const busy = blocker.address().port;

  const srv = createServer({ home: HOME, isAlive: () => false });
  const ports = [];
  await new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error("listenWithFallback não chamou o callback")), 3000);
    listenWithFallback(srv, busy, 5, p => { ports.push(p); clearTimeout(t); resolve(); });
  });

  // O bug original: o callback do listen(port, host, cb) fica registrado como
  // listener persistente de "listening", então o retry disparava o callback
  // duas vezes — uma com a porta ocupada (URL errada) e outra com a real.
  assert.deepStrictEqual(ports, [busy + 1], "callback deve rodar 1x, com a porta aberta");
  assert.strictEqual(srv.address().port, busy + 1, "servidor escuta na porta reportada");

  await new Promise(r => srv.close(r));
  await new Promise(r => blocker.close(r));
});
