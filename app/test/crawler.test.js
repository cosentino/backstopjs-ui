const { test, before, after } = require('node:test');
const assert = require('node:assert');
const http = require('node:http');

const { normalizeUrl, crawl } = require('../lib/crawler');

// Sito fixture: A → B, C, esterno, mailto, #frammento; B → A (ciclo); C senza link.
// /slow non risponde mai (timeout); /image è content-type non HTML.
let server;
let base;

before(async () => {
  server = http.createServer((req, res) => {
    const pages = {
      '/': `<html><head><title>Pagina A</title></head><body>
        <a href="/b">B</a>
        <a href="c">C</a>
        <a href="https://esterno.example.com/x">esterno</a>
        <a href="mailto:x@example.com">mail</a>
        <a href="/#sezione">frammento</a>
        <a href="/image">img</a>
      </body></html>`,
      '/b': `<html><head><title>Pagina B</title></head><body><a href="/">A</a></body></html>`,
      '/c': `<html><head><title>Pagina C</title></head><body>fine</body></html>`,
    };
    if (req.url === '/image') {
      res.writeHead(200, { 'Content-Type': 'image/png' });
      res.end('png');
      return;
    }
    const page = pages[req.url];
    if (!page) {
      res.writeHead(404);
      res.end('not found');
      return;
    }
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(page);
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${server.address().port}`;
});

after(() => server.close());

test('normalizeUrl: risoluzione relativa, hash, schemi non http', () => {
  assert.strictEqual(normalizeUrl('/b', 'http://x.test/a'), 'http://x.test/b');
  assert.strictEqual(normalizeUrl('c', 'http://x.test/dir/a'), 'http://x.test/dir/c');
  assert.strictEqual(normalizeUrl('http://x.test/p#frag', 'http://x.test/'), 'http://x.test/p');
  assert.strictEqual(normalizeUrl('mailto:a@b.c', 'http://x.test/'), null);
  assert.strictEqual(normalizeUrl('tel:+391234', 'http://x.test/'), null);
  assert.strictEqual(normalizeUrl('javascript:void(0)', 'http://x.test/'), null);
  assert.strictEqual(normalizeUrl('not a url', ''), null);
});

test('crawl: trova le pagine same-origin una sola volta, con titoli', async () => {
  const { pages, truncated } = await crawl(base + '/');
  const urls = pages.map((p) => p.url).sort();
  assert.deepStrictEqual(urls, [base + '/', base + '/b', base + '/c']);
  assert.strictEqual(truncated, false);
  const home = pages.find((p) => p.url === base + '/');
  assert.strictEqual(home.title, 'Pagina A');
  assert.strictEqual(home.depth, 0);
});

test('crawl: rispetta maxPages e segnala il troncamento', async () => {
  const { pages, truncated } = await crawl(base + '/', { maxPages: 2 });
  assert.strictEqual(pages.length, 2);
  assert.strictEqual(truncated, true);
});

test('crawl: pagina irraggiungibile ignorata senza errori', async () => {
  const { pages } = await crawl(base + '/does-not-exist');
  assert.deepStrictEqual(pages, []);
});
