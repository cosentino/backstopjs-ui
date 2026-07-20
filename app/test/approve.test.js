const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { approveLastTest } = require('../lib/approve');

const TS = '20260720-211218';

function pair(label, fileName, status, testDir = TS) {
  return {
    pair: {
      reference: `../bitmaps_reference/${fileName}`,
      test: `../bitmaps_test/${testDir}/${fileName}`,
      fileName,
      label,
      viewportLabel: 'mobile',
      diff: { misMatchPercentage: status === 'fail' ? '7.81' : '0.00' },
    },
    status,
  };
}

// Ricrea la struttura che BackstopJS lascia su disco dopo un test.
function fixture(tests, { withBitmaps = true } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vrt-appr-'));
  const data = path.join(dir, 'projects', 'x', 'backstop_data');
  const reportDir = path.join(data, 'html_report');
  const testDir = path.join(data, 'bitmaps_test', TS);
  const refDir = path.join(data, 'bitmaps_reference');
  for (const d of [reportDir, testDir, refDir]) fs.mkdirSync(d, { recursive: true });

  fs.writeFileSync(
    path.join(reportDir, 'config.js'),
    `report(${JSON.stringify({ testSuite: 'BackstopJS', tests })});`
  );

  if (withBitmaps) {
    for (const t of tests) {
      fs.writeFileSync(path.join(testDir, t.pair.fileName), `nuovo:${t.pair.fileName}`);
      fs.writeFileSync(path.join(refDir, t.pair.fileName), `vecchio:${t.pair.fileName}`);
    }
  }
  return { dir, refDir };
}

function refContent(refDir, fileName) {
  return fs.readFileSync(path.join(refDir, fileName), 'utf8');
}

test('promuove solo le coppie fallite, lascia intatte quelle passate', () => {
  const { dir, refDir } = fixture([
    pair('Home', 'x_Home_0_document_0_mobile.png', 'fail'),
    pair('About', 'x_About_0_document_0_mobile.png', 'pass'),
  ]);

  const res = approveLastTest(dir, 'x');

  assert.deepStrictEqual(res.promoted, ['x_Home_0_document_0_mobile.png']);
  assert.strictEqual(refContent(refDir, 'x_Home_0_document_0_mobile.png'), 'nuovo:x_Home_0_document_0_mobile.png');
  assert.strictEqual(refContent(refDir, 'x_About_0_document_0_mobile.png'), 'vecchio:x_About_0_document_0_mobile.png');
});

// Il bug originale: `backstop approve --filter=^Home$` confrontava la regex col
// nome del bitmap (x_Home_0_document_0_mobile.png) e non promuoveva mai nulla.
test('scenarioLabel promuove solo quella pagina, con label ancorata', () => {
  const { dir, refDir } = fixture([
    pair('Home', 'x_Home_0_document_0_mobile.png', 'fail'),
    pair('About', 'x_About_0_document_0_mobile.png', 'fail'),
  ]);

  const res = approveLastTest(dir, 'x', { scenarioLabel: 'Home' });

  assert.deepStrictEqual(res.promoted, ['x_Home_0_document_0_mobile.png']);
  assert.strictEqual(refContent(refDir, 'x_Home_0_document_0_mobile.png'), 'nuovo:x_Home_0_document_0_mobile.png');
  assert.strictEqual(refContent(refDir, 'x_About_0_document_0_mobile.png'), 'vecchio:x_About_0_document_0_mobile.png');
});

test('promuove tutte le pagine fallite quando non c\'è filtro', () => {
  const { dir, refDir } = fixture([
    pair('Home', 'x_Home_0_document_0_mobile.png', 'fail'),
    pair('About', 'x_About_0_document_0_mobile.png', 'fail'),
  ]);

  const res = approveLastTest(dir, 'x');

  assert.deepStrictEqual(res.promoted.sort(), [
    'x_About_0_document_0_mobile.png',
    'x_Home_0_document_0_mobile.png',
  ]);
  assert.strictEqual(refContent(refDir, 'x_About_0_document_0_mobile.png'), 'nuovo:x_About_0_document_0_mobile.png');
});

test('label inesistente → nessuna promozione', () => {
  const { dir, refDir } = fixture([pair('Home', 'x_Home_0_document_0_mobile.png', 'fail')]);

  const res = approveLastTest(dir, 'x', { scenarioLabel: 'Contatti' });

  assert.deepStrictEqual(res.promoted, []);
  assert.strictEqual(refContent(refDir, 'x_Home_0_document_0_mobile.png'), 'vecchio:x_Home_0_document_0_mobile.png');
});

test('nessun report → errore 404', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vrt-appr-'));
  assert.throws(() => approveLastTest(dir, 'x'), (err) => err.status === 404);
});

test('bitmap di test mancante → segnalato in missing, senza crash', () => {
  const { dir } = fixture([pair('Home', 'x_Home_0_document_0_mobile.png', 'fail')], {
    withBitmaps: false,
  });

  const res = approveLastTest(dir, 'x');

  assert.deepStrictEqual(res.promoted, []);
  assert.deepStrictEqual(res.missing, ['x_Home_0_document_0_mobile.png']);
});

test('percorsi fuori dal progetto vengono ignorati', () => {
  const { dir } = fixture([pair('Home', 'x_Home_0_document_0_mobile.png', 'fail')]);
  const reportDir = path.join(dir, 'projects', 'x', 'backstop_data', 'html_report');
  const evil = {
    pair: {
      reference: '../../../../../../evil.png',
      test: `../bitmaps_test/${TS}/x_Home_0_document_0_mobile.png`,
      fileName: 'evil.png',
      label: 'Home',
      viewportLabel: 'mobile',
    },
    status: 'fail',
  };
  fs.writeFileSync(
    path.join(reportDir, 'config.js'),
    `report(${JSON.stringify({ tests: [evil] })});`
  );

  const res = approveLastTest(dir, 'x');

  assert.deepStrictEqual(res.promoted, []);
  assert.strictEqual(fs.existsSync(path.join(dir, '..', 'evil.png')), false);
});
