// Backend address (Google Apps Script web app). Set once after deployment.
// On localhost the local test server's /api is used instead.
var GW_LOCAL = /^(localhost|127\.0\.0\.1)$/.test(location.hostname);
window.GW_CONFIG = {
  API_URL: GW_LOCAL ? '/api' : '',
  INDIA_DATA: 'https://ashutoshgupta26.github.io/india-stock-market-report/'
};
