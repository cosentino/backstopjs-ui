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
//
// Nota: non basta "request.continue({ url })" con l'hostname riscritto.
// Chrome applica la riscrittura solo alla richiesta di navigazione
// principale; per le sotto-risorse (css, js, immagini, font, ...) la
// blocca (net::ERR_BLOCKED_BY_CLIENT), lasciando la pagina catturata senza
// stile. Per questo qui la richiesta viene rifatta noi stessi verso
// l'host giusto e la risposta inoltrata a Chrome con request.respond().
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
  page.on('request', async (req) => {
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
    try {
      const upstream = await fetch(url.href, {
        method: req.method(),
        headers: req.headers(),
        body: req.postData(),
      });
      const body = Buffer.from(await upstream.arrayBuffer());
      const headers = {};
      upstream.headers.forEach((value, key) => {
        // fetch() ha già decodificato la risposta: content-encoding/length
        // originali non corrispondono più al body che stiamo inoltrando.
        if (key === 'content-encoding' || key === 'content-length') return;
        headers[key] = value;
      });
      await req.respond({ status: upstream.status, headers, body });
    } catch {
      req.abort();
    }
  });
};
