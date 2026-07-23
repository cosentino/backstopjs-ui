const { spawn } = require('node:child_process');
const { randomUUID } = require('node:crypto');

// Regex ancorata che matcha esattamente il label dello scenario:
// backstop --filter accetta una regex sui label.
function escapeFilter(label) {
  return '^' + String(label).replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '$';
}

// Segnala l'intero gruppo di processi (pid negativo): vedi il commento su
// detached in work(). Ricade sul solo child se il processo è già uscito o il
// pid non è disponibile (es. su piattaforme senza gruppi di processi).
function killGroup(child, signal) {
  try {
    process.kill(-child.pid, signal);
  } catch {
    try {
      child.kill(signal);
    } catch {
      // già uscito: niente da fare
    }
  }
}

// Coda FIFO con un solo worker: BackstopJS avvia Chromium, meglio un run alla
// volta. I run vivono in memoria (il risultato persistente è il report su disco).
function createRunner({ dataDir, backstopCmd = 'backstop', maxHistory = 50 }) {
  const runs = new Map(); // id -> run
  const order = []; // id, dal più vecchio
  const queue = [];
  const listeners = new Map(); // id -> Set<fn>
  let working = false;
  let currentChild = null;
  let currentRunId = null;

  function emit(id, event) {
    const subs = listeners.get(id);
    if (subs) for (const fn of subs) fn(event);
  }

  function publicRun(run) {
    const { log, ...meta } = run;
    return meta;
  }

  function trimHistory() {
    while (order.length > maxHistory) {
      const id = order.shift();
      const run = runs.get(id);
      // Mai scartare run non ancora conclusi
      if (run && (run.status === 'queued' || run.status === 'running')) {
        order.push(id);
        break;
      }
      runs.delete(id);
      listeners.delete(id);
    }
  }

  function work() {
    if (working) return;
    const run = queue.shift();
    if (!run) return;
    working = true;

    run.status = 'running';
    run.startedAt = new Date().toISOString();
    emit(run.id, { type: 'status', run: publicRun(run) });

    const args = [run.command, `--config=projects/${run.project}/backstop.json`];
    if (run.filter) args.push(`--filter=${run.filter}`);

    // detached: true rende il child leader di un proprio gruppo di processi.
    // BackstopJS avvia Chromium come nipote: se al cancel mandassimo il
    // segnale solo al child diretto, Chromium potrebbe restare orfano (e
    // tenere aperte le pipe di stdio, con l'evento 'close' che non arriva
    // mai). Segnalando l'intero gruppo (pid negativo) li fermiamo tutti.
    const child = spawn(backstopCmd, args, {
      cwd: dataDir,
      env: { ...process.env },
      detached: true,
    });
    currentChild = child;
    currentRunId = run.id;

    const onData = (chunk) => {
      const text = chunk.toString();
      run.log += text;
      for (const line of text.split('\n')) {
        if (line.trim() !== '') emit(run.id, { type: 'log', line });
      }
    };
    child.stdout.on('data', onData);
    child.stderr.on('data', onData);

    child.on('error', (err) => {
      run.log += `\n[runner] errore di avvio: ${err.message}\n`;
    });

    child.on('close', (code) => {
      currentChild = null;
      currentRunId = null;
      run.exitCode = code;
      run.status = run.cancelRequested ? 'cancelled' : code === 0 ? 'success' : 'failed';
      run.endedAt = new Date().toISOString();
      emit(run.id, { type: 'status', run: publicRun(run) });
      trimHistory();
      working = false;
      work();
    });
  }

  return {
    enqueue({ project, command, filter }) {
      const run = {
        id: randomUUID(),
        project,
        command,
        filter: filter || null,
        status: 'queued',
        createdAt: new Date().toISOString(),
        startedAt: null,
        endedAt: null,
        exitCode: null,
        log: '',
      };
      runs.set(run.id, run);
      order.push(run.id);
      queue.push(run);
      // Il worker parte al prossimo tick, così il chiamante vede "queued"
      setImmediate(work);
      return publicRun(run);
    },

    // Registra un'esecuzione già conclusa: serve alle operazioni svolte in
    // process (l'approvazione), che non passano da spawn ma devono comunque
    // comparire nel pannello esecuzioni con il loro log.
    record({ project, command, filter = null, log = '', ok = true }) {
      const now = new Date().toISOString();
      const run = {
        id: randomUUID(),
        project,
        command,
        filter,
        status: ok ? 'success' : 'failed',
        createdAt: now,
        startedAt: now,
        endedAt: now,
        exitCode: ok ? 0 : 1,
        log,
      };
      runs.set(run.id, run);
      order.push(run.id);
      trimHistory();
      return publicRun(run);
    },

    get(id) {
      return runs.get(id);
    },

    list() {
      return order
        .slice()
        .reverse()
        .map((id) => publicRun(runs.get(id)));
    },

    subscribe(id, fn) {
      if (!listeners.has(id)) listeners.set(id, new Set());
      listeners.get(id).add(fn);
      return () => listeners.get(id)?.delete(fn);
    },

    // Annulla un run in coda (rimosso senza mai partire) o in corso (SIGTERM
    // al processo backstop, con SIGKILL di riserva se non termina). Sui run
    // già conclusi non fa nulla.
    cancel(id) {
      const run = runs.get(id);
      if (!run) return null;

      if (run.status === 'queued') {
        const idx = queue.findIndex((r) => r.id === id);
        if (idx !== -1) queue.splice(idx, 1);
        run.status = 'cancelled';
        run.endedAt = new Date().toISOString();
        const line = "[runner] esecuzione annullata prima dell'avvio";
        run.log += `\n${line}\n`;
        emit(run.id, { type: 'log', line });
        emit(run.id, { type: 'status', run: publicRun(run) });
        trimHistory();
        return publicRun(run);
      }

      if (run.status === 'running' && currentRunId === id && currentChild) {
        run.cancelRequested = true;
        const child = currentChild;
        killGroup(child, 'SIGTERM');
        setTimeout(() => {
          if (currentChild === child) killGroup(child, 'SIGKILL');
        }, 5000).unref();
      }

      return publicRun(run);
    },
  };
}

module.exports = { createRunner, escapeFilter };
