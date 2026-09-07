/* backstopui — SPA senza build: hash routing + fetch + SSE. */
(function () {
  'use strict';

  const view = document.getElementById('view');

  // ---------- helpers ----------

  function esc(s) {
    return String(s ?? '').replace(/[&<>"']/g, (c) => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
    }[c]));
  }

  function toast(message) {
    document.querySelector('.toast')?.remove();
    const el = document.createElement('div');
    el.className = 'toast';
    el.setAttribute('role', 'alert');
    el.textContent = message;
    document.body.appendChild(el);
    setTimeout(() => el.remove(), 5000);
  }

  async function api(path, options = {}) {
    const res = await fetch(path, {
      headers: { 'Content-Type': 'application/json' },
      ...options,
    });
    if (res.status === 204) return null;
    const body = await res.json().catch(() => ({}));
    if (!res.ok) {
      const err = new Error(body.error || `Errore ${res.status}`);
      err.status = res.status;
      err.body = body;
      throw err;
    }
    return body;
  }

  function reportUrl(slug) {
    return `/reports/${slug}/backstop_data/html_report/index.html`;
  }

  // Le immagini del report stanno sotto /reports/<slug>/: i nomi file generati
  // da BackstopJS contengono il label dello scenario, quindi vanno codificati.
  function reportAsset(slug, relPath) {
    const parts = relPath.split('/').map(encodeURIComponent).join('/');
    return `/reports/${encodeURIComponent(slug)}/${parts}`;
  }

  // Gli URL degli scenari sono scritti dal punto di vista del container, che è
  // chi apre davvero le pagine: "host.docker.internal" è la macchina host e il
  // sito demo del compose risponde su "demo". Per aprirli nel browser
  // dell'utente vanno riportati alla vista dell'host.
  function browserUrl(url) {
    try {
      const u = new URL(url);
      if (u.hostname === 'host.docker.internal') u.hostname = 'localhost';
      else if (u.hostname === 'demo' && !u.port) { u.hostname = 'localhost'; u.port = '8081'; }
      return u.href;
    } catch {
      return url;
    }
  }

  // Preferenze di sola interfaccia (pannelli aperti, colonna esecuzioni):
  // localStorage può mancare o lanciare, e in quel caso si usano i default.
  function readPref(key, fallback) {
    try { return localStorage.getItem(key) ?? fallback; } catch { return fallback; }
  }
  function writePref(key, value) {
    try { localStorage.setItem(key, value); } catch { /* niente da fare */ }
  }

  // I pannelli di configurazione partono chiusi a ogni caricamento, ma la vista
  // si ridisegna a ogni salvataggio: senza tenerne memoria qui, modificare un
  // viewport richiuderebbe il pannello in cui si sta lavorando.
  const panelOpen = { config: false, crawler: false };
  function isPanelOpen(name) { return panelOpen[name] === true; }
  function setPanelOpen(name, open) { panelOpen[name] = open; }

  function badge(lastResult) {
    if (!lastResult) return '<span class="badge badge-none">mai testato</span>';
    const { passed, failed, total } = lastResult.summary;
    return failed > 0
      ? `<span class="badge badge-fail">${failed}/${total} diversi</span>`
      : `<span class="badge badge-pass">${passed}/${total} ok</span>`;
  }

  // ---------- esito di una pagina: anteprima e confronto ----------

  // Fra le prove di una pagina (una per viewport) l'anteprima mostra la prima
  // che ha differenze: è quella che si vuole vedere. Se sono tutte a posto va
  // bene la prima, tanto sono uguali alla baseline.
  function pickEntry(entries) {
    return entries.find((e) => e.status === 'fail') || entries[0];
  }

  // Il diff (magenta sulle aree cambiate) racconta l'esito meglio dello scatto;
  // se manca — test passato, o report vecchio — si ripiega sullo scatto.
  function entryImage(entry) {
    return entry.images?.diff || entry.images?.test || entry.images?.reference || null;
  }

  const shotPreview = document.getElementById('shot-preview');
  let previewTimer = null;

  function hidePreview() {
    clearTimeout(previewTimer);
    shotPreview.hidden = true;
    shotPreview.innerHTML = '';
  }

  // Il riquadro è ancorato allo schermo: scorrendo resterebbe fermo mentre la
  // riga a cui si riferisce se ne va.
  window.addEventListener('scroll', () => { if (!shotPreview.hidden) hidePreview(); }, { passive: true });

  function placePreview(x, y) {
    const gap = 16;
    const pad = 10;
    const box = shotPreview.getBoundingClientRect();
    let left = x + gap;
    let top = y + gap;
    if (left + box.width > window.innerWidth - pad) left = x - box.width - gap;
    if (top + box.height > window.innerHeight - pad) top = window.innerHeight - box.height - pad;
    shotPreview.style.left = `${Math.max(pad, left)}px`;
    shotPreview.style.top = `${Math.max(pad, top)}px`;
  }

  // L'anteprima parte in ritardo: passando il mouse sulla tabella per arrivare
  // a un bottone non deve aprirsi e chiudersi a ogni riga attraversata.
  function schedulePreview(slug, entries, x, y) {
    clearTimeout(previewTimer);
    const entry = pickEntry(entries);
    const image = entryImage(entry);
    if (!image) return;
    previewTimer = setTimeout(() => {
      const diff = entry.status === 'fail'
        ? `${entry.misMatchPercentage ?? '?'}% diverso`
        : 'nessuna differenza';
      shotPreview.innerHTML = `<img alt="" src="${esc(reportAsset(slug, image))}">
        <div class="shot-preview-cap"><b>${esc(entry.viewport || '')}</b> · ${esc(diff)}</div>`;
      shotPreview.hidden = false;
      placePreview(x, y);
      // L'immagine arriva dopo: a quel punto il riquadro ha la sua dimensione
      // vera e va riposizionato, altrimenti esce dallo schermo.
      shotPreview.querySelector('img').addEventListener('load', () => placePreview(x, y), { once: true });
    }, 180);
  }

  const resultDialog = document.getElementById('result-dialog');
  const resultBody = document.getElementById('result-body');
  document.getElementById('result-close').addEventListener('click', () => resultDialog.close());
  resultDialog.addEventListener('close', () => { resultBody.innerHTML = ''; });

  function shotFigure(caption, slug, relPath, missing) {
    const body = relPath
      ? `<img loading="lazy" alt="${esc(caption)}" src="${esc(reportAsset(slug, relPath))}">`
      : `<div class="shot-missing">${esc(missing)}</div>`;
    return `<figure><figcaption>${esc(caption)}</figcaption>${body}</figure>`;
  }

  // Sopra la baseline si può mettere lo scatto o il diff: vederlo scorrere sul
  // riferimento dice subito se il magenta copre una regressione o un dettaglio.
  // È una scelta sola per tutta la modale e sopravvive al cambio di pagina.
  const scrubDiff = document.getElementById('scrub-diff');
  let scrubOverlayDiff = false;

  // Applicata sui pannelli già in pagina invece di ridisegnare, altrimenti i
  // cursori tornerebbero tutti a metà a ogni spunta.
  function applyScrubOverlay() {
    resultBody.querySelectorAll('.scrub').forEach((s) => {
      const img = s.querySelector('.scrub-top img');
      const useDiff = scrubOverlayDiff && Boolean(img.dataset.diffSrc);
      img.src = useDiff ? img.dataset.diffSrc : img.dataset.testSrc;
      img.alt = useDiff ? 'Differenze' : 'Ultimo test';
      s.querySelector('.scrub-tag-right').textContent = useDiff ? 'differenze' : 'ultimo test';
    });
  }

  scrubDiff.addEventListener('change', () => {
    scrubOverlayDiff = scrubDiff.checked;
    applyScrubOverlay();
  });

  // Confronto sovrapposto: baseline e ultimo test impilati, con un cursore da
  // trascinare che scopre l'uno o l'altro (lo scrubber del report BackstopJS).
  // Alla larghezza piena della modale gli scatti si leggono davvero, cosa che
  // affiancati in tre colonne non succede.
  function scrubPane(slug, entry) {
    const ref = entry.images?.reference;
    const test = entry.images?.test;
    if (!ref || !test) {
      return '<div class="shot-missing">confronto non disponibile: manca la baseline o lo scatto</div>';
    }
    const diff = entry.images?.diff;
    // Un viewport passato non ha un diff: lì sopra resta lo scatto, e a dirlo
    // è l'etichetta del pannello.
    const useDiff = scrubOverlayDiff && Boolean(diff);
    return `<div class="scrub" data-pos="50">
      <div class="scrub-scroll">
        <div class="scrub-stack">
          <img alt="Baseline" src="${esc(reportAsset(slug, ref))}">
          <div class="scrub-top">
            <img alt="${useDiff ? 'Differenze' : 'Ultimo test'}"
              src="${esc(reportAsset(slug, useDiff ? diff : test))}"
              data-test-src="${esc(reportAsset(slug, test))}"
              data-diff-src="${diff ? esc(reportAsset(slug, diff)) : ''}">
          </div>
        </div>
      </div>
      <span class="scrub-tag scrub-tag-left">baseline</span>
      <span class="scrub-tag scrub-tag-right">${useDiff ? 'differenze' : 'ultimo test'}</span>
      <div class="scrub-handle" role="slider" tabindex="0" aria-label="Cursore di confronto"
        aria-valuemin="0" aria-valuemax="100" aria-valuenow="50"></div>
    </div>`;
  }

  // Il cursore vive fuori dal contenitore che scorre (altrimenti sparirebbe
  // scorrendo l'immagine): la sua posizione va quindi in pixel, misurata sullo
  // stack, perché la percentuale di .scrub comprenderebbe la barra di scorrimento.
  function setScrub(scrub, pct) {
    const pos = Math.min(100, Math.max(0, pct));
    const stack = scrub.querySelector('.scrub-stack').getBoundingClientRect();
    const box = scrub.getBoundingClientRect();
    scrub.style.setProperty('--pos', `${pos}%`);
    // Lo stack può essere più stretto e centrato (scatti mobile): la maniglia
    // segue il suo bordo sinistro, non quello del pannello.
    scrub.style.setProperty('--handle-x', `${stack.left - box.left + (stack.width * pos) / 100}px`);
    scrub.querySelector('.scrub-handle').setAttribute('aria-valuenow', String(Math.round(pos)));
    scrub.dataset.pos = String(pos);
  }

  function syncScrubs() {
    resultBody.querySelectorAll('.scrub').forEach((s) => setScrub(s, Number(s.dataset.pos) || 50));
  }
  window.addEventListener('resize', () => { if (resultDialog.open) syncScrubs(); });
  // Finché l'immagine non è caricata lo stack non ha larghezza: si riallinea
  // quando arriva (load non fa bubbling, serve la fase di cattura).
  resultBody.addEventListener('load', (ev) => {
    const scrub = ev.target.closest?.('.scrub');
    if (scrub) setScrub(scrub, Number(scrub.dataset.pos) || 50);
  }, true);

  resultBody.addEventListener('pointerdown', (ev) => {
    const scrub = ev.target.closest('.scrub');
    if (!scrub || ev.button !== 0) return;
    const rect = scrub.querySelector('.scrub-stack').getBoundingClientRect();
    const moveTo = (e) => setScrub(scrub, ((e.clientX - rect.left) / rect.width) * 100);
    const stop = () => {
      scrub.removeEventListener('pointermove', moveTo);
      scrub.removeEventListener('pointerup', stop);
      scrub.removeEventListener('pointercancel', stop);
      scrub.classList.remove('is-dragging');
    };
    try { scrub.setPointerCapture(ev.pointerId); } catch { /* si trascina comunque, ma solo dentro il pannello */ }
    scrub.addEventListener('pointermove', moveTo);
    scrub.addEventListener('pointerup', stop);
    scrub.addEventListener('pointercancel', stop);
    scrub.classList.add('is-dragging');
    scrub.querySelector('.scrub-handle').focus();
    moveTo(ev);
    ev.preventDefault(); // niente selezione del testo né drag nativo dell'immagine
  });

  // Frecce sul cursore: fermate qui, altrimenti la modale cambierebbe pagina.
  resultBody.addEventListener('keydown', (ev) => {
    const handle = ev.target.closest('.scrub-handle');
    if (!handle) return;
    const scrub = handle.closest('.scrub');
    const pos = Number(scrub.dataset.pos) || 50;
    const step = ev.shiftKey ? 10 : 2;
    const next = { ArrowLeft: pos - step, ArrowRight: pos + step, Home: 0, End: 100 }[ev.key];
    if (next === undefined) return;
    setScrub(scrub, next);
    ev.preventDefault();
    ev.stopPropagation();
  });

  // Dalla modale si scorrono le pagine dell'ultimo test senza tornare alla
  // tabella: qui restano l'elenco su cui si naviga e la posizione corrente.
  const resultNav = { slug: null, items: [], index: 0 };
  let shotView = 'side'; // 'side' = tre colonne affiancate, 'scrub' = sovrapposte

  // Quanto spazio dare al confronto dipende dallo schermo, non da cosa si sta
  // guardando: a differenza della vista, questa scelta si ricorda tra sessioni.
  const FULL_KEY = 'backstopui.resultFull';
  const fullBtn = document.getElementById('result-full');

  function setResultFull(full) {
    resultDialog.classList.toggle('is-full', full);
    fullBtn.setAttribute('aria-pressed', String(full));
    fullBtn.textContent = full ? '⤡' : '⤢';
    const label = full ? 'Riporta alla dimensione normale' : 'Estendi a tutta la pagina';
    fullBtn.title = label;
    fullBtn.setAttribute('aria-label', label);
    writePref(FULL_KEY, full ? '1' : '0');
    // Cambia la larghezza degli scatti: i cursori di confronto vanno riallineati.
    if (resultDialog.open) syncScrubs();
  }

  setResultFull(readPref(FULL_KEY, '0') === '1');
  fullBtn.addEventListener('click', () => setResultFull(!resultDialog.classList.contains('is-full')));

  document.querySelectorAll('.view-switch [data-view]').forEach((btn) => {
    btn.addEventListener('click', () => {
      if (shotView === btn.dataset.view) return;
      shotView = btn.dataset.view;
      drawResult();
    });
  });

  function drawResult() {
    const { slug, items, index } = resultNav;
    const { scenario, entries } = items[index];
    const failed = entries.filter((e) => e.status === 'fail').length;
    const open = browserUrl(scenario.url);

    document.getElementById('result-title').textContent = scenario.label;
    const urlLink = document.getElementById('result-url');
    urlLink.textContent = scenario.url;
    urlLink.href = open;
    urlLink.title = open === scenario.url
      ? `Apri ${scenario.url} in una nuova scheda`
      : `Apri ${scenario.url} in una nuova scheda\n(dal browser diventa ${open})`;

    document.getElementById('result-links').innerHTML = `
      ${failed
        ? `<span class="badge badge-fail">${failed}/${entries.length} diversi</span>`
        : `<span class="badge badge-pass">${entries.length}/${entries.length} ok</span>`}
      <a href="${reportUrl(slug)}" target="_blank" rel="noopener noreferrer">report completo</a>`;

    document.getElementById('result-pos').textContent = `${index + 1} / ${items.length}`;
    const alone = items.length < 2;
    document.getElementById('result-prev').disabled = alone;
    document.getElementById('result-next').disabled = alone;

    // Chi apre il confronto cerca la differenza: i viewport che ce l'hanno
    // vanno per primi, gli altri restano nell'ordine della configurazione.
    const ordered = [...entries].sort((a, b) => (b.status === 'fail') - (a.status === 'fail'));

    document.querySelectorAll('.view-switch [data-view]').forEach((btn) => {
      btn.setAttribute('aria-pressed', String(btn.dataset.view === shotView));
    });

    // La spunta resta com'era: si disabilita solo dove non c'è alcun diff da
    // mostrare (pagina tutta verde), senza perdere la scelta fatta.
    document.getElementById('scrub-diff-wrap').hidden = shotView !== 'scrub';
    scrubDiff.checked = scrubOverlayDiff;
    scrubDiff.disabled = !entries.some((e) => e.images?.diff);

    resultBody.innerHTML = ordered.map((e) => `
      <section class="vp-result">
        <div class="vp-result-head">
          <span>${esc(e.viewport || 'viewport')}</span>
          ${e.status === 'fail'
            ? `<span class="badge badge-sm badge-fail">${esc(e.misMatchPercentage ?? '?')}% diverso</span>`
            : '<span class="badge badge-sm badge-pass">nessuna differenza</span>'}
        </div>
        ${shotView === 'scrub' ? scrubPane(slug, e) : `<div class="shots">
          ${shotFigure('Baseline', slug, e.images?.reference, 'baseline non disponibile')}
          ${shotFigure('Ultimo test', slug, e.images?.test, 'scatto non disponibile')}
          ${shotFigure('Differenze', slug, e.images?.diff, e.status === 'fail' ? 'diff non disponibile' : 'nessuna differenza')}
        </div>`}
      </section>`).join('');
    resultBody.scrollTop = 0;
    if (shotView === 'scrub') requestAnimationFrame(syncScrubs);
  }

  function stepResult(delta) {
    const total = resultNav.items.length;
    if (total < 2) return;
    resultNav.index = (resultNav.index + delta + total) % total;
    drawResult();
  }

  document.getElementById('result-prev').addEventListener('click', () => stepResult(-1));
  document.getElementById('result-next').addEventListener('click', () => stepResult(1));
  resultDialog.addEventListener('keydown', (ev) => {
    if (ev.key === 'ArrowLeft') { ev.preventDefault(); stepResult(-1); }
    else if (ev.key === 'ArrowRight') { ev.preventDefault(); stepResult(1); }
  });

  function openResultDialog(slug, items, index) {
    hidePreview();
    resultNav.slug = slug;
    resultNav.items = items;
    resultNav.index = index;
    drawResult();
    if (!resultDialog.open) resultDialog.showModal();
  }

  // ---------- pannello esecuzioni (globale) ----------

  const runCurrent = document.getElementById('run-current');
  const runProgress = document.getElementById('run-progress');
  const runProgressFill = document.getElementById('run-progress-fill');
  const runProgressLabel = document.getElementById('run-progress-label');
  const runLog = document.getElementById('run-log');
  const runHistory = document.getElementById('run-history');
  let eventSource = null;

  // Il pannello esecuzioni è di servizio: si chiude per lasciare tutta la
  // pagina alla tabella. Chiuso, lo stato del run resta leggibile dal pallino
  // sull'interruttore in testata; un run che parte lo riapre.
  const railToggle = document.getElementById('rail-toggle');
  const railDot = document.getElementById('rail-dot');
  const RAIL_KEY = 'backstopui.rail';

  function setRail(open) {
    document.body.classList.toggle('rail-hidden', !open);
    railToggle.setAttribute('aria-expanded', String(open));
    writePref(RAIL_KEY, open ? '1' : '0');
  }

  function setRailStatus(status) {
    railDot.className = `dot dot-${status || 'idle'}`;
  }

  setRail(readPref(RAIL_KEY, '1') !== '0');
  railToggle.addEventListener('click', () => setRail(document.body.classList.contains('rail-hidden')));
  document.getElementById('rail-hide').addEventListener('click', () => setRail(false));

  const COMMAND_LABEL = {
    reference: 'baseline',
    test: 'test',
    approve: 'approvazione',
  };

  function runLine(run) {
    const label = COMMAND_LABEL[run.command] || run.command;
    const status = {
      queued: 'in coda',
      running: 'in corso',
      success: 'completato',
      failed: run.command === 'test' ? 'differenze trovate' : 'errore',
      cancelled: 'annullato',
    }[run.status] || run.status;
    const stoppable = run.status === 'queued' || run.status === 'running';
    return `<div class="run-line">
      <span class="dot dot-${esc(run.status)}"></span>
      <b>${esc(run.project)}</b> · ${esc(label)} · ${esc(status)}
      ${stoppable ? `<button class="btn btn-ghost btn-stop" data-cancel-run="${esc(run.id)}">Ferma</button>` : ''}
    </div>`;
  }

  const WHEN_FMT = new Intl.DateTimeFormat('it-IT', {
    day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit',
  });

  function fmtWhen(iso) {
    if (!iso) return '';
    const d = new Date(iso);
    return Number.isNaN(d.getTime()) ? '' : WHEN_FMT.format(d);
  }

  async function refreshHistory() {
    try {
      const runs = await api('/api/runs');
      runHistory.innerHTML = runs
        .slice(0, 8)
        .map((r) => `<li><span class="dot dot-${esc(r.status)}"></span><b>${esc(r.project)}</b> ${esc(COMMAND_LABEL[r.command] || r.command)}${r.filter ? ' (filtro)' : ''}<time class="run-when">${esc(fmtWhen(r.startedAt || r.createdAt))}</time></li>`)
        .join('');
    } catch { /* pannello secondario: niente toast */ }
  }

  // Avanzamento di reference/test ricavato dal log di BackstopJS: la riga
  // "Selected N of M scenarios" dà gli scenari selezionati (rispetta il
  // filtro), e ogni scatto acquisito emette una riga "x Close Browser".
  // Scatti totali = scenari × viewport (il numero di viewport lo chiediamo
  // alla config del progetto). approve non acquisisce nulla: barra assente.
  function trackProgress(run) {
    let scenarioCount = null;
    let viewportCount = null;
    let captured = 0;
    let finished = false;

    function draw() {
      if (finished || (scenarioCount === null && captured === 0)) {
        runProgress.hidden = true;
        return;
      }
      runProgress.hidden = false;
      const total = scenarioCount && viewportCount ? scenarioCount * viewportCount : null;
      if (total) {
        const done = Math.min(captured, total);
        const pct = Math.round((done / total) * 100);
        runProgressFill.classList.remove('is-indeterminate');
        runProgressFill.style.width = pct + '%';
        runProgressLabel.textContent = `${pct}% · ${done}/${total} schermate`;
        runProgress.setAttribute('aria-valuenow', String(pct));
      } else {
        // Totale non ancora noto (viewport in arrivo): barra indeterminata.
        runProgressFill.classList.add('is-indeterminate');
        runProgressFill.style.width = '';
        runProgressLabel.textContent = 'Acquisizione schermate…';
        runProgress.removeAttribute('aria-valuenow');
      }
    }

    // Numero di viewport dalla config del progetto (una sola richiesta).
    api(`/api/projects/${run.project}`)
      .then((cfg) => { viewportCount = Array.isArray(cfg.viewports) ? cfg.viewports.length : null; draw(); })
      .catch(() => {});

    draw();

    return {
      onLine(line) {
        const sel = line.match(/Selected (\d+) of \d+ scenarios/);
        if (sel) { scenarioCount = Number(sel[1]); captured = 0; draw(); return; }
        if (line.includes('Close Browser')) { captured += 1; draw(); }
      },
      finish() { finished = true; draw(); },
    };
  }

  function watchRun(run) {
    eventSource?.close();
    runLog.textContent = '';
    runCurrent.innerHTML = runLine(run);
    setRailStatus(run.status);
    setRail(true);
    const progress = trackProgress(run);

    eventSource = new EventSource(`/api/runs/${run.id}/log`);
    eventSource.addEventListener('log', (ev) => {
      const { line } = JSON.parse(ev.data);
      progress.onLine(line);
      runLog.textContent += line + '\n';
      runLog.scrollTop = runLog.scrollHeight;
    });
    eventSource.addEventListener('status', (ev) => {
      const { run: updated } = JSON.parse(ev.data);
      runCurrent.innerHTML = runLine(updated);
      setRailStatus(updated.status);
      if (updated.status === 'success' || updated.status === 'failed' || updated.status === 'cancelled') {
        progress.finish();
        eventSource.close();
        refreshHistory();
        render(); // aggiorna badge/esiti della vista corrente
      }
    });
    eventSource.onerror = () => eventSource.close();
  }

  runCurrent.addEventListener('click', (ev) => {
    const btn = ev.target.closest('[data-cancel-run]');
    if (!btn) return;
    btn.disabled = true;
    api(`/api/runs/${btn.dataset.cancelRun}/cancel`, { method: 'POST' })
      .catch((err) => toast(err.message));
  });

  const LOCAL_HOSTNAMES = new Set(['localhost', '127.0.0.1']);

  function replaceLocalHost(url) {
    try {
      const u = new URL(url);
      if (!LOCAL_HOSTNAMES.has(u.hostname)) return url;
      u.hostname = 'host.docker.internal';
      return u.href;
    } catch {
      return url;
    }
  }

  // Se uno scenario punta a localhost/127.0.0.1 non raggiungibile dal
  // container (tipicamente un dev server sulla macchina dell'utente), il
  // server risponde 409: qui si propone la correzione (sostituire l'host
  // con host.docker.internal, che Docker mappa alla macchina host) e, se
  // confermata, si riprova il run con gli URL corretti e persistiti.
  async function tryFixLocalhostAndRetry(slug, err) {
    if (err.status !== 409 || err.body?.code !== 'LOCALHOST_UNREACHABLE') throw err;
    const list = err.body.affected.map((s) => `• ${s.label}: ${s.url}`).join('\n');
    const ok = confirm(
      `${err.body.affected.length === 1 ? 'Questa pagina punta' : 'Queste pagine puntano'} `
      + `a un indirizzo locale non raggiungibile dal container:\n\n${list}\n\n`
      + 'Se il sito gira sulla tua macchina (es. un dev server), sostituisco "localhost"/"127.0.0.1" '
      + 'con "host.docker.internal" (l\'host visto da dentro Docker) in tutte le URL del progetto. Continuare?'
    );
    if (!ok) return null;

    const config = await api(`/api/projects/${slug}`);
    for (const sc of config.scenarios) sc.url = replaceLocalHost(sc.url);
    await api(`/api/projects/${slug}`, { method: 'PUT', body: JSON.stringify(config) });
    render(); // la vista del progetto mostra ancora gli URL vecchi finché non si aggiorna
    return true;
  }

  async function launchRun(slug, command, scenarioLabel) {
    let run;
    try {
      ({ run } = await api(`/api/projects/${slug}/runs`, {
        method: 'POST',
        body: JSON.stringify({ command, scenarioLabel }),
      }));
    } catch (err) {
      const fixed = await tryFixLocalhostAndRetry(slug, err);
      if (!fixed) return;
      ({ run } = await api(`/api/projects/${slug}/runs`, {
        method: 'POST',
        body: JSON.stringify({ command, scenarioLabel }),
      }));
    }
    watchRun(run);
    refreshHistory();
    // La baseline azzera lato server l'esito dell'ultimo test: senza questo
    // la vista continuerebbe a mostrare il vecchio conteggio per tutto il run.
    if (command === 'reference') render();
  }

  // Al load: se c'è un run attivo, riaggancia il log
  async function resumeActiveRun() {
    try {
      const runs = await api('/api/runs');
      const active = runs.find((r) => r.status === 'running' || r.status === 'queued');
      if (active) watchRun(active);
      else if (runs[0]) setRailStatus(runs[0].status);
      refreshHistory();
    } catch { /* ignora */ }
  }

  // ---------- vista: dashboard ----------

  async function renderDashboard() {
    const list = await api('/api/projects');

    const cards = list.map((p) => {
      const hasResult = Boolean(p.lastResult);
      return `<article class="card">
        <h3><a href="#/project/${esc(p.slug)}">${esc(p.slug)}</a></h3>
        ${badge(p.lastResult)}
        <div class="card-meta">
          <span>${p.scenarioCount} pagine</span>
          <span>${p.viewportCount} viewport</span>
        </div>
        <div class="card-actions">
          <button class="btn" data-test="${esc(p.slug)}" ${p.scenarioCount ? '' : 'disabled'}>Esegui test</button>
          <a class="btn btn-ghost ${hasResult ? '' : 'is-disabled'}" ${hasResult ? `href="${reportUrl(p.slug)}" target="_blank"` : 'aria-disabled="true"'}>Report</a>
        </div>
      </article>`;
    }).join('');

    view.innerHTML = `
      <h1>Progetti</h1>
      <p class="hint">Ogni progetto raggruppa le pagine da tenere sotto controllo visivo.</p>
      <section class="section">
        <form id="new-project" class="inline-form">
          <input name="name" placeholder="nome del nuovo progetto" required autocomplete="off">
          <button class="btn btn-primary" type="submit">Crea progetto</button>
        </form>
      </section>
      ${list.length
        ? `<div class="cards">${cards}</div>`
        : '<div class="empty" style="margin-top:1rem">Nessun progetto. Creane uno qui sopra: poi aggiungi le URL da controllare.</div>'}
    `;

    view.querySelector('#new-project').addEventListener('submit', async (ev) => {
      ev.preventDefault();
      const name = new FormData(ev.target).get('name');
      try {
        const { slug } = await api('/api/projects', { method: 'POST', body: JSON.stringify({ name }) });
        location.hash = `#/project/${slug}`;
      } catch (err) { toast(err.message); }
    });

    view.querySelectorAll('[data-test]').forEach((btn) => {
      btn.addEventListener('click', () => {
        launchRun(btn.dataset.test, 'test').catch((err) => toast(err.message));
      });
    });
  }

  // ---------- vista: dettaglio progetto ----------

  function scenarioFromForm(form) {
    const data = new FormData(form);
    const lines = (name) => String(data.get(name) || '')
      .split('\n').map((s) => s.trim()).filter(Boolean);
    const scenario = {
      label: String(data.get('label')).trim(),
      url: String(data.get('url')).trim(),
      delay: Number(data.get('delay')) || 0,
      misMatchThreshold: Number(data.get('misMatchThreshold')) || 0.1,
      requireSameDimensions: true,
      hideSelectors: lines('hideSelectors'),
      removeSelectors: lines('removeSelectors'),
    };
    const click = String(data.get('clickSelector') || '').trim();
    if (click) scenario.clickSelector = click;
    return scenario;
  }

  // Impostazioni predefinite a livello di progetto: usate come punto di
  // partenza per nuove pagine (form manuale e crawler). Gestisce anche
  // progetti creati prima di questa funzionalità (pageDefaults assente).
  function projectDefaults(config) {
    const d = config.pageDefaults || {};
    return {
      delay: d.delay ?? 300,
      misMatchThreshold: d.misMatchThreshold ?? 0.1,
      clickSelector: d.clickSelector || '',
      hideSelectors: d.hideSelectors || [],
      removeSelectors: d.removeSelectors || [],
    };
  }

  function defaultsFromForm(form) {
    const data = new FormData(form);
    const lines = (name) => String(data.get(name) || '')
      .split('\n').map((s) => s.trim()).filter(Boolean);
    const defaults = {
      delay: Number(data.get('delay')) || 0,
      misMatchThreshold: Number(data.get('misMatchThreshold')) || 0.1,
      hideSelectors: lines('hideSelectors'),
      removeSelectors: lines('removeSelectors'),
    };
    const click = String(data.get('clickSelector') || '').trim();
    if (click) defaults.clickSelector = click;
    return defaults;
  }

  // Le pagine sono valori concreti: alla creazione ereditano i predefiniti
  // del progetto, poi restano modificabili singolarmente senza legame col
  // progetto (coerente col fatto che BackstopJS legge scenari già risolti).
  function openScenarioDialog(scenario, defaults, onSave) {
    const dialog = document.getElementById('scenario-dialog');
    const form = document.getElementById('scenario-form');
    document.getElementById('scenario-dialog-title').textContent =
      scenario ? `Modifica: ${scenario.label}` : 'Nuova pagina da controllare';

    const base = scenario || defaults;
    form.label.value = scenario?.label || '';
    form.url.value = scenario?.url || '';
    form.delay.value = base?.delay ?? 300;
    form.misMatchThreshold.value = base?.misMatchThreshold ?? 0.1;
    form.clickSelector.value = base?.clickSelector || '';
    form.hideSelectors.value = (base?.hideSelectors || []).join('\n');
    form.removeSelectors.value = (base?.removeSelectors || []).join('\n');

    form.onsubmit = (ev) => {
      ev.preventDefault();
      if (!form.reportValidity()) return;
      onSave(scenarioFromForm(form), scenario);
      dialog.close();
    };
    document.getElementById('scenario-cancel').onclick = () => dialog.close();
    dialog.showModal();
  }

  async function renderProject(slug) {
    let config;
    try {
      config = await api(`/api/projects/${slug}`);
    } catch (err) {
      view.innerHTML = `<p class="crumb"><a href="#/">← progetti</a></p>
        <div class="empty">${esc(err.message)}</div>`;
      return;
    }
    const defaults = projectDefaults(config);
    const lastResult = await api(`/api/projects/${slug}/result`).catch(() => null);
    // L'ultimo test ha un esito per ogni coppia pagina×viewport: raggruppati
    // per pagina servono sia alla colonna "esito" sia al confronto in modale.
    const testsByLabel = new Map();
    for (const t of lastResult?.tests || []) {
      if (!testsByLabel.has(t.label)) testsByLabel.set(t.label, []);
      testsByLabel.get(t.label).push(t);
    }

    function summarize(entries) {
      const fail = entries.filter((e) => e.status === 'fail');
      return {
        total: entries.length,
        fail: fail.length,
        pass: entries.length - fail.length,
        worst: fail.reduce((max, e) => Math.max(max, Number(e.misMatchPercentage) || 0), 0),
      };
    }

    // L'approvazione agisce sul report dell'ultimo test. Se quel test era
    // filtrato su una pagina, copre solo quella: dichiariamo lo scope reale
    // invece di promettere "tutte".
    const testedLabels = [...new Set((lastResult?.tests || []).map((t) => t.label))];
    const partialScope = Boolean(lastResult) && testedLabels.length < config.scenarios.length;
    const nothingToApprove = !lastResult || lastResult.summary.failed === 0;

    let approveLabel = 'Approva tutte le differenze';
    if (partialScope) {
      approveLabel = testedLabels.length === 1
        ? `Approva le differenze di «${testedLabels[0]}»`
        : `Approva le differenze dell'ultimo test (${testedLabels.length} pagine)`;
    }

    let approveHint = "Promuove a baseline gli screenshot dell'ultimo test.";
    if (!lastResult) approveHint = 'Nessun test eseguito finora.';
    else if (lastResult.summary.failed === 0) approveHint = 'Nessuna differenza da approvare.';
    else if (partialScope) {
      approveHint = `L'ultimo test riguardava solo: ${testedLabels.join(', ')}. `
        + 'Per approvare tutte le pagine esegui prima un test completo.';
    }

    async function saveConfig(mutate) {
      const next = structuredClone(config);
      mutate(next);
      try {
        config = await api(`/api/projects/${slug}`, { method: 'PUT', body: JSON.stringify(next) });
        render();
      } catch (err) { toast(err.message); }
    }

    // La cella è un bottone: aprire il confronto deve essere raggiungibile
    // anche da tastiera, non solo cliccando la riga.
    function outcomeCell(res, i) {
      if (!res) return '<span class="badge badge-sm badge-none">—</span>';
      const inner = res.fail
        ? `<span class="badge badge-sm badge-fail">${res.fail}/${res.total} div.</span>`
        : `<span class="badge badge-sm badge-pass">${res.pass}/${res.total} ok</span>`;
      const worst = res.worst ? ` — differenza massima ${res.worst}%` : '';
      const what = res.fail
        ? `${res.fail} viewport su ${res.total} con differenze${worst}`
        : `${res.total} viewport senza differenze`;
      return `<button type="button" class="outcome-btn" data-inspect="${i}"
        title="${esc(`${what}. Apri il confronto.`)}">${inner}</button>`;
    }

    const scenarioRows = config.scenarios.map((sc, i) => {
      const hidden = sc.hideSelectors?.length || 0;
      const removed = sc.removeSelectors?.length || 0;
      const entries = testsByLabel.get(sc.label);
      const res = entries ? summarize(entries) : null;
      const canApprove = Boolean(res?.fail);
      const approveTitle = canApprove
        ? `Promuove a baseline gli screenshot di "${sc.label}" dall'ultimo test.`
        : "Nessuna differenza da approvare per questa pagina nell'ultimo test.";
      const open = browserUrl(sc.url);
      const urlTitle = open === sc.url
        ? `Apri ${sc.url} in una nuova scheda`
        : `Apri ${sc.url} in una nuova scheda\n(dal browser diventa ${open})`;
      return `<tr data-row="${i}" class="${canApprove ? 'row-fail' : ''} ${res ? 'is-inspectable' : ''}"
        ${res ? 'title="Clicca la riga per vedere il confronto"' : ''}>
        <td class="mono truncate" title="${esc(sc.label)}">${esc(sc.label)}</td>
        <td class="mono truncate">
          <a class="url-link" href="${esc(open)}" target="_blank" rel="noopener noreferrer" title="${esc(urlTitle)}">${esc(sc.url)}</a>
        </td>
        <td>${outcomeCell(res, i)}</td>
        <td class="mono num">${sc.delay ?? 0}</td>
        <td class="mono num">${sc.misMatchThreshold ?? 0.1}</td>
        <td class="mono num" title="${esc(`${hidden} area/e nascoste, ${removed} rimosse`)}">${hidden || removed ? `${hidden}+${removed}` : '—'}</td>
        <td><div class="actions-cell">
          <button class="btn btn-ghost" data-edit="${i}" title="Modifica questa pagina">Modifica</button>
          <button class="btn btn-ghost" data-run-one="${i}" title="Esegui il test solo per questa pagina">Test</button>
          <button class="btn btn-ghost" data-approve-one="${i}" title="${esc(approveTitle)}" ${canApprove ? '' : 'disabled'}>Approva</button>
          <button class="btn btn-danger" data-del="${i}" title="Rimuovi questa pagina dal progetto">Elimina</button>
        </div></td>
      </tr>`;
    }).join('');

    const vpRows = config.viewports.map((vp, i) => `
      <div class="vp-row" data-vp="${i}">
        <input value="${esc(vp.label)}" data-field="label" aria-label="nome viewport">
        <input value="${vp.width}" data-field="width" type="number" min="1" aria-label="larghezza">
        <input value="${vp.height}" data-field="height" type="number" min="1" aria-label="altezza">
        <button class="btn btn-ghost" data-vp-del="${i}" ${config.viewports.length === 1 ? 'disabled' : ''}>×</button>
      </div>`).join('');

    const configNote = [
      `${config.viewports.length} viewport: ${config.viewports.map((vp) => `${vp.width}×${vp.height}`).join(', ')}`,
      `attesa ${defaults.delay} ms`,
      `soglia ${defaults.misMatchThreshold}%`,
      `discreta ${config.stealth ? 'attiva' : 'spenta'}`,
    ].join(' · ');

    view.innerHTML = `
      <p class="crumb"><a href="#/">← progetti</a></p>
      <div class="project-head">
        <h1 class="mono">${esc(slug)}</h1>
        ${badge(lastResult)}
        ${lastResult ? `<span class="hint">ultimo test ${esc(fmtWhen(lastResult.at))}</span>` : ''}
        ${lastResult ? `<a class="btn btn-ghost" href="${reportUrl(slug)}" target="_blank">Apri report</a>` : ''}
      </div>

      <div class="run-actions">
        <button class="btn" id="run-reference">Crea/aggiorna baseline</button>
        <button class="btn btn-primary" id="run-test" ${config.scenarios.length ? '' : 'disabled'}>Esegui test</button>
        <button class="btn" id="run-approve" title="${esc(approveHint)}" ${nothingToApprove ? 'disabled' : ''}>${esc(approveLabel)}</button>
        <span class="spacer"></span>
        <button class="btn btn-danger" id="del-project">Elimina progetto</button>
      </div>

      <details class="panel" data-panel="config" ${isPanelOpen('config') ? 'open' : ''}>
        <summary>Configurazione<span class="summary-note">${esc(configNote)}</span></summary>
        <div class="panel-body config-grid">
          <div class="config-block">
            <h3>Viewport (${config.viewports.length})</h3>
            <p class="hint">Ogni pagina viene fotografata a tutte queste dimensioni.</p>
            <div id="vp-editor">${vpRows}</div>
            <div class="section-actions">
              <button class="btn btn-ghost" id="vp-add">Aggiungi viewport</button>
              <button class="btn btn-primary" id="vp-save">Salva viewport</button>
            </div>
          </div>

          <div class="config-block">
            <h3>Impostazioni predefinite pagina</h3>
            <p class="hint">Punto di partenza per le nuove pagine (a mano o dal crawler). Ogni pagina resta modificabile singolarmente.</p>
            <form id="defaults-form" class="settings-form">
              <div class="form-row">
                <label>Attesa dopo il load (ms)
                  <input name="delay" type="number" min="0" step="100" value="${defaults.delay}">
                </label>
                <label>Soglia differenze (%)
                  <input name="misMatchThreshold" type="number" min="0" max="100" step="0.1" value="${defaults.misMatchThreshold}">
                </label>
              </div>
              <label>Clicca prima dello screenshot (selettore CSS)
                <input name="clickSelector" placeholder="es. #accetta-cookie" value="${esc(defaults.clickSelector)}" autocomplete="off">
              </label>
              <div class="form-row">
                <label>Aree da nascondere <small>uno per riga — lo spazio resta</small>
                  <textarea name="hideSelectors" rows="3" placeholder=".carousel&#10;.orologio">${esc(defaults.hideSelectors.join('\n'))}</textarea>
                </label>
                <label>Aree da rimuovere <small>uno per riga — lo spazio collassa</small>
                  <textarea name="removeSelectors" rows="3" placeholder=".cookie-banner">${esc(defaults.removeSelectors.join('\n'))}</textarea>
                </label>
              </div>
              <div class="section-actions">
                <button class="btn btn-primary" type="submit">Salva impostazioni predefinite</button>
              </div>
            </form>
          </div>

          <div class="config-block">
            <h3>Modalità discreta</h3>
            <p class="hint">
              Nasconde al sito che le pagine vengono aperte da un browser pilotato: user agent senza
              «Headless», <span class="mono">navigator.webdriver</span> a false, lingua e fuso coerenti,
              e header da browser vero anche per il crawler. Serve quando un WAF risponde con una
              challenge o un 403 invece che con la pagina.
            </p>
            <label class="toggle">
              <input type="checkbox" id="stealth-toggle" ${config.stealth ? 'checked' : ''}>
              <span>Maschera l'automazione del browser</span>
            </label>
            <p class="hint">
              Cambia il modo in cui il sito viene richiesto (user agent, lingua, fuso): dopo aver
              attivato o spento questa opzione rifai la baseline, altrimenti il primo test può
              segnalare differenze che non sono regressioni.
            </p>
          </div>
        </div>
      </details>

      <details class="panel" data-panel="crawler" ${isPanelOpen('crawler') ? 'open' : ''}>
        <summary>Scopri pagine (crawler)<span class="summary-note">aggiunge pagine seguendo i link da un URL di partenza</span></summary>
        <div class="panel-body">
          <form id="crawl-form" class="crawl-form">
            <input name="url" placeholder="URL di partenza, es. http://demo/ o https://www.example.com" required>
            <input name="maxPages" type="number" value="30" min="1" max="100" title="numero massimo di pagine">
            <button class="btn" type="submit">Scopri pagine</button>
          </form>
          <div id="crawl-results" class="crawl-results"></div>
        </div>
      </details>

      <section class="section">
        <div class="section-head">
          <h2>Pagine sotto controllo (${config.scenarios.length})</h2>
          <div class="section-head-actions">
            <button class="btn btn-primary btn-mini" id="add-scenario">Aggiungi pagina</button>
            <button class="btn btn-danger btn-mini" id="del-all-scenarios" ${config.scenarios.length ? '' : 'disabled'}>Elimina tutte</button>
          </div>
        </div>
        ${config.scenarios.length ? `<div class="table-wrap"><table class="scenarios-table">
          <colgroup>
            <col class="c-name"><col class="c-url"><col class="c-res">
            <col class="c-delay"><col class="c-thr"><col class="c-ign"><col class="c-act">
          </colgroup>
          <thead><tr>
            <th>Nome</th><th>URL</th><th>Esito</th>
            <th title="attesa dopo il load, in millisecondi">Attesa</th>
            <th title="soglia differenze, in percentuale">Soglia</th>
            <th title="aree ignorate: nascoste + rimosse">Aree</th>
            <th>Azioni</th>
          </tr></thead>
          <tbody>${scenarioRows}</tbody>
        </table></div>` : '<div class="empty">Nessuna pagina. Aggiungine una a mano o scoprila col crawler qui sopra.</div>'}
      </section>
    `;

    view.querySelectorAll('details.panel').forEach((panel) => {
      panel.addEventListener('toggle', () => setPanelOpen(panel.dataset.panel, panel.open));
    });

    // --- esito della singola pagina: anteprima al passaggio, confronto al click ---
    const tbody = view.querySelector('.scenarios-table tbody');

    // Le pagine con un esito, nell'ordine della tabella: è l'elenco su cui
    // scorrono le frecce della modale.
    const inspectable = config.scenarios
      .map((scenario) => ({ scenario, entries: testsByLabel.get(scenario.label) }))
      .filter((item) => item.entries?.length);

    function entriesOfRow(el) {
      const row = el?.closest('tr[data-row]');
      if (!row) return null;
      const scenario = config.scenarios[Number(row.dataset.row)];
      return inspectable.find((item) => item.scenario === scenario) || null;
    }

    function inspectRow(el) {
      const found = entriesOfRow(el);
      if (found) openResultDialog(slug, inspectable, inspectable.indexOf(found));
    }

    if (tbody) {
      let hovered = null;
      tbody.addEventListener('mouseover', (ev) => {
        const row = ev.target.closest('tr[data-row]');
        if (row === hovered) return;
        hovered = row;
        hidePreview();
        const found = entriesOfRow(row);
        if (found) schedulePreview(slug, found.entries, ev.clientX, ev.clientY);
      });
      tbody.addEventListener('mouseleave', () => { hovered = null; hidePreview(); });

      // Il click sulla riga apre il confronto, ma URL e comandi restano loro.
      tbody.addEventListener('click', (ev) => {
        if (ev.target.closest('a, button, input')) return;
        inspectRow(ev.target);
      });
    }

    view.querySelectorAll('[data-inspect]').forEach((btn) => {
      btn.addEventListener('click', () => inspectRow(btn));
    });

    // --- azioni run ---
    const goRun = (command, scenarioLabel) =>
      launchRun(slug, command, scenarioLabel).catch((err) => toast(err.message));

    view.querySelector('#run-reference').addEventListener('click', () => {
      if (confirm('Sovrascrive la baseline con lo stato ATTUALE delle pagine. Continuare?')) {
        goRun('reference');
      }
    });
    view.querySelector('#run-test').addEventListener('click', () => goRun('test'));
    view.querySelector('#run-approve').addEventListener('click', () => {
      const scope = partialScope
        ? `Verranno approvate solo le differenze di: ${testedLabels.join(', ')}.\n`
          + 'Per approvare tutte le pagine esegui prima un test completo.\n\n'
        : '';
      if (confirm(`${scope}Promuove gli screenshot dell'ultimo test a nuova baseline. Continuare?`)) {
        goRun('approve');
      }
    });

    // --- elimina progetto ---
    view.querySelector('#del-project').addEventListener('click', async () => {
      const typed = prompt(`Eliminazione definitiva di progetto, baseline e report.\nScrivi "${slug}" per confermare:`);
      if (typed !== slug) return;
      try {
        await api(`/api/projects/${slug}`, { method: 'DELETE' });
        location.hash = '#/';
      } catch (err) { toast(err.message); }
    });

    // --- impostazioni predefinite ---
    view.querySelector('#defaults-form').addEventListener('submit', (ev) => {
      ev.preventDefault();
      const next = defaultsFromForm(ev.target);
      saveConfig((cfg) => { cfg.pageDefaults = next; });
    });

    // --- modalità discreta ---
    view.querySelector('#stealth-toggle').addEventListener('change', (ev) => {
      const enabled = ev.target.checked;
      saveConfig((cfg) => { cfg.stealth = enabled; });
    });

    // --- scenari ---
    view.querySelector('#add-scenario').addEventListener('click', () => {
      openScenarioDialog(null, defaults, (scenario) => {
        saveConfig((cfg) => cfg.scenarios.push(scenario));
      });
    });

    view.querySelectorAll('[data-edit]').forEach((btn) => {
      btn.addEventListener('click', () => {
        const i = Number(btn.dataset.edit);
        openScenarioDialog(config.scenarios[i], defaults, (updated) => {
          saveConfig((cfg) => {
            // preserva i campi avanzati non gestiti dal form
            cfg.scenarios[i] = { ...cfg.scenarios[i], ...updated };
            if (!updated.clickSelector) delete cfg.scenarios[i].clickSelector;
          });
        });
      });
    });

    view.querySelectorAll('[data-run-one]').forEach((btn) => {
      btn.addEventListener('click', () =>
        goRun('test', config.scenarios[Number(btn.dataset.runOne)].label));
    });

    view.querySelectorAll('[data-approve-one]').forEach((btn) => {
      btn.addEventListener('click', () => {
        const label = config.scenarios[Number(btn.dataset.approveOne)].label;
        if (confirm(`Approva la nuova baseline solo per "${label}"?`)) {
          goRun('approve', label);
        }
      });
    });

    view.querySelectorAll('[data-del]').forEach((btn) => {
      btn.addEventListener('click', () => {
        const i = Number(btn.dataset.del);
        if (confirm(`Rimuovere "${config.scenarios[i].label}" dal progetto?`)) {
          saveConfig((cfg) => cfg.scenarios.splice(i, 1));
        }
      });
    });

    view.querySelector('#del-all-scenarios')?.addEventListener('click', () => {
      if (confirm(`Rimuovere tutte le ${config.scenarios.length} pagine dal progetto?`)) {
        saveConfig((cfg) => { cfg.scenarios = []; });
      }
    });

    // --- crawler ---
    const crawlResults = view.querySelector('#crawl-results');
    view.querySelector('#crawl-form').addEventListener('submit', async (ev) => {
      ev.preventDefault();
      const data = new FormData(ev.target);
      crawlResults.innerHTML = '<p class="hint">Scansione in corso…</p>';
      try {
        const { pages, truncated } = await api('/api/crawl', {
          method: 'POST',
          body: JSON.stringify({
            url: data.get('url'),
            maxPages: Number(data.get('maxPages')),
            stealth: config.stealth,
          }),
        });
        const known = new Set(config.scenarios.map((s) => s.url));
        const fresh = pages.filter((p) => !known.has(p.url));
        if (!fresh.length) {
          crawlResults.innerHTML = '<div class="empty">Nessuna pagina nuova trovata.</div>';
          return;
        }
        crawlResults.innerHTML = `
          ${fresh.map((p, i) => `<label>
            <input type="checkbox" checked data-crawl="${i}">
            <span>${esc(p.url)}</span> <span class="title">${esc(p.title)}</span>
          </label>`).join('')}
          ${truncated ? '<p class="hint">Elenco troncato: alza il limite per continuare.</p>' : ''}
          <div class="section-actions">
            <button class="btn btn-primary" id="crawl-add">Aggiungi selezionate</button>
          </div>`;
        crawlResults.querySelector('#crawl-add').addEventListener('click', () => {
          const chosen = [...crawlResults.querySelectorAll('[data-crawl]:checked')]
            .map((cb) => fresh[Number(cb.dataset.crawl)]);
          saveConfig((cfg) => {
            const labels = new Set(cfg.scenarios.map((s) => s.label));
            for (const page of chosen) {
              let label = new URL(page.url).pathname.replace(/\/$/, '') || 'home';
              label = label.replace(/^\//, '').replace(/\//g, ' / ') || 'home';
              while (labels.has(label)) label += ' (2)';
              labels.add(label);
              const scenario = {
                label,
                url: page.url,
                delay: defaults.delay,
                misMatchThreshold: defaults.misMatchThreshold,
                requireSameDimensions: true,
                hideSelectors: [...defaults.hideSelectors],
                removeSelectors: [...defaults.removeSelectors],
              };
              if (defaults.clickSelector) scenario.clickSelector = defaults.clickSelector;
              cfg.scenarios.push(scenario);
            }
          });
        });
      } catch (err) {
        crawlResults.innerHTML = `<div class="empty">${esc(err.message)}</div>`;
      }
    });

    // --- viewport ---
    view.querySelector('#vp-add').addEventListener('click', () => {
      saveConfig((cfg) => cfg.viewports.push({ label: 'nuovo', width: 1280, height: 800 }));
    });
    view.querySelectorAll('[data-vp-del]').forEach((btn) => {
      btn.addEventListener('click', () => {
        saveConfig((cfg) => cfg.viewports.splice(Number(btn.dataset.vpDel), 1));
      });
    });
    view.querySelector('#vp-save').addEventListener('click', () => {
      const rows = [...view.querySelectorAll('.vp-row')];
      saveConfig((cfg) => {
        cfg.viewports = rows.map((row) => ({
          label: row.querySelector('[data-field="label"]').value.trim(),
          width: Number(row.querySelector('[data-field="width"]').value),
          height: Number(row.querySelector('[data-field="height"]').value),
        }));
      });
    });
  }

  // ---------- router ----------

  function render() {
    hidePreview(); // la vista viene sostituita: nessun mouseleave arriverebbe
    const hash = location.hash || '#/';
    const match = hash.match(/^#\/project\/([a-z0-9-]+)$/);
    if (match) {
      renderProject(match[1]).catch((err) => toast(err.message));
    } else {
      renderDashboard().catch((err) => toast(err.message));
    }
  }

  window.addEventListener('hashchange', render);
  render();
  resumeActiveRun();
})();
