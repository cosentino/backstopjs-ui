const cheerio = require('cheerio');

// Risolve href rispetto a base, scarta schemi non http(s), rimuove il fragment.
function normalizeUrl(href, base) {
  try {
    const url = new URL(href, base);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
    url.hash = '';
    return url.href;
  } catch {
    return null;
  }
}

const LOCAL_HOSTNAMES = new Set(['localhost', '127.0.0.1']);

// Scarica una pagina. Ritorna l'HTML, o null se la risposta va ignorata
// (status non-ok, content-type non HTML). Lancia in caso di errore di rete.
async function fetchHtml(url, fetchTimeoutMs) {
  const res = await fetch(url, {
    signal: AbortSignal.timeout(fetchTimeoutMs),
    redirect: 'follow',
  });
  if (!res.ok) return null;
  const contentType = res.headers.get('content-type') || '';
  if (!contentType.includes('text/html')) return null;
  return res.text();
}

// In esecuzione dentro Docker, "localhost"/"127.0.0.1" nell'URL puntano al
// container stesso, non all'host dove gira il sito da scansionare: se il
// fetch diretto fallisce per errore di rete, ritenta con l'hostname speciale
// che Docker mappa all'host, così l'utente non deve saperlo.
async function fetchHtmlWithLocalFallback(url, fetchTimeoutMs) {
  try {
    return await fetchHtml(url, fetchTimeoutMs);
  } catch (err) {
    const parsed = new URL(url);
    if (!LOCAL_HOSTNAMES.has(parsed.hostname)) throw err;
    parsed.hostname = 'host.docker.internal';
    try {
      return await fetchHtml(parsed.href, fetchTimeoutMs);
    } catch {
      throw err; // riportiamo l'errore sull'URL originale, più chiaro per l'utente
    }
  }
}

// BFS same-origin a partire da startUrl. Gli errori delle singole pagine
// (timeout, 404, content-type non HTML) non interrompono il crawl.
async function crawl(startUrl, { maxPages = 30, maxDepth = 2, fetchTimeoutMs = 8000 } = {}) {
  const start = normalizeUrl(startUrl, undefined);
  if (!start) {
    const err = new Error(`URL di partenza non valida: "${startUrl}"`);
    err.status = 400;
    throw err;
  }
  const origin = new URL(start).origin;

  const visited = new Set([start]);
  const queue = [{ url: start, depth: 0 }];
  const pages = [];
  let truncated = false;

  while (queue.length > 0) {
    const { url, depth } = queue.shift();

    let html;
    try {
      html = await fetchHtmlWithLocalFallback(url, fetchTimeoutMs);
    } catch (err) {
      // Se anche l'URL di partenza non è raggiungibile (rete, DNS, timeout),
      // meglio segnalarlo che restituire silenziosamente un elenco vuoto:
      // capita ad es. quando il target gira su un host/container non
      // raggiungibile da chi esegue il crawler.
      if (depth === 0) {
        const wrapped = new Error(`Impossibile raggiungere "${url}": ${err.message || err}`);
        wrapped.status = 502;
        throw wrapped;
      }
      continue;
    }
    if (html == null) continue;

    const $ = cheerio.load(html);
    pages.push({
      url,
      title: $('title').first().text().trim() || url,
      depth,
    });

    if (depth >= maxDepth) continue;

    for (const el of $('a[href]').toArray()) {
      const link = normalizeUrl($(el).attr('href'), url);
      if (!link || visited.has(link)) continue;
      if (new URL(link).origin !== origin) continue;
      if (visited.size >= maxPages) {
        truncated = true;
        continue;
      }
      visited.add(link);
      queue.push({ url: link, depth: depth + 1 });
    }
  }

  return { pages, truncated };
}

module.exports = { normalizeUrl, crawl };
