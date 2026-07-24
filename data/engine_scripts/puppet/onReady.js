module.exports = async (page, scenario, viewport, isReference, browserContext) => {
  await require('./clickAndHoverHelper')(page, scenario);

  // 0. Scroll istantaneo: evita animazioni smooth che lasciano header/pagina
  //    in stati transitori non deterministici.
  await page.addStyleTag({
    content: 'html { scroll-behavior: auto !important; }',
  });

  // 1. Forza il lazyload: scrolla tutta la pagina per far entrare in
  //    viewport ogni immagine, poi torna in cima.
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

  // 4. Assesta l'header sticky: riporta a quota 0, ri-emette lo scroll a 0
  //    (così eventuali handler ricalcolano lo stato "in cima") e attende
  //    che il layout si stabilizzi prima dello scatto.
  await page.evaluate(() => {
    window.scrollTo(0, 0);
    window.dispatchEvent(new Event('scroll'));
    return new Promise((resolve) => {
      requestAnimationFrame(() => requestAnimationFrame(resolve));
    });
  });
  await new Promise((resolve) => setTimeout(resolve, 400));
};
