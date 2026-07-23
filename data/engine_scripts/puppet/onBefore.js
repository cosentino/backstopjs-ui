module.exports = async (page, scenario, viewport, isReference, browserContext) => {
  await require('./localHostFallback')(page, scenario);
  await require('./loadCookies')(page, scenario);
};
