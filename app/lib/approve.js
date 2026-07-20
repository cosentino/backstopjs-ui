const fs = require('node:fs');
const path = require('node:path');

const { httpError } = require('./projects');
const { readReport, reportDir } = require('./results');

// Perché non usiamo `backstop approve`:
// il suo `--filter` viene confrontato col NOME DEL BITMAP
// (demo_Home_0_document_0_mobile.png), non con la label dello scenario, quindi
// una label ancorata come `^Home$` non matcha mai e non promuove nulla. Inoltre
// legge solo la cartella di test più recente, che dopo un test filtrato contiene
// una sola pagina.
// Qui promuoviamo esattamente le coppie che il report segna come "fail", usando
// i percorsi che il report stesso contiene: ciò che approviamo coincide sempre
// con ciò che la dashboard mostra.
function approveLastTest(dataDir, slug, { scenarioLabel = null } = {}) {
  const data = readReport(dataDir, slug);
  if (!data) throw httpError(404, 'Nessun test eseguito finora');

  const base = reportDir(dataDir, slug);
  const root = path.resolve(dataDir, 'projects', slug, 'backstop_data');
  const inside = (p) => p === root || p.startsWith(root + path.sep);

  const promoted = [];
  const missing = [];

  for (const entry of data.tests || []) {
    const pair = entry && entry.pair;
    if (!pair || entry.status !== 'fail') continue;
    if (scenarioLabel && pair.label !== scenarioLabel) continue;
    if (!pair.test || !pair.reference) continue;

    const src = path.resolve(base, pair.test);
    const dest = path.resolve(base, pair.reference);
    // Il report è generato, ma resta un file su disco: non usciamo dal progetto.
    if (!inside(src) || !inside(dest)) continue;

    const name = pair.fileName || path.basename(dest);
    if (!fs.existsSync(src)) {
      missing.push(name);
      continue;
    }

    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.copyFileSync(src, dest);
    promoted.push(name);
  }

  return { promoted, missing };
}

// Log mostrato nel pannello esecuzioni, al posto dell'output di BackstopJS.
function formatApproveLog({ scenarioLabel, promoted, missing }) {
  const lines = [
    scenarioLabel
      ? `Approvazione dall'ultimo report, solo la pagina "${scenarioLabel}".`
      : "Approvazione di tutte le differenze dell'ultimo report.",
  ];

  if (promoted.length === 0) {
    lines.push('Nessuna differenza da approvare.');
  } else {
    lines.push(`Promossi a baseline ${promoted.length} screenshot:`);
    for (const name of promoted) lines.push(`>  ${name}`);
  }

  if (missing.length > 0) {
    lines.push(`Attenzione: ${missing.length} screenshot di test non trovati sul disco:`);
    for (const name of missing) lines.push(`!  ${name}`);
  }

  return lines.join('\n') + '\n';
}

module.exports = { approveLastTest, formatApproveLog };
