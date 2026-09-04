const path = require('node:path');
const express = require('express');

const projects = require('./lib/projects');
const { createRunner, escapeFilter } = require('./lib/runner');
const { getLastResult, clearLastResult } = require('./lib/results');
const { approveLastTest, formatApproveLog } = require('./lib/approve');
const { crawl } = require('./lib/crawler');
const { findUnreachableLocalScenarios } = require('./lib/reachability');

const RUN_COMMANDS = ['reference', 'test', 'approve'];
const TERMINAL_STATUSES = ['success', 'failed', 'cancelled'];

function createApp({ dataDir, runner }) {
  const app = express();
  app.use(express.json({ limit: '1mb' }));

  // ---- Progetti ------------------------------------------------------------

  app.get('/api/projects', (req, res) => {
    const list = projects.listProjects(dataDir).map((p) => ({
      ...p,
      lastResult: getLastResult(dataDir, p.slug),
    }));
    res.json(list);
  });

  app.post('/api/projects', (req, res) => {
    const created = projects.createProject(dataDir, req.body?.name);
    res.status(201).json(created);
  });

  app.get('/api/projects/:slug', (req, res) => {
    res.json(projects.getProject(dataDir, req.params.slug));
  });

  app.put('/api/projects/:slug', (req, res) => {
    res.json(projects.updateProject(dataDir, req.params.slug, req.body));
  });

  app.delete('/api/projects/:slug', (req, res) => {
    projects.deleteProject(dataDir, req.params.slug);
    res.status(204).end();
  });

  app.get('/api/projects/:slug/result', (req, res) => {
    projects.getProject(dataDir, req.params.slug); // 404 se non esiste
    const result = getLastResult(dataDir, req.params.slug);
    if (!result) {
      throw projects.httpError(404, 'Nessun test eseguito finora');
    }
    res.json(result);
  });

  // ---- Run -----------------------------------------------------------------

  // Express 4 non propaga i reject degli handler async: serve try/next.
  app.post('/api/projects/:slug/runs', async (req, res, next) => {
    try {
      const { command, scenarioLabel, rawFilter } = req.body || {};
      if (!RUN_COMMANDS.includes(command)) {
        throw projects.httpError(400, `Comando non valido: usa ${RUN_COMMANDS.join(', ')}`);
      }
      const config = projects.getProject(dataDir, req.params.slug); // 404 se non esiste

      // L'approvazione non passa da BackstopJS: vedi lib/approve.js per il perché.
      if (command === 'approve') {
        const label = scenarioLabel || null;
        const { promoted, missing } = approveLastTest(dataDir, req.params.slug, {
          scenarioLabel: label,
        });
        const run = runner.record({
          project: req.params.slug,
          command,
          filter: label,
          log: formatApproveLog({ scenarioLabel: label, promoted, missing }),
        });
        return res.status(202).json({ run });
      }

      // reference/test lanciano davvero Chromium: se uno scenario punta a
      // localhost/127.0.0.1 non raggiungibile dal container, meglio
      // bloccare e far scegliere all'utente se correggere gli URL, invece
      // di produrre screenshot silenziosamente rotti (mancano CSS/risorse).
      const scenarios = Array.isArray(config.scenarios) ? config.scenarios : [];
      const targeted = scenarioLabel
        ? scenarios.filter((s) => s.label === scenarioLabel)
        : scenarios;
      const affected = await findUnreachableLocalScenarios(targeted);
      if (affected.length > 0) {
        return res.status(409).json({
          error: 'Alcune pagine puntano a un indirizzo locale non raggiungibile dal container',
          code: 'LOCALHOST_UNREACHABLE',
          affected: affected.map((s) => ({ label: s.label, url: s.url })),
        });
      }

      // Rigenerare la baseline invalida l'esito dell'ultimo test: gli scenari
      // possono essere cambiati (quindi anche il totale) e il confronto era
      // comunque contro immagini che stiamo per sostituire. Azzeriamo qui,
      // dopo i controlli che possono rifiutare il run, così contatore e badge
      // non restano appesi a un risultato che non descrive più niente.
      if (command === 'reference') clearLastResult(dataDir, req.params.slug);

      const filter = scenarioLabel ? escapeFilter(scenarioLabel) : rawFilter || null;
      const run = runner.enqueue({ project: req.params.slug, command, filter });
      res.status(202).json({ run });
    } catch (err) {
      next(err);
    }
  });

  app.get('/api/runs', (req, res) => {
    res.json(runner.list());
  });

  app.get('/api/runs/:id', (req, res) => {
    const run = runner.get(req.params.id);
    if (!run) throw projects.httpError(404, 'Run non trovato');
    const { log, ...meta } = run;
    res.json(meta);
  });

  app.post('/api/runs/:id/cancel', (req, res) => {
    if (!runner.get(req.params.id)) throw projects.httpError(404, 'Run non trovato');
    const run = runner.cancel(req.params.id);
    res.json({ run });
  });

  // Log live via Server-Sent Events. Se il run è già concluso: replay del log,
  // evento status e chiusura dello stream.
  app.get('/api/runs/:id/log', (req, res) => {
    const run = runner.get(req.params.id);
    if (!run) throw projects.httpError(404, 'Run non trovato');

    res.set({
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
    });
    res.flushHeaders();

    const send = (event, data) => {
      res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    };

    for (const line of run.log.split('\n')) {
      if (line.trim() !== '') send('log', { line });
    }

    if (TERMINAL_STATUSES.includes(run.status)) {
      const { log, ...meta } = run;
      send('status', { run: meta });
      res.end();
      return;
    }

    const unsubscribe = runner.subscribe(run.id, (ev) => {
      if (ev.type === 'log') send('log', { line: ev.line });
      if (ev.type === 'status') {
        send('status', { run: ev.run });
        if (TERMINAL_STATUSES.includes(ev.run.status)) {
          unsubscribe();
          res.end();
        }
      }
    });
    req.on('close', unsubscribe);
  });

  // ---- Crawler -------------------------------------------------------------

  // Express 4 non propaga i reject degli handler async: serve try/next.
  app.post('/api/crawl', async (req, res, next) => {
    try {
      const { url, maxPages, stealth } = req.body || {};
      const result = await crawl(url, {
        maxPages: Number.isInteger(maxPages) && maxPages > 0 ? Math.min(maxPages, 100) : 30,
        // Come per gli screenshot: discreto salvo richiesta esplicita.
        stealth: stealth !== false,
      });
      res.json(result);
    } catch (err) {
      next(err);
    }
  });

  // ---- Statici -------------------------------------------------------------

  // Report BackstopJS: stessa forma di URL usata in 01-backstopjs
  app.use('/reports', express.static(path.join(dataDir, 'projects')));
  app.use(express.static(path.join(__dirname, 'public')));

  // ---- Errori --------------------------------------------------------------

  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, next) => {
    const status = err.status || 500;
    if (status === 500) console.error(err);
    res.status(status).json({ error: err.message || 'Errore interno' });
  });

  return app;
}

if (require.main === module) {
  const dataDir = process.env.DATA_DIR || path.resolve(__dirname, '..', 'data');
  const port = Number(process.env.PORT) || 3000;
  const runner = createRunner({ dataDir });
  const app = createApp({ dataDir, runner });
  app.listen(port, () => {
    console.log(`BackstopJS UI in ascolto su http://localhost:${port} (dati: ${dataDir})`);
  });
}

module.exports = { createApp };
