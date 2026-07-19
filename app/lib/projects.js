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

function validateConfig(slug, config) {
  if (!config || typeof config !== 'object') {
    throw httpError(400, 'Configurazione mancante o non valida');
  }

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

function updateProject(dataDir, slug, config) {
  readConfig(dataDir, slug); // 404 se non esiste
  const validated = validateConfig(assertSafeSlug(slug), config);
  writeConfig(dataDir, slug, validated);
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
