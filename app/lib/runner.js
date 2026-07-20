const { spawn } = require('node:child_process');
const { randomUUID } = require('node:crypto');

// Regex ancorata che matcha esattamente il label dello scenario:
// backstop --filter accetta una regex sui label.
function escapeFilter(label) {
  return '^' + String(label).replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '$';
}

// Coda FIFO con un solo worker: BackstopJS avvia Chromium, meglio un run alla
// volta. I run vivono in memoria (il risultato persistente è il report su disco).
function createRunner({ dataDir, backstopCmd = 'backstop', maxHistory = 50 }) {
  const runs = new Map(); // id -> run
  const order = []; // id, dal più vecchio
  const queue = [];
  const listeners = new Map(); // id -> Set<fn>
  let working = false;

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

    const child = spawn(backstopCmd, args, {
      cwd: dataDir,
      env: { ...process.env },
    });

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
      run.exitCode = code;
      run.status = code === 0 ? 'success' : 'failed';
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
  };
}

module.exports = { createRunner, escapeFilter };
