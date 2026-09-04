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

test('POST run: scenario su localhost irraggiungibile → 409 con elenco pagine', async () => {
  const cfg = await (await api('/api/projects/sito-test')).json();
  cfg.scenarios = [
    { label: 'Home', url: 'http://demo/' },
    { label: 'Locale', url: 'http://127.0.0.1:1/pagina' }, // porta 1: nessuno in ascolto
  ];
  await api('/api/projects/sito-test', { method: 'PUT', body: JSON.stringify(cfg) });

  const res = await api('/api/projects/sito-test/runs', {
    method: 'POST',
    body: JSON.stringify({ command: 'test' }),
  });
  assert.strictEqual(res.status, 409);
  const body = await res.json();
  assert.strictEqual(body.code, 'LOCALHOST_UNREACHABLE');
  assert.deepStrictEqual(body.affected, [{ label: 'Locale', url: 'http://127.0.0.1:1/pagina' }]);

  // Ripristina lo stato lasciato da "PUT valida aggiorna la config", da cui
  // dipendono i test successivi (scenario "Home").
  cfg.scenarios = [{ label: 'Home', url: 'http://demo/', hideSelectors: ['.slider'] }];
  await api('/api/projects/sito-test', { method: 'PUT', body: JSON.stringify(cfg) });
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

test('POST /api/runs/:id/cancel → 404 su id sconosciuto', async () => {
  const res = await api('/api/runs/id-inventato/cancel', { method: 'POST' });
  assert.strictEqual(res.status, 404);
});

test('POST /api/runs/:id/cancel interrompe un run in corso', async () => {
  // Server isolato con un comando lento: quello condiviso ('echo') finisce
  // troppo in fretta per catturare lo stato 'running'.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vrt-srv-cancel-'));
  fs.mkdirSync(path.join(dir, 'projects', 'demo'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'projects', 'demo', 'backstop.json'), '{}');
  const sleepScript = path.join(dir, 'sleep-cmd.sh');
  fs.writeFileSync(sleepScript, '#!/bin/sh\nsleep 30\n');
  fs.chmodSync(sleepScript, 0o755);

  const runner = createRunner({ dataDir: dir, backstopCmd: sleepScript });
  const app = createApp({ dataDir: dir, runner });
  const srv = app.listen(0, '127.0.0.1');
  await new Promise((r) => srv.once('listening', r));
  const localBase = `http://127.0.0.1:${srv.address().port}`;
  const local = (p, opts) => fetch(localBase + p, { headers: { 'Content-Type': 'application/json' }, ...opts });

  try {
    const { run } = await (await local('/api/projects/demo/runs', {
      method: 'POST',
      body: JSON.stringify({ command: 'test' }),
    })).json();

    let running;
    for (let i = 0; i < 100; i++) {
      running = await (await local(`/api/runs/${run.id}`)).json();
      if (running.status === 'running') break;
      await new Promise((r) => setTimeout(r, 20));
    }
    assert.strictEqual(running.status, 'running');

    const cancelRes = await local(`/api/runs/${run.id}/cancel`, { method: 'POST' });
    assert.strictEqual(cancelRes.status, 200);

    let done;
    for (let i = 0; i < 200; i++) {
      done = await (await local(`/api/runs/${run.id}`)).json();
      if (done.status === 'cancelled') break;
      await new Promise((r) => setTimeout(r, 20));
    }
    assert.strictEqual(done.status, 'cancelled');
  } finally {
    srv.close();
  }
});

test('GET /api/projects/:slug/result senza report → 404', async () => {
  const res = await api('/api/projects/sito-test/result');
  assert.strictEqual(res.status, 404);
});

test('POST run approve senza report → 404', async () => {
  const res = await api('/api/projects/sito-test/runs', {
    method: 'POST',
    body: JSON.stringify({ command: 'approve' }),
  });
  assert.strictEqual(res.status, 404);
});

test("POST run approve promuove solo la pagina indicata", async () => {
  const data = path.join(dataDir, 'projects', 'sito-test', 'backstop_data');
  const reportDir = path.join(data, 'html_report');
  const testDir = path.join(data, 'bitmaps_test', '20260720-211218');
  const refDir = path.join(data, 'bitmaps_reference');
  for (const d of [reportDir, testDir, refDir]) fs.mkdirSync(d, { recursive: true });

  const pair = (label, fileName) => ({
    pair: {
      reference: `../bitmaps_reference/${fileName}`,
      test: `../bitmaps_test/20260720-211218/${fileName}`,
      fileName,
      label,
      viewportLabel: 'mobile',
      diff: { misMatchPercentage: '7.81' },
    },
    status: 'fail',
  });
  const tests = [
    pair('Home', 'sito_Home_0_document_0_mobile.png'),
    pair('About', 'sito_About_0_document_0_mobile.png'),
  ];
  for (const t of tests) {
    fs.writeFileSync(path.join(testDir, t.pair.fileName), 'nuovo');
    fs.writeFileSync(path.join(refDir, t.pair.fileName), 'vecchio');
  }
  fs.writeFileSync(path.join(reportDir, 'config.js'), `report(${JSON.stringify({ tests })});`);

  const res = await api('/api/projects/sito-test/runs', {
    method: 'POST',
    body: JSON.stringify({ command: 'approve', scenarioLabel: 'Home' }),
  });
  assert.strictEqual(res.status, 202);
  const { run } = await res.json();
  assert.strictEqual(run.status, 'success');
  assert.strictEqual(run.filter, 'Home');

  const read = (name) => fs.readFileSync(path.join(refDir, name), 'utf8');
  assert.strictEqual(read('sito_Home_0_document_0_mobile.png'), 'nuovo');
  assert.strictEqual(read('sito_About_0_document_0_mobile.png'), 'vecchio', 'About non era nel filtro');

  const text = await (await api(`/api/runs/${run.id}/log`)).text();
  assert.match(text, /sito_Home_0_document_0_mobile\.png/);
  assert.match(text, /event: status/);
});

function writeReport(slug) {
  const dir = path.join(dataDir, 'projects', slug, 'backstop_data', 'html_report');
  fs.mkdirSync(dir, { recursive: true });
  const tests = [
    { pair: { label: 'Home', viewportLabel: 'mobile', diff: { misMatchPercentage: '7.81' } }, status: 'fail' },
  ];
  fs.writeFileSync(path.join(dir, 'config.js'), `report(${JSON.stringify({ tests })});`);
  return dir;
}

test("POST run reference azzera l'esito dell'ultimo test", async () => {
  const reportDir = writeReport('sito-test');
  assert.strictEqual((await api('/api/projects/sito-test/result')).status, 200);

  const res = await api('/api/projects/sito-test/runs', {
    method: 'POST',
    body: JSON.stringify({ command: 'reference' }),
  });
  assert.strictEqual(res.status, 202);

  // Già sparito quando arriva la risposta: gli scenari possono essere
  // cambiati e il confronto era contro la baseline che stiamo sostituendo.
  assert.strictEqual(fs.existsSync(reportDir), false);
  assert.strictEqual((await api('/api/projects/sito-test/result')).status, 404);

  const list = await (await api('/api/projects')).json();
  assert.strictEqual(list.find((p) => p.slug === 'sito-test').lastResult, null);

  await waitRunDone((await res.json()).run.id);
});

test('POST run reference rifiutato (409) non tocca il report', async () => {
  writeReport('sito-test');
  const cfg = await (await api('/api/projects/sito-test')).json();
  await api('/api/projects/sito-test', {
    method: 'PUT',
    body: JSON.stringify({ ...cfg, scenarios: [{ label: 'Locale', url: 'http://127.0.0.1:1/pagina' }] }),
  });

  const res = await api('/api/projects/sito-test/runs', {
    method: 'POST',
    body: JSON.stringify({ command: 'reference' }),
  });
  assert.strictEqual(res.status, 409);
  assert.strictEqual((await api('/api/projects/sito-test/result')).status, 200, 'la baseline non è stata rigenerata');

  await api('/api/projects/sito-test', { method: 'PUT', body: JSON.stringify(cfg) });
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
