module.exports = async (page, scenario, viewport, isReference, browserContext) => {
  await require('./clickAndHoverHelper')(page, scenario);

  // Qui eventuale logica custom valida per tutti gli scenari
  // (es. attendere un font, nascondere elementi via JS, scrollare, ecc.)
};
