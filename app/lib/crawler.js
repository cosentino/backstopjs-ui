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

// Header di un browser vero. Il fetch di Node si presenta con "undici" come
// user agent e senza Accept-Language: per molti WAF è già abbastanza per
// rispondere 403, e il crawler tornerebbe con zero pagine su un sito che dal
// browser si apre benissimo. Lo user agent dichiarato coincide con quello
// usato per gli screenshot (vedi engine_scripts/puppet/stealth.js): due
// client dichiarati diversi sulla stessa sessione sono a loro volta sospetti.
const BROWSER_HEADERS = {
  'User-Agent':
    'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
  'Accept-Language': 'it-IT,it;q=0.9,en-US;q=0.8,en;q=0.7',
  'Upgrade-Insecure-Requests': '1',
  'sec-ch-ua': '"Not_A Brand";v="8", "Chromium";v="120", "Google Chrome";v="120"',
  'sec-ch-ua-mobile': '?0',
  'sec-ch-ua-platform': '"Linux"',
};

// Scarica una pagina. Ritorna l'HTML, o null se la risposta va ignorata
// (status non-ok, content-type non HTML). Lancia in caso di errore di rete.
async function fetchHtml(url, fetchTimeoutMs, stealth = true) {
  const res = await fetch(url, {
    signal: AbortSignal.timeout(fetchTimeoutMs),
    redirect: 'follow',
    headers: stealth ? BROWSER_HEADERS : {},
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
async function fetchHtmlWithLocalFallback(url, fetchTimeoutMs, stealth) {
  try {
    return await fetchHtml(url, fetchTimeoutMs, stealth);
  } catch (err) {
    const parsed = new URL(url);
    if (!LOCAL_HOSTNAMES.has(parsed.hostname)) throw err;
    parsed.hostname = 'host.docker.internal';
    try {
      return await fetchHtml(parsed.href, fetchTimeoutMs, stealth);
    } catch {
      throw err; // riportiamo l'errore sull'URL originale, più chiaro per l'utente
    }
  }
}

// BFS same-origin a partire da startUrl. Gli errori delle singole pagine
// (timeout, 404, content-type non HTML) non interrompono il crawl.
async function crawl(
  startUrl,
  { maxPages = 30, maxDepth = 2, fetchTimeoutMs = 8000, stealth = true } = {}
) {
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
      html = await fetchHtmlWithLocalFallback(url, fetchTimeoutMs, stealth);
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
