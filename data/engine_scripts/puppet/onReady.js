module.exports = async (page, scenario, viewport, isReference, browserContext) => {
  await require('./clickAndHoverHelper')(page, scenario);

  // 0. Stabilizza il rendering per lo scatto:
  //    - scroll istantaneo (niente smooth che lascia la pagina in transizione)
  //    - azzera durate di animazioni/transizioni (Splide/Swiper/hover): evita
  //      screenshot catturati a metà transizione
  //    - disattiva backdrop-filter: nei full-page screenshot il blur campiona
  //      lo sfondo in modo non deterministico (frequente sorgente di flakiness
  //      su qualsiasi barra/overlay con effetto blur)
  await page.addStyleTag({
    content: `
      html { scroll-behavior: auto !important; }
      *, *::before, *::after {
        animation-duration: 0s !important;
        animation-delay: 0s !important;
        transition-duration: 0s !important;
        transition-delay: 0s !important;
      }
      * {
        backdrop-filter: none !important;
        -webkit-backdrop-filter: none !important;
      }
    `,
  });

  // 1a. Forza il caricamento IMMEDIATO di tutte le immagini lazysizes.
  //     Necessario perché le immagini dentro gli slider a scorrimento
  //     ORIZZONTALE non vengono intercettate dallo scroll verticale sotto,
  //     e lazysizes carica in modo asincrono: senza questo lo stato allo
  //     scatto è non deterministico (card vuote vs piene, immagini clippate).
  await page.evaluate(() => {
    // API ufficiale lazysizes: gestisce correttamente anche <picture>,
    // <source data-srcset> e il plugin respimg. Più affidabile di uno swap
    // manuale del solo attributo src.
    if (window.lazySizes && typeof window.lazySizes.loadAll === 'function') {
      window.lazySizes.loadAll();
    }
    // Fallback manuale (se lazysizes non è esposto su window): forza src/srcset
    // su img e sui <source> interni ai <picture>.
    document
      .querySelectorAll('picture source[data-srcset], picture source[data-src]')
      .forEach((source) => {
        if (source.dataset.srcset) source.srcset = source.dataset.srcset;
        if (source.dataset.src) source.src = source.dataset.src;
      });
    document
      .querySelectorAll('img.lazyload, img[data-src], img[data-srcset]')
      .forEach((img) => {
        if (img.dataset.srcset) img.srcset = img.dataset.srcset;
        if (img.dataset.src) img.src = img.dataset.src;
        img.classList.remove('lazyload');
        img.classList.add('lazyloaded');
        img.loading = 'eager';
      });
    document.querySelectorAll('[data-bg]').forEach((el) => {
      el.style.backgroundImage = `url("${el.dataset.bg}")`;
    });
  });

  // 1b. Forza il lazyload residuo: scrolla tutta la pagina per far entrare in
  //     viewport ogni immagine, poi torna in cima.
  await page.evaluate(async () => {
    await new Promise((resolve) => {
      let total = 0;
      const step = 250;
      const timer = setInterval(() => {
        window.scrollBy(0, step);
        total += step;
        if (total >= document.body.scrollHeight) {
          clearInterval(timer);
          resolve();
        }
      }, 50);
    });
    window.scrollTo(0, 0);
  });

  // 2. Aspetta che TUTTE le immagini siano effettivamente caricate.
  await page.evaluate(() =>
    Promise.all(
      Array.from(document.images)
        .filter((img) => !img.complete)
        .map((img) => new Promise((res) => {
          img.onload = img.onerror = res;
        }))
    )
  );

  // 3. Aspetta i web font (evita lo shift di testo).
  await page.evaluate(() => document.fonts && document.fonts.ready);

  // 4. Assesta l'header sticky + forza il ricalcolo del layout degli slider.
  //    Riporta a quota 0, ri-emette lo scroll a 0 (handler "in cima") e
  //    dispatcha un resize: gli slider Splide/Swiper con autoHeight ri-misurano
  //    l'altezza ORA che le immagini sono caricate, evitando slide clippate/
  //    vuote (causa non deterministica dei diff su timeline/multistep/speaker).
  await page.evaluate(() => {
    window.scrollTo(0, 0);
    window.dispatchEvent(new Event('scroll'));
    window.dispatchEvent(new Event('resize'));
  });

  // 5. Attendi che il browser abbia FINITO il rendering dopo lo scroll
  //    down→up e il resize: aspetta che l'altezza della pagina smetta di
  //    cambiare per alcuni frame consecutivi (slider/lazyload ricalcolano il
  //    layout in modo asincrono). Meccanismo generico, senza selettori.
  await page.evaluate(() => new Promise((resolve) => {
    let last = -1;
    let stableFrames = 0;
    const check = () => {
      const h = document.body.scrollHeight;
      stableFrames = h === last ? stableFrames + 1 : 0;
      last = h;
      // ~5 frame consecutivi senza variazioni = layout assestato
      if (stableFrames >= 5) {
        resolve();
      } else {
        requestAnimationFrame(check);
      }
    };
    requestAnimationFrame(check);
  }));

  // 6. Ri-attendi il completamento di TUTTE le immagini: il resize/refresh
  //    degli slider può aver richiesto nuove sorgenti (srcset responsive)
  //    che devono finire di caricare prima dello scatto.
  await page.evaluate(() =>
    Promise.all(
      Array.from(document.images)
        .filter((img) => !img.complete)
        .map((img) => new Promise((res) => {
          img.onload = img.onerror = res;
        }))
    )
  );

  // 7. Margine di sicurezza finale prima dello scatto.
  await new Promise((resolve) => setTimeout(resolve, 400));
};
