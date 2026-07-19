// Contenuto volutamente NON deterministico: cambia a ogni caricamento.
// Serve a dimostrare gli hideSelectors: senza ignorare ".carousel",
// ogni run del test fallirebbe.
(function () {
  const slides = [
    '«Il miglior bug è quello che non arriva mai in produzione.»',
    '«Un pixel fuori posto è un pixel di troppo.»',
    '«Le baseline non si aggiornano da sole. Per fortuna.»',
    '«Verde è bello. Rosso è utile.»',
    '«Il diff non mente mai.»'
  ];
  const slide = slides[Math.floor(Math.random() * slides.length)];
  const now = new Date().toLocaleTimeString('it-IT');

  document.getElementById('carousel-slide').textContent = slide;
  document.getElementById('carousel-meta').textContent =
    'Slide casuale n. ' + Math.floor(Math.random() * 1000) + ' — caricata alle ' + now;
})();
