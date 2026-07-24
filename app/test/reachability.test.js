const { test } = require('node:test');
const assert = require('node:assert');
const http = require('node:http');

const { findUnreachableLocalScenarios } = require('../lib/reachability');

// Apre un server, ne recupera la porta e lo chiude subito: la porta resta
// libera ma garantita "nessuno in ascolto" (connessione rifiutata, non un
// semplice timeout), a differenza di una porta scelta a caso.
async function closedLocalPort() {
  const server = http.createServer();
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;
  await new Promise((r) => server.close(r));
  return port;
}

test('scenari con hostname non locale: mai considerati, nessuna verifica di rete', async () => {
  const scenarios = [{ label: 'Home', url: 'https://esempio.test/pagina' }];
  const affected = await findUnreachableLocalScenarios(scenarios);
  assert.deepStrictEqual(affected, []);
});

test('scenario con url non valida: ignorato', async () => {
  const scenarios = [{ label: 'Rotto', url: 'non-una-url' }];
  const affected = await findUnreachableLocalScenarios(scenarios);
  assert.deepStrictEqual(affected, []);
});

test('localhost raggiungibile: non segnalato', async () => {
  const server = http.createServer((req, res) => res.end('ok'));
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;
  try {
    const scenarios = [{ label: 'Home', url: `http://127.0.0.1:${port}/` }];
    const affected = await findUnreachableLocalScenarios(scenarios);
    assert.deepStrictEqual(affected, []);
  } finally {
    server.close();
  }
});

test('localhost non raggiungibile: segnalato', async () => {
  const port = await closedLocalPort();
  const scenarios = [{ label: 'Home', url: `http://127.0.0.1:${port}/pagina` }];
  const affected = await findUnreachableLocalScenarios(scenarios);
  assert.strictEqual(affected.length, 1);
  assert.strictEqual(affected[0].label, 'Home');
});

test('stessa coppia host:porta verificata una sola volta', async () => {
  const port = await closedLocalPort();
  const scenarios = [
    { label: 'Home', url: `http://localhost:${port}/a` },
    { label: 'About', url: `http://localhost:${port}/b` },
  ];
  const affected = await findUnreachableLocalScenarios(scenarios);
  assert.strictEqual(affected.length, 2);
  assert.deepStrictEqual(affected.map((s) => s.label), ['Home', 'About']);
});
