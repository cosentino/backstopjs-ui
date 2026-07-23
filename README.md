# 02 — Backstop UI: dashboard web per visual regression testing

Dashboard web leggera costruita sopra il motore di [BackstopJS](https://github.com/garris/BackstopJS):
configurazione, esecuzione e report di visual regression testing direttamente
dal browser, senza CLI né file JSON da modificare a mano. **Unico prerequisito:
Docker.** L'immagine è basata su `backstopjs/backstopjs:6.3.25` (versione
pinnata), quindi il rendering è identico su ogni macchina.

## Avvio

```bash
./up.sh
```

- Dashboard: http://localhost:3000
- Sito demo: http://localhost:8081

La prima build scarica l'immagine BackstopJS (~1.5 GB) e installa due dipendenze
npm (express, cheerio): solo la prima volta.

## Cosa si può fare dalla dashboard

- **Più progetti**: card con esito dell'ultimo test (verde `n/n ok`, magenta
  `k/n diversi`), creazione e cancellazione (con conferma).
- **Pagine sotto controllo**: aggiunta/modifica/rimozione di URL; per ogni
  pagina si configurano attesa, soglia differenze, click preliminare (es.
  chiudere un banner cookie) e **aree da ignorare** (nascoste o rimosse).
- **Crawler**: dai un URL di partenza e scopre le pagine dello stesso dominio;
  selezioni quelle da aggiungere al progetto.
- **Viewport/breakpoint**: editor per definire a quali dimensioni catturare.
- **Esecuzioni**: crea/aggiorna baseline, test completo, test o approvazione
  della singola pagina, approvazione di tutte le differenze. Log in diretta
  nel pannello a destra; un run alla volta (coda automatica).
- **Report BackstopJS**: diff affiancato, sovrapposto con scrubber e aree
  evidenziate — link "Apri report" o
  `http://localhost:3000/reports/<progetto>/backstop_data/html_report/index.html`.

## Il giro completo in 2 minuti (col sito demo incluso)

1. Apri la dashboard → progetto **demo** → **Crea/aggiorna baseline**.
2. **Esegui test** → verde (`6/6 ok`), nonostante il carosello a contenuto
   casuale: è tra le aree ignorate.
3. Simula una regressione: in `demo-site/style.css` cambia `--accent: #0066cc`
   in `#cc3300`.
4. **Esegui test** → magenta (`6/6 diversi`) → **Apri report** per vedere le
   differenze evidenziate.
5. Se la modifica era voluta: **Approva tutte le differenze** → test di nuovo
   verde. Se era un bug: ripristina il CSS e rilancia il test.

## URL raggiungibili dal motore

| Cosa vuoi testare | URL da usare |
|---|---|
| Sito pubblico | `https://www.example.com/...` |
| Dev server sull'host (es. `npm run dev` su :5173) | `http://host.docker.internal:5173/...` |
| Il sito demo incluso | `http://demo/...` |

## Dati, baseline e condivisione col team

`data/` è la fonte di verità, **nel formato standard di BackstopJS**: ogni
progetto è `data/projects/<slug>/backstop.json` (un progetto BackstopJS
esistente si può copiare qui dentro così com'è). In teoria andrebbero
versionate in git le config e le baseline (`bitmaps_reference/`); per ora
però tutta `data/projects/` è esclusa dal `.gitignore`, per evitare di
committare cose specifiche di progetto e di appesantire il repository.

Workflow di team: chi modifica volutamente la UI esegue test + approva e
condivide le nuove baseline con gli altri (per ora fuori da git, es. copiando
la cartella `data/projects`).

## Deploy su un server condiviso

È la stessa cosa che gira in locale:

```bash
git clone <repo> && cd 02-backstopjs-ui && ./up.sh
```

La dashboard è su `:3000` (cambia il mapping in `docker-compose.yml` se serve).
**Non c'è autenticazione**: pensata per LAN/VPN di team; non esporla su
internet senza un reverse proxy con auth davanti.

## Architettura

```
02-backstopjs-ui/
├── up.sh / docker-compose.yml / Dockerfile
├── demo-site/                  # sito di prova (servito da nginx su :8081)
├── data/                       # fonte di verità (versionabile)
│   ├── engine_scripts/puppet/  # hook Puppeteer (cookie, click…)
│   └── projects/<slug>/backstop.json + backstop_data/
└── app/                        # Node/Express, zero build step
    ├── server.js               # REST API + SSE + statici
    ├── lib/                    # projects, runner (coda), results, crawler
    ├── public/                 # SPA vanilla (index.html, app.js, style.css)
    └── test/                   # unit test (node --test): 34 test
```

API principali (usate dalla SPA, utilizzabili anche da script/CI):
`GET/POST /api/projects`, `GET/PUT/DELETE /api/projects/:slug`,
`POST /api/projects/:slug/runs` (`{command: reference|test|approve,
scenarioLabel?}`), `GET /api/runs/:id`, `GET /api/runs/:id/log` (SSE),
`GET /api/projects/:slug/result`, `POST /api/crawl`.

Test unitari (serve Node ≥ 20 in locale): `cd app && npm test`.

## Troubleshooting

- **Porta 3000 o 8081 occupata** — cambia i mapping in `docker-compose.yml`.
- **"Approva" non ha approvato tutto** — l'approvazione promuove gli screenshot
  dell'**ultimo test eseguito**: se era filtrato su una pagina, approva solo
  quella, e il bottone lo dichiara ("Approva le differenze di «Home»"). Per
  approvare tutto esegui prima un test completo. I bottoni sono disabilitati
  quando l'ultimo test non ha differenze da promuovere.
- **Test instabili su pagine con contenuto dinamico** — aggiungi i selettori
  alle aree ignorate ("nascondi" mantiene lo spazio: se l'altezza varia, meglio
  "rimuovi" o un'altezza fissa nel CSS del sito).
- **Il run resta in coda** — c'è un altro run in corso: guarda il pannello
  Esecuzioni; la coda smaltisce da sola.
