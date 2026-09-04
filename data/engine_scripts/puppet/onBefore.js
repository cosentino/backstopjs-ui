module.exports = async (page, scenario, viewport, isReference, browserContext, config) => {
  // Modalità discreta: attiva salvo opt-out esplicito nel backstop.json del
  // progetto (config.stealth === false). Va qui e non in onReady perché deve
  // agire sulla richiesta di navigazione, prima che il WAF veda la sessione.
  if (!config || config.stealth !== false) {
    await require('./stealth')(page, viewport);
  }

  await require('./loadCookies')(page, scenario);
};
