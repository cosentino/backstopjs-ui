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
      const res = await fetch(url, {
        signal: AbortSignal.timeout(fetchTimeoutMs),
        redirect: 'follow',
      });
      if (!res.ok) continue;
      const contentType = res.headers.get('content-type') || '';
      if (!contentType.includes('text/html')) continue;
      html = await res.text();
    } catch {
      continue;
    }

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
