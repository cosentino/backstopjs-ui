// Maschera i segnali che rivelano un browser guidato da Puppeteer.
//
// Serve quando il sito da fotografare sta dietro a un WAF/anti-bot: senza
// questo la sessione si presenta con "HeadlessChrome" nello user agent e
// navigator.webdriver = true, e la protezione risponde con una challenge o un
// 403 invece che con la pagina — gli screenshot escono tutti uguali e inutili.
//
// I valori dichiarati qui devono restare COERENTI fra loro: chi fa detection
// non cerca il singolo valore "sbagliato", cerca le combinazioni impossibili
// (user agent Chrome ma WebGL assente, Accept-Language it-IT ma fuso UTC,
// finestra più grande dello schermo). Per questo lingua, fuso e dimensioni
// vengono impostati insieme.
//
// Cosa NON viene toccato, perché nel container è già identico a un Chrome
// normale (verificato sul browser dell'immagine): navigator.plugins,
// mimeTypes, window.chrome, navigator.platform, maxTouchPoints.

// Lingua: header HTTP e navigator devono dire la stessa cosa.
const ACCEPT_LANGUAGE = 'it-IT,it;q=0.9,en-US;q=0.8,en;q=0.7';
const LANGUAGES = ['it-IT', 'it', 'en-US', 'en'];

// Fuso coerente con la lingua: headless in container parte su UTC.
const TIMEZONE = 'Europe/Rome';

// Stringhe del renderer WebGL: quelle vere del rendering software
// (SwiftShader / Mesa llvmpipe) sono un marchio quasi esclusivo dei browser
// headless. Qui dichiariamo una GPU integrata plausibile su Linux.
// NOTA: il Chromium dell'immagine BackstopJS non ha WebGL del tutto
// (getContext('webgl') torna null e nessun flag --use-gl lo riabilita), quindi
// oggi questa patch non scatta mai: resta pronta per immagini con WebGL
// disponibile. L'assenza di WebGL è il segnale residuo che non possiamo
// coprire da qui.
const WEBGL_VENDOR = 'Google Inc. (Intel)';
const WEBGL_RENDERER = 'ANGLE (Intel, Mesa Intel(R) UHD Graphics 620 (KBL GT2), OpenGL 4.6)';

// Schermo dichiarato: headless resta a 800x600 anche con viewport 1920, e una
// finestra più larga dello schermo è impossibile su una macchina vera.
const SCREEN = { width: 1920, height: 1080 };
const TASKBAR_HEIGHT = 40; // per screen.availHeight
const BROWSER_CHROME_HEIGHT = 88; // barra indirizzi + tab, per window.outerHeight

const HARDWARE_CONCURRENCY = 8;
const DEVICE_MEMORY = 8;

module.exports = async (page, viewport) => {
  // 1. User agent. Partiamo da quello reale e togliamo "Headless": così la
  //    versione dichiarata resta quella effettiva del browser. Inventare una
  //    versione più recente sarebbe smentito dalle feature JS disponibili.
  const real = await page.browser().userAgent();
  const userAgent = real.replace(/HeadlessChrome/g, 'Chrome');
  const fullVersion = (userAgent.match(/Chrome\/([\d.]+)/) || [])[1] || '';
  const major = fullVersion.split('.')[0] || '';

  // Su HTTPS il sito legge anche navigator.userAgentData e l'header sec-ch-ua,
  // che direbbero "HeadlessChrome" anche dopo aver cambiato lo user agent:
  // setUserAgent con i metadati (Client Hints) aggiorna entrambi. Se la
  // versione di CDP non accetta questa forma, ripieghiamo sul solo UA.
  const brands = [
    { brand: 'Not_A Brand', version: '8' },
    { brand: 'Chromium', version: major },
    { brand: 'Google Chrome', version: major },
  ];
  try {
    await page.setUserAgent(userAgent, {
      brands,
      fullVersionList: brands.map((b) => ({
        brand: b.brand,
        version: b.brand === 'Not_A Brand' ? '8.0.0.0' : fullVersion,
      })),
      fullVersion,
      platform: 'Linux',
      platformVersion: '6.5.0',
      architecture: 'x86',
      bitness: '64',
      model: '',
      mobile: false,
      wow64: false,
    });
  } catch {
    await page.setUserAgent(userAgent);
  }

  await page.setExtraHTTPHeaders({ 'Accept-Language': ACCEPT_LANGUAGE });

  // emulateTimezone fallisce solo con un fuso inesistente: non deve impedire
  // lo scatto.
  try {
    await page.emulateTimezone(TIMEZONE);
  } catch {
    // fuso non applicato: lo screenshot si fa lo stesso
  }

  // 2. Correzioni lato pagina, installate prima di ogni documento (quindi
  //    anche negli iframe e dopo i redirect della challenge anti-bot).
  await page.evaluateOnNewDocument(
    (cfg) => {
      // Ogni proprietà sostituita deve continuare a sembrare nativa:
      // ispezionare il sorgente dei getter di navigator è il primo test che
      // fa qualunque libreria di detection.
      const nativeToString = Function.prototype.toString;
      const spoofed = new WeakMap();
      Function.prototype.toString = new Proxy(nativeToString, {
        apply(target, thisArg, args) {
          // toString.toString(): senza questo caso il Proxy si tradirebbe
          // restituendo "function () { [native code] }", senza il nome.
          if (thisArg === Function.prototype.toString) {
            return Reflect.apply(target, target, args);
          }
          const name = spoofed.get(thisArg);
          return name === undefined
            ? Reflect.apply(target, thisArg, args)
            : `function ${name}() { [native code] }`;
        },
      });

      const define = (target, prop, compute) => {
        spoofed.set(compute, `get ${prop}`);
        Object.defineProperty(target, prop, {
          get: compute,
          configurable: true,
          enumerable: true,
        });
      };

      // navigator.webdriver: true significa "sono un'automazione". Il valore
      // di un Chrome normale è false, non "assente": cancellare la proprietà
      // sarebbe a sua volta un'anomalia ('webdriver' in navigator === true).
      define(Navigator.prototype, 'webdriver', () => false);

      const languages = Object.freeze(cfg.languages.slice());
      define(Navigator.prototype, 'languages', () => languages);
      define(Navigator.prototype, 'language', () => cfg.languages[0]);
      define(Navigator.prototype, 'hardwareConcurrency', () => cfg.hardwareConcurrency);
      // deviceMemory esiste solo in contesto sicuro: aggiungerlo dove il
      // browser vero non ce l'ha sarebbe un'incoerenza in più, non in meno.
      if ('deviceMemory' in Navigator.prototype) {
        define(Navigator.prototype, 'deviceMemory', () => cfg.deviceMemory);
      }

      // Headless risponde 'denied' alle notifiche; un Chrome appena aperto
      // risponde 'default'. Allineiamo anche permissions.query, che
      // altrimenti direbbe 'prompt' contraddicendo Notification.permission.
      if (typeof Notification !== 'undefined') {
        define(Notification, 'permission', () => 'default');
      }
      if (navigator.permissions && navigator.permissions.query) {
        const query = navigator.permissions.query.bind(navigator.permissions);
        const patched = async (parameters) => {
          const status = await query(parameters);
          if (parameters && parameters.name === 'notifications') {
            // Sovrascriviamo solo lo stato sull'oggetto vero, così restano
            // prototipo e addEventListener del PermissionStatus originale.
            Object.defineProperty(status, 'state', {
              get: () => Notification.permission,
              configurable: true,
            });
          }
          return status;
        };
        spoofed.set(patched, 'query');
        navigator.permissions.query = patched;
      }

      // WebGL: nasconde il renderer software. I due parametri esistono solo
      // con l'estensione WEBGL_debug_renderer_info, che è esattamente quella
      // che le librerie di detection interrogano. No-op finché il browser non
      // espone un contesto WebGL (vedi nota in cima al file).
      const UNMASKED_VENDOR_WEBGL = 0x9245;
      const UNMASKED_RENDERER_WEBGL = 0x9246;
      for (const ctor of [window.WebGLRenderingContext, window.WebGL2RenderingContext]) {
        if (!ctor) continue;
        const getParameter = ctor.prototype.getParameter;
        const patched = function (parameter) {
          if (parameter === UNMASKED_VENDOR_WEBGL) return cfg.webglVendor;
          if (parameter === UNMASKED_RENDERER_WEBGL) return cfg.webglRenderer;
          return getParameter.call(this, parameter);
        };
        spoofed.set(patched, 'getParameter');
        ctor.prototype.getParameter = patched;
      }

      // Schermo e dimensioni esterne della finestra, allineati al viewport
      // (che BackstopJS ha già impostato prima di questo script).
      define(Screen.prototype, 'width', () => cfg.screen.width);
      define(Screen.prototype, 'height', () => cfg.screen.height);
      define(Screen.prototype, 'availWidth', () => cfg.screen.width);
      define(Screen.prototype, 'availHeight', () => cfg.screen.height - cfg.taskbarHeight);
      define(window, 'outerWidth', () => window.innerWidth);
      define(window, 'outerHeight', () => window.innerHeight + cfg.browserChromeHeight);
    },
    {
      languages: LANGUAGES,
      webglVendor: WEBGL_VENDOR,
      webglRenderer: WEBGL_RENDERER,
      hardwareConcurrency: HARDWARE_CONCURRENCY,
      deviceMemory: DEVICE_MEMORY,
      taskbarHeight: TASKBAR_HEIGHT,
      browserChromeHeight: BROWSER_CHROME_HEIGHT,
      screen: {
        width: Math.max(SCREEN.width, (viewport && viewport.width) || 0),
        height: Math.max(SCREEN.height, (viewport && viewport.height) || 0),
      },
    }
  );
};
