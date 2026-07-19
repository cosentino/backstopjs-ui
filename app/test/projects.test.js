const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  slugify,
  listProjects,
  getProject,
  createProject,
  updateProject,
  deleteProject,
  canonicalPaths,
} = require('../lib/projects');

function tempDataDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vrt-ui-'));
  fs.mkdirSync(path.join(dir, 'projects'), { recursive: true });
  return dir;
}

test('slugify: base, accenti, caratteri speciali', () => {
  assert.strictEqual(slugify('Il Mio Sito!'), 'il-mio-sito');
  assert.strictEqual(slugify('Città  è -- bella'), 'citta-e-bella');
  assert.strictEqual(slugify('demo'), 'demo');
  assert.throws(() => slugify('***'), /nome/i);
  assert.throws(() => slugify(''), /nome/i);
});

test('canonicalPaths: percorsi fissi per slug', () => {
  const p = canonicalPaths('demo');
  assert.strictEqual(p.bitmaps_reference, 'projects/demo/backstop_data/bitmaps_reference');
  assert.strictEqual(p.bitmaps_test, 'projects/demo/backstop_data/bitmaps_test');
  assert.strictEqual(p.html_report, 'projects/demo/backstop_data/html_report');
  assert.strictEqual(p.ci_report, 'projects/demo/backstop_data/ci_report');
  assert.strictEqual(p.engine_scripts, 'engine_scripts');
});

test('create → list → get roundtrip', () => {
  const dir = tempDataDir();
  const { slug } = createProject(dir, 'Sito di Prova');
  assert.strictEqual(slug, 'sito-di-prova');

  const list = listProjects(dir);
  assert.strictEqual(list.length, 1);
  assert.strictEqual(list[0].slug, 'sito-di-prova');
  assert.strictEqual(list[0].scenarioCount, 0);
  assert.strictEqual(list[0].viewportCount, 3);

  const cfg = getProject(dir, 'sito-di-prova');
  assert.strictEqual(cfg.id, 'sito-di-prova');
  assert.strictEqual(cfg.engine, 'puppeteer');
  assert.deepStrictEqual(cfg.paths, canonicalPaths('sito-di-prova'));
});

test('create duplicato → 409', () => {
  const dir = tempDataDir();
  createProject(dir, 'demo');
  assert.throws(() => createProject(dir, 'Demo'), (err) => err.status === 409);
});

test('get progetto mancante → 404', () => {
  const dir = tempDataDir();
  assert.throws(() => getProject(dir, 'non-esiste'), (err) => err.status === 404);
});

test('get con slug malevolo → 400', () => {
  const dir = tempDataDir();
  assert.throws(() => getProject(dir, '../etc'), (err) => err.status === 400);
  assert.throws(() => getProject(dir, '_template'), (err) => err.status === 400);
});

test('update: validazioni', () => {
  const dir = tempDataDir();
  const { slug } = createProject(dir, 'demo');
  const base = getProject(dir, slug);

  assert.throws(
    () => updateProject(dir, slug, { ...base, scenarios: 'no' }),
    (err) => err.status === 400
  );
  assert.throws(
    () => updateProject(dir, slug, { ...base, scenarios: [{ label: 'Home' }] }),
    (err) => err.status === 400 && /url/i.test(err.message)
  );
  assert.throws(
    () =>
      updateProject(dir, slug, {
        ...base,
        scenarios: [
          { label: 'Home', url: 'http://a/' },
          { label: 'Home', url: 'http://b/' },
        ],
      }),
    (err) => err.status === 400 && /duplicat/i.test(err.message)
  );
  assert.throws(
    () => updateProject(dir, slug, { ...base, viewports: [] }),
    (err) => err.status === 400
  );
  assert.throws(
    () => updateProject(dir, slug, { ...base, viewports: [{ label: 'x', width: 'no', height: 100 }] }),
    (err) => err.status === 400
  );
});

test('update: normalizza id/paths, preserva campi sconosciuti, filtra selettori vuoti', () => {
  const dir = tempDataDir();
  const { slug } = createProject(dir, 'demo');
  const base = getProject(dir, slug);

  const updated = updateProject(dir, slug, {
    ...base,
    id: 'MANOMESSO',
    paths: { bitmaps_reference: '/etc/passwd' },
    campoCustom: 42,
    scenarios: [
      {
        label: 'Home',
        url: 'http://demo/',
        hideSelectors: ['.carousel', '', '  '],
        cookiePath: 'engine_scripts/cookies.json',
      },
    ],
  });

  assert.strictEqual(updated.id, 'demo');
  assert.deepStrictEqual(updated.paths, canonicalPaths('demo'));
  assert.strictEqual(updated.campoCustom, 42);
  assert.deepStrictEqual(updated.scenarios[0].hideSelectors, ['.carousel']);
  assert.strictEqual(updated.scenarios[0].cookiePath, 'engine_scripts/cookies.json');

  const reread = getProject(dir, slug);
  assert.deepStrictEqual(reread, updated);
});

test('delete rimuove la cartella', () => {
  const dir = tempDataDir();
  const { slug } = createProject(dir, 'demo');
  deleteProject(dir, slug);
  assert.throws(() => getProject(dir, slug), (err) => err.status === 404);
  assert.strictEqual(listProjects(dir).length, 0);
});
