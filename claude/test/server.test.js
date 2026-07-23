const test = require("node:test");
const assert = require("node:assert");
const path = require("node:path");
const fs = require("node:fs");
const http = require("node:http");
const { buildSnapshot, createServer, listenWithFallback } = require("../ctx-dash.js");
const lib = require("../ctx-lib.js");

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

test("/api/usage computa assíncrono e depois serve o agregado", async () => {
  const srv = createServer({ home: HOME, isAlive: () => true });
  await new Promise(r => srv.listen(0, "127.0.0.1", r));
  const port = srv.address().port;

  const first = await (await fetch(`http://127.0.0.1:${port}/api/usage`)).json();
  assert.strictEqual(first.computing, true);

  // Espera o compute (setImmediate) concluir, com poll curto.
  let data = null;
  for (let i = 0; i < 50 && !data; i++) {
    const d = await (await fetch(`http://127.0.0.1:${port}/api/usage`)).json();
    if (!d.computing) data = d; else await new Promise(r => setTimeout(r, 20));
  }
  assert.ok(data, "usage deve ficar pronto");
  assert.ok(data.allTime && data.win5h && Array.isArray(data.daily));

  await new Promise(r => srv.close(r));
});

test("/api/usage não dispara aggregateUsage duas vezes sob requests concorrentes", async () => {
  // Monkey-patch: lib.aggregateUsage é acessada por propriedade dentro de
  // computeUsage (não desestruturada no require de ctx-dash.js), então
  // substituir a propriedade no módulo compartilhado é visível lá também.
  const original = lib.aggregateUsage;
  let calls = 0;
  lib.aggregateUsage = (...args) => { calls++; return original(...args); };
  try {
    const srv = createServer({ home: HOME, isAlive: () => true });
    await new Promise(r => srv.listen(0, "127.0.0.1", r));
    const port = srv.address().port;

    // Dispara 3 requests concorrentes antes que o primeiro compute (setImmediate)
    // tenha chance de resolver — nenhuma delas deve agendar um segundo compute.
    await Promise.all([
      fetch(`http://127.0.0.1:${port}/api/usage`),
      fetch(`http://127.0.0.1:${port}/api/usage`),
      fetch(`http://127.0.0.1:${port}/api/usage`)
    ]);

    // Espera o compute concluir antes de fechar, para não deixar timers soltos.
    let data = null;
    for (let i = 0; i < 50 && !data; i++) {
      const d = await (await fetch(`http://127.0.0.1:${port}/api/usage`)).json();
      if (!d.computing) data = d; else await new Promise(r => setTimeout(r, 20));
    }
    assert.ok(data, "usage deve ficar pronto");
    assert.strictEqual(calls, 1, "aggregateUsage deve rodar só uma vez mesmo sob requests concorrentes");

    await new Promise(r => srv.close(r));
  } finally {
    lib.aggregateUsage = original;
  }
});

test("invalidação por fs.watch limpa o cache sem recompute eager — só o próximo /api/usage recomputa", async () => {
  const original = lib.aggregateUsage;
  let calls = 0;
  lib.aggregateUsage = (...args) => { calls++; return original(...args); };
  const probe = path.join(HOME, ".claude", "projects", "-fake-proj", `.___probe-${process.pid}.tmp`);
  try {
    const srv = createServer({ home: HOME, isAlive: () => true });
    await new Promise(r => srv.listen(0, "127.0.0.1", r));
    const port = srv.address().port;

    // Aquece o cache.
    let data = null;
    for (let i = 0; i < 50 && !data; i++) {
      const d = await (await fetch(`http://127.0.0.1:${port}/api/usage`)).json();
      if (!d.computing) data = d; else await new Promise(r => setTimeout(r, 20));
    }
    assert.ok(data, "cache deve aquecer antes do teste de invalidação");
    assert.strictEqual(calls, 1, "um compute para aquecer");

    // Segunda leitura: serve do cache, sem novo compute.
    const cached = await (await fetch(`http://127.0.0.1:${port}/api/usage`)).json();
    assert.strictEqual(cached.computing, undefined, "segunda leitura serve do cache (sem flag computing)");
    assert.strictEqual(calls, 1, "leitura do cache não recomputa");

    // Dispara o fs.watch real tocando um arquivo dentro de um diretório observado
    // (mesmo mecanismo de invalidação usado em produção — não é um seam de teste).
    fs.writeFileSync(probe, "x");
    // Passa do debounce de 200ms do notify, com folga.
    await new Promise(r => setTimeout(r, 400));

    // A invalidação por si só — sem nenhum GET /api/usage nesse meio-tempo — NÃO
    // deve ter disparado um novo compute; onWatch só limpa o cache.
    assert.strictEqual(calls, 1, "onWatch deve só invalidar o cache, sem recompute eager");

    // O PRÓXIMO /api/usage é quem dispara o compute fresco.
    const afterInvalidate = await (await fetch(`http://127.0.0.1:${port}/api/usage`)).json();
    assert.strictEqual(afterInvalidate.computing, true, "cache invalidado -> próxima leitura recomputa do zero, não serve stale");

    let fresh = null;
    for (let i = 0; i < 50 && !fresh; i++) {
      const d = await (await fetch(`http://127.0.0.1:${port}/api/usage`)).json();
      if (!d.computing) fresh = d; else await new Promise(r => setTimeout(r, 20));
    }
    assert.ok(fresh, "novo compute deve terminar");
    assert.strictEqual(calls, 2, "exatamente um novo compute após a invalidação");

    await new Promise(r => srv.close(r));
  } finally {
    lib.aggregateUsage = original;
    try { fs.unlinkSync(probe); } catch {}
  }
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
