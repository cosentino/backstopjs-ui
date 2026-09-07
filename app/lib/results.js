const fs = require('node:fs');
const path = require('node:path');

const { assertSafeSlug } = require('./projects');

// Cartella del report: i percorsi dentro config.js sono relativi a questa.
function reportDir(dataDir, slug) {
  return path.join(dataDir, 'projects', slug, 'backstop_data', 'html_report');
}

// Report grezzo, così com'è stato scritto da BackstopJS (null se assente/illeggibile).
function readReport(dataDir, slug) {
  try {
    const txt = fs.readFileSync(path.join(reportDir(dataDir, slug), 'config.js'), 'utf8');
    return JSON.parse(txt.slice(txt.indexOf('{'), txt.lastIndexOf('}') + 1));
  } catch {
    return null;
  }
}

// Nel report i percorsi delle immagini sono relativi a html_report
// ("../bitmaps_test/…"): qui diventano relativi alla cartella del progetto,
// che è quella pubblicata su /reports/<slug>/. Un percorso che uscirebbe da
// backstop_data non è servibile e vale come assente.
function assetPath(p) {
  if (typeof p !== 'string' || p === '') return null;
  const rel = path.posix.normalize(path.posix.join('backstop_data/html_report', p));
  return rel.startsWith('backstop_data/') ? rel : null;
}

// Legge l'esito dell'ultimo test dal report HTML generato da BackstopJS
// (html_report/config.js, formato: `report({...});`).
// Restituisce null se non c'è un report o non è leggibile.
function getLastResult(dataDir, slug) {
  const file = path.join(reportDir(dataDir, slug), 'config.js');
  try {
    const data = readReport(dataDir, slug);
    if (!data) return null;
    const tests = (data.tests || []).map((t) => ({
      label: t.pair.label,
      viewport: t.pair.viewportLabel,
      status: t.status,
      misMatchPercentage: t.pair.diff ? t.pair.diff.misMatchPercentage : undefined,
      // Le tre immagini del confronto: servono alla UI per mostrare l'esito
      // della singola pagina senza aprire il report completo.
      images: {
        reference: assetPath(t.pair.reference),
        test: assetPath(t.pair.test),
        diff: assetPath(t.pair.diffImage),
      },
    }));
    const passed = tests.filter((t) => t.status === 'pass').length;
    return {
      at: fs.statSync(file).mtime.toISOString(),
      summary: { passed, failed: tests.length - passed, total: tests.length },
      tests,
    };
  } catch {
    return null;
  }
}

// Il report HTML è l'unica traccia dell'esito dell'ultimo test: dopo aver
// rigenerato la baseline non descrive più niente di reale (gli scenari
// possono essere cambiati, e comunque il confronto era contro immagini che
// ora sono state sostituite). Lo rimuoviamo: lo riscrive il prossimo test.
function clearLastResult(dataDir, slug) {
  fs.rmSync(reportDir(dataDir, assertSafeSlug(slug)), { recursive: true, force: true });
}

module.exports = { getLastResult, readReport, reportDir, clearLastResult };
