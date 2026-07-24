const fs = require('node:fs');
const path = require('node:path');

// Errore con status HTTP associato, propagato così com'è dalle route.
function httpError(status, message) {
  const err = new Error(message);
  err.status = status;
  return err;
}

const SLUG_RE = /^[a-z0-9][a-z0-9-]*$/;

function slugify(name) {
  const slug = String(name || '')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  if (!slug || !SLUG_RE.test(slug)) {
    throw httpError(400, 'Nome progetto non valido: deve contenere lettere o numeri');
  }
  return slug;
}

// Gli slug arrivano anche da URL: mai usarli in un path senza questa verifica.
function assertSafeSlug(slug) {
  if (typeof slug !== 'string' || !SLUG_RE.test(slug)) {
    throw httpError(400, `Slug non valido: "${slug}"`);
  }
  return slug;
}

function projectDir(dataDir, slug) {
  return path.join(dataDir, 'projects', assertSafeSlug(slug));
}

function configPath(dataDir, slug) {
  return path.join(projectDir(dataDir, slug), 'backstop.json');
}

function canonicalPaths(slug) {
  const base = `projects/${slug}/backstop_data`;
  return {
    bitmaps_reference: `${base}/bitmaps_reference`,
    bitmaps_test: `${base}/bitmaps_test`,
    engine_scripts: 'engine_scripts',
    html_report: `${base}/html_report`,
    ci_report: `${base}/ci_report`,
  };
}

function defaultPageDefaults() {
  return {
    delay: 300,
    misMatchThreshold: 0.1,
    hideSelectors: [],
    removeSelectors: [],
  };
}

function newProjectConfig(slug) {
  return {
    id: slug,
    viewports: [
      { label: 'mobile', width: 375, height: 667 },
      { label: 'tablet', width: 768, height: 1024 },
      { label: 'desktop', width: 1920, height: 1080 },
    ],
    onBeforeScript: 'puppet/onBefore.js',
    onReadyScript: 'puppet/onReady.js',
    pageDefaults: defaultPageDefaults(),
    scenarios: [],
    paths: canonicalPaths(slug),
    report: ['browser'],
    engine: 'puppeteer',
    engineOptions: { args: ['--no-sandbox'] },
    asyncCaptureLimit: 5,
    asyncCompareLimit: 50,
    debug: false,
    debugWindow: false,
  };
}

function readConfig(dataDir, slug) {
  const file = configPath(dataDir, slug);
  if (!fs.existsSync(file)) {
    throw httpError(404, `Progetto "${slug}" non trovato`);
  }
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function writeConfig(dataDir, slug, config) {
  fs.writeFileSync(configPath(dataDir, slug), JSON.stringify(config, null, 2) + '\n');
}

function listProjects(dataDir) {
  const root = path.join(dataDir, 'projects');
  if (!fs.existsSync(root)) return [];
  return fs
    .readdirSync(root, { withFileTypes: true })
    .filter((e) => e.isDirectory() && SLUG_RE.test(e.name))
    .filter((e) => fs.existsSync(path.join(root, e.name, 'backstop.json')))
    .map((e) => {
      const cfg = JSON.parse(fs.readFileSync(path.join(root, e.name, 'backstop.json'), 'utf8'));
      return {
        slug: e.name,
        scenarioCount: Array.isArray(cfg.scenarios) ? cfg.scenarios.length : 0,
        viewportCount: Array.isArray(cfg.viewports) ? cfg.viewports.length : 0,
      };
    })
    .sort((a, b) => a.slug.localeCompare(b.slug));
}

function getProject(dataDir, slug) {
  return readConfig(dataDir, slug);
}

function createProject(dataDir, name) {
  const slug = slugify(name);
  const dir = projectDir(dataDir, slug);
  if (fs.existsSync(dir)) {
    throw httpError(409, `Il progetto "${slug}" esiste già`);
  }
  fs.mkdirSync(dir, { recursive: true });
  writeConfig(dataDir, slug, newProjectConfig(slug));
  return { slug };
}

// Filtra un campo array-di-stringhe: tiene solo stringhe non vuote.
function cleanStringArray(value, fieldName, scenarioLabel) {
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) {
    throw httpError(400, `"${fieldName}" dello scenario "${scenarioLabel}" deve essere un array`);
  }
  return value.filter((s) => typeof s === 'string' && s.trim() !== '').map((s) => s.trim());
}

// Normalizza le impostazioni predefinite usate come punto di partenza per le
// nuove pagine (form manuale e crawler). Progetti creati prima di questa
// funzionalità non hanno "pageDefaults": qui viene aggiunto con dei default.
function validatePageDefaults(defaults) {
  if (defaults === undefined || defaults === null) return defaultPageDefaults();
  if (typeof defaults !== 'object') {
    throw httpError(400, '"pageDefaults" deve essere un oggetto');
  }
  const out = {
    delay: Number.isFinite(defaults.delay) ? defaults.delay : 300,
    misMatchThreshold: Number.isFinite(defaults.misMatchThreshold) ? defaults.misMatchThreshold : 0.1,
    hideSelectors: cleanStringArray(defaults.hideSelectors, 'hideSelectors', 'predefinito') || [],
    removeSelectors: cleanStringArray(defaults.removeSelectors, 'removeSelectors', 'predefinito') || [],
  };
  const click = typeof defaults.clickSelector === 'string' ? defaults.clickSelector.trim() : '';
  if (click) out.clickSelector = click;
  return out;
}

function validateConfig(slug, config) {
  if (!config || typeof config !== 'object') {
    throw httpError(400, 'Configurazione mancante o non valida');
  }

  config.pageDefaults = validatePageDefaults(config.pageDefaults);

  if (!Array.isArray(config.viewports) || config.viewports.length === 0) {
    throw httpError(400, 'Serve almeno un viewport');
  }
  for (const vp of config.viewports) {
    if (
      !vp ||
      typeof vp.label !== 'string' ||
      vp.label.trim() === '' ||
      !Number.isInteger(vp.width) ||
      vp.width <= 0 ||
      !Number.isInteger(vp.height) ||
      vp.height <= 0
    ) {
      throw httpError(400, 'Ogni viewport deve avere label, width e height (interi positivi)');
    }
  }

  if (!Array.isArray(config.scenarios)) {
    throw httpError(400, '"scenarios" deve essere un array');
  }
  const labels = new Set();
  for (const sc of config.scenarios) {
    if (!sc || typeof sc.label !== 'string' || sc.label.trim() === '') {
      throw httpError(400, 'Ogni scenario deve avere un label');
    }
    if (typeof sc.url !== 'string' || sc.url.trim() === '') {
      throw httpError(400, `Lo scenario "${sc.label}" deve avere una url`);
    }
    if (labels.has(sc.label)) {
      throw httpError(400, `Label scenario duplicato: "${sc.label}"`);
    }
    labels.add(sc.label);
    const hide = cleanStringArray(sc.hideSelectors, 'hideSelectors', sc.label);
    if (hide !== undefined) sc.hideSelectors = hide;
    const remove = cleanStringArray(sc.removeSelectors, 'removeSelectors', sc.label);
    if (remove !== undefined) sc.removeSelectors = remove;
  }

  // Campi che l'utente non può alterare: identità e percorsi.
  config.id = slug;
  config.paths = canonicalPaths(slug);
  return config;
}

function escapeRegExp(str) {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// Replica la sanitizzazione che BackstopJS applica alla label per generare i
// nomi dei bitmap (core/util/engineTools.js: makeSafe + strip finale).
function labelToFileSafe(label) {
  return String(label).replace(/[ /]/g, '_').replace(/[^a-z0-9_-]/gi, '');
}

// Rimuove gli screenshot (baseline e cronologia test) delle pagine eliminate.
// I file sono nominati `${configId}_${labelSafe}_${selectorIndex}_...png`: il
// suffisso "_\d+_" dopo la label evita falsi positivi quando una label è
// prefisso di un'altra (es. "Home" vs "Home Page").
function removeScenarioBitmaps(dataDir, slug, removedLabels) {
  if (!removedLabels.length) return;
  const base = path.join(projectDir(dataDir, slug), 'backstop_data');
  const patterns = removedLabels.map(
    (label) => new RegExp(`^${escapeRegExp(slug)}_${escapeRegExp(labelToFileSafe(label))}_\\d+_.+\\.(png|log\\.json)$`)
  );
  const matches = (name) => patterns.some((re) => re.test(name));

  const purgeDir = (dir) => {
    if (!fs.existsSync(dir)) return;
    for (const name of fs.readdirSync(dir)) {
      if (matches(name)) fs.rmSync(path.join(dir, name), { force: true });
    }
  };

  purgeDir(path.join(base, 'bitmaps_reference'));

  const testRoot = path.join(base, 'bitmaps_test');
  if (fs.existsSync(testRoot)) {
    for (const entry of fs.readdirSync(testRoot, { withFileTypes: true })) {
      if (entry.isDirectory()) purgeDir(path.join(testRoot, entry.name));
    }
  }
}

function updateProject(dataDir, slug, config) {
  const previous = readConfig(dataDir, slug); // 404 se non esiste
  const validated = validateConfig(assertSafeSlug(slug), config);
  writeConfig(dataDir, slug, validated);

  const nextLabels = new Set(validated.scenarios.map((sc) => sc.label));
  const removedLabels = (previous.scenarios || [])
    .map((sc) => sc.label)
    .filter((label) => !nextLabels.has(label));
  removeScenarioBitmaps(dataDir, slug, removedLabels);

  return validated;
}

function deleteProject(dataDir, slug) {
  const dir = projectDir(dataDir, slug);
  if (!fs.existsSync(dir)) {
    throw httpError(404, `Progetto "${slug}" non trovato`);
  }
  fs.rmSync(dir, { recursive: true, force: true });
}

module.exports = {
  httpError,
  slugify,
  assertSafeSlug,
  canonicalPaths,
  listProjects,
  getProject,
  createProject,
  updateProject,
  deleteProject,
};
