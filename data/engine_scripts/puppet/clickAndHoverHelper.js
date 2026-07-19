// Gestisce le proprietà opzionali degli scenari:
//   clickSelector(s)  — clicca uno o più elementi (es. chiudere un banner cookie)
//   hoverSelector(s)  — porta il mouse sopra uno o più elementi
//   scrollToSelector  — scrolla fino a un elemento
//   postInteractionWait — attesa (ms o selettore) dopo le interazioni
module.exports = async (page, scenario) => {
  const hoverSelectors = scenario.hoverSelectors || (scenario.hoverSelector ? [scenario.hoverSelector] : []);
  const clickSelectors = scenario.clickSelectors || (scenario.clickSelector ? [scenario.clickSelector] : []);
  const scrollToSelector = scenario.scrollToSelector;
  const postInteractionWait = scenario.postInteractionWait;

  for (const selector of clickSelectors) {
    await page.waitForSelector(selector);
    await page.click(selector);
  }

  for (const selector of hoverSelectors) {
    await page.waitForSelector(selector);
    await page.hover(selector);
  }

  if (scrollToSelector) {
    await page.waitForSelector(scrollToSelector);
    await page.evaluate((sel) => {
      document.querySelector(sel).scrollIntoView();
    }, scrollToSelector);
  }

  if (postInteractionWait) {
    if (typeof postInteractionWait === 'number') {
      await new Promise((resolve) => setTimeout(resolve, postInteractionWait));
    } else {
      await page.waitForSelector(postInteractionWait);
    }
  }
};
