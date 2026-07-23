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
    if (!res.ok) throw new Error(body.error || `Errore ${res.status}`);
    return body;
  }

  function reportUrl(slug) {
    return `/reports/${slug}/backstop_data/html_report/index.html`;
  }

  function badge(lastResult) {
    if (!lastResult) return '<span class="badge badge-none">mai testato</span>';
    const { passed, failed, total } = lastResult.summary;
    return failed > 0
      ? `<span class="badge badge-fail">${failed}/${total} diversi</span>`
      : `<span class="badge badge-pass">${passed}/${total} ok</span>`;
  }

  // ---------- pannello esecuzioni (globale) ----------

  const runCurrent = document.getElementById('run-current');
  const runLog = document.getElementById('run-log');
  const runHistory = document.getElementById('run-history');
  let eventSource = null;

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
    }[run.status];
    return `<div class="run-line">
      <span class="dot dot-${esc(run.status)}"></span>
      <b>${esc(run.project)}</b> · ${esc(label)} · ${esc(status)}
    </div>`;
  }

  async function refreshHistory() {
    try {
      const runs = await api('/api/runs');
      runHistory.innerHTML = runs
        .slice(0, 8)
        .map((r) => `<li><span class="dot dot-${esc(r.status)}"></span><b>${esc(r.project)}</b> ${esc(COMMAND_LABEL[r.command] || r.command)}${r.filter ? ' (filtro)' : ''}</li>`)
        .join('');
    } catch { /* pannello secondario: niente toast */ }
  }

  function watchRun(run) {
    eventSource?.close();
    runLog.textContent = '';
    runCurrent.innerHTML = runLine(run);

    eventSource = new EventSource(`/api/runs/${run.id}/log`);
    eventSource.addEventListener('log', (ev) => {
      const { line } = JSON.parse(ev.data);
      runLog.textContent += line + '\n';
      runLog.scrollTop = runLog.scrollHeight;
    });
    eventSource.addEventListener('status', (ev) => {
      const { run: updated } = JSON.parse(ev.data);
      runCurrent.innerHTML = runLine(updated);
      if (updated.status === 'success' || updated.status === 'failed') {
        eventSource.close();
        refreshHistory();
        render(); // aggiorna badge/esiti della vista corrente
      }
    });
    eventSource.onerror = () => eventSource.close();
  }

  async function launchRun(slug, command, scenarioLabel) {
    const { run } = await api(`/api/projects/${slug}/runs`, {
      method: 'POST',
      body: JSON.stringify({ command, scenarioLabel }),
    });
    watchRun(run);
    refreshHistory();
  }

  // Al load: se c'è un run attivo, riaggancia il log
  async function resumeActiveRun() {
    try {
      const runs = await api('/api/runs');
      const active = runs.find((r) => r.status === 'running' || r.status === 'queued');
      if (active) watchRun(active);
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

  function openScenarioDialog(scenario, onSave) {
    const dialog = document.getElementById('scenario-dialog');
    const form = document.getElementById('scenario-form');
    document.getElementById('scenario-dialog-title').textContent =
      scenario ? `Modifica: ${scenario.label}` : 'Nuova pagina da controllare';

    form.label.value = scenario?.label || '';
    form.url.value = scenario?.url || '';
    form.delay.value = scenario?.delay ?? 300;
    form.misMatchThreshold.value = scenario?.misMatchThreshold ?? 0.1;
    form.clickSelector.value = scenario?.clickSelector || '';
    form.hideSelectors.value = (scenario?.hideSelectors || []).join('\n');
    form.removeSelectors.value = (scenario?.removeSelectors || []).join('\n');

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
    const lastResult = await api(`/api/projects/${slug}/result`).catch(() => null);
    const failsByScenario = new Set(
      (lastResult?.tests || []).filter((t) => t.status === 'fail').map((t) => t.label)
    );

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

    const scenarioRows = config.scenarios.map((sc, i) => {
      const ignored = (sc.hideSelectors?.length || 0) + (sc.removeSelectors?.length || 0);
      const canApprove = failsByScenario.has(sc.label);
      const approveTitle = canApprove
        ? `Promuove a baseline gli screenshot di "${sc.label}" dall'ultimo test.`
        : "Nessuna differenza da approvare per questa pagina nell'ultimo test.";
      return `<tr class="${canApprove ? 'row-fail' : ''}">
        <td class="mono truncate" title="${esc(sc.label)}">${esc(sc.label)}</td>
        <td class="mono truncate" title="${esc(sc.url)}">${esc(sc.url)}</td>
        <td class="mono">${ignored || '—'}</td>
        <td><div class="actions-cell">
          <button class="btn btn-ghost" data-edit="${i}">Modifica</button>
          <button class="btn btn-ghost" data-run-one="${i}">Test</button>
          <button class="btn btn-ghost" data-approve-one="${i}" title="${esc(approveTitle)}" ${canApprove ? '' : 'disabled'}>Approva</button>
          <button class="btn btn-danger" data-del="${i}">Elimina</button>
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

    view.innerHTML = `
      <p class="crumb"><a href="#/">← progetti</a></p>
      <div class="project-head">
        <h1 class="mono">${esc(slug)}</h1>
        ${badge(lastResult)}
        ${lastResult ? `<a class="btn btn-ghost" href="${reportUrl(slug)}" target="_blank">Apri report</a>` : ''}
      </div>

      <div class="run-actions">
        <button class="btn" id="run-reference">Crea/aggiorna baseline</button>
        <button class="btn btn-primary" id="run-test" ${config.scenarios.length ? '' : 'disabled'}>Esegui test</button>
        <button class="btn" id="run-approve" title="${esc(approveHint)}" ${nothingToApprove ? 'disabled' : ''}>${esc(approveLabel)}</button>
        <span class="spacer"></span>
        <button class="btn btn-danger" id="del-project">Elimina progetto</button>
      </div>

      <section class="section">
        <h2>Pagine sotto controllo (${config.scenarios.length})</h2>
        ${config.scenarios.length ? `<div class="table-wrap"><table class="scenarios-table">
          <thead><tr><th>Nome</th><th>URL</th><th>Ignorati</th><th>Azioni</th></tr></thead>
          <tbody>${scenarioRows}</tbody>
        </table></div>` : '<div class="empty">Nessuna pagina. Aggiungine una a mano o scoprile col crawler qui sotto.</div>'}
        <div class="section-actions">
          <button class="btn btn-primary" id="add-scenario">Aggiungi pagina</button>
        </div>
      </section>

      <section class="section">
        <h2>Scopri pagine (crawler)</h2>
        <form id="crawl-form" class="crawl-form">
          <input name="url" placeholder="URL di partenza, es. http://demo/ o https://www.example.com" required>
          <input name="maxPages" type="number" value="30" min="1" max="100" title="numero massimo di pagine">
          <button class="btn" type="submit">Scopri pagine</button>
        </form>
        <div id="crawl-results" class="crawl-results"></div>
      </section>

      <section class="section">
        <h2>Viewport (${config.viewports.length})</h2>
        <div id="vp-editor">${vpRows}</div>
        <div class="section-actions">
          <button class="btn btn-ghost" id="vp-add">Aggiungi viewport</button>
          <button class="btn btn-primary" id="vp-save">Salva viewport</button>
        </div>
      </section>
    `;

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

    // --- scenari ---
    view.querySelector('#add-scenario').addEventListener('click', () => {
      openScenarioDialog(null, (scenario) => {
        saveConfig((cfg) => cfg.scenarios.push(scenario));
      });
    });

    view.querySelectorAll('[data-edit]').forEach((btn) => {
      btn.addEventListener('click', () => {
        const i = Number(btn.dataset.edit);
        openScenarioDialog(config.scenarios[i], (updated) => {
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

    // --- crawler ---
    const crawlResults = view.querySelector('#crawl-results');
    view.querySelector('#crawl-form').addEventListener('submit', async (ev) => {
      ev.preventDefault();
      const data = new FormData(ev.target);
      crawlResults.innerHTML = '<p class="hint">Scansione in corso…</p>';
      try {
        const { pages, truncated } = await api('/api/crawl', {
          method: 'POST',
          body: JSON.stringify({ url: data.get('url'), maxPages: Number(data.get('maxPages')) }),
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
              cfg.scenarios.push({
                label,
                url: page.url,
                delay: 300,
                misMatchThreshold: 0.1,
                requireSameDimensions: true,
              });
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
