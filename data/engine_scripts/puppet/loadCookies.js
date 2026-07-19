const fs = require('fs');

// Carica i cookie indicati da scenario.cookiePath (percorso relativo alla root
// del progetto, es. "engine_scripts/cookies.json"). Utile per saltare banner
// cookie/GDPR o per testare pagine dietro login basato su cookie.
module.exports = async (page, scenario) => {
  let cookies = [];
  const cookiePath = scenario.cookiePath;

  if (cookiePath && fs.existsSync(cookiePath)) {
    cookies = JSON.parse(fs.readFileSync(cookiePath));
  }

  if (cookies.length) {
    await page.setCookie(...cookies);
    console.log('Cookie caricati per: ' + scenario.label);
  }
};
