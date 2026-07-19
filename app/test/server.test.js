const { test, before, after } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { createApp } = require('../server');
const { createRunner } = require('../lib/runner');

let server;
let base;
let dataDir;

function api(pathname, options = {}) {
  return fetch(base + pathname, {
    headers: { 'Content-Type': 'application/json' },
    ...options,
  });
}

async function waitRunDone(id, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const res = await api(`/api/runs/${id}`);
    const run = await res.json();
    if (run.status === 'success' || run.status === 'failed') return run;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error('timeout run ' + id);
}

before(async () => {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vrt-srv-'));
  fs.mkdirSync(path.join(dataDir, 'projects'), { recursive: true });
  const runner = createRunner({ dataDir, backstopCmd: 'echo' });
  const app = createApp({ dataDir, runner });
  server = app.listen(0, '127.0.0.1');
  await new Promise((r) => server.once('listening', r));
  base = `http://127.0.0.1:${server.address().port}`;
});

after(() => server.close());

test('POST /api/projects crea e GET /api/projects elenca', async () => {
  const res = await api('/api/projects', {
    method: 'POST',
    body: JSON.stringify({ name: 'Sito Test' }),
  });
  assert.strictEqual(res.status, 201);
  const { slug } = await res.json();
  assert.strictEqual(slug, 'sito-test');

  const list = await (await api('/api/projects')).json();
  const found = list.find((p) => p.slug === 'sito-test');
  assert.ok(found);
  assert.strictEqual(found.scenarioCount, 0);
  assert.strictEqual(found.lastResult, null);
});

test('POST duplicato → 409 con messaggio', async () => {
  const res = await api('/api/projects', {
    method: 'POST',
    body: JSON.stringify({ name: 'Sito Test' }),
  });
  assert.strictEqual(res.status, 409);
  const body = await res.json();
  assert.ok(body.error);
});

test('PUT config non valida → 400', async () => {
  const cfg = await (await api('/api/projects/sito-test')).json();
  const res = await api('/api/projects/sito-test', {
    method: 'PUT',
    body: JSON.stringify({ ...cfg, viewports: [] }),
  });
  assert.strictEqual(res.status, 400);
});

test('PUT valida aggiorna la config', async () => {
  const cfg = await (await api('/api/projects/sito-test')).json();
  cfg.scenarios = [{ label: 'Home', url: 'http://demo/', hideSelectors: ['.slider'] }];
  const res = await api('/api/projects/sito-test', {
    method: 'PUT',
    body: JSON.stringify(cfg),
  });
  assert.strictEqual(res.status, 200);
  const updated = await res.json();
  assert.strictEqual(updated.scenarios.length, 1);
});

test('POST run: comando fuori allowlist → 400', async () => {
  const res = await api('/api/projects/sito-test/runs', {
    method: 'POST',
    body: JSON.stringify({ command: 'rm -rf /' }),
  });
  assert.strictEqual(res.status, 400);
});

test('POST run test → 202, completa, log via SSE', async () => {
  const res = await api('/api/projects/sito-test/runs', {
    method: 'POST',
    body: JSON.stringify({ command: 'test', scenarioLabel: 'Home' }),
  });
  assert.strictEqual(res.status, 202);
  const { run } = await res.json();
  assert.strictEqual(run.project, 'sito-test');
  assert.strictEqual(run.filter, '^Home$');

  const done = await waitRunDone(run.id);
  assert.strictEqual(done.status, 'success');
  assert.strictEqual(done.log, undefined, 'il log non deve stare nel meta');

  const sse = await api(`/api/runs/${run.id}/log`);
  assert.match(sse.headers.get('content-type'), /text\/event-stream/);
  const text = await sse.text(); // run già concluso: lo stream si chiude dopo il replay
  assert.match(text, /--config=projects\/sito-test\/backstop\.json/);
  assert.match(text, /event: status/);
});

test('POST run su progetto inesistente → 404', async () => {
  const res = await api('/api/projects/fantasma/runs', {
    method: 'POST',
    body: JSON.stringify({ command: 'test' }),
  });
  assert.strictEqual(res.status, 404);
});

test('GET /api/runs/sconosciuto → 404', async () => {
  const res = await api('/api/runs/id-inventato');
  assert.strictEqual(res.status, 404);
});

test('GET /api/projects/:slug/result senza report → 404', async () => {
  const res = await api('/api/projects/sito-test/result');
  assert.strictEqual(res.status, 404);
});

test('DELETE progetto → 204, poi GET → 404', async () => {
  const res = await api('/api/projects/sito-test', { method: 'DELETE' });
  assert.strictEqual(res.status, 204);
  const res2 = await api('/api/projects/sito-test');
  assert.strictEqual(res2.status, 404);
});

test('POST /api/crawl con url non valida → 400', async () => {
  const res = await api('/api/crawl', {
    method: 'POST',
    body: JSON.stringify({ url: 'non-una-url' }),
  });
  assert.strictEqual(res.status, 400);
});

test('la UI statica è servita su /', async () => {
  const res = await api('/');
  assert.strictEqual(res.status, 200);
  assert.match(res.headers.get('content-type'), /text\/html/);
});
