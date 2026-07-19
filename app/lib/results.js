const fs = require('node:fs');
const path = require('node:path');

// Legge l'esito dell'ultimo test dal report HTML generato da BackstopJS
// (html_report/config.js, formato: `report({...});`).
// Restituisce null se non c'è un report o non è leggibile.
function getLastResult(dataDir, slug) {
  const file = path.join(
    dataDir,
    'projects',
    slug,
    'backstop_data',
    'html_report',
    'config.js'
  );
  try {
    const txt = fs.readFileSync(file, 'utf8');
    const data = JSON.parse(txt.slice(txt.indexOf('{'), txt.lastIndexOf('}') + 1));
    const tests = (data.tests || []).map((t) => ({
      label: t.pair.label,
      viewport: t.pair.viewportLabel,
      status: t.status,
      misMatchPercentage: t.pair.diff ? t.pair.diff.misMatchPercentage : undefined,
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

module.exports = { getLastResult };
