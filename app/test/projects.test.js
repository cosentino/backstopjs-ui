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

test('update: eliminare una pagina ripulisce i suoi bitmap, non quelli delle altre', () => {
  const dir = tempDataDir();
  const { slug } = createProject(dir, 'demo');
  const base = getProject(dir, slug);

  const withScenarios = updateProject(dir, slug, {
    ...base,
    scenarios: [
      { label: 'Home', url: 'http://demo/' },
      { label: 'Home Page', url: 'http://demo/altra' },
    ],
  });

  const backstopData = path.join(dir, 'projects', slug, 'backstop_data');
  const refDir = path.join(backstopData, 'bitmaps_reference');
  const testDir = path.join(backstopData, 'bitmaps_test', '20260724-000000');
  fs.mkdirSync(refDir, { recursive: true });
  fs.mkdirSync(testDir, { recursive: true });

  const homeFile = `${slug}_Home_0_document_0_mobile.png`;
  const homePageFile = `${slug}_Home_Page_0_document_0_mobile.png`;
  for (const dest of [refDir, testDir]) {
    fs.writeFileSync(path.join(dest, homeFile), 'x');
    fs.writeFileSync(path.join(dest, homePageFile), 'x');
  }

  updateProject(dir, slug, { ...withScenarios, scenarios: [{ label: 'Home Page', url: 'http://demo/altra' }] });

  assert.strictEqual(fs.existsSync(path.join(refDir, homeFile)), false);
  assert.strictEqual(fs.existsSync(path.join(testDir, homeFile)), false);
  assert.strictEqual(fs.existsSync(path.join(refDir, homePageFile)), true);
  assert.strictEqual(fs.existsSync(path.join(testDir, homePageFile)), true);
});

test('delete rimuove la cartella', () => {
  const dir = tempDataDir();
  const { slug } = createProject(dir, 'demo');
  deleteProject(dir, slug);
  assert.throws(() => getProject(dir, slug), (err) => err.status === 404);
  assert.strictEqual(listProjects(dir).length, 0);
});

test('modalità discreta: attiva sui progetti nuovi, con il flag di lancio', () => {
  const dir = tempDataDir();
  createProject(dir, 'nuovo');
  const cfg = getProject(dir, 'nuovo');
  assert.strictEqual(cfg.stealth, true);
  assert.ok(cfg.engineOptions.args.includes('--no-sandbox'));
  assert.ok(cfg.engineOptions.args.includes('--disable-blink-features=AutomationControlled'));
});

test('modalità discreta: spegnerla toglie il flag, riaccenderla lo rimette', () => {
  const dir = tempDataDir();
  createProject(dir, 'p');
  const cfg = getProject(dir, 'p');

  const off = updateProject(dir, 'p', { ...cfg, stealth: false });
  assert.strictEqual(off.stealth, false);
  assert.ok(off.engineOptions.args.includes('--no-sandbox'));
  assert.ok(!off.engineOptions.args.includes('--disable-blink-features=AutomationControlled'));
  // e deve essere finita su disco, che è quello che legge BackstopJS
  assert.strictEqual(getProject(dir, 'p').stealth, false);

  const on = updateProject(dir, 'p', { ...off, stealth: true });
  assert.deepStrictEqual(on.engineOptions.args, [
    '--no-sandbox',
    '--disable-blink-features=AutomationControlled',
  ]);
});

test('modalità discreta: gli argomenti aggiunti a mano restano', () => {
  const dir = tempDataDir();
  createProject(dir, 'p');
  const cfg = getProject(dir, 'p');
  cfg.engineOptions = { args: ['--no-sandbox', '--proxy-server=http://proxy:8080'], headless: 'new' };

  const saved = updateProject(dir, 'p', cfg);
  assert.ok(saved.engineOptions.args.includes('--proxy-server=http://proxy:8080'));
  assert.strictEqual(saved.engineOptions.headless, 'new');
  // niente doppioni dopo più salvataggi
  const again = updateProject(dir, 'p', saved);
  assert.strictEqual(
    again.engineOptions.args.filter((a) => a === '--no-sandbox').length,
    1
  );
});

test('progetto creato prima della modalità discreta: migrato in lettura', () => {
  const dir = tempDataDir();
  createProject(dir, 'vecchio');
  const file = path.join(dir, 'projects', 'vecchio', 'backstop.json');
  const legacy = JSON.parse(fs.readFileSync(file, 'utf8'));
  delete legacy.stealth;
  legacy.engineOptions = { args: ['--no-sandbox'] };
  fs.writeFileSync(file, JSON.stringify(legacy, null, 2));

  const cfg = getProject(dir, 'vecchio');
  assert.strictEqual(cfg.stealth, true);
  assert.ok(cfg.engineOptions.args.includes('--disable-blink-features=AutomationControlled'));
  // riscritto su disco: il run legge il file, non l'oggetto in memoria
  const onDisk = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.strictEqual(onDisk.stealth, true);
  assert.ok(onDisk.engineOptions.args.includes('--disable-blink-features=AutomationControlled'));
});

test('backstop.json di sola lettura: la migrazione non impedisce di aprirlo', () => {
  const dir = tempDataDir();
  createProject(dir, 'readonly');
  const file = path.join(dir, 'projects', 'readonly', 'backstop.json');
  const legacy = JSON.parse(fs.readFileSync(file, 'utf8'));
  delete legacy.stealth;
  fs.writeFileSync(file, JSON.stringify(legacy, null, 2));
  fs.chmodSync(file, 0o444);

  const cfg = getProject(dir, 'readonly'); // non deve lanciare EACCES
  assert.strictEqual(cfg.stealth, true);
});

// --- progetti copiati a mano (cartella duplicata sul filesystem) ---

// Crea un progetto "copia" duplicando la cartella di "origine": è quello che
// fa un copia-incolla da file manager, backstop.json compreso.
function copyProjectDir(dir, from, to) {
  fs.cpSync(path.join(dir, 'projects', from), path.join(dir, 'projects', to), { recursive: true });
}

function writeBitmap(dir, slug, sub, name) {
  const full = path.join(dir, 'projects', slug, 'backstop_data', sub);
  fs.mkdirSync(full, { recursive: true });
  fs.writeFileSync(path.join(full, name), 'png');
}

test('progetto copiato a mano: id e paths riallineati allo slug in lettura', () => {
  const dir = tempDataDir();
  createProject(dir, 'origine');
  copyProjectDir(dir, 'origine', 'copia');

  const cfg = getProject(dir, 'copia');
  assert.strictEqual(cfg.id, 'copia');
  assert.deepStrictEqual(cfg.paths, canonicalPaths('copia'));

  // riscritto su disco: è il file che legge BackstopJS durante un run, ed è
  // da lì che dipende la cartella in cui finiscono report e screenshot
  const onDisk = JSON.parse(
    fs.readFileSync(path.join(dir, 'projects', 'copia', 'backstop.json'), 'utf8')
  );
  assert.strictEqual(onDisk.id, 'copia');
  assert.deepStrictEqual(onDisk.paths, canonicalPaths('copia'));
});

test('progetto copiato a mano: i bitmap seguono il nuovo id', () => {
  const dir = tempDataDir();
  createProject(dir, 'origine');
  writeBitmap(dir, 'origine', 'bitmaps_reference', 'origine_Home_0_document_0_desktop.png');
  writeBitmap(dir, 'origine', 'bitmaps_test/20250101-101010', 'origine_Home_0_document_0_desktop.png');
  copyProjectDir(dir, 'origine', 'copia');

  getProject(dir, 'copia');

  const base = path.join(dir, 'projects', 'copia', 'backstop_data');
  // BackstopJS nomina i bitmap `${id}_...`: senza rinomina la baseline
  // copiata resterebbe orfana e ogni scenario risulterebbe senza riferimento
  assert.deepStrictEqual(fs.readdirSync(path.join(base, 'bitmaps_reference')), [
    'copia_Home_0_document_0_desktop.png',
  ]);
  assert.deepStrictEqual(fs.readdirSync(path.join(base, 'bitmaps_test', '20250101-101010')), [
    'copia_Home_0_document_0_desktop.png',
  ]);
  // l'originale non viene toccato
  assert.deepStrictEqual(
    fs.readdirSync(path.join(dir, 'projects', 'origine', 'backstop_data', 'bitmaps_reference')),
    ['origine_Home_0_document_0_desktop.png']
  );
});

test('progetto copiato a mano: il report ereditato viene rimosso', () => {
  const dir = tempDataDir();
  createProject(dir, 'origine');
  writeBitmap(dir, 'origine', 'html_report', 'config.js');
  copyProjectDir(dir, 'origine', 'copia');

  getProject(dir, 'copia');

  // descriveva bitmap con i nomi vecchi: dopo la rinomina non è più leggibile
  assert.strictEqual(
    fs.existsSync(path.join(dir, 'projects', 'copia', 'backstop_data', 'html_report')),
    false
  );
});

test('progetto già allineato: la lettura non tocca niente su disco', () => {
  const dir = tempDataDir();
  createProject(dir, 'stabile');
  writeBitmap(dir, 'stabile', 'bitmaps_reference', 'stabile_Home_0_document_0_desktop.png');
  writeBitmap(dir, 'stabile', 'html_report', 'config.js');
  const file = path.join(dir, 'projects', 'stabile', 'backstop.json');
  const before = fs.statSync(file).mtimeMs;

  getProject(dir, 'stabile');

  assert.strictEqual(fs.statSync(file).mtimeMs, before);
  assert.strictEqual(
    fs.existsSync(path.join(dir, 'projects', 'stabile', 'backstop_data', 'html_report', 'config.js')),
    true
  );
});

test('copia con backstop.json di sola lettura: bitmap non rinominati', () => {
  const dir = tempDataDir();
  createProject(dir, 'origine');
  writeBitmap(dir, 'origine', 'bitmaps_reference', 'origine_Home_0_document_0_desktop.png');
  copyProjectDir(dir, 'origine', 'copia');
  const file = path.join(dir, 'projects', 'copia', 'backstop.json');
  fs.chmodSync(file, 0o444);

  const cfg = getProject(dir, 'copia'); // non deve lanciare EACCES
  assert.strictEqual(cfg.id, 'copia');

  // La config su disco è rimasta con l'id vecchio: rinominare i bitmap qui
  // lascerebbe la baseline orfana rispetto al file che legge BackstopJS.
  assert.deepStrictEqual(
    fs.readdirSync(path.join(dir, 'projects', 'copia', 'backstop_data', 'bitmaps_reference')),
    ['origine_Home_0_document_0_desktop.png']
  );
});
