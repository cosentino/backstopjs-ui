const { test } = require('node:test');
const assert = require('node:assert');
const os = require('node:os');
const fs = require('node:fs');
const path = require('node:path');

const { createRunner, escapeFilter } = require('../lib/runner');

function waitForStatus(runner, id, statuses, timeoutMs = 5000) {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('timeout attesa run ' + id)), timeoutMs);
    const check = () => {
      const run = runner.get(id);
      if (run && statuses.includes(run.status)) {
        clearTimeout(t);
        resolve(run);
        return true;
      }
      return false;
    };
    if (check()) return;
    const unsub = runner.subscribe(id, () => {
      if (check()) unsub();
    });
  });
}

function tempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'vrt-run-'));
}

test('escapeFilter: regex ancorata e con escape', () => {
  assert.strictEqual(escapeFilter('Home'), '^Home$');
  assert.strictEqual(escapeFilter('Home (v2)'), '^Home \\(v2\\)$');
  assert.strictEqual(escapeFilter('a.b*c'), '^a\\.b\\*c$');
});

test('run con successo: log catturato, args corretti', async () => {
  const runner = createRunner({ dataDir: tempDir(), backstopCmd: 'echo' });
  const run = runner.enqueue({ project: 'demo', command: 'test', filter: '^Home$' });
  assert.strictEqual(run.status, 'queued');

  const done = await waitForStatus(runner, run.id, ['success', 'failed']);
  assert.strictEqual(done.status, 'success');
  assert.strictEqual(done.exitCode, 0);
  assert.match(done.log, /test --config=projects\/demo\/backstop\.json --filter=\^Home\$/);
  assert.ok(done.startedAt && done.endedAt);
});

test('run fallito: status failed con exitCode', async () => {
  const runner = createRunner({ dataDir: tempDir(), backstopCmd: 'false' });
  const run = runner.enqueue({ project: 'demo', command: 'test' });
  const done = await waitForStatus(runner, run.id, ['success', 'failed']);
  assert.strictEqual(done.status, 'failed');
  assert.notStrictEqual(done.exitCode, 0);
});

test('esecuzione sequenziale: la seconda parte dopo la prima', async () => {
  const runner = createRunner({ dataDir: tempDir(), backstopCmd: 'echo' });
  const r1 = runner.enqueue({ project: 'a', command: 'test' });
  const r2 = runner.enqueue({ project: 'b', command: 'test' });
  const d2 = await waitForStatus(runner, r2.id, ['success', 'failed']);
  const d1 = runner.get(r1.id);
  assert.ok(new Date(d2.startedAt) >= new Date(d1.endedAt), 'r2 deve partire dopo la fine di r1');
});

test('subscribe: riceve eventi log e status', async () => {
  const runner = createRunner({ dataDir: tempDir(), backstopCmd: 'echo' });
  const events = [];
  const run = runner.enqueue({ project: 'demo', command: 'reference' });
  runner.subscribe(run.id, (ev) => events.push(ev));
  await waitForStatus(runner, run.id, ['success']);
  // Lascia svuotare la coda degli eventi
  await new Promise((r) => setTimeout(r, 50));
  assert.ok(events.some((e) => e.type === 'log'), 'manca evento log');
  assert.ok(events.some((e) => e.type === 'status' && e.run.status === 'success'), 'manca evento status');
});

test('list: più recenti prima, senza log', async () => {
  const runner = createRunner({ dataDir: tempDir(), backstopCmd: 'echo' });
  const r1 = runner.enqueue({ project: 'a', command: 'test' });
  const r2 = runner.enqueue({ project: 'b', command: 'test' });
  await waitForStatus(runner, r2.id, ['success']);
  const list = runner.list();
  assert.strictEqual(list[0].id, r2.id);
  assert.strictEqual(list[1].id, r1.id);
  assert.strictEqual(list[0].log, undefined);
});
