const net = require('net');

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

// Da dentro il container Docker, "localhost"/"127.0.0.1" nell'URL di uno
// scenario puntano al container stesso, non all'host dove gira il sito da
// testare (es. un dev server avviato sulla macchina). Se la porta non
// risponde direttamente, reindirizza in modo trasparente tutte le richieste
// verso quell'host su "host.docker.internal", che Docker mappa all'host:
// così l'utente può scrivere localhost/127.0.0.1 nello scenario senza
// doversi preoccupare di dove gira davvero BackstopJS.
module.exports = async (page, scenario) => {
  let target;
  try {
    target = new URL(scenario.url);
  } catch {
    return;
  }
  if (!LOCAL_HOSTNAMES.has(target.hostname)) return;

  const port = Number(target.port) || (target.protocol === 'https:' ? 443 : 80);
  const reachable = await canConnect(target.hostname, port);
  if (reachable) return;

  const originalHostname = target.hostname;
  await page.setRequestInterception(true);
  page.on('request', (req) => {
    let url;
    try {
      url = new URL(req.url());
    } catch {
      req.continue();
      return;
    }
    if (url.hostname !== originalHostname) {
      req.continue();
      return;
    }
    url.hostname = 'host.docker.internal';
    req.continue({ url: url.href });
  });
};
