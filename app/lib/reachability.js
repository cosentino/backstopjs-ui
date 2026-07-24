const net = require('node:net');

const LOCAL_HOSTNAMES = new Set(['localhost', '127.0.0.1']);

function canConnect(hostname, port, timeoutMs = 800) {
  return new Promise((resolve) => {
    const socket = net.createConnection({ host: hostname, port });
    const done = (ok) => {
      socket.removeAllListeners();
      socket.destroy();
      resolve(ok);
    };
    socket.once('connect', () => done(true));
    socket.once('error', () => done(false));
    socket.setTimeout(timeoutMs, () => done(false));
  });
}

// In esecuzione dentro Docker, "localhost"/"127.0.0.1" in uno scenario
// puntano al container stesso, non all'host dove gira il sito da testare
// (es. un dev server avviato sulla macchina). Prima di lanciare un run
// verifichiamo se è davvero raggiungibile: se non lo è, meglio bloccare e
// far scegliere all'utente se correggere gli URL, piuttosto che produrre
// screenshot silenziosamente rotti.
async function findUnreachableLocalScenarios(scenarios) {
  const cache = new Map(); // "hostname:port" -> raggiungibile?
  const affected = [];
  for (const scenario of scenarios) {
    let url;
    try {
      url = new URL(scenario.url);
    } catch {
      continue;
    }
    if (!LOCAL_HOSTNAMES.has(url.hostname)) continue;

    const port = Number(url.port) || (url.protocol === 'https:' ? 443 : 80);
    const key = `${url.hostname}:${port}`;
    if (!cache.has(key)) cache.set(key, await canConnect(url.hostname, port));
    if (!cache.get(key)) affected.push(scenario);
  }
  return affected;
}

module.exports = { findUnreachableLocalScenarios, LOCAL_HOSTNAMES };
