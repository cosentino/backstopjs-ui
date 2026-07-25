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
  //     scatto è non deterministico (card vuote vs piene).
  await page.evaluate(() => {
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

  // 4. Assesta l'header sticky: riporta a quota 0 e ri-emette lo scroll a 0
  //    (così eventuali handler ricalcolano lo stato "in cima").
  await page.evaluate(() => {
    window.scrollTo(0, 0);
    window.dispatchEvent(new Event('scroll'));
  });

  // 5. Attendi che il browser abbia FINITO il rendering dopo lo scroll
  //    down→up: aspetta che l'altezza della pagina smetta di cambiare per
  //    alcuni frame consecutivi (le librerie di slider/lazyload ricalcolano
  //    il layout in modo asincrono). Evita di scattare mentre la pagina è
  //    ancora in assestamento — meccanismo generico, senza selettori.
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

  // 6. Margine di sicurezza finale prima dello scatto.
  await new Promise((resolve) => setTimeout(resolve, 400));
};
