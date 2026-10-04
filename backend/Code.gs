/**
 * Growebtek AI Stock & Fund Analyzer — backend (Google Apps Script web app).
 * Handles admin/user login, the user access list and live market data.
 * Deploy: Deploy > New deployment > Web app > Execute as: Me, Who has access: Anyone.
 * Passwords are never stored: only a salted one-way hash.
 */
var ADMIN_MOBILE = '8700436279';
var DEFAULT_SALT = '__SALT__';
var DEFAULT_HASH = '__HASH__';
var HASH_ROUNDS = 200;
var ADMIN_SESSION_HOURS = 12;
var USER_SESSION_DAYS = 7;
var UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124 Safari/537.36';

// ---------------------------------------------------------------- entry points
function doGet() {
  return json_({ ok: true, app: 'Growebtek AI Stock & Fund Analyzer', time: new Date().toISOString() });
}

function doPost(e) {
  var req;
  try { req = JSON.parse(e.postData.contents); } catch (err) { return json_({ error: 'bad_request', message: 'Bad request.' }); }
  try { return json_(route_(req)); }
  catch (err) {
    if (err && err.gw) return json_({ error: err.code, message: err.message });
    console.error(err && err.stack || err);
    return json_({ error: 'server', message: 'Something went wrong on the server. Please try again.' });
  }
}

function route_(q) {
  switch (q.action) {
    case 'adminLogin': return adminLogin_(q);
    case 'userLogin': return userLogin_(q);
    case 'me': return me_(q);
    case 'logout': return { ok: true };
    case 'listUsers': admin_(q); return { users: listUsers_() };
    case 'saveUser': admin_(q); return saveUser_(q);
    case 'deleteUser': admin_(q); return deleteUser_(q);
    case 'changePassword': admin_(q); return changePassword_(q);
    case 'search': anyone_(q); return search_(q);
    case 'stock': anyone_(q); return security_(q, false);
    case 'fund': anyone_(q); return security_(q, true);
  }
  throw fail_('bad_request', 'Unknown action.');
}

// ---------------------------------------------------------------- helpers
function json_(o) { return ContentService.createTextOutput(JSON.stringify(o)).setMimeType(ContentService.MimeType.JSON); }
function fail_(code, msg) { var e = new Error(msg); e.gw = true; e.code = code; return e; }
function props_() { return PropertiesService.getScriptProperties(); }
function hex_(bytes) { return bytes.map(function (b) { return ('0' + (b & 255).toString(16)).slice(-2); }).join(''); }
function sha_(s) { return hex_(Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, s, Utilities.Charset.UTF_8)); }
function hashPw_(salt, pw) { var h = salt + ':' + pw; for (var i = 0; i < HASH_ROUNDS; i++) h = sha_(h); return h; }
function b64u_(s) { return Utilities.base64EncodeWebSafe(s, Utilities.Charset.UTF_8).replace(/=+$/, ''); }
function unb64u_(s) { while (s.length % 4) s += '='; return Utilities.newBlob(Utilities.base64DecodeWebSafe(s, Utilities.Charset.UTF_8)).getDataAsString('UTF-8'); }
function eqConst_(a, b) { a = String(a); b = String(b); if (a.length !== b.length) return false; var r = 0; for (var i = 0; i < a.length; i++) r |= a.charCodeAt(i) ^ b.charCodeAt(i); return r === 0; }
function mobile_(m) { var d = String(m || '').replace(/\D/g, ''); return d.length > 10 ? d.slice(-10) : d; }
function device_(d) { return String(d || '').toUpperCase().replace(/[^A-Z0-9]/g, ''); }
function secret_() {
  var p = props_(), s = p.getProperty('SECRET');
  if (!s) { s = Utilities.getUuid() + Utilities.getUuid(); p.setProperty('SECRET', s); }
  return s;
}
function sign_(payload) {
  var body = b64u_(JSON.stringify(payload));
  var sig = Utilities.base64EncodeWebSafe(Utilities.computeHmacSha256Signature(body, secret_())).replace(/=+$/, '');
  return body + '.' + sig;
}
function verify_(token) {
  if (!token || token.indexOf('.') < 0) return null;
  var parts = String(token).split('.');
  var sig = Utilities.base64EncodeWebSafe(Utilities.computeHmacSha256Signature(parts[0], secret_())).replace(/=+$/, '');
  if (!eqConst_(sig, parts[1])) return null;
  try { var p = JSON.parse(unb64u_(parts[0])); return p.e > Date.now() ? p : null; } catch (e) { return null; }
}
// Too many wrong attempts -> short lock (per key).
function throttle_(key, max, minutes) {
  var c = CacheService.getScriptCache(), n = +(c.get('t:' + key) || 0);
  if (n >= max) throw fail_('locked', 'Too many attempts. Please wait ' + minutes + ' minutes and try again.');
  return function bump() { c.put('t:' + key, String(n + 1), minutes * 60); };
}

// ---------------------------------------------------------------- auth
function adminHash_() {
  var p = props_();
  return { salt: p.getProperty('ADMIN_SALT') || DEFAULT_SALT, hash: p.getProperty('ADMIN_HASH') || DEFAULT_HASH, ver: +(p.getProperty('ADMIN_VER') || 1) };
}
function adminLogin_(q) {
  var bump = throttle_('admin', 6, 15);
  var a = adminHash_();
  if (mobile_(q.mobile) !== ADMIN_MOBILE || !eqConst_(hashPw_(a.salt, String(q.password || '')), a.hash)) {
    bump(); throw fail_('denied', 'Wrong mobile number or password.');
  }
  var exp = Date.now() + ADMIN_SESSION_HOURS * 3600e3;
  return { token: sign_({ r: 'admin', m: ADMIN_MOBILE, d: device_(q.deviceId), e: exp, v: a.ver }), role: 'admin', mobile: ADMIN_MOBILE, exp: exp };
}
function endOfDayIst_(ymd) { // expiry date is valid until 23:59:59 India time
  var t = Date.parse(ymd + 'T23:59:59+05:30');
  return isNaN(t) ? 0 : t;
}
function userLogin_(q) {
  var m = mobile_(q.mobile), d = device_(q.deviceId);
  if (m.length !== 10) throw fail_('denied', 'Please enter a valid 10-digit mobile number.');
  if (d.length !== 16) throw fail_('denied', 'Device ID missing. Please reload the page.');
  var bump = throttle_('u' + m, 15, 10);
  var all = listUsers_().filter(function (u) { return u.mobile === m; });
  if (!all.length) { bump(); throw fail_('denied', 'This mobile number does not have access yet. Share your Device ID with the admin to get access.'); }
  var u = all.filter(function (x) { return x.deviceId === d; })[0];
  if (!u) { bump(); throw fail_('denied', 'This device is not approved for this mobile number. Share your Device ID with the admin.'); }
  if (u.status === 'blocked') throw fail_('denied', 'Your access has been paused by the admin.');
  var end = endOfDayIst_(u.expiry);
  if (end < Date.now()) throw fail_('denied', 'Your access expired on ' + u.expiry + '. Please contact the admin to renew.');
  var exp = Math.min(end, Date.now() + USER_SESSION_DAYS * 864e5);
  return { token: sign_({ r: 'user', m: m, d: d, e: exp }), role: 'user', mobile: m, name: u.name || '', expiry: u.expiry, exp: exp };
}
// Validates the token; for users also re-checks the access list (removed/expired/blocked users are signed out).
function session_(q, strict) {
  var p = verify_(q.token);
  if (!p || p.d !== device_(q.deviceId)) throw fail_('auth', 'Please log in again.');
  if (p.r === 'admin') {
    if (p.v !== adminHash_().ver) throw fail_('auth', 'Password changed. Please log in again.');
  } else if (strict) {
    var u = getUser_(p.m, p.d);
    if (!u || u.status === 'blocked' || endOfDayIst_(u.expiry) < Date.now()) throw fail_('auth', 'Your access has ended. Please contact the admin.');
    p.expiry = u.expiry; p.name = u.name || '';
  }
  return p;
}
function admin_(q) { var p = session_(q, true); if (p.r !== 'admin') throw fail_('auth', 'Admin only.'); return p; }
function anyone_(q) { return session_(q, false); }
function me_(q) { var p = session_(q, true); return { role: p.r, mobile: p.m, expiry: p.expiry || null, name: p.name || '', exp: p.e }; }

function changePassword_(q) {
  var a = adminHash_();
  if (!eqConst_(hashPw_(a.salt, String(q.oldPassword || '')), a.hash)) throw fail_('denied', 'Current password is wrong.');
  var pw = String(q.newPassword || '');
  if (pw.length < 10 || !/[A-Za-z]/.test(pw) || !/\d/.test(pw)) throw fail_('denied', 'New password must be at least 10 characters with letters and numbers.');
  var salt = Utilities.getUuid().replace(/-/g, '').slice(0, 24);
  props_().setProperties({ ADMIN_SALT: salt, ADMIN_HASH: hashPw_(salt, pw), ADMIN_VER: String(a.ver + 1) });
  return { ok: true };
}

// ---------------------------------------------------------------- users (one script property per user+device)
function ukey_(m, d) { return 'u:' + m + ':' + d; }
function listUsers_() {
  var all = props_().getProperties(), out = [];
  Object.keys(all).forEach(function (k) {
    if (k.indexOf('u:') !== 0) return;
    try { out.push(JSON.parse(all[k])); } catch (e) {}
  });
  return out.sort(function (a, b) { return (b.created || 0) - (a.created || 0); });
}
function getUser_(m, d) { var v = props_().getProperty(ukey_(m, d)); return v ? JSON.parse(v) : null; }
function saveUser_(q) {
  var m = mobile_(q.mobile), d = device_(q.newDeviceId), exp = String(q.expiry || '');
  if (m.length !== 10) throw fail_('invalid', 'Mobile number must have 10 digits.');
  if (d.length !== 16) throw fail_('invalid', 'Device ID must be exactly 16 letters/numbers.');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(exp) || !endOfDayIst_(exp)) throw fail_('invalid', 'Please choose a valid expiry date.');
  var lock = LockService.getScriptLock(); lock.waitLock(10000);
  try {
    var p = props_(), now = Date.now(), prev = null;
    if (q.origMobile && q.origDeviceId) {
      var ok = ukey_(mobile_(q.origMobile), device_(q.origDeviceId));
      var pv = p.getProperty(ok); if (pv) prev = JSON.parse(pv);
      if (ok !== ukey_(m, d)) p.deleteProperty(ok);
    }
    var existing = getUser_(m, d);
    var rec = { mobile: m, deviceId: d, expiry: exp, name: String(q.name || '').slice(0, 60), status: q.status === 'blocked' ? 'blocked' : 'active',
      created: (prev || existing || {}).created || now, updated: now };
    p.setProperty(ukey_(m, d), JSON.stringify(rec));
    return { ok: true, user: rec };
  } finally { lock.releaseLock(); }
}
function deleteUser_(q) {
  props_().deleteProperty(ukey_(mobile_(q.mobile), device_(q.targetDeviceId)));
  return { ok: true };
}

// ---------------------------------------------------------------- market data (Yahoo Finance)
function cacheGet_(k) { try { var v = CacheService.getScriptCache().get(k); return v ? JSON.parse(v) : null; } catch (e) { return null; } }
function cachePut_(k, o, s) { try { var v = JSON.stringify(o); if (v.length < 95000) CacheService.getScriptCache().put(k, v, s); } catch (e) {} }

function fetchJson_(url, headers) {
  var r = UrlFetchApp.fetch(url, { muteHttpExceptions: true, headers: Object.assign({ 'User-Agent': UA, Accept: 'application/json' }, headers || {}) });
  var code = r.getResponseCode();
  if (code !== 200) return { _status: code };
  try { return JSON.parse(r.getContentText()); } catch (e) { return { _status: 'parse' }; }
}
function yahooAuth_(force) {
  var c = CacheService.getScriptCache();
  if (!force) { var v = c.get('yauth'); if (v) return JSON.parse(v); }
  var cookie = '';
  ['https://fc.yahoo.com/', 'https://finance.yahoo.com/'].some(function (u) {
    try {
      var r = UrlFetchApp.fetch(u, { muteHttpExceptions: true, followRedirects: false, headers: { 'User-Agent': UA } });
      var sc = r.getAllHeaders()['Set-Cookie'];
      sc = Array.isArray(sc) ? sc : sc ? [sc] : [];
      cookie = sc.map(function (s) { return s.split(';')[0]; }).filter(function (s) { return /^(A1|A3|B)=/.test(s); }).join('; ');
    } catch (e) {}
    return !!cookie;
  });
  var crumb = '';
  ['https://query1.finance.yahoo.com', 'https://query2.finance.yahoo.com'].some(function (h) {
    try {
      var r = UrlFetchApp.fetch(h + '/v1/test/getcrumb', { muteHttpExceptions: true, headers: { 'User-Agent': UA, Cookie: cookie } });
      var t = r.getContentText();
      if (r.getResponseCode() === 200 && t && t.length < 40 && t.indexOf('<') < 0) crumb = t;
    } catch (e) {}
    return !!crumb;
  });
  var auth = { cookie: cookie, crumb: crumb };
  if (crumb) c.put('yauth', JSON.stringify(auth), 6 * 3600);
  return auth;
}
function yahoo_(path, needCrumb) {
  var hosts = ['https://query1.finance.yahoo.com', 'https://query2.finance.yahoo.com'];
  var auth = needCrumb ? yahooAuth_(false) : null;
  for (var i = 0; i < 3; i++) {
    var url = hosts[i % 2] + path;
    var hdr = {};
    if (auth) { url += (path.indexOf('?') < 0 ? '?' : '&') + 'crumb=' + encodeURIComponent(auth.crumb); hdr.Cookie = auth.cookie; }
    var j = fetchJson_(url, hdr);
    if (!j._status) return j;
    if ((j._status === 401 || j._status === 403) && needCrumb) auth = yahooAuth_(true);
    else if (j._status === 404) return null;
    Utilities.sleep(400 * (i + 1));
  }
  return null;
}

function search_(q) {
  var text = String(q.q || '').trim();
  if (text.length < 1) return { results: [] };
  var key = 's:' + (q.kind || '') + ':' + text.toLowerCase();
  var hit = cacheGet_(key); if (hit) return hit;
  var j = yahoo_('/v1/finance/search?quotesCount=12&newsCount=0&enableFuzzyQuery=true&q=' + encodeURIComponent(text), false);
  var want = q.kind === 'fund' ? { MUTUALFUND: 1, ETF: 1 } : { EQUITY: 1, ETF: 1 };
  var res = ((j && j.quotes) || []).filter(function (x) { return x.symbol && want[x.quoteType]; }).map(function (x) {
    return { symbol: x.symbol, name: x.longname || x.shortname || x.symbol, exchange: x.exchDisp || x.exchange || '', type: x.typeDisp || x.quoteType, quoteType: x.quoteType };
  });
  var out = { results: res };
  cachePut_(key, out, 3600);
  return out;
}

function compactChart_(c) {
  if (!c || !c.timestamp) return null;
  var q = c.indicators.quote[0], adj = c.indicators.adjclose && c.indicators.adjclose[0] && c.indicators.adjclose[0].adjclose;
  var t = [], cl = [], ac = [], v = [], h = [], l = [];
  for (var i = 0; i < c.timestamp.length; i++) {
    if (q.close[i] == null) continue;
    t.push(c.timestamp[i]); cl.push(+q.close[i].toPrecision(7)); v.push(q.volume && q.volume[i] || 0);
    h.push(q.high && q.high[i] != null ? +q.high[i].toPrecision(7) : cl[cl.length - 1]);
    l.push(q.low && q.low[i] != null ? +q.low[i].toPrecision(7) : cl[cl.length - 1]);
    ac.push(adj && adj[i] != null ? +adj[i].toPrecision(7) : cl[cl.length - 1]);
  }
  var m = c.meta || {};
  return { t: t, c: cl, ac: ac, h: h, l: l, v: v, meta: { currency: m.currency, symbol: m.symbol, exchange: m.fullExchangeName || m.exchangeName, tz: m.exchangeTimezoneName,
    price: m.regularMarketPrice, prevClose: m.chartPreviousClose, time: m.regularMarketTime, type: m.instrumentType, name: m.longName || m.shortName,
    dayHigh: m.regularMarketDayHigh, dayLow: m.regularMarketDayLow, hi52: m.fiftyTwoWeekHigh, lo52: m.fiftyTwoWeekLow } };
}
function raw_(o) { // flatten Yahoo {raw, fmt} objects
  if (o == null || typeof o !== 'object') return o;
  if (Array.isArray(o)) return o.map(raw_);
  if ('raw' in o) return o.raw;
  if (Object.keys(o).length === 0) return null;
  var r = {}; Object.keys(o).forEach(function (k) { r[k] = raw_(o[k]); }); return r;
}
function security_(q, isFund) {
  var sym = String(q.symbol || '').trim().toUpperCase();
  if (!/^[A-Z0-9.\-^=&]{1,20}$/.test(sym)) throw fail_('invalid', 'Unknown symbol.');
  var key = (isFund ? 'f:' : 'k:') + sym;
  var hit = cacheGet_(key); if (hit) return hit;
  var range = isFund ? '10y' : '5y';
  var ch = yahoo_('/v8/finance/chart/' + encodeURIComponent(sym) + '?range=' + range + '&interval=1d&includeAdjustedClose=true&events=div%2Csplit', false);
  var chart = compactChart_(ch && ch.chart && ch.chart.result && ch.chart.result[0]);
  if (!chart) throw fail_('not_found', 'No market data found for ' + sym + '. Check the name or try another listing.');
  if (isFund) { delete chart.h; delete chart.l; delete chart.v; } // funds: closing values are enough (keeps the reply small)
  var mods = isFund
    ? 'price,summaryDetail,defaultKeyStatistics,fundProfile,fundPerformance,topHoldings,assetProfile'
    : 'price,summaryDetail,defaultKeyStatistics,financialData,assetProfile,recommendationTrend,earnings,earningsTrend,calendarEvents';
  var s = yahoo_('/v10/finance/quoteSummary/' + encodeURIComponent(sym) + '?modules=' + mods, true);
  var summary = s && s.quoteSummary && s.quoteSummary.result && raw_(s.quoteSummary.result[0]) || null;
  if (summary && summary.assetProfile) {
    var ap = summary.assetProfile;
    summary.assetProfile = { sector: ap.sector, industry: ap.industry, country: ap.country, website: ap.website, employees: ap.fullTimeEmployees,
      summary: String(ap.longBusinessSummary || '').slice(0, 900) };
  }
  if (summary && summary.earningsTrend) summary.earningsTrend = (summary.earningsTrend.trend || []).slice(0, 4).map(function (t) {
    return { period: t.period, growth: t.growth, epsAvg: t.earningsEstimate && t.earningsEstimate.avg, revAvg: t.revenueEstimate && t.revenueEstimate.avg };
  });
  if (summary && summary.topHoldings) {
    var th = summary.topHoldings;
    summary.topHoldings = { holdings: (th.holdings || []).slice(0, 10).map(function (x) { return { name: x.holdingName, symbol: x.symbol, pct: x.holdingPercent }; }),
      sectors: (th.sectorWeightings || []).map(function (o) { var k = Object.keys(o)[0]; return { sector: k, pct: o[k] }; }),
      stock: th.stockPosition, bond: th.bondPosition, cash: th.cashPosition, pe: th.equityHoldings && th.equityHoldings.priceToEarnings, pb: th.equityHoldings && th.equityHoldings.priceToBook };
  }
  var news = [];
  try {
    var nm = (summary && summary.price && (summary.price.shortName || summary.price.longName)) || chart.meta.name || sym;
    nm = String(nm).replace(/\b(limited|ltd\.?|inc\.?|corporation|corp\.?|plc|co\.?)\s*$/i, '').trim();
    var nj = yahoo_('/v1/finance/search?quotesCount=0&newsCount=8&q=' + encodeURIComponent(nm), false);
    news = ((nj && nj.news) || []).map(function (n) { return { title: n.title, url: n.link, src: n.publisher, ts: (n.providerPublishTime || 0) * 1000 }; });
  } catch (e) {}
  var out = { symbol: sym, chart: chart, summary: summary, news: news, fetched: Date.now() };
  cachePut_(key, out, 600);
  return out;
}

// Run once from the editor to approve permissions and check data access.
function setupTest() {
  secret_();
  var r = search_({ q: 'Reliance', kind: 'stock' });
  Logger.log('Search OK: ' + r.results.length + ' results');
  var s = security_({ symbol: 'AAPL' }, false);
  Logger.log('Price data OK: ' + s.chart.c.length + ' days. Company details: ' + (s.summary ? 'OK' : 'not available'));
}
