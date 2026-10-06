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
function doGet(e) {
  var feed = e && e.parameter && e.parameter.feed;
  if (e && e.parameter && e.parameter.ping) return json_({ ok: true, version: 'v10' });
  var ns = e && e.parameter && e.parameter.news;
  if (ns) { try { var nk = 'n81:' + ns; var hit = cacheGet_(nk); if (hit) return json_(hit); var nr = { symbol: ns, news: stockNews_(String(ns).toUpperCase().slice(0, 20), String(e.parameter.name || ns).slice(0, 80)) }; cachePut_(nk, nr, 600); return json_(nr); } catch (err) { return json_({ ok: false }); } }
  if (feed) { try { return json_(marketFeed_(String(feed), !!e.parameter.debug)); } catch (err) { return json_({ ok: false, error: 'feed unavailable' }); } }
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
    case 'mfinfo': anyone_(q); return mfInfo_(q);
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
  var key = (isFund ? 'f9:' : 'k9:') + sym;
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
  if (summary && !isFund) { try { summary.fundTs = fundTs_(sym); } catch (e) {} }
  var news = [];
  try {
    var nm = (summary && summary.price && (summary.price.longName || summary.price.shortName)) || chart.meta.name || sym;
    news = stockNews_(sym, nm);
  } catch (e) {}
  var out = { symbol: sym, chart: chart, summary: summary, news: news, fetched: Date.now() };
  cachePut_(key, out, 600);
  return out;
}

// Statement figures (annual, latest quarter, trailing 12M) used to fill ratios Yahoo leaves empty (ROE, current ratio, cash flow, PEG, ...).
function fundTs_(sym) {
  var A = ["FreeCashFlow", "OperatingCashFlow", "CapitalExpenditure", "NetIncome", "StockholdersEquity", "CurrentAssets", "CurrentLiabilities", "TotalRevenue", "EBITDA", "TotalDebt", "CashAndCashEquivalents", "DilutedEPS", "Inventory"];
  var Q = ["StockholdersEquity", "CurrentAssets", "CurrentLiabilities", "TotalDebt", "CashAndCashEquivalents", "Inventory"];
  var T = ["NetIncome", "FreeCashFlow", "OperatingCashFlow", "TotalRevenue", "EBITDA", "DilutedEPS"];
  var types = A.map(function (t) { return "annual" + t; }).concat(Q.map(function (t) { return "quarterly" + t; }), T.map(function (t) { return "trailing" + t; }));
  var now = Math.floor(Date.now() / 1000);
  var j = yahoo_("/ws/fundamentals-timeseries/v1/finance/timeseries/" + encodeURIComponent(sym) + "?type=" + types.join(",") + "&period1=" + (now - 6 * 365 * 86400) + "&period2=" + now, false);
  var res = j && j.timeseries && j.timeseries.result;
  if (!res || !res.length) return null;
  var out = { a: {}, q: {}, t: {} };
  res.forEach(function (x) {
    var ty = x.meta && x.meta.type && x.meta.type[0]; if (!ty) return;
    var rows = (x[ty] || []).filter(function (r) { return r && r.reportedValue && isFinite(r.reportedValue.raw); })
      .map(function (r) { return [r.asOfDate, r.reportedValue.raw]; }).sort(function (p, q) { return p[0] < q[0] ? -1 : 1; });
    if (!rows.length) return;
    var m = ty.match(/^(annual|quarterly|trailing)(.+)$/); if (!m) return;
    if (m[1] === "annual") out.a[m[2]] = rows.slice(-4);
    else out[m[1] === "quarterly" ? "q" : "t"][m[2]] = rows[rows.length - 1];
  });
  return out;
}

// Company-specific news, for any listing worldwide: Google News (local edition) by name and by ticker + Yahoo, keeping only headlines about the company.
// Indian mutual fund details the NAV source lacks: AUM, expense ratio, exit load, benchmark, managers, holdings,
// category rank and average, peer funds and news. Sources: Groww's public scheme pages, Kuvera (via ISIN), Google News.
function mfInfo_(q) {
  var code = String(q.code || '').replace(/\D/g, '').slice(0, 7);
  if (!code) throw fail_('invalid', 'Unknown scheme.');
  var key = 'mi10:' + code;
  var hit = cacheGet_(key); if (hit) return hit;
  var name = String(q.name || '').slice(0, 140), isin = String(q.isin || '').toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 12);
  var house = String(q.house || '').slice(0, 60), cat = String(q.category || '').slice(0, 60);
  var out = { code: code, fetched: Date.now() };
  try { out.g = growwInfo_(code, name); } catch (e) {}
  try { if (isin) out.k = kuveraInfo_(isin); } catch (e) {}
  // Regular/IDCW plans are missing from both sources; fall back to the same scheme's Direct Growth plan
  try { if (!out.k && out.g && out.g.isin && out.g.isin !== isin) { out.k = kuveraInfo_(out.g.isin); if (out.k) out.k.approx = true; } } catch (e) {}
  try { out.news = mfNews_(name, house, cat); } catch (e) { out.news = []; }
  cachePut_(key, out, out.g || out.k ? 6 * 3600 : 900);
  return out;
}
function growGet_(path) {
  var r = UrlFetchApp.fetch('https://groww.in' + path, { muteHttpExceptions: true, headers: { 'User-Agent': UA, Accept: 'application/json' } });
  if (r.getResponseCode() !== 200) return null;
  try { return JSON.parse(r.getContentText()); } catch (e) { return null; }
}
function growwInfo_(code, name) {
  var base = String(name).split(/\s+-\s+/)[0].replace(/\s*\((formerly|erstwhile)[^)]*\)/ig, '').trim();
  var words = base.split(/\s+/);
  var tries = [base, words.slice(0, 4).join(' '), words.slice(0, 3).join(' ')].filter(function (s, i, a) { return s && a.indexOf(s) === i; });
  var cands = [];
  for (var i = 0; i < tries.length && !cands.length; i++) {
    var s = growGet_('/v1/api/search/v1/entity?app=false&entity_type=scheme&page=0&size=10&q=' + encodeURIComponent(tries[i]));
    cands = (s && s.content || []).filter(function (c) { return c.search_id; });
  }
  if (!cands.length) return null;
  var exact = cands.filter(function (c) { return String(c.scheme_code) === code; })[0];
  var order = exact ? [exact] : cands.slice(0, 3), first = null;
  for (var k = 0; k < order.length; k++) {
    var j = growGet_('/v1/api/data/mf/web/v4/scheme/search/' + encodeURIComponent(order[k].search_id));
    if (!j || !j.scheme_name) continue;
    if (!first) first = j;
    if (String(j.scheme_code) === code) return growwCompact_(j, false);
    if (j.regular_search_id && String(j.direct_scheme_code) !== code) {
      var r = growGet_('/v1/api/data/mf/web/v4/scheme/search/' + encodeURIComponent(j.regular_search_id));
      if (r && String(r.scheme_code) === code) return growwCompact_(r, false);
    }
  }
  // same scheme, other plan/option (e.g. IDCW): portfolio, managers and exit load are shared
  return first ? growwCompact_(first, true) : null;
}
function growwCompact_(j, approx) {
  var rs = (j.return_stats || [])[0] || {}, st = {};
  (j.stats || []).forEach(function (s) { st[s.type] = s; });
  var hold = (j.holdings || []).filter(function (h) { return h && isFinite(+h.corpus_per); }).sort(function (a, b) { return b.corpus_per - a.corpus_per; });
  var sec = {}, nat = {};
  hold.forEach(function (h) { var p = +h.corpus_per; var sn = h.sector_name || 'Others'; sec[sn] = (sec[sn] || 0) + p; var nn = h.nature_name || 'Other'; nat[nn] = (nat[nn] || 0) + p; });
  var toArr = function (o) { return Object.keys(o).map(function (k) { return [k, Math.round(o[k] * 100) / 100]; }).sort(function (a, b) { return b[1] - a[1]; }); };
  var cut = function (s, n) { s = String(s || '').replace(/\s+/g, ' ').trim(); return s.length > n ? s.slice(0, n - 1) + '…' : s; };
  var pickRs = {};
  ['return1m', 'return3m', 'return6m', 'return1y', 'return3y', 'return5y', 'return10y', 'cat_return1y', 'cat_return3y', 'cat_return5y', 'cat_return10y', 'rank1yr', 'rank3yr', 'rank5yr', 'rank10yr',
    'rank_count1yr', 'rank_count3yr', 'rank_count5yr', 'rank_count10yr', 'sharpe_ratio', 'sortino_ratio', 'beta', 'alpha', 'standard_deviation', 'information_ratio', 'risk', 'mean_return']
    .forEach(function (k) { if (rs[k] != null) pickRs[k] = rs[k]; });
  return {
    approx: approx, sid: j.search_id, isin: j.isin || '', code: String(j.scheme_code || ''), name: j.scheme_name, plan: j.plan_type, opt: j.scheme_type,
    exitLoad: cut(j.exit_load, 400), lockIn: j.lock_in, benchmark: j.benchmark_name || j.benchmark, aum: j.aum, exp: parseFloat(j.expense_ratio), baseExp: parseFloat(j.base_expense_ratio),
    turnover: j.portfolio_turnover, launch: j.launch_date || j.allotment_date, minSip: j.min_sip_investment, minLump: j.min_investment_amount,
    desc: cut(j.description, 700), catDesc: cut((j.category_info || {}).description, 500), tax: cut((j.category_info || {}).tax_impact, 300),
    risk: rs.risk || j.nfo_risk || '', rating: j.groww_rating, cat: j.category, sub: j.sub_category, stamp: j.stamp_duty, rta: (j.rta_details || {}).rta_name,
    rs: pickRs, catAvg: st.CATEGORY_AVG_RETURN || null,
    analysis: (j.analysis || []).map(function (a) { return { t: a.analysis_type, d: cut(a.analysis_desc, 260) }; }),
    managers: (j.fund_manager_details || []).slice(0, 6).map(function (m) { return { n: m.person_name, from: m.date_from, edu: cut(m.education, 200), exp: cut(m.experience, 280), funds: (m.funds_managed || []).length }; }),
    hold: hold.slice(0, 15).map(function (h) { return { n: h.company_name, s: h.sector_name, k: h.nature_name, i: h.instrument_name, p: Math.round(h.corpus_per * 100) / 100, r: h.rating || '' }; }),
    holdN: hold.length, holdDate: (hold[0] || {}).portfolio_date || null, sectors: toArr(sec).slice(0, 12), nature: toArr(nat),
    amcAum: (j.amc_info || {}).aum, amcRank: (j.amc_info || {}).rank
  };
}
function kuveraInfo_(isin) {
  var r = UrlFetchApp.fetch('https://mf.captnemo.in/kuvera/' + encodeURIComponent(isin), { muteHttpExceptions: true, followRedirects: true, headers: { 'User-Agent': UA, Accept: 'application/json' } });
  if (r.getResponseCode() !== 200) return null;
  var a = JSON.parse(r.getContentText()), j = Array.isArray(a) ? a[0] : a;
  if (!j || !j.name) return null;
  var cr = function (x) { return isFinite(+x) ? Math.round(+x / 10) : null; }; // Kuvera reports AUM in units of ₹10 lakh
  return {
    rating: j.fund_rating, ratingDate: j.fund_rating_date, riskLabel: j.crisil_rating, objective: String(j.investment_objective || '').slice(0, 700), aum: cr(j.aum),
    exp: parseFloat(j.expense_ratio), expDate: j.expense_ratio_date, managers: j.fund_manager, vol: j.volatility, ret: j.returns, start: j.start_date, cat: j.fund_category, type: j.fund_type,
    lockIn: j.lock_in_period, turnover: j.portfolio_turnover,
    peers: (j.comparison || []).slice(0, 8).map(function (p) { return { n: p.short_name || p.name, code: p.code, y1: p['1y'], y3: p['3y'], y5: p['5y'], si: p.inception, vol: p.volatility, exp: p.expense_ratio, aum: cr(p.aum), ir: p.info_ratio }; })
  };
}
function mfNews_(name, house, cat) {
  var base = String(name).split(/\s+-\s+/)[0].trim();
  var brand = String(house).replace(/\s*mutual\s*fund\s*$/i, '').trim();
  var catW = String(cat).replace(/^(equity|debt|hybrid|other|solution oriented)\s+scheme\s*-\s*/i, '').replace(/\s*fund\s*$/i, '').trim();
  var g = function (q) { return 'https://news.google.com/rss/search?q=' + encodeURIComponent(q) + '&hl=en-IN&gl=IN&ceid=IN:en'; };
  var reqs = [[g('"' + base + '" when:120d'), 'fund'], [g('"' + brand + '" ("mutual fund" OR AMC OR NFO OR SIP) when:45d'), 'amc']];
  if (catW && catW.length > 3) reqs.push([g('"' + catW + '" (funds OR "mutual funds" OR "mutual fund") when:30d'), 'category']);
  var dec = function (t) { return String(t || '').replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1').replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/<[^>]+>/g, '').trim(); };
  var tag = function (b, n) { var m = b.match(new RegExp('<' + n + '[^>]*>([\\s\\S]*?)</' + n + '>')); return m ? dec(m[1]) : ''; };
  var rs = []; try { rs = UrlFetchApp.fetchAll(reqs.map(function (x) { return { url: x[0], muteHttpExceptions: true, headers: { 'User-Agent': UA } }; })); } catch (e) {}
  var lc = function (s) { return s.toLowerCase(); }, keyB = lc(base.split(/\s+/).slice(0, 2).join(' ')), keyH = lc(brand.split(/\s+/)[0] || ''), keyC = lc(catW);
  var seen = {}, out = [];
  rs.forEach(function (r, ix) {
    if (!r || r.getResponseCode() !== 200) return;
    (r.getContentText().match(/<item[\s>][\s\S]*?<\/item>/g) || []).slice(0, 25).forEach(function (b) {
      var t = tag(b, 'title'), src = tag(b, 'source');
      if (src) t = t.replace(new RegExp('\\s+-\\s+' + src.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '$'), '');
      var tl = lc(t), kind = reqs[ix][1];
      var rel = kind === 'fund' ? tl.indexOf(keyB) >= 0 : kind === 'amc' ? (keyH && tl.indexOf(keyH) >= 0) : (keyC && tl.indexOf(keyC) >= 0);
      if (!rel || t.length < 20) return;
      var k = tl.replace(/[^a-z0-9]+/g, ' ').trim().slice(0, 60); if (seen[k]) return; seen[k] = 1;
      out.push({ title: t, url: tag(b, 'link'), src: src || 'Google News', ts: Date.parse(tag(b, 'pubDate')) || 0, kind: kind });
    });
  });
  var rank = { fund: 0, amc: 1, category: 2 };
  out.sort(function (a, b) { return rank[a.kind] - rank[b.kind] || b.ts - a.ts; });
  var res = [], cnt = { fund: 0, amc: 0, category: 0 };
  out.forEach(function (n) { if (cnt[n.kind] < 5 && res.length < 12) { cnt[n.kind]++; res.push(n); } });
  return res.sort(function (a, b) { return b.ts - a.ts; });
}

function stockNews_(sym, name) {
  var nm = String(name || sym).replace(/\s*\(.*?\)\s*/g, ' ').replace(/&amp;/g, '&').trim();
  for (var i = 0; i < 3; i++) nm = nm.replace(/[.,]?\s*\b(limited|ltd|inc|incorporated|corporation|corp|plc|co|company|holdings?|group|class [a-z]|aktiengesellschaft|ag|se|sa|s\.a|nv|n\.v|spa|s\.p\.a|ab|asa|oyj|kgaa|bhd|berhad|tbk|pcl|nl)\.?\s*$/i, '').trim();
  nm = nm || sym;
  var suf = (sym.match(/\.([A-Z]+)$/) || [])[1] || '', india = suf === 'NS' || suf === 'BO';
  var tick = sym.replace(/\.[A-Z]+$/, '').replace(/^\^/, '').replace(/-/g, ' ');
  var esc = function (s) { return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); };
  var words = nm.split(/\s+/), short = words.length > 2 ? words.slice(0, 2).join(' ') : nm;
  var ed = { NS: 'IN', BO: 'IN', L: 'GB', AX: 'AU', TO: 'CA', V: 'CA', HK: 'HK', SI: 'SG', NZ: 'NZ', JO: 'ZA' }[suf] || 'US';
  var gnews = function (q) { return 'https://news.google.com/rss/search?q=' + encodeURIComponent(q) + '&hl=en-' + ed + '&gl=' + ed + '&ceid=' + ed + ':en'; };
  var tickOk = tick.length > 1 && /[A-Za-z]/.test(tick) && tick.toLowerCase() !== nm.toLowerCase();
  var names = '("' + nm + '"' + (short !== nm ? ' OR "' + short + '"' : '') + ')';
  var reqs = [gnews(names + ' ' + (india ? '(share OR shares OR stock OR NSE OR BSE)' : '(stock OR shares)') + ' when:30d'),
    'https://query2.finance.yahoo.com/v1/finance/search?quotesCount=0&newsCount=15&q=' + encodeURIComponent(nm)];
  if (tickOk) reqs.push(gnews('"' + tick + '" ' + (india ? '(NSE OR BSE OR share)' : '(stock OR shares)') + ' when:30d'));
  var dec = function (t) { return String(t || '').replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1').replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/<[^>]+>/g, '').trim(); };
  var tag = function (b, n) { var m = b.match(new RegExp('<' + n + '[^>]*>([\\s\\S]*?)</' + n + '>')); return m ? dec(m[1]) : ''; };
  var all = [];
  var take = function (rs) {
    rs.forEach(function (r, ix) {
      if (!r || r.getResponseCode() !== 200) return;
      var body = r.getContentText();
      if (/^\s*\{/.test(body)) { try { (JSON.parse(body).news || []).forEach(function (n) { all.push({ title: n.title, url: n.link, src: n.publisher, ts: (n.providerPublishTime || 0) * 1000 }); }); } catch (e) {} return; }
      (body.match(/<item[\s>][\s\S]*?<\/item>/g) || []).forEach(function (b) {
        var t = tag(b, 'title'), src = tag(b, 'source');
        if (src) t = t.replace(new RegExp('\\s+-\\s+' + esc(src) + '$'), '');
        all.push({ title: t, url: tag(b, 'link'), src: src || 'Google News', ts: Date.parse(tag(b, 'pubDate')) || 0, g: 1 });
      });
    });
  };
  var fetch = function (urls) { try { return UrlFetchApp.fetchAll(urls.map(function (u) { return { url: u, muteHttpExceptions: true, headers: { 'User-Agent': UA } }; })); } catch (e) { return []; } };
  take(fetch(reqs));
  // relevance: a headline naming the company in full (or its ticker) is kept; one naming only the first word of the
  // name (e.g. "Siemens", "ABB") also needs a sign it is about this listing, so a parent or namesake company is left out
  var generic = words.length > 1 && /^(the|tata|bajaj|adani|hdfc|icici|sbi|state|bank|indian|india|general|american|united|first|national|new|big|grand|southern|global|bharat|hindustan|mahindra|birla|aditya|godrej|jsw|larsen)$/i.test(words[0]);
  var b = function (s) { return new RegExp('(^|[^a-z0-9\\u0900-\\u097f])(' + s + ')($|[^a-z0-9\\u0900-\\u097f])', 'i'); };
  // a one-word name, or a ticker that is just the first word of the name, is only a weak match
  var strong = words.length > 1 ? [esc(short.toLowerCase()), esc(nm.toLowerCase())] : [];
  if (generic) strong.push(esc(words.slice(0, 2).join(' ').toLowerCase()));
  var strongRx = strong.length ? b(strong.join('|')) : null, weakRx = generic ? null : b(esc(words[0].toLowerCase()));
  // tickers are matched in capitals only, so SHOP or BEL do not match the words shop or bel
  var tickRx = tickOk && tick.length > 2 && tick.toLowerCase() !== words[0].toLowerCase() ? new RegExp('(^|[^A-Za-z0-9])' + esc(tick.toUpperCase()) + '($|[^A-Za-z0-9])') : null;
  // a namesake or parent company: the first word followed by another company word, e.g. Siemens Energy, ABB Power
  var other = new RegExp('(^|[^a-z0-9])' + esc(words[0].toLowerCase()) + '\\W+(energy|healthineers|ag|se|aktiengesellschaft|gamesa|mobility|group|inc|corp|corporation|plc|holdings?|motors?|financial|capital|power|global|international|usa|us|uk|europe|japan|china|germany|asia|music|entertainment)\\b', 'i');
  var full = String(name || '').toLowerCase(), namesake = function (t) { var m = t.match(other); return !!m && full.indexOf(m[2].toLowerCase()) < 0; };
  var foreign = /\b(eur|usd|chf|gbp|aud|cad|hkd|swx|xetra|nyse|nasdaq|asx|tsx|lse|hkex|sgx|otc|pre-market|frankfurt|australia|aussie)\b|\$\s?\d/i;
  var fin = /\b(shares?|stocks?|nse|bse|sensex|nifty|nasdaq|nyse|s&p|dow|target|q[1-4]|fy\d*|results?|earnings|ipo|dividend|ltd|limited|inc|profit|revenue|orders?|rating|upgrade|downgrade|buy|sell|hold|price|market cap|ceo|deal|acquir\w*|stake|investors?|analysts?|brokerage|rally|falls?|jumps?|surges?|slips?|gains?|crore|lakh|billion|million|bonus|split|sales|launch\w*)\b/i;
  var local = india ? /\b(india|indian|nse|bse|sensex|nifty|ltd|limited|crore|lakh|rs|inr|dalal)\b|₹|[ऀ-ॿ]/i : fin;
  var junk = /stock price, news|share price, news|news, quote|options? chain|live price|tokeni[sz]ed stock|, [^,]+ live,|stock quote|share price (today|live)|stock price (today|live)|price - live|price & chart|stock forecasts?\b|historical (data|prices)|market (report|size|share)|forecast to 20\d\d|cagr of|(stock|shares?|position|stake|holdings?) (sold|bought|purchased|acquired|cut|raised|trimmed|lowered|increased|decreased|boosted|reduced) by|(sells|buys|acquires|purchases) [\d,]+ shares|has \$?[\d.,]+ (million|billion)? ?(stock )?(position|holdings|stake)/i;
  var pick = function () {
    var seen = {}, out = [];
    all.filter(function (x) { return x.title && x.title.length > 15 && x.url && !junk.test(x.title) && (strongRx && strongRx.test(x.title) || tickRx && tickRx.test(x.title) || weakRx && weakRx.test(x.title) && local.test(x.title) && !namesake(x.title) && !(india && foreign.test(x.title))); })
      .sort(function (p, q) { return q.ts - p.ts; })
      .forEach(function (x) { var k = x.title.toLowerCase().replace(/[^a-z0-9ऀ-ॿ]+/g, ' ').trim().slice(0, 60); if (!seen[k] && out.length < 10) { seen[k] = 1; out.push(x); } });
    return out;
  };
  var out = pick();
  // thinly covered stocks: widen to any date and to the plain name
  if (out.length < 5) { take(fetch([gnews(names), gnews('"' + nm + '"' + (tickOk ? ' OR "' + tick + '"' : ''))])); out = pick(); }
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

// ===== LIVE MARKET REPORTS (generated by build-market.mjs, do not edit by hand) =====
if (!Array.prototype.at) Object.defineProperty(Array.prototype, 'at', { value: function (i) { i = Math.trunc(i) || 0; if (i < 0) i += this.length; return this[i]; }, configurable: true, writable: true });
var __defProp = Object.defineProperty;
var __defProps = Object.defineProperties;
var __getOwnPropDescs = Object.getOwnPropertyDescriptors;
var __getOwnPropSymbols = Object.getOwnPropertySymbols;
var __hasOwnProp = Object.prototype.hasOwnProperty;
var __propIsEnum = Object.prototype.propertyIsEnumerable;
var __defNormalProp = (obj, key, value) => key in obj ? __defProp(obj, key, { enumerable: true, configurable: true, writable: true, value }) : obj[key] = value;
var __spreadValues = (a, b) => {
  for (var prop in b || (b = {}))
    if (__hasOwnProp.call(b, prop))
      __defNormalProp(a, prop, b[prop]);
  if (__getOwnPropSymbols)
    for (var prop of __getOwnPropSymbols(b)) {
      if (__propIsEnum.call(b, prop))
        __defNormalProp(a, prop, b[prop]);
    }
  return a;
};
var __spreadProps = (a, b) => __defProps(a, __getOwnPropDescs(b));
var __objRest = (source, exclude) => {
  var target = {};
  for (var prop in source)
    if (__hasOwnProp.call(source, prop) && exclude.indexOf(prop) < 0)
      target[prop] = source[prop];
  if (source != null && __getOwnPropSymbols)
    for (var prop of __getOwnPropSymbols(source)) {
      if (exclude.indexOf(prop) < 0 && __propIsEnum.call(source, prop))
        target[prop] = source[prop];
    }
  return target;
};
var MKT_ = (function() {
  const MEMO = {};
  let T0 = Date.now(), LIMIT = 45, LOG = [], YA = null, YA_TRIES = 0;
  const late = () => Date.now() - T0 > LIMIT * 1e3;
  const note = (url, status, t) => {
    if (LOG.length < 300) LOG.push(String(url).replace(/^https?:\/\//, "").slice(0, 70) + " " + status + " " + (Date.now() - t) + "ms");
  };
  const YH = /^https:\/\/query[12]\.finance\.yahoo\.com\/v[78]\//;
  const withAuth = (url, o) => {
    if (!YA || !YA.crumb || !YH.test(url)) return [url, o];
    return [url + (url.indexOf("?") < 0 ? "?" : "&") + "crumb=" + encodeURIComponent(YA.crumb), Object.assign({}, o || {}, { headers: Object.assign({}, o && o.headers || {}, { Cookie: YA.cookie }) })];
  };
  let PART = "", MARKED = [];
  const hostOf = (u) => String(u).split("/")[2] || "";
  const hangKey = (h) => "mkt:hang:" + PART + ":" + h;
  const NEVER = ["www.nseindia.com"];
  const markOf = (h) => {
    if (MARKED.indexOf(h) >= 0) return "";
    try {
      return CacheService.getScriptCache().get(hangKey(h)) || "";
    } catch (e) {
      return "";
    }
  };
  const blocked = (h) => NEVER.indexOf(h) >= 0 || markOf(h) === "s";
  function mark(hosts, v) {
    try {
      const c = CacheService.getScriptCache();
      const old = MARKED.filter((h) => hosts.indexOf(h) < 0);
      if (old.length) c.removeAll(old.map(hangKey));
      const o = {};
      hosts.forEach((h) => {
        o[hangKey(h)] = v;
      });
      c.putAll(o, 21600);
      MARKED = hosts.slice();
    } catch (e) {
    }
  }
  function unmark() {
    try {
      if (MARKED.length) CacheService.getScriptCache().removeAll(MARKED.map(hangKey));
    } catch (e) {
    }
    MARKED = [];
  }
  const FAIL = { getResponseCode: () => 599, getContentText: () => "", getAllHeaders: () => ({}) };
  const toReq = (url, o) => ({ url, method: o && o.method || "get", headers: o && o.headers || {}, muteHttpExceptions: true, followRedirects: true });
  const wrap = (r) => {
    const code = r.getResponseCode();
    const all = () => {
      try {
        return r.getAllHeaders();
      } catch (e) {
        return {};
      }
    };
    return {
      ok: code >= 200 && code < 300,
      status: code,
      text: () => r.getContentText(),
      json: () => JSON.parse(r.getContentText()),
      headers: {
        get: (k) => {
          const h = all();
          const key = Object.keys(h).find((x) => x.toLowerCase() === String(k).toLowerCase());
          return key ? String(h[key]) : null;
        },
        getSetCookie: () => {
          const sc = all()["Set-Cookie"];
          return Array.isArray(sc) ? sc : sc ? [sc] : [];
        }
      }
    };
  };
  function prefetch(list) {
    const todo = list.filter((x) => !MEMO[x[0]] && !blocked(hostOf(x[0])) && !markOf(hostOf(x[0])));
    if (!todo.length || late()) return;
    const t = Date.now();
    const hs = todo.map((x) => hostOf(x[0])).filter((h, i, a) => a.indexOf(h) === i);
    mark(hs, hs.length > 1 ? "b" : "s");
    try {
      UrlFetchApp.fetchAll(todo.map((x) => {
        const a = withAuth(x[0], x[1]);
        return toReq(a[0], a[1]);
      })).forEach((r, i) => {
        MEMO[todo[i][0]] = r;
        note(todo[i][0], r.getResponseCode() + " [batch of " + todo.length + "]", t);
      });
    } catch (e) {
      note("[" + todo.length + "] " + todo[0][0], "ERR", t);
    }
  }
  function raw(url, opts) {
    if (late()) return FAIL;
    if (blocked(hostOf(url))) {
      note(url, "skipped", Date.now());
      return FAIL;
    }
    mark([hostOf(url)], "s");
    const a = withAuth(url, opts), t = Date.now();
    try {
      const r = UrlFetchApp.fetch(a[0], toReq(a[0], a[1]));
      note(url, r.getResponseCode(), t);
      return r;
    } catch (e) {
      note(url, "ERR", t);
      throw e;
    }
  }
  function fetch(url, opts) {
    let r = MEMO[url];
    delete MEMO[url];
    if (!r) r = raw(url, opts);
    let res = wrap(r);
    if (YH.test(url) && (res.status === 401 || res.status === 403 || res.status === 429) && YA_TRIES < 2 && !late()) {
      YA_TRIES++;
      const t = Date.now();
      YA = yahooAuth_(YA_TRIES > 1 || YA && YA.crumb);
      note("yahoo crumb", YA && YA.crumb ? "ok" : "none", t);
      if (YA && YA.crumb) res = wrap(raw(url, opts));
    }
    return res;
  }
  const sleep = (ms) => {
    if (ms > 400 && !late()) Utilities.sleep(Math.min(ms, 1500));
  };
  const Promise_all = (a) => a;
  const YAHOO = "https://query1.finance.yahoo.com";
  const sparkUrls = (symbols) => {
    const out = [];
    for (let i = 0; i < symbols.length; i += 20) out.push(YAHOO + "/v7/finance/spark?range=1d&interval=5m&symbols=" + encodeURIComponent(symbols.slice(i, i + 20).join(",")));
    return out;
  };
  const chartUrl = (s) => YAHOO + "/v8/finance/chart/" + encodeURIComponent(s) + "?range=5d&interval=5m";
  function nyOffsetH(ms) {
    try {
      const z = Utilities.formatDate(new Date(ms), "America/New_York", "Z");
      return (z[0] === "-" ? -1 : 1) * (+z.slice(1, 3) + +z.slice(3) / 60);
    } catch (e) {
      return -5;
    }
  }
  function indiaData(__in) {
    var _a, _b, _c, _d, _e, _f, _g, _h, _i, _j, _k, _l;
    const readJson = (x) => x;
    const DATA = __in.data, NEWS = __in.news;
    let __result = null;
    const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124 Safari/537.36";
    const HOSTS = ["https://query1.finance.yahoo.com", "https://query2.finance.yahoo.com"];
    const r2 = (x, d = 2) => x == null || !Number.isFinite(x) ? null : Math.round(x * 10 ** d) / 10 ** d;
    function getJson(path, tries = 4) {
      let lastErr;
      for (let i = 0; i < tries; i++) {
        const url = HOSTS[i % HOSTS.length] + path;
        try {
          const res = fetch(url, { headers: { "User-Agent": UA, Accept: "application/json" }, signal: void 0 });
          if (res.status === 429 || res.status >= 500) throw new Error("HTTP " + res.status);
          if (!res.ok) throw new Error("HTTP " + res.status);
          return res.json();
        } catch (e) {
          lastErr = e;
          sleep(1500 * (i + 1));
        }
      }
      throw lastErr;
    }
    const INDICES = [
      ["^NSEI", "NIFTY 50"],
      ["^BSESN", "SENSEX"],
      ["^NSEBANK", "NIFTY BANK"],
      ["NIFTY_FIN_SERVICE.NS", "NIFTY FIN SERVICES"],
      ["NIFTY_MIDCAP_100.NS", "NIFTY MIDCAP 100"],
      ["^CNXSC", "NIFTY SMALLCAP 100"],
      ["^NSMIDCP", "NIFTY NEXT 50"],
      ["^CNXIT", "NIFTY IT"],
      ["^INDIAVIX", "INDIA VIX"]
    ];
    const SECTORS = [
      ["^CNXIT", "IT"],
      ["^CNXAUTO", "AUTO"],
      ["^CNXFMCG", "FMCG"],
      ["^CNXMEDIA", "MEDIA"],
      ["^CNXMETAL", "METAL"],
      ["^CNXPHARMA", "PHARMA"],
      ["^CNXPSUBANK", "PSU BANK"],
      ["NIFTY_PVT_BANK.NS", "PRIVATE BANK"],
      ["^CNXREALTY", "REALTY"],
      ["NIFTY_OIL_AND_GAS.NS", "OIL & GAS"],
      ["NIFTY_CONSR_DURBL.NS", "CONSUMER DURABLES"],
      ["NIFTY_HEALTHCARE.NS", "HEALTHCARE"],
      ["NIFTY_CHEMICALS.NS", "CHEMICALS"],
      ["NIFTY_CEMENT.NS", "CEMENT"]
    ];
    const GLOBAL = [
      ["^DJI", "Dow Jones", "US"],
      ["^GSPC", "S&P 500", "US"],
      ["^IXIC", "Nasdaq", "US"],
      ["^FTSE", "FTSE 100", "UK"],
      ["^GDAXI", "DAX", "Germany"],
      ["^N225", "Nikkei 225", "Japan"],
      ["^HSI", "Hang Seng", "Hong Kong"],
      ["000001.SS", "Shanghai", "China"],
      ["^KS11", "KOSPI", "Korea"]
    ];
    const ASSETS = [
      ["GC=F", "Gold", "$/oz"],
      ["SI=F", "Silver", "$/oz"],
      ["BZ=F", "Brent", "$/bbl"],
      ["CL=F", "Crude (WTI)", "$/bbl"],
      ["INR=X", "USD/INR", "\u20B9 per $"],
      ["BTC-USD", "Bitcoin", "$"]
    ];
    const STOCKS = `RELIANCE HDFCBANK ICICIBANK INFY TCS BHARTIARTL ITC LT SBIN KOTAKBANK AXISBANK HINDUNILVR BAJFINANCE M&M MARUTI
SUNPHARMA HCLTECH NTPC TATAMOTORS TMPV TITAN ULTRACEMCO POWERGRID ONGC ASIANPAINT TATASTEEL ADANIENT ADANIPORTS BAJAJFINSV
COALINDIA WIPRO JSWSTEEL NESTLEIND BAJAJ-AUTO GRASIM HINDALCO TECHM SBILIFE HDFCLIFE EICHERMOT CIPLA DRREDDY TRENT BEL
SHRIRAMFIN APOLLOHOSP TATACONSUM HEROMOTOCO INDUSINDBK JIOFIN ETERNAL MAXHEALTH INDIGO
ADANIGREEN ADANIPOWER AMBUJACEM BAJAJHLDNG BANKBARODA BOSCHLTD BRITANNIA CANBK CHOLAFIN COLPAL DABUR DIVISLAB DLF DMART
GAIL GODREJCP HAL HAVELLS HINDZINC ICICIGI ICICIPRULI IOC IRFC JINDALSTEL LICI LODHA NAUKRI PIDILITIND PFC PNB RECLTD
SHREECEM SIEMENS ENRIN TATAPOWER TORNTPHARM TVSMOTOR UNITDSPR VBL VEDL ZYDUSLIFE CGPOWER SOLARINDS MAZDOCK HYUNDAI SWIGGY
MPHASIS COFORGE PERSISTENT LTIM OFSS KPITTECH POLICYBZR PAYTM NYKAA UNOMINDA KALYANKJIL UPL LICHSGFIN BLUESTARCO SAIL
POWERINDIA CUMMINSIND BSE MCX ANGELONE CDSL IDEA YESBANK IDFCFIRSTB FEDERALBNK AUBANK BANDHANBNK MUTHOOTFIN MANAPPURAM
ASHOKLEY BHARATFORG MOTHERSON EXIDEIND TATACOMM TATAELXSI LUPIN AUROPHARMA BIOCON ALKEM GLENMARK MANKIND
NMDC NATIONALUM BPCL HINDPETRO PETRONET OIL IGL ADANIENSOL JSWENERGY NHPC SJVN SUZLON IREDA BHEL ABB POLYCAB DIXON
VOLTAS CROMPTON PAGEIND MARICO GODREJPROP OBEROIRLTY PRESTIGE PHOENIXLTD INDHOTEL IRCTC CONCOR ASTRAL SUPREMEIND
TARIL MONEYVIEW`.split(/\s+/).filter(Boolean);
    const IST_OFF = 5.5 * 36e5;
    const istParts = (ms) => {
      const d = new Date(ms + IST_OFF);
      return { y: d.getUTCFullYear(), m: d.getUTCMonth(), d: d.getUTCDate(), dow: d.getUTCDay(), min: d.getUTCHours() * 60 + d.getUTCMinutes(), date: d.toISOString().slice(0, 10), hhmm: d.toISOString().slice(11, 16) };
    };
    function spark(symbols) {
      var _a2, _b2, _c2, _d2, _e2, _f2, _g2, _h2, _i2, _j2, _k2, _l2, _m;
      prefetch(sparkUrls(symbols).map((u) => [u, { headers: { "User-Agent": UA, Accept: "application/json" } }]));
      const out = {};
      for (let i = 0; i < symbols.length; i += 20) {
        const chunk = symbols.slice(i, i + 20);
        try {
          const j = getJson("/v7/finance/spark?range=1d&interval=5m&symbols=" + encodeURIComponent(chunk.join(",")));
          for (const r of (_b2 = (_a2 = j == null ? void 0 : j.spark) == null ? void 0 : _a2.result) != null ? _b2 : []) {
            const m = (_d2 = (_c2 = r.response) == null ? void 0 : _c2[0]) == null ? void 0 : _d2.meta;
            if (!m || m.regularMarketPrice == null) continue;
            const prev = (_e2 = m.chartPreviousClose) != null ? _e2 : m.previousClose, last = m.regularMarketPrice;
            out[r.symbol] = {
              last,
              prev,
              chg: prev ? last - prev : null,
              pct: prev ? (last - prev) / prev * 100 : null,
              high: (_f2 = m.regularMarketDayHigh) != null ? _f2 : null,
              low: (_g2 = m.regularMarketDayLow) != null ? _g2 : null,
              hi52: (_h2 = m.fiftyTwoWeekHigh) != null ? _h2 : null,
              lo52: (_i2 = m.fiftyTwoWeekLow) != null ? _i2 : null,
              vol: (_j2 = m.regularMarketVolume) != null ? _j2 : null,
              time: (_k2 = m.regularMarketTime) != null ? _k2 : null,
              name: (_m = (_l2 = m.shortName) != null ? _l2 : m.longName) != null ? _m : null
            };
          }
        } catch (e) {
          errors.push("spark " + chunk[0] + "..: " + e.message);
        }
        sleep(350);
      }
      return out;
    }
    function intraday(sym) {
      var _a2, _b2, _c2, _d2, _e2, _f2, _g2, _h2;
      const j = getJson(`/v8/finance/chart/${encodeURIComponent(sym)}?range=5d&interval=5m`);
      const r = (_b2 = (_a2 = j == null ? void 0 : j.chart) == null ? void 0 : _a2.result) == null ? void 0 : _b2[0];
      if (!(r == null ? void 0 : r.timestamp)) return null;
      const c = (_f2 = (_e2 = (_d2 = (_c2 = r.indicators) == null ? void 0 : _c2.quote) == null ? void 0 : _d2[0]) == null ? void 0 : _e2.close) != null ? _f2 : [];
      const pts = r.timestamp.map((t, i) => [t, c[i]]).filter(([, v]) => v != null);
      if (!pts.length) return null;
      const lastDate = istParts(pts.at(-1)[0] * 1e3).date;
      const day = pts.filter(([t]) => istParts(t * 1e3).date === lastDate);
      const before = pts.filter(([t]) => istParts(t * 1e3).date < lastDate);
      const prev = before.length ? before.at(-1)[1] : (_h2 = (_g2 = r.meta) == null ? void 0 : _g2.previousClose) != null ? _h2 : null;
      return { date: lastDate, prev: r2(prev), points: day.map(([t, v]) => [t, r2(v)]) };
    }
    function ibja() {
      try {
        const res = fetch("https://ibjarates.com/", { headers: { "User-Agent": UA }, signal: void 0 });
        const html = res.text();
        const hid = (id) => {
          const m = html.match(new RegExp('id="' + id + '" value="([^"]*)"'));
          try {
            return m ? JSON.parse(m[1].replace(/&quot;/g, '"')) : null;
          } catch (e) {
            return null;
          }
        };
        const row = (h, key) => {
          var _a2, _b2;
          const v = h == null ? void 0 : h[key];
          if (!(v == null ? void 0 : v.length)) return null;
          const last = +v.at(-1), prev = +v.at(-2);
          return { last, pct: prev ? r2((last - prev) / prev * 100, 3) : null, date: (_b2 = (_a2 = h.labels) == null ? void 0 : _a2.at(-1)) != null ? _b2 : null };
        };
        const gold = row(hid("HdnGold"), "purity999"), silver = row(hid("HdnSilver"), "silverRate");
        return gold || silver ? { gold, silver, source: "IBJA 999 purity, excl. GST" } : null;
      } catch (e) {
        return null;
      }
    }
    const errors = [];
    const prevData = (_a = readJson(DATA)) != null ? _a : {};
    const news = (_b = readJson(NEWS)) != null ? _b : {};
    const newsSyms = [.../* @__PURE__ */ new Set([
      ...((_c = news.trending) != null ? _c : []).map((t) => t.symbol),
      ...Object.keys((_d = news.gainerReasons) != null ? _d : {}),
      ...Object.keys((_e = news.loserReasons) != null ? _e : {})
    ])];
    const stockList = [.../* @__PURE__ */ new Set([...STOCKS, ...newsSyms])];
    const ySyms = [...new Set([...INDICES, ...SECTORS, ...GLOBAL, ...ASSETS].map((x) => x[0]))];
    const q = spark([...ySyms, ...stockList.map((s) => s + ".NS")]);
    const fmt = (s, name, extra = {}) => {
      const x = q[s];
      return x && __spreadValues({ name, symbol: s, last: r2(x.last), chg: r2(x.chg), pct: r2(x.pct), high: r2(x.high), low: r2(x.low), prev: r2(x.prev) }, extra);
    };
    const nifty = q["^NSEI"];
    if (!nifty) errors.push("nifty quote missing");
    const indices = INDICES.map(([s, n]) => {
      var _a2, _b2;
      return fmt(s, n, { hi52: r2((_a2 = q[s]) == null ? void 0 : _a2.hi52), lo52: r2((_b2 = q[s]) == null ? void 0 : _b2.lo52) });
    }).filter(Boolean);
    const sectors = SECTORS.map(([s, n]) => fmt(s, n)).filter(Boolean).sort((a, b) => b.pct - a.pct);
    const global = GLOBAL.map(([s, n, region]) => fmt(s, n, { region })).filter(Boolean);
    const assets = ASSETS.map(([s, n, unit]) => fmt(s, n, { unit })).filter(Boolean);
    const now = Date.now();
    const nowIst = istParts(now);
    const sessionDate = (nifty == null ? void 0 : nifty.time) ? istParts(nifty.time * 1e3).date : null;
    const stocks = stockList.map((s) => {
      const x = q[s + ".NS"];
      if (!x || x.pct == null) return null;
      if (sessionDate && x.time && istParts(x.time * 1e3).date !== sessionDate) return null;
      return {
        symbol: s,
        name: x.name,
        ltp: r2(x.last),
        chg: r2(x.chg),
        pct: r2(x.pct),
        high: r2(x.high),
        low: r2(x.low),
        prev: r2(x.prev),
        hi52: r2(x.hi52),
        lo52: r2(x.lo52),
        vol: x.vol,
        valueCr: x.vol ? r2(x.vol * x.last / 1e7, 0) : null
      };
    }).filter(Boolean);
    const movable = stocks.filter((s) => Math.abs(s.pct) <= 20);
    const gainers = [...movable].filter((s) => s.pct > 0).sort((a, b) => b.pct - a.pct).slice(0, 10);
    const losers = [...movable].filter((s) => s.pct < 0).sort((a, b) => a.pct - b.pct).slice(0, 10);
    const mostActive = [...stocks].filter((s) => s.valueCr).sort((a, b) => b.valueCr - a.valueCr).slice(0, 10);
    const intra = {};
    prefetch([["^NSEI", "nifty"], ["^BSESN", "sensex"], ["^NSEBANK", "banknifty"]].map(([s]) => [chartUrl(s), { headers: { "User-Agent": UA, Accept: "application/json" } }]).concat([["https://ibjarates.com/", { headers: { "User-Agent": UA } }]]));
    for (const [s, key] of [["^NSEI", "nifty"], ["^BSESN", "sensex"], ["^NSEBANK", "banknifty"]]) {
      try {
        intra[key] = intraday(s);
      } catch (e) {
        errors.push("chart " + s + ": " + e.message);
        intra[key] = (_g = (_f = prevData.intraday) == null ? void 0 : _f[key]) != null ? _g : null;
      }
      sleep(300);
    }
    const inHours = nowIst.dow >= 1 && nowIst.dow <= 5 && nowIst.min >= 555 && nowIst.min < 930;
    const tradedToday = sessionDate === nowIst.date;
    const status = inHours && (tradedToday || !nifty) ? "open" : "closed";
    let statusNote = "Market closed";
    if (status === "open") statusNote = "Market open";
    else if (nowIst.dow === 0 || nowIst.dow === 6) statusNote = "Weekend: market closed";
    else if (inHours && !tradedToday) statusNote = "Market holiday or not yet trading";
    else if (nowIst.min < 555) statusNote = "Pre-open: market opens 9:15 AM IST";
    else statusNote = "Market closed for the day";
    const bullion = (_i = (_h = ibja()) != null ? _h : prevData.bullion) != null ? _i : null;
    const payload = {
      market: { status, note: statusNote, sessionDate, hours: "09:15-15:30 IST, Mon-Fri" },
      indices,
      sectors,
      gainers,
      losers,
      mostActive,
      stocks,
      global,
      assets,
      bullion,
      intraday: intra,
      source: "Yahoo Finance (prices, may be delayed); IBJA (bullion)"
    };
    const strip = (o) => {
      const _a2 = o != null ? o : {}, { updated, updatedIst, errors: _e2 } = _a2, rest = __objRest(_a2, ["updated", "updatedIst", "errors"]);
      return JSON.stringify(rest);
    };
    const usable = indices.length > 0 && stocks.length > 0;
    if (!usable) {
      console.error("No usable data fetched; data.json left unchanged.", errors.join(" | "));
      return null;
    }
    if (false) {
      console.log("No price changes; data.json unchanged.");
    } else {
      const out = __spreadProps(__spreadValues({ updated: new Date(now).toISOString(), updatedIst: `${nowIst.date} ${nowIst.hhmm}` }, payload), { errors });
      __result = out;
      console.log(`Wrote data.json: ${indices.length} indices, ${sectors.length} sectors, ${stocks.length} stocks, nifty ${(_l = (_k = (_j = intra.nifty) == null ? void 0 : _j.points) == null ? void 0 : _k.length) != null ? _l : 0} pts, status=${status}${errors.length ? ", errors: " + errors.join(" | ") : ""}`);
    }
    return __result;
  }
  function indiaNews(__in) {
    var _a, _b, _c, _d, _e, _f, _g, _h, _i, _j, _k, _l, _m, _n, _o, _p, _q, _r, _s, _t, _u, _v;
    const readJson = (x) => x;
    const DATA = __in.data, NEWS = __in.news;
    let __result = null;
    const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124 Safari/537.36";
    const nf = (x, d = 2) => x == null ? "\u2013" : Number(x).toLocaleString("en-IN", { minimumFractionDigits: d, maximumFractionDigits: d });
    const sg = (x, d = 2) => (x > 0 ? "+" : x < 0 ? "\u2212" : "") + nf(Math.abs(x), d);
    const pc = (x) => sg(x) + "%";
    const errors = [];
    function get2(url, opts = {}, tries = 2) {
      var _a2;
      for (let i = 0; i < tries; i++) {
        try {
          const r = fetch(url, __spreadProps(__spreadValues({}, opts), { headers: __spreadValues({ "User-Agent": UA }, (_a2 = opts.headers) != null ? _a2 : {}), signal: void 0 }));
          if (r.ok) return r;
          if (r.status < 500 && r.status !== 429) return null;
        } catch (e) {
        }
        sleep(800 * (i + 1));
      }
      return null;
    }
    const decode = (s) => s.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1").replace(/<[^>]+>/g, "").replace(/&amp;/g, "&").replace(/&quot;/g, '"').replace(/&#0?39;|&apos;|#39;/g, "'").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&#(\d+);/g, (_, n) => String.fromCharCode(+n)).replace(/\s+/g, " ").trim();
    const tag = (block, name) => {
      const m = block.match(new RegExp(`<${name}[^>]*>([\\s\\S]*?)</${name}>`));
      return m ? decode(m[1]) : "";
    };
    function rss(url, src) {
      const r = get2(url);
      if (!r) {
        errors.push("feed " + src);
        return [];
      }
      const xml = r.text();
      return [...xml.matchAll(/<item[\s>][\s\S]*?<\/item>/g)].map(([b]) => {
        let title2 = tag(b, "title"), source = src;
        const gsrc = tag(b, "source");
        if (gsrc) {
          source = gsrc;
          title2 = title2.replace(new RegExp("\\s+-\\s+" + gsrc.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + "$"), "");
        }
        const ts = Date.parse(tag(b, "pubDate")) || 0;
        return { title: title2, url: tag(b, "link"), src: source, ts };
      }).filter((x) => x.title && x.title.length > 15);
    }
    const gnews = (q) => `https://news.google.com/rss/search?q=${encodeURIComponent(q)}&hl=en-IN&gl=IN&ceid=IN:en`;
    const FEEDS = {
      stocks: [["https://economictimes.indiatimes.com/markets/stocks/news/rssfeeds/2146842.cms", "ET Markets"], ["https://www.livemint.com/rss/markets", "Mint"]],
      markets: [["https://economictimes.indiatimes.com/markets/rssfeeds/1977021501.cms", "ET Markets"], ["https://www.business-standard.com/rss/markets-106.rss", "Business Standard"]],
      econ: [["https://economictimes.indiatimes.com/news/economy/rssfeeds/1373380680.cms", "ET Economy"]],
      mf: [["https://economictimes.indiatimes.com/mf/rssfeeds/359241701.cms", "ET Mutual Funds"]],
      ipo: [["https://economictimes.indiatimes.com/markets/ipos/fpos/rssfeeds/14655708.cms", "ET IPO"]],
      fin: [[gnews('(RBI OR SEBI OR FPI OR FII OR "bond yield" OR rupee) India when:2d'), "Google News"]],
      results: [[gnews("(Q1 OR Q2 OR Q3 OR Q4) results net profit India stock when:3d"), "Google News"]]
    };
    const MAX_AGE = 3 * 864e5;
    const norm = (s) => s.toLowerCase().replace(/[^a-z0-9 ]/g, "").split(" ").slice(0, 8).join(" ");
    function pick(items, n, seen2, filter = () => true) {
      const out2 = [];
      for (const it of [...items].sort((a, b) => b.ts - a.ts)) {
        if (out2.length >= n) break;
        if (it.ts && Date.now() - it.ts > MAX_AGE) continue;
        const k = norm(it.title);
        if (seen2.has(k) || !filter(it)) continue;
        seen2.add(k);
        out2.push(it);
      }
      return out2;
    }
    const slim = (it) => ({ title: it.title, url: it.url, src: it.src, ts: it.ts || null });
    let nseCookie = "";
    function nse(path) {
      var _a2, _b2, _c2;
      try {
        if (!nseCookie) {
          const r2 = get2("https://www.nseindia.com/", { headers: { Accept: "text/html" } }, 1);
          nseCookie = ((_c2 = (_b2 = r2 == null ? void 0 : (_a2 = r2.headers).getSetCookie) == null ? void 0 : _b2.call(_a2)) != null ? _c2 : []).map((c) => c.split(";")[0]).join("; ") || "none";
        }
        const r = get2("https://www.nseindia.com/api/" + path, { headers: { Accept: "application/json", Referer: "https://www.nseindia.com/", Cookie: nseCookie } }, 2);
        return r ? r.json() : null;
      } catch (e) {
        return null;
      }
    }
    const D = readJson(DATA);
    const prev = (_a = readJson(NEWS)) != null ? _a : {};
    if (!((_b = D == null ? void 0 : D.indices) == null ? void 0 : _b.length)) {
      console.error("data.json missing; news.json left unchanged.");
      return null;
    }
    prefetch(Object.values(FEEDS).flat().map(([u]) => [u, { headers: { "User-Agent": UA } }]));
    const feeds = {};
    for (const [k, list] of Object.entries(FEEDS)) {
      feeds[k] = Promise_all(list.map(([u, s]) => rss(u, s))).flat();
    }
    const all = Object.values(feeds).flat();
    const seen = /* @__PURE__ */ new Set();
    const ANALYST = /\b(target price|target of|price target|buy rating|sell rating|upgrade|downgrade|overweight|underweight|initiates coverage|brokerage|stocks to buy|top picks?)\b/i;
    const analyst = pick([...feeds.stocks, ...feeds.markets], 6, seen, (it) => ANALYST.test(it.title));
    const stockNews = pick([...feeds.stocks, ...feeds.markets], 8, seen);
    const econNews = pick(feeds.econ, 6, seen);
    const mfNews = pick(feeds.mf, 6, seen);
    const finNews = pick(feeds.fin, 6, seen);
    const ipoNews = pick(feeds.ipo, 3, seen);
    const earnings = pick(feeds.results, 5, seen);
    const MC = "https://www.moneycontrol.com/markets/fii-dii-data/", TL = "https://trendlyne.com/macro-data/fii-dii/latest/cash-pastmonth/", GROWW = "https://groww.in/v1/api/primaries/v1/ipo/open";
    function mcFii() {
      var _a2, _b2, _c2, _d2;
      try {
        const r = get2(MC, { headers: { Accept: "text/html" } }, 2);
        if (!r) return null;
        const m = r.text().match(/<script id="__NEXT_DATA__"[^>]*>([\s\S]*?)<\/script>/);
        const a = m && ((_d2 = (_c2 = (_b2 = (_a2 = JSON.parse(m[1])) == null ? void 0 : _a2.props) == null ? void 0 : _b2.pageProps) == null ? void 0 : _c2.FiiDiiData) == null ? void 0 : _d2.fiiDiiData);
        if (!Array.isArray(a) || !a.length) return null;
        const num = (x) => +String(x).replace(/,/g, ""), d = a[0];
        const [y, mo, da] = String(d.date).split("-");
        const date = `${da}-${["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"][+mo - 1]}-${y}`;
        return [{ cat: "FII/FPI", date, buy: null, sell: null, net: num(d.fiiCM) }, { cat: "DII", date, buy: null, sell: null, net: num(d.diiCM) }].filter((x) => isFinite(x.net));
      } catch (e) {
        return null;
      }
    }
    function tlFii() {
      try {
        const r = get2(TL, { headers: { Accept: "text/html" } }, 2);
        if (!r) return null;
        const html = r.text().replace(/\s+/g, " ");
        const one = (who, cat) => {
          const m = html.match(new RegExp(who + " were net (buyers|sellers) of \u20B9 ?(-?[\\d.,]+) Cr in the cash segment on (\\d{1,2}) (\\w{3}) (\\d{4})"));
          if (!m) return null;
          const v = Math.abs(+m[2].replace(/,/g, ""));
          return { cat, date: `${m[3].padStart(2, "0")}-${m[4]}-${m[5]}`, buy: null, sell: null, net: m[1] === "sellers" ? -v : v };
        };
        const out2 = [one("FII", "FII/FPI"), one("DII", "DII")].filter((x) => x && isFinite(x.net));
        return out2.length ? out2 : null;
      } catch (e) {
        return null;
      }
    }
    function growwIpo() {
      var _a2;
      try {
        const r = get2(GROWW, { headers: { Accept: "application/json" } }, 2);
        if (!r) return null;
        const list = (_a2 = r.json()) == null ? void 0 : _a2.ipoList;
        if (!Array.isArray(list)) return null;
        const dt = (ms) => {
          const d = new Date(ms + 5.5 * 36e5);
          return `${String(d.getUTCDate()).padStart(2, "0")}-${["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"][d.getUTCMonth()]}-${d.getUTCFullYear()}`;
        };
        return list.map((i) => {
          var _a3, _b2;
          const c = (_b2 = ((_a3 = i.categories) != null ? _a3 : [])[0]) != null ? _b2 : {};
          return { name: i.companyName + (i.isSme ? " (SME)" : ""), price: c.maxPrice ? c.minPrice && c.minPrice !== c.maxPrice ? `\u20B9${c.minPrice}\u2013${c.maxPrice}` : `\u20B9${c.maxPrice}` : "", open: i.bidStartTimestamp ? dt(i.bidStartTimestamp) : "", close: i.bidEndTimestamp ? dt(i.bidEndTimestamp) : "", subs: i.overallSubscription != null ? +i.overallSubscription : null };
        });
      } catch (e) {
        return null;
      }
    }
    prefetch([[MC, { headers: { "User-Agent": UA, Accept: "text/html" } }], [TL, { headers: { "User-Agent": UA, Accept: "text/html" } }], [GROWW, { headers: { "User-Agent": UA, Accept: "application/json" } }]]);
    const [fiiRaw, ipoRaw, caRaw, holRaw] = [(_c = mcFii()) != null ? _c : tlFii(), growwIpo(), nse("corporates-corporateActions?index=equities"), nse("holiday-master?type=trading")];
    const fiidii = (fiiRaw == null ? void 0 : fiiRaw.length) ? fiiRaw : (errors.push("fii/dii"), (_d = prev.fiidii) != null ? _d : []);
    const ipos = Array.isArray(ipoRaw) ? ipoRaw : (errors.push("ipo"), (_e = prev.ipos) != null ? _e : []);
    const MON = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
    const istNow = new Date(Date.now() + 5.5 * 36e5);
    const dayStart = (d) => Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
    const parseNse = (s) => Date.parse(String(s).replace(/-/g, " ") + " UTC");
    const today0 = dayStart(istNow);
    const corpActions = Array.isArray(caRaw) ? caRaw.filter((c) => {
      const t = parseNse(c.exDate);
      return t >= today0 && t <= today0 + 7 * 864e5;
    }).slice(0, 12).map((c) => ({ symbol: c.symbol, subject: c.subject, exDate: c.exDate })) : (errors.push("nse corp actions"), ((_f = prev.corpActions) != null ? _f : []).filter((c) => parseNse(c.exDate) >= today0));
    const holidays = new Set(((_g = holRaw == null ? void 0 : holRaw.CM) != null ? _g : []).map((h) => h.tradingDate));
    function nextSession() {
      var _a2;
      const open2 = ((_a2 = D.market) == null ? void 0 : _a2.status) === "open";
      const afterClose = istNow.getUTCHours() * 60 + istNow.getUTCMinutes() >= 555;
      let t = today0 + (open2 || afterClose ? 864e5 : 0);
      for (let i = 0; i < 10; i++, t += 864e5) {
        const d = new Date(t), dow = d.getUTCDay();
        const key = `${String(d.getUTCDate()).padStart(2, "0")}-${MON[d.getUTCMonth()]}-${d.getUTCFullYear()}`;
        if (dow > 0 && dow < 6 && !holidays.has(key)) return `${["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"][dow]} ${d.getUTCDate()} ${MON[d.getUTCMonth()]} ${d.getUTCFullYear()}`;
      }
      return null;
    }
    const idx = (n) => D.indices.find((i) => i.name === n);
    const asset = (n) => {
      var _a2;
      return ((_a2 = D.assets) != null ? _a2 : []).find((a) => a.name === n);
    };
    const n50 = idx("NIFTY 50"), sx = idx("SENSEX"), bn = idx("NIFTY BANK"), vix = idx("INDIA VIX");
    const secs = [...(_h = D.sectors) != null ? _h : []].sort((a, b) => b.pct - a.pct);
    const open = ((_i = D.market) == null ? void 0 : _i.status) === "open";
    const sd = ((_j = D.market) == null ? void 0 : _j.sessionDate) ? /* @__PURE__ */ new Date(D.market.sessionDate + "T00:00:00Z") : istNow;
    const sdLabel = `${sd.getUTCDate()} ${MON[sd.getUTCMonth()]} ${sd.getUTCFullYear()}`;
    const hhmm = `${String(istNow.getUTCHours()).padStart(2, "0")}:${String(istNow.getUTCMinutes()).padStart(2, "0")}`;
    const tracked = (_k = D.stocks) != null ? _k : [];
    const adv = tracked.filter((s) => s.pct > 0).length, dec = tracked.filter((s) => s.pct < 0).length;
    const p = n50.pct;
    const mood = p >= 0.75 ? "Bullish" : p >= 0.2 ? "Mildly bullish" : p <= -0.75 ? "Bearish" : p <= -0.2 ? "Mildly bearish" : "Neutral";
    const verb = open ? p >= 0 ? "is up" : "is down" : p >= 0 ? "closed up" : "closed down";
    const top = secs[0], bot = secs[secs.length - 1];
    const g1 = (_l = D.gainers) == null ? void 0 : _l[0], l1 = (_m = D.losers) == null ? void 0 : _m[0];
    const fii = fiidii.find((f) => /FII|FPI/i.test(f.cat)), dii = fiidii.find((f) => /DII/i.test(f.cat));
    const cr = (x) => "Rs " + nf(Math.abs(x), 0) + " Cr";
    const parts = [
      `Nifty ${verb} ${nf(Math.abs(p))}% at ${nf(n50.last)} (range ${nf(n50.low)}\u2013${nf(n50.high)})`,
      sx && `Sensex ${sg(sx.chg)} pts at ${nf(sx.last)}`,
      top && bot && `${title(top.name)} leads (${pc(top.pct)}), ${title(bot.name)} lags (${pc(bot.pct)})`,
      g1 && l1 && `Top gainer ${g1.symbol} (${pc(g1.pct)}), top loser ${l1.symbol} (${pc(l1.pct)})`,
      fii && `FPIs net ${fii.net < 0 ? "sold" : "bought"} ${cr(fii.net)} (${fii.date})`
    ].filter(Boolean);
    const summary = parts.join(". ") + ".";
    function title(s) {
      return s.split(" ").map((w) => w.length <= 3 && w === w.toUpperCase() ? w : w[0] + w.slice(1).toLowerCase()).join(" ");
    }
    const P = (n50.high + n50.low + n50.last) / 3;
    const R1 = 2 * P - n50.low, S1 = 2 * P - n50.high, R2 = P + (n50.high - n50.low), S2 = P - (n50.high - n50.low);
    const r0 = (x) => Math.round(x / 5) * 5;
    const bull = { level: `Above ${nf(r0(R1), 0)}`, text: `A sustained move above the pivot resistance ${nf(r0(R1), 0)} would put buyers in control; next resistance ${nf(r0(R2), 0)}. Today's high: ${nf(n50.high)}.` };
    const bear = { level: `Below ${nf(r0(S1), 0)}`, text: `Slipping under the pivot support ${nf(r0(S1), 0)} would favour sellers; next support ${nf(r0(S2), 0)}. Today's low: ${nf(n50.low)}.` };
    const risks = [];
    if (vix) risks.push(vix.pct > 3 ? `India VIX up ${nf(vix.pct)}% to ${nf(vix.last)}: expect bigger swings` : vix.last > 18 ? `India VIX elevated at ${nf(vix.last)}` : `India VIX at ${nf(vix.last)} (${pc(vix.pct)})`);
    if (fii && fii.net < 0) risks.push(`FPIs net sold ${cr(fii.net)} on ${fii.date}${dii && dii.net > 0 ? `; DIIs bought ${cr(dii.net)}` : ""}`);
    const brent = asset("Brent");
    if (brent && (brent.last > 85 || Math.abs(brent.pct) > 2)) risks.push(`Brent crude at $${nf(brent.last)} (${pc(brent.pct)}) weighs on inflation and OMCs`);
    const inr = asset("USD/INR");
    if (inr && inr.pct > 0.1) risks.push(`Rupee weaker at ${nf(inr.last)} per dollar (${pc(inr.pct)})`);
    const us = ((_n = D.global) != null ? _n : []).find((g) => g.name === "S&P 500");
    if (us && us.pct < -0.5) risks.push(`Weak US cue: S&P 500 ${pc(us.pct)}`);
    if (dec > adv * 1.5) risks.push(`Weak breadth: ${dec} of ${tracked.length} tracked stocks are down`);
    if (n50.hi52 && n50.last < n50.hi52 * 0.9) risks.push(`Nifty ${nf((1 - n50.last / n50.hi52) * 100, 1)}% below its 52-week high of ${nf(n50.hi52)}`);
    const conclusion = `Nifty ${verb} ${nf(Math.abs(p))}% at ${nf(n50.last)}${bn ? `, Bank Nifty ${pc(bn.pct)}` : ""}. Breadth: ${adv} up, ${dec} down among ${tracked.length} tracked stocks. Watch ${nf(r0(S1), 0)} support and ${nf(r0(R1), 0)} resistance${open ? "" : " next session"}.`;
    const STOP = /* @__PURE__ */ new Set(["POWER", "ENERGY", "STEEL", "MOTORS", "CAPITAL", "HOUSING", "GLOBAL", "INFRA", "TATA", "BAJAJ", "ADANI", "HINDUSTAN", "BHARAT", "NATIONAL", "GENERAL", "UNITED", "LIMITED", "LTD", "LTD.", "INDIA", "INDIAN", "THE", "AND", "&", "CORPORATION", "CORP", "COMPANY", "INDUSTRIES", "BANK", "OF", "FINANCE", "SERVICES", "ENTERPRISES"]);
    function headlineFor(s) {
      var _a2;
      const keys = STOP.has(s.symbol) ? [] : [s.symbol];
      const w = ((_a2 = s.name) != null ? _a2 : "").toUpperCase().replace(/[^A-Z0-9& ]/g, " ").split(/\s+/).filter(Boolean);
      if (w[0] && !STOP.has(w[0])) keys.push(w[0].length < 5 && w[1] && !STOP.has(w[1]) ? w[0] + " " + w[1] : w[0]);
      const esc = (k) => k.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/-/g, "[ -]");
      const res = keys.filter((k) => k.length >= 3).map((k) => new RegExp("\\b" + esc(k) + "\\b", "i"));
      const hit = [...all].sort((a, b) => b.ts - a.ts).find((it) => (!it.ts || Date.now() - it.ts < 2 * 864e5) && res.some((r) => r.test(it.title)));
      return hit ? hit.title : null;
    }
    const short = (s, n = 90) => s.length > n ? s.slice(0, n - 1).replace(/\s+\S*$/, "") + "\u2026" : s;
    const reasons = (list) => Object.fromEntries((list != null ? list : []).slice(0, 10).map((s) => {
      const h = headlineFor(s);
      return [s.symbol, h ? "In news: " + short(h) : ""];
    }).filter(([, v]) => v));
    const gainerReasons = reasons(D.gainers), loserReasons = reasons(D.losers);
    const trending = [];
    const addT = (s, why) => {
      if (s && !trending.some((t) => t.symbol === s.symbol)) {
        const h = headlineFor(s);
        trending.push({ symbol: s.symbol, reason: why + (h ? ". In news: " + short(h, 70) : "") });
      }
    };
    ((_o = D.gainers) != null ? _o : []).slice(0, 3).forEach((s, i) => addT(s, `Up ${nf(s.pct)}%${i === 0 ? ", top gainer" : ""}`));
    ((_p = D.losers) != null ? _p : []).slice(0, 3).forEach((s, i) => addT(s, `Down ${nf(Math.abs(s.pct))}%${i === 0 ? ", top loser" : ""}`));
    ((_q = D.mostActive) != null ? _q : []).slice(0, 4).forEach((s) => addT(s, `Most traded: Rs ${nf(s.valueCr, 0)} Cr (${pc(s.pct)})`));
    const SECTOR_KEYS = {
      IT: /\b(IT stocks|IT shares|tech stocks|Infosys|TCS|Wipro|HCL ?Tech)\b/i,
      AUTO: /\b(auto|car|two-wheeler|Maruti|Tata Motors|M&M)\b/i,
      FMCG: /\b(FMCG|consumer staples|HUL|Nestle|Dabur|Britannia)\b/i,
      MEDIA: /\b(media|Zee|Sun TV|PVR)\b/i,
      METAL: /\b(metal|steel|aluminium|copper|Tata Steel|Hindalco|JSW)\b/i,
      PHARMA: /\b(pharma|drug ?maker|USFDA|Sun Pharma|Cipla)\b/i,
      "PSU BANK": /\b(PSU bank|SBI|public sector bank)\b/i,
      "PRIVATE BANK": /\b(private bank|HDFC Bank|ICICI Bank|Kotak|Axis Bank)\b/i,
      REALTY: /\b(realty|real estate|DLF|Godrej Properties|Lodha)\b/i,
      "OIL & GAS": /\b(oil|crude|OMC|gas|Reliance|ONGC)\b/i,
      "CONSUMER DURABLES": /\b(consumer durables|Titan|Havells|Voltas)\b/i,
      HEALTHCARE: /\b(hospital|healthcare|Apollo)\b/i,
      CHEMICALS: /\b(chemical|agrochemical|fertili[sz]er)\b/i,
      CEMENT: /\b(cement|UltraTech|Ambuja|ACC)\b/i
    };
    const sectorReasons = Object.fromEntries(secs.map((s) => {
      const re = SECTOR_KEYS[s.name];
      const h = re && [...all].sort((a, b) => b.ts - a.ts).find((it) => (!it.ts || Date.now() - it.ts < 864e5) && re.test(it.title));
      return [s.name, h ? "In news: " + short(h.title, 80) : ""];
    }).filter(([, v]) => v));
    const ipoNote = ipoNews.length ? ipoNews.map((x) => x.title).slice(0, 2).join(". ") : (_r = prev.ipoNote) != null ? _r : "";
    const out = {
      asOf: (_t = (_s = D.market) == null ? void 0 : _s.sessionDate) != null ? _t : null,
      asOfLabel: open ? `${sdLabel}, ${hhmm} IST` : `${sdLabel}, 3:30 PM IST`,
      session: open ? `Live \xB7 ${hhmm} IST` : ((_u = D.market) == null ? void 0 : _u.sessionDate) === istNow.toISOString().slice(0, 10) ? "Closing Report \xB7 3:30 PM" : "Last session report",
      mood,
      summary,
      conclusion,
      bull,
      bear,
      risks: risks.slice(0, 5),
      trending,
      gainerReasons,
      loserReasons,
      sectorReasons,
      assetReasons: {},
      stockNews: stockNews.map(slim),
      econNews: econNews.map(slim),
      mfNews: mfNews.map(slim),
      finNews: finNews.map(slim),
      earnings: earnings.map(slim),
      analyst: analyst.map(slim),
      ipoNote,
      ipos,
      corpActions,
      fiidii,
      nextSession: nextSession(),
      generated: "Automatic: headlines from ET, Mint, Business Standard and Google News RSS; summary, mood and levels computed from prices."
    };
    for (const k of ["stockNews", "econNews", "mfNews", "finNews", "earnings"]) if (!out[k].length && ((_v = prev[k]) == null ? void 0 : _v.length)) out[k] = prev[k];
    const strip = (o) => {
      const _a2 = o != null ? o : {}, { asOfLabel, session, updated, errors: _e2 } = _a2, rest = __objRest(_a2, ["asOfLabel", "session", "updated", "errors"]);
      return JSON.stringify(rest);
    };
    if (false) {
      console.log("No news changes; news.json unchanged.");
      return null;
    }
    out.updated = (/* @__PURE__ */ new Date()).toISOString();
    out.errors = errors;
    __result = out;
    console.log(`Wrote news.json: ${stockNews.length} stock, ${econNews.length} econ, ${mfNews.length} MF, ${finNews.length} fin, ${analyst.length} analyst, ${earnings.length} results headlines; mood=${mood}${errors.length ? "; errors: " + errors.join(", ") : ""}`);
    return __result;
  }
  function usData(__in) {
    var _a, _b, _c, _d, _e, _f;
    const readJson = (x) => x;
    const DATA = __in.data, NEWS = __in.news;
    let __result = null;
    const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124 Safari/537.36";
    const HOSTS = ["https://query1.finance.yahoo.com", "https://query2.finance.yahoo.com"];
    const r2 = (x, d = 2) => x == null || !Number.isFinite(x) ? null : Math.round(x * 10 ** d) / 10 ** d;
    function getJson(path, tries = 4) {
      let lastErr;
      for (let i = 0; i < tries; i++) {
        const url = HOSTS[i % HOSTS.length] + path;
        try {
          const res = fetch(url, { headers: { "User-Agent": UA, Accept: "application/json" }, signal: void 0 });
          if (!res.ok) throw new Error("HTTP " + res.status);
          return res.json();
        } catch (e) {
          lastErr = e;
          sleep(1500 * (i + 1));
        }
      }
      throw lastErr;
    }
    const INDICES = [
      ["^GSPC", "S&P 500"],
      ["^DJI", "Dow Jones"],
      ["^IXIC", "Nasdaq Composite"],
      ["^NDX", "Nasdaq 100"],
      ["^RUT", "Russell 2000"],
      ["^VIX", "CBOE VIX"]
    ];
    const SECTORS = [
      ["XLK", "Technology"],
      ["XLF", "Financials"],
      ["XLV", "Health Care"],
      ["XLE", "Energy"],
      ["XLY", "Consumer Discretionary"],
      ["XLP", "Consumer Staples"],
      ["XLI", "Industrials"],
      ["XLB", "Materials"],
      ["XLU", "Utilities"],
      ["XLRE", "Real Estate"],
      ["XLC", "Communication Services"]
    ];
    const GLOBAL = [
      ["^FTSE", "FTSE 100", "UK"],
      ["^GDAXI", "DAX", "Germany"],
      ["^FCHI", "CAC 40", "France"],
      ["^N225", "Nikkei 225", "Japan"],
      ["^HSI", "Hang Seng", "Hong Kong"],
      ["000001.SS", "Shanghai", "China"],
      ["^KS11", "KOSPI", "Korea"],
      ["^NSEI", "Nifty 50", "India"],
      ["^BSESN", "Sensex", "India"]
    ];
    const ASSETS = [
      ["GC=F", "Gold", "$/oz"],
      ["SI=F", "Silver", "$/oz"],
      ["BZ=F", "Brent", "$/bbl"],
      ["CL=F", "Crude (WTI)", "$/bbl"],
      ["NG=F", "Natural gas", "$/MMBtu"],
      ["BTC-USD", "Bitcoin", "$"],
      ["ETH-USD", "Ethereum", "$"],
      ["DX-Y.NYB", "US Dollar Index", "index"],
      ["EURUSD=X", "EUR/USD", "$ per \u20AC"],
      ["JPY=X", "USD/JPY", "\xA5 per $"],
      ["INR=X", "USD/INR", "\u20B9 per $"]
    ];
    const YIELDS = [["^IRX", "13-week T-bill"], ["^FVX", "5-year Treasury"], ["^TNX", "10-year Treasury"], ["^TYX", "30-year Treasury"]];
    const STOCKS = `AAPL MSFT NVDA AMZN GOOGL META AVGO TSLA BRK-B JPM LLY V MA UNH XOM JNJ WMT PG HD COST ORCL ABBV BAC KO NFLX
CVX MRK PEP AMD CRM ADBE TMO LIN ACN MCD CSCO ABT WFC IBM GE DHR QCOM TXN INTU AMGN PM CAT ISRG VZ NOW GS DIS AXP
SPGI RTX T MS NEE LOW PFE UNP BKNG HON CMCSA C BLK SCHW PLTR UBER COP DE LMT GILD SBUX BA MDT ADP MO BMY CVS
TMUS SO DUK MMM GD UPS FDX TGT NKE INTC MU AMAT LRCX KLAC PANW CRWD ANET SNOW SHOP COIN MSTR SMCI ARM HOOD
PYPL XYZ SOFI RIVN F GM USB PNC COF MET AIG BK SPG AMT CL MDLZ KHC CHTR EMR DELL APP ABNB DASH TSM MRVL
DDOG NET ZS RBLX CVNA RDDT`.split(/\s+/).filter(Boolean);
    const NY = "America/New_York";
    const NYSE_HOLIDAYS = /* @__PURE__ */ new Set([
      "2026-01-01",
      "2026-01-19",
      "2026-02-16",
      "2026-04-03",
      "2026-05-25",
      "2026-06-19",
      "2026-07-03",
      "2026-09-07",
      "2026-11-26",
      "2026-12-25",
      "2027-01-01",
      "2027-01-18",
      "2027-02-15",
      "2027-03-26",
      "2027-05-31",
      "2027-06-18",
      "2027-07-05",
      "2027-09-06",
      "2027-11-25",
      "2027-12-24"
    ]);
    const NYSE_EARLY = /* @__PURE__ */ new Set(["2026-11-27", "2026-12-24", "2027-11-26"]);
    const fmtNY = new Intl.DateTimeFormat("en-US", { timeZone: NY, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23", weekday: "short" });
    function etParts(ms) {
      const p = Object.fromEntries(fmtNY.formatToParts(new Date(ms)).map((x) => [x.type, x.value]));
      const h = +p.hour % 24, mi = +p.minute;
      return {
        date: `${p.year}-${p.month}-${p.day}`,
        dow: ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].indexOf(p.weekday),
        min: h * 60 + mi,
        hhmm: `${String(h).padStart(2, "0")}:${String(mi).padStart(2, "0")}`
      };
    }
    function etEpoch(date, hh, mm) {
      const guess = Date.parse(`${date}T${String(hh).padStart(2, "0")}:${String(mm).padStart(2, "0")}:00Z`);
      const h = nyOffsetH(guess + 5 * 36e5);
      return Math.round((guess - h * 36e5) / 1e3);
    }
    const isTradingDay = (date, dow) => dow >= 1 && dow <= 5 && !NYSE_HOLIDAYS.has(date);
    function spark(symbols) {
      var _a2, _b2, _c2, _d2, _e2, _f2, _g, _h, _i, _j, _k, _l, _m;
      prefetch(sparkUrls(symbols).map((u) => [u, { headers: { "User-Agent": UA, Accept: "application/json" } }]));
      const out = {};
      for (let i = 0; i < symbols.length; i += 20) {
        const chunk = symbols.slice(i, i + 20);
        try {
          const j = getJson("/v7/finance/spark?range=1d&interval=5m&symbols=" + encodeURIComponent(chunk.join(",")));
          for (const r of (_b2 = (_a2 = j == null ? void 0 : j.spark) == null ? void 0 : _a2.result) != null ? _b2 : []) {
            const m = (_d2 = (_c2 = r.response) == null ? void 0 : _c2[0]) == null ? void 0 : _d2.meta;
            if (!m || m.regularMarketPrice == null) continue;
            const prev = (_e2 = m.chartPreviousClose) != null ? _e2 : m.previousClose, last = m.regularMarketPrice;
            out[r.symbol] = {
              last,
              prev,
              chg: prev ? last - prev : null,
              pct: prev ? (last - prev) / prev * 100 : null,
              high: (_f2 = m.regularMarketDayHigh) != null ? _f2 : null,
              low: (_g = m.regularMarketDayLow) != null ? _g : null,
              hi52: (_h = m.fiftyTwoWeekHigh) != null ? _h : null,
              lo52: (_i = m.fiftyTwoWeekLow) != null ? _i : null,
              vol: (_j = m.regularMarketVolume) != null ? _j : null,
              time: (_k = m.regularMarketTime) != null ? _k : null,
              name: (_m = (_l = m.shortName) != null ? _l : m.longName) != null ? _m : null
            };
          }
        } catch (e) {
          errors.push("spark " + chunk[0] + "..: " + e.message);
        }
        sleep(350);
      }
      return out;
    }
    function intraday(sym) {
      var _a2, _b2, _c2, _d2, _e2, _f2, _g, _h;
      const j = getJson(`/v8/finance/chart/${encodeURIComponent(sym)}?range=5d&interval=5m`);
      const r = (_b2 = (_a2 = j == null ? void 0 : j.chart) == null ? void 0 : _a2.result) == null ? void 0 : _b2[0];
      if (!(r == null ? void 0 : r.timestamp)) return null;
      const c = (_f2 = (_e2 = (_d2 = (_c2 = r.indicators) == null ? void 0 : _c2.quote) == null ? void 0 : _d2[0]) == null ? void 0 : _e2.close) != null ? _f2 : [];
      const pts = r.timestamp.map((t, i) => [t, c[i]]).filter(([, v]) => v != null);
      if (!pts.length) return null;
      const lastDate = etParts(pts.at(-1)[0] * 1e3).date;
      const day = pts.filter(([t]) => etParts(t * 1e3).date === lastDate);
      const before = pts.filter(([t]) => etParts(t * 1e3).date < lastDate);
      const prev = before.length ? before.at(-1)[1] : (_h = (_g = r.meta) == null ? void 0 : _g.previousClose) != null ? _h : null;
      const open = etEpoch(lastDate, 9, 30), close = NYSE_EARLY.has(lastDate) ? etEpoch(lastDate, 13, 0) : etEpoch(lastDate, 16, 0);
      return { date: lastDate, prev: r2(prev), open, close, points: day.map(([t, v]) => [t, r2(v)]) };
    }
    const errors = [];
    const prevData = (_a = readJson(DATA)) != null ? _a : {};
    const ySyms = [...new Set([...INDICES, ...SECTORS, ...GLOBAL, ...ASSETS, ...YIELDS].map((x) => x[0]))];
    const q = spark([...ySyms, ...STOCKS]);
    const fmt = (s, name, extra = {}, d = 2) => {
      const x = q[s];
      const z = (v) => v ? r2(v, d) : null;
      return x && __spreadValues({ name, symbol: s, last: r2(x.last, d), chg: r2(x.chg, d), pct: r2(x.pct), high: z(x.high), low: z(x.low), prev: r2(x.prev, d) }, extra);
    };
    const spx = q["^GSPC"];
    if (!spx) errors.push("S&P 500 quote missing");
    const indices = INDICES.map(([s, n]) => {
      var _a2, _b2;
      return fmt(s, n, { hi52: r2((_a2 = q[s]) == null ? void 0 : _a2.hi52), lo52: r2((_b2 = q[s]) == null ? void 0 : _b2.lo52) });
    }).filter(Boolean);
    const sectors = SECTORS.map(([s, n]) => fmt(s, n)).filter(Boolean).sort((a, b) => b.pct - a.pct);
    const global = GLOBAL.map(([s, n, region]) => fmt(s, n, { region })).filter(Boolean);
    const assets = ASSETS.map(([s, n, unit]) => fmt(s, n, { unit }, s === "EURUSD=X" ? 4 : s === "NG=F" ? 3 : 2)).filter(Boolean);
    const yields = YIELDS.map(([s, n]) => {
      const x = fmt(s, n, { unit: "%" }, 3);
      if (x) x.bp = x.chg == null ? null : r2(x.chg * 100, 1);
      return x;
    }).filter(Boolean);
    const now = Date.now();
    const nowEt = etParts(now);
    const sessionDate = (spx == null ? void 0 : spx.time) ? etParts(spx.time * 1e3).date : null;
    const stocks = STOCKS.map((s) => {
      const x = q[s];
      if (!x || x.pct == null) return null;
      if (sessionDate && x.time && etParts(x.time * 1e3).date !== sessionDate) return null;
      return {
        symbol: s,
        name: x.name,
        ltp: r2(x.last),
        chg: r2(x.chg),
        pct: r2(x.pct),
        high: r2(x.high),
        low: r2(x.low),
        prev: r2(x.prev),
        hi52: r2(x.hi52),
        lo52: r2(x.lo52),
        vol: x.vol,
        valueM: x.vol ? r2(x.vol * x.last / 1e6, 0) : null
      };
    }).filter(Boolean);
    const gainers = stocks.filter((s) => s.pct > 0).sort((a, b) => b.pct - a.pct).slice(0, 10);
    const losers = stocks.filter((s) => s.pct < 0).sort((a, b) => a.pct - b.pct).slice(0, 10);
    const mostActive = [...stocks].filter((s) => s.valueM).sort((a, b) => b.valueM - a.valueM).slice(0, 10);
    const near52High = stocks.filter((s) => s.hi52 && s.ltp >= s.hi52 * 0.98).sort((a, b) => b.ltp / b.hi52 - a.ltp / a.hi52).slice(0, 10);
    const near52Low = stocks.filter((s) => s.lo52 && s.ltp <= s.lo52 * 1.02).sort((a, b) => a.ltp / a.lo52 - b.ltp / b.lo52).slice(0, 10);
    const intra = {};
    prefetch([["^GSPC", "sp500"], ["^DJI", "dow"], ["^IXIC", "nasdaq"]].map(([s]) => [chartUrl(s), { headers: { "User-Agent": UA, Accept: "application/json" } }]));
    for (const [s, key] of [["^GSPC", "sp500"], ["^DJI", "dow"], ["^IXIC", "nasdaq"]]) {
      try {
        intra[key] = intraday(s);
      } catch (e) {
        errors.push("chart " + s + ": " + e.message);
        intra[key] = (_c = (_b = prevData.intraday) == null ? void 0 : _b[key]) != null ? _c : null;
      }
      sleep(300);
    }
    const trading = isTradingDay(nowEt.date, nowEt.dow);
    const early = NYSE_EARLY.has(nowEt.date);
    const closeMin = early ? 780 : 960;
    let status = "closed", note2;
    if (trading && nowEt.min >= 570 && nowEt.min < closeMin) {
      status = "open";
      note2 = early ? "Market open (early close 1:00 PM ET)" : "Market open";
    } else if (trading && nowEt.min >= 240 && nowEt.min < 570) {
      status = "pre";
      note2 = "Pre-market: regular session opens 9:30 AM ET";
    } else if (trading && nowEt.min >= closeMin && nowEt.min < 1200) {
      status = "post";
      note2 = "After-hours trading: regular session closed";
    } else if (nowEt.dow === 0 || nowEt.dow === 6) note2 = "Weekend: market closed";
    else if (!trading) note2 = "NYSE holiday: market closed";
    else if (nowEt.min < 240) note2 = "Market closed: opens 9:30 AM ET";
    else note2 = "Market closed for the day";
    const payload = {
      market: { status, note: note2, sessionDate, earlyClose: NYSE_EARLY.has(sessionDate != null ? sessionDate : ""), hours: "9:30 AM\u20134:00 PM ET, Mon\u2013Fri" },
      indices,
      sectors,
      gainers,
      losers,
      mostActive,
      near52High,
      near52Low,
      stocks,
      global,
      assets,
      yields,
      intraday: intra,
      source: "Yahoo Finance (prices, may be delayed)"
    };
    const strip = (o) => {
      const _a2 = o != null ? o : {}, { updated, updatedEt, errors: _e2 } = _a2, rest = __objRest(_a2, ["updated", "updatedEt", "errors"]);
      return JSON.stringify(rest);
    };
    if (!(indices.length > 0 && stocks.length > 0)) {
      console.error("No usable data fetched; data.json left unchanged.", errors.join(" | "));
      return null;
    }
    if (false) {
      console.log("No price changes; us/data.json unchanged.");
    } else {
      const out = __spreadProps(__spreadValues({ updated: new Date(now).toISOString(), updatedEt: `${nowEt.date} ${nowEt.hhmm}` }, payload), { errors });
      __result = out;
      console.log(`Wrote us/data.json: ${indices.length} indices, ${sectors.length} sectors, ${stocks.length}/${STOCKS.length} stocks, S&P ${(_f = (_e = (_d = intra.sp500) == null ? void 0 : _d.points) == null ? void 0 : _e.length) != null ? _f : 0} pts, status=${status}${errors.length ? ", errors: " + errors.join(" | ") : ""}`);
    }
    return __result;
  }
  function usNews(__in) {
    var _a, _b, _c, _d, _e, _f, _g, _h, _i, _j, _k, _l, _m, _n, _o, _p, _q, _r, _s;
    const readJson = (x) => x;
    const DATA = __in.data, NEWS = __in.news;
    let __result = null;
    const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124 Safari/537.36";
    const nf = (x, d = 2) => x == null ? "\u2013" : Number(x).toLocaleString("en-US", { minimumFractionDigits: d, maximumFractionDigits: d });
    const sg = (x, d = 2) => (x > 0 ? "+" : x < 0 ? "\u2212" : "") + nf(Math.abs(x), d);
    const pc = (x) => sg(x) + "%";
    const errors = [];
    function get2(url, opts = {}, tries = 2) {
      var _a2;
      for (let i = 0; i < tries; i++) {
        try {
          const r = fetch(url, __spreadProps(__spreadValues({}, opts), { headers: __spreadValues({ "User-Agent": UA }, (_a2 = opts.headers) != null ? _a2 : {}), signal: void 0 }));
          if (r.ok) return r;
          if (r.status < 500 && r.status !== 429) return null;
        } catch (e) {
        }
        sleep(800 * (i + 1));
      }
      return null;
    }
    const decode = (s) => s.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1").replace(/<[^>]+>/g, "").replace(/&amp;/g, "&").replace(/&quot;/g, '"').replace(/&#0?39;|&apos;|#39;/g, "'").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&#(\d+);/g, (_, n) => String.fromCharCode(+n)).replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCharCode(parseInt(n, 16))).replace(/\s+/g, " ").trim();
    const tag = (block, name) => {
      const m = block.match(new RegExp(`<${name}[^>]*>([\\s\\S]*?)</${name}>`));
      return m ? decode(m[1]) : "";
    };
    function rss(url, src) {
      const r = get2(url);
      if (!r) {
        errors.push("feed " + src);
        return [];
      }
      const xml = r.text();
      return [...xml.matchAll(/<item[\s>][\s\S]*?<\/item>/g)].map(([b]) => {
        let title = tag(b, "title"), source = src;
        const gsrc = tag(b, "source");
        if (gsrc) {
          source = gsrc;
          title = title.replace(new RegExp("\\s+-\\s+" + gsrc.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + "$"), "");
        }
        const ts = Date.parse(tag(b, "pubDate")) || 0;
        let link = tag(b, "link");
        if (!/^https?:/.test(link)) link = (b.match(/<link[^>]*href="([^"]+)"/) || [])[1] || link;
        return { title, url: link, src: source, ts };
      }).filter((x) => x.title && x.title.length > 15);
    }
    const gnews = (q) => `https://news.google.com/rss/search?q=${encodeURIComponent(q)}&hl=en-US&gl=US&ceid=US:en`;
    const cnbc = (id) => `https://www.cnbc.com/id/${id}/device/rss/rss.html`;
    const FEEDS = {
      stocks: [
        [cnbc(100003114), "CNBC"],
        [cnbc(10000664), "CNBC"],
        ["https://feeds.content.dowjones.io/public/rss/mw_topstories", "MarketWatch"],
        ["https://seekingalpha.com/market_currents.xml", "Seeking Alpha"],
        ["https://www.nasdaq.com/feed/rssoutbound?category=Markets", "Nasdaq"],
        ["https://finance.yahoo.com/news/rssindex", "Yahoo Finance"]
      ],
      econ: [[cnbc(20910258), "CNBC Economy"], [gnews('(Fed OR FOMC OR Powell OR CPI OR "jobs report" OR payrolls OR "Treasury yields" OR inflation) economy when:2d'), "Google News"]],
      earnings: [[cnbc(15839135), "CNBC Earnings"], [gnews('(earnings OR "quarterly results") (beats OR misses OR guidance) stock when:3d'), "Google News"]],
      analyst: [[gnews('(upgrades OR downgrades OR "price target" OR "initiates coverage") stock analyst when:2d'), "Google News"]],
      ipo: [[gnews('IPO (prices OR files OR debut OR "shares jump" OR "shares fall") NYSE OR Nasdaq when:7d'), "Google News"]],
      commod: [[gnews("(bitcoin OR ether OR gold OR silver OR oil OR crude OR OPEC) prices when:2d"), "Google News"]]
    };
    const MAX_AGE = 3 * 864e5;
    const JUNK_SRC = /ad-hoc-news|scanx|Nyasa|thefinancetoday|Moneycontrol|Economic Times|Business Standard|Livemint|Yahoo! Finance Canada|OilPrice\.com|Startup Fortune|middle-east-online|USA Today/i;
    const JUNK = /Social Security|retire(?:ment|d)?\b|Dalal|Sensex|Nifty|\bRBI\b|Stock Forecast & Price Target|\| Opinion|Which .*Better Buy|Is It Too Late|Should You Buy|Millionaire|Passive Income|Dividend Stocks? to Buy|Stocks? to Buy (?:Now|and Hold)/i;
    const US_ECON = /\b(Fed|FOMC|Powell|Warsh|Treasury|U\.?S\.?|US|American|Wall Street|jobs report|payrolls|jobless|CPI|PCE|GDP|tariffs?|White House|Trump|Hassett|Bessent|mortgage rates|consumer)\b/;
    const norm = (s) => s.toLowerCase().replace(/[^a-z0-9 ]/g, "").split(" ").slice(0, 8).join(" ");
    function pick(items, n, seen2, filter = () => true, maxAge = MAX_AGE) {
      const out2 = [];
      for (const it of [...items].sort((a, b) => b.ts - a.ts)) {
        if (out2.length >= n) break;
        if (!it.ts || Date.now() - it.ts > maxAge || JUNK_SRC.test(it.src) || JUNK.test(it.title)) continue;
        const k = norm(it.title);
        if (seen2.has(k) || !filter(it)) continue;
        seen2.add(k);
        out2.push(it);
      }
      return out2;
    }
    const slim = (it) => ({ title: it.title, url: it.url, src: it.src, ts: it.ts || null });
    const NY = "America/New_York";
    const NYSE_HOLIDAYS = {
      "2026-01-01": "New Year's Day",
      "2026-01-19": "Martin Luther King Jr. Day",
      "2026-02-16": "Washington's Birthday",
      "2026-04-03": "Good Friday",
      "2026-05-25": "Memorial Day",
      "2026-06-19": "Juneteenth",
      "2026-07-03": "Independence Day (observed)",
      "2026-09-07": "Labor Day",
      "2026-11-26": "Thanksgiving Day",
      "2026-12-25": "Christmas Day",
      "2027-01-01": "New Year's Day",
      "2027-01-18": "Martin Luther King Jr. Day",
      "2027-02-15": "Washington's Birthday",
      "2027-03-26": "Good Friday",
      "2027-05-31": "Memorial Day",
      "2027-06-18": "Juneteenth (observed)",
      "2027-07-05": "Independence Day (observed)",
      "2027-09-06": "Labor Day",
      "2027-11-25": "Thanksgiving Day",
      "2027-12-24": "Christmas Day (observed)"
    };
    const NYSE_EARLY = { "2026-11-27": "Day after Thanksgiving", "2026-12-24": "Christmas Eve", "2027-11-26": "Day after Thanksgiving" };
    const FOMC = [
      "2026-01-28",
      "2026-03-18*",
      "2026-04-29",
      "2026-06-17*",
      "2026-07-29",
      "2026-09-16*",
      "2026-10-28",
      "2026-12-09*",
      "2027-01-27",
      "2027-03-17*",
      "2027-04-28",
      "2027-06-09*",
      "2027-07-28",
      "2027-09-15*",
      "2027-10-27",
      "2027-12-08*"
    ];
    const fmtNY = new Intl.DateTimeFormat("en-US", { timeZone: NY, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23" });
    const etNow = (() => {
      const p2 = Object.fromEntries(fmtNY.formatToParts(/* @__PURE__ */ new Date()).map((x) => [x.type, x.value]));
      return { date: `${p2.year}-${p2.month}-${p2.day}`, min: +p2.hour % 24 * 60 + +p2.minute };
    })();
    const MON = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"], DOW = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
    const dlabel = (iso) => {
      const d = /* @__PURE__ */ new Date(iso + "T12:00:00Z");
      return `${DOW[d.getUTCDay()]} ${MON[d.getUTCMonth()]} ${d.getUTCDate()}, ${d.getUTCFullYear()}`;
    };
    const addDays = (iso, n) => new Date(Date.parse(iso + "T12:00:00Z") + n * 864e5).toISOString().slice(0, 10);
    const isTrading = (iso) => {
      const w = (/* @__PURE__ */ new Date(iso + "T12:00:00Z")).getUTCDay();
      return w > 0 && w < 6 && !NYSE_HOLIDAYS[iso];
    };
    const clock = (min) => {
      const h = Math.floor(min / 60), m = min % 60;
      return `${(h + 11) % 12 + 1}:${String(m).padStart(2, "0")} ${h < 12 ? "AM" : "PM"}`;
    };
    function nextSession() {
      let d = etNow.date;
      if (!isTrading(d) || etNow.min >= 570) d = addDays(d, 1);
      for (let i = 0; i < 10 && !isTrading(d); i++) d = addDays(d, 1);
      return dlabel(d) + (NYSE_EARLY[d] ? " (early close 1:00 PM ET)" : "");
    }
    function upcomingEvents() {
      const ev = [];
      const until = addDays(etNow.date, 75);
      for (const f of FOMC) {
        const d = f.replace("*", "");
        if (d < etNow.date || d > until) continue;
        ev.push({ date: d, label: `Fed (FOMC) rate decision, 2:00 PM ET${f.endsWith("*") ? " + economic projections" : ""}` });
      }
      for (const [d, n] of Object.entries(NYSE_HOLIDAYS)) if (d >= etNow.date && d <= until) ev.push({ date: d, label: `NYSE closed: ${n}` });
      for (const [d, n] of Object.entries(NYSE_EARLY)) if (d >= etNow.date && d <= until) ev.push({ date: d, label: `Early close 1:00 PM ET: ${n}` });
      return ev.sort((a, b) => a.date.localeCompare(b.date)).slice(0, 6).map((e) => __spreadProps(__spreadValues({}, e), { when: dlabel(e.date) }));
    }
    const D = readJson(DATA);
    const prev = (_a = readJson(NEWS)) != null ? _a : {};
    if (!((_b = D == null ? void 0 : D.indices) == null ? void 0 : _b.length)) {
      console.error("us/data.json missing; news.json left unchanged.");
      return null;
    }
    prefetch(Object.values(FEEDS).flat().map(([u]) => [u, { headers: { "User-Agent": UA } }]));
    const feeds = {};
    for (const [k, list] of Object.entries(FEEDS)) feeds[k] = Promise_all(list.map(([u, s]) => rss(u, s))).flat();
    const all = Object.values(feeds).flat();
    const seen = /* @__PURE__ */ new Set();
    const ANALYST = /\b(price target|target to \\$|upgrades?|upgraded|downgrades?|downgraded|overweight|underweight|outperform|underperform|initiates? coverage|reiterates? (?:buy|sell|hold|outperform|overweight|neutral)|buy rating|sell rating|neutral rating|analysts? (?:say|see|says))\b/i;
    const EARN = /\b(earnings|quarter|quarterly|Q[1-4]|results|EPS|revenue|guidance|profit)\b/i;
    const IPO = /\bIPO|initial public offering|debut|goes public|going public\b/i;
    const analyst = pick([...feeds.analyst, ...feeds.stocks], 8, seen, (it) => ANALYST.test(it.title));
    const earnings = pick([...feeds.earnings, ...feeds.stocks], 8, seen, (it) => EARN.test(it.title));
    const ipoNews = pick([...feeds.ipo, ...feeds.stocks], 6, seen, (it) => IPO.test(it.title), 7 * 864e5);
    const econNews = pick(feeds.econ, 8, seen, (it) => it.src.startsWith("CNBC") || US_ECON.test(it.title));
    const commodNews = pick(feeds.commod, 6, seen);
    const stockNews = pick(feeds.stocks, 10, seen);
    const idx = (n) => D.indices.find((i) => i.name === n);
    const asset = (n) => {
      var _a2;
      return ((_a2 = D.assets) != null ? _a2 : []).find((a) => a.name === n);
    };
    const yld = (n) => {
      var _a2;
      return ((_a2 = D.yields) != null ? _a2 : []).find((a) => a.name === n);
    };
    const spx = idx("S&P 500"), dow = idx("Dow Jones"), nas = idx("Nasdaq Composite"), rut = idx("Russell 2000"), vix = idx("CBOE VIX");
    const secs = [...(_c = D.sectors) != null ? _c : []].sort((a, b) => b.pct - a.pct);
    const open = ((_d = D.market) == null ? void 0 : _d.status) === "open";
    const sd = (_f = (_e = D.market) == null ? void 0 : _e.sessionDate) != null ? _f : etNow.date;
    const sdLabel = dlabel(sd).replace(/^\w+ /, "");
    const closeLbl = ((_g = D.market) == null ? void 0 : _g.earlyClose) ? "1:00 PM ET" : "4:00 PM ET";
    const tracked = (_h = D.stocks) != null ? _h : [];
    const adv = tracked.filter((s) => s.pct > 0).length, dec = tracked.filter((s) => s.pct < 0).length;
    const p = spx.pct;
    const mood = p >= 0.75 ? "Bullish" : p >= 0.2 ? "Mildly bullish" : p <= -0.75 ? "Bearish" : p <= -0.2 ? "Mildly bearish" : "Neutral";
    const verb = open ? p >= 0 ? "is up" : "is down" : p >= 0 ? "closed up" : "closed down";
    const top = secs[0], bot = secs[secs.length - 1];
    const g1 = (_i = D.gainers) == null ? void 0 : _i[0], l1 = (_j = D.losers) == null ? void 0 : _j[0];
    const tnx = yld("10-year Treasury");
    const parts = [
      `The S&P 500 ${verb} ${nf(Math.abs(p))}% at ${nf(spx.last)} (range ${nf(spx.low)}\u2013${nf(spx.high)})`,
      dow && nas && `Dow ${sg(dow.chg)} pts (${pc(dow.pct)}), Nasdaq ${pc(nas.pct)}`,
      top && bot && `${top.name} leads (${pc(top.pct)}), ${bot.name} lags (${pc(bot.pct)})`,
      g1 && l1 && `Top gainer ${g1.symbol} (${pc(g1.pct)}), top loser ${l1.symbol} (${pc(l1.pct)})`,
      tnx && `10-year Treasury yield ${nf(tnx.last, 2)}% (${tnx.bp > 0 ? "+" : tnx.bp < 0 ? "\u2212" : ""}${nf(Math.abs((_k = tnx.bp) != null ? _k : 0), 0)} bp)`
    ].filter(Boolean);
    const summary = parts.join(". ") + ".";
    const P = (spx.high + spx.low + spx.last) / 3;
    const R1 = 2 * P - spx.low, S1 = 2 * P - spx.high, R2 = P + (spx.high - spx.low), S2 = P - (spx.high - spx.low);
    const r0 = (x) => Math.round(x / 5) * 5;
    const bull = { level: `Above ${nf(r0(R1), 0)}`, text: `A sustained move above the pivot resistance ${nf(r0(R1), 0)} would put buyers in control; next resistance ${nf(r0(R2), 0)}. Session high: ${nf(spx.high)}.` };
    const bear = { level: `Below ${nf(r0(S1), 0)}`, text: `Slipping under the pivot support ${nf(r0(S1), 0)} would favor sellers; next support ${nf(r0(S2), 0)}. Session low: ${nf(spx.low)}.` };
    const pivots = { P: Math.round(P), R1: r0(R1), R2: r0(R2), S1: r0(S1), S2: r0(S2) };
    const events = upcomingEvents();
    const risks = [];
    if (vix) risks.push(vix.pct > 5 ? `VIX jumped ${nf(vix.pct)}% to ${nf(vix.last)}: expect bigger swings` : vix.last > 20 ? `VIX elevated at ${nf(vix.last)}` : `VIX at ${nf(vix.last)} (${pc(vix.pct)})`);
    if (tnx && (tnx.bp >= 7 || tnx.last >= 4.75)) risks.push(`10-year Treasury yield at ${nf(tnx.last)}% (${tnx.bp >= 0 ? "+" : "\u2212"}${nf(Math.abs(tnx.bp), 0)} bp): high yields pressure valuations`);
    const nextFed = events.find((e) => /FOMC/.test(e.label));
    if (nextFed && (Date.parse(nextFed.date) - Date.parse(etNow.date)) / 864e5 <= 14) risks.push(`Fed decision on ${nextFed.when}: rate-sensitive stocks may swing`);
    const brent = asset("Brent");
    if (brent && (brent.last > 90 || Math.abs(brent.pct) > 2)) risks.push(`Brent crude at $${nf(brent.last)} (${pc(brent.pct)}) feeds inflation worries`);
    const dxy = asset("US Dollar Index");
    if (dxy && Math.abs(dxy.pct) > 0.5) risks.push(`Dollar index ${pc(dxy.pct)} to ${nf(dxy.last)}: watch multinationals' earnings`);
    if (dec > adv * 1.5) risks.push(`Weak breadth: ${dec} of ${tracked.length} tracked stocks are down`);
    if (rut && spx && rut.pct < spx.pct - 1) risks.push(`Small caps lag: Russell 2000 ${pc(rut.pct)} vs S&P 500 ${pc(spx.pct)}`);
    if (spx.hi52 && spx.last < spx.hi52 * 0.9) risks.push(`S&P 500 ${nf((1 - spx.last / spx.hi52) * 100, 1)}% below its 52-week high of ${nf(spx.hi52)}`);
    const btc = asset("Bitcoin");
    if (btc && Math.abs(btc.pct) > 5) risks.push(`Bitcoin ${pc(btc.pct)}: crypto-linked stocks (COIN, MSTR, HOOD) may be volatile`);
    const conclusion = `The S&P 500 ${verb} ${nf(Math.abs(p))}% at ${nf(spx.last)}${nas ? `, Nasdaq ${pc(nas.pct)}` : ""}. Breadth: ${adv} up, ${dec} down among ${tracked.length} tracked stocks. Watch ${nf(r0(S1), 0)} support and ${nf(r0(R1), 0)} resistance${open ? "" : " next session"}.`;
    const KEYS = {
      AAPL: "Apple",
      MSFT: "Microsoft",
      NVDA: "Nvidia|NVIDIA",
      AMZN: "Amazon",
      GOOGL: "Alphabet|Google",
      META: "Meta(?! ?[a-z])|Facebook|Instagram",
      AVGO: "Broadcom",
      TSLA: "Tesla",
      "BRK-B": "Berkshire",
      JPM: "!JPMorgan|JP Morgan|Dimon",
      LLY: "Eli Lilly|Lilly",
      V: "Visa(?:'s)? (?:Inc|shares|stock|earnings|profit|revenue|CEO)|Visa,? (?:and )?Mastercard",
      MA: "Mastercard",
      UNH: "UnitedHealth",
      XOM: "Exxon",
      JNJ: "Johnson & Johnson|J&J",
      WMT: "Walmart",
      PG: "Procter|P&G",
      HD: "Home Depot",
      COST: "Costco",
      ORCL: "Oracle",
      ABBV: "AbbVie",
      BAC: "!Bank of America|BofA",
      KO: "Coca-Cola|Coke",
      NFLX: "Netflix",
      CVX: "Chevron",
      MRK: "Merck",
      PEP: "PepsiCo|Pepsi",
      AMD: "AMD|Advanced Micro",
      CRM: "Salesforce",
      ADBE: "Adobe",
      TMO: "Thermo Fisher",
      LIN: "Linde",
      ACN: "Accenture",
      MCD: "McDonald's",
      CSCO: "Cisco",
      ABT: "Abbott",
      WFC: "!Wells Fargo",
      IBM: "IBM",
      GE: "GE Aerospace",
      DHR: "Danaher",
      QCOM: "Qualcomm",
      TXN: "Texas Instruments",
      INTU: "Intuit",
      AMGN: "Amgen",
      PM: "Philip Morris",
      CAT: "Caterpillar",
      ISRG: "Intuitive Surgical",
      VZ: "Verizon",
      NOW: "ServiceNow",
      GS: "!Goldman",
      DIS: "Disney",
      AXP: "American Express|Amex",
      SPGI: "S&P Global",
      RTX: "RTX|Raytheon",
      T: "AT&T",
      MS: "!Morgan Stanley",
      NEE: "NextEra",
      LOW: "Lowe's",
      PFE: "Pfizer",
      UNP: "Union Pacific",
      BKNG: "Booking Holdings",
      HON: "Honeywell",
      CMCSA: "Comcast",
      C: "!Citigroup|Citi",
      BLK: "!BlackRock",
      SCHW: "Schwab",
      PLTR: "Palantir",
      UBER: "Uber",
      COP: "ConocoPhillips",
      DE: "Deere",
      LMT: "Lockheed",
      GILD: "Gilead",
      SBUX: "Starbucks",
      BA: "Boeing",
      MDT: "Medtronic",
      ADP: "Automatic Data Processing",
      MO: "Altria",
      BMY: "Bristol[- ]Myers",
      CVS: "CVS",
      TMUS: "T-Mobile",
      SO: "Southern Co(?:mpany)?\\b",
      DUK: "Duke Energy",
      MMM: "3M",
      GD: "General Dynamics",
      UPS: "UPS",
      FDX: "FedEx",
      TGT: "Target(?:'s| Corp| stock| shares| earnings| sales| CEO)",
      NKE: "Nike",
      INTC: "Intel",
      MU: "Micron",
      AMAT: "Applied Materials",
      LRCX: "Lam Research",
      KLAC: "KLA",
      PANW: "Palo Alto Networks",
      CRWD: "CrowdStrike",
      ANET: "Arista",
      SNOW: "Snowflake",
      SHOP: "Shopify",
      COIN: "Coinbase",
      MSTR: "MicroStrategy|Strategy Inc|Saylor",
      SMCI: "Super Micro|Supermicro",
      ARM: "Arm Holdings|Arm(?:'s)? (?:shares|stock|CEO)",
      HOOD: "Robinhood",
      PYPL: "PayPal",
      XYZ: "Block Inc|Cash App",
      SOFI: "SoFi",
      RIVN: "Rivian",
      F: "Ford",
      GM: "General Motors|GM",
      USB: "U\\.?S\\.? Bancorp",
      PNC: "PNC",
      COF: "Capital One",
      MET: "MetLife",
      AIG: "AIG",
      BK: "BNY|Bank of New York",
      SPG: "Simon Property",
      AMT: "American Tower",
      CL: "Colgate",
      MDLZ: "Mondelez",
      KHC: "Kraft Heinz",
      CHTR: "Charter Communications",
      EMR: "Emerson",
      DELL: "Dell",
      APP: "AppLovin",
      ABNB: "Airbnb",
      DASH: "DoorDash",
      TSM: "TSMC|Taiwan Semiconductor",
      MRVL: "Marvell",
      DDOG: "Datadog",
      NET: "Cloudflare",
      ZS: "Zscaler",
      RBLX: "Roblox",
      CVNA: "Carvana",
      RDDT: "Reddit"
    };
    const BANK_CTX = /\b(earnings|profit|results|quarter|revenue|CEO|layoffs?|job cuts|fined?|settle\w*|lawsuit|shares (?:rise|fall|jump|drop|slide|gain|sink|surge)|stock (?:rises|falls|jumps|drops|slides|gains|sinks|surges))\b/i;
    const COMMON = /* @__PURE__ */ new Set(["ALL", "NOW", "LOW", "CAT", "NET", "APP", "ARM", "DASH", "HOOD", "SNOW", "COST", "ADP", "DELL", "UBER", "META", "SHOP", "COIN", "TGT"]);
    const escRe = (k) => k.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    function matcher(sym) {
      var _a2;
      let k = KEYS[sym];
      let ctx = false;
      if (k && k.startsWith("!")) {
        ctx = true;
        k = k.slice(1);
      }
      const pats = [];
      if (k) pats.push("\\b(?:" + k + ")");
      const t = escRe(sym);
      pats.push(`\\((?:NYSE|NASDAQ|Nasdaq)?:? ?${t}\\)`, `(?:NYSE|NASDAQ|Nasdaq): ?${t}\\b`, `\\$${t}\\b`);
      if (sym.length >= 3 && !COMMON.has(sym) && !((_a2 = KEYS[sym]) == null ? void 0 : _a2.includes(sym))) pats.push(`\\b${t}\\b`);
      const re = new RegExp(pats.join("|"));
      return (title) => re.test(title) && (!ctx || BANK_CTX.test(title));
    }
    const recent = [...all].sort((a, b) => b.ts - a.ts).filter((it) => it.ts && Date.now() - it.ts < 2 * 864e5 && !JUNK_SRC.test(it.src) && !JUNK.test(it.title));
    function headlineFor(s) {
      const m = matcher(s.symbol);
      const hit = recent.find((it) => m(it.title));
      return hit ? hit.title : null;
    }
    const short = (s, n = 90) => s.length > n ? s.slice(0, n - 1).replace(/\s+\S*$/, "") + "\u2026" : s;
    const reasons = (list) => Object.fromEntries((list != null ? list : []).slice(0, 10).map((s) => {
      const h = headlineFor(s);
      return [s.symbol, h ? "In news: " + short(h) : ""];
    }).filter(([, v]) => v));
    const gainerReasons = reasons(D.gainers), loserReasons = reasons(D.losers);
    const trending = [];
    const addT = (s, why) => {
      if (s && !trending.some((t) => t.symbol === s.symbol)) {
        const h = headlineFor(s);
        trending.push({ symbol: s.symbol, reason: why + (h ? ". In news: " + short(h, 70) : "") });
      }
    };
    ((_l = D.gainers) != null ? _l : []).slice(0, 3).forEach((s, i) => addT(s, `Up ${nf(s.pct)}%${i === 0 ? ", top gainer" : ""}`));
    ((_m = D.losers) != null ? _m : []).slice(0, 3).forEach((s, i) => addT(s, `Down ${nf(Math.abs(s.pct))}%${i === 0 ? ", top loser" : ""}`));
    ((_n = D.mostActive) != null ? _n : []).slice(0, 4).forEach((s) => addT(s, `Most traded: $${nf(s.valueM >= 1e3 ? s.valueM / 1e3 : s.valueM, s.valueM >= 1e3 ? 1 : 0)}${s.valueM >= 1e3 ? "B" : "M"} (${pc(s.pct)})`));
    const day1 = recent.filter((it) => Date.now() - it.ts < 864e5);
    const firstHit = (re) => {
      const h = day1.find((it) => re.test(it.title));
      return h ? "In news: " + short(h.title, 80) : "";
    };
    const SECTOR_KEYS = {
      Technology: /\b(tech stocks|tech shares|chip ?stocks|chipmakers?|semiconductors?|Nvidia|Apple|Microsoft|Broadcom)\b/i,
      Financials: /\b(bank stocks|bank shares|regional banks|lenders|financials|financial stocks)\b/i,
      "Health Care": /\b(health ?care|drugmakers?|pharma\w*|biotech|FDA|UnitedHealth|Eli Lilly|Pfizer|Merck)\b/i,
      Energy: /\b(oil|crude|OPEC|energy stocks|Exxon|Chevron|natural gas)\b/i,
      "Consumer Discretionary": /\b(retailers?|consumer spending|Amazon|Tesla|Home Depot|Nike|automakers?)\b/i,
      "Consumer Staples": /\b(consumer staples|Walmart|Costco|Procter|PepsiCo|Coca-Cola|grocer)\b/i,
      Industrials: /\b(industrials|Boeing|Caterpillar|airlines?|railroads?|defen[cs]e stocks|GE Aerospace)\b/i,
      Materials: /\b(materials|copper|steel|mining stocks|miners|chemicals?)\b/i,
      Utilities: /\b(utilities|power demand|NextEra|Duke Energy)\b/i,
      "Real Estate": /\b(REITs?|real estate stocks|commercial real estate)\b/i,
      "Communication Services": /\b(Alphabet|Google|Meta|Netflix|Disney|telecom|streaming)\b/
    };
    const sectorReasons = Object.fromEntries(secs.map((s) => [s.name, SECTOR_KEYS[s.name] ? firstHit(SECTOR_KEYS[s.name]) : ""]).filter(([, v]) => v));
    const ASSET_KEYS = {
      Gold: /\bgold\b/i,
      Silver: /\bsilver\b/i,
      Brent: /\b(oil|crude|Brent|OPEC)\b/i,
      "Crude (WTI)": /\b(oil|crude|WTI|OPEC)\b/i,
      "Natural gas": /\bnatural gas\b/i,
      Bitcoin: /\bbitcoin\b/i,
      Ethereum: /\b(ether|ethereum)\b/i,
      "US Dollar Index": /\b(dollar index|U\.?S\.? dollar|greenback)\b/i,
      "EUR/USD": /\beuro\b/i,
      "USD/JPY": /\byen\b/i,
      "USD/INR": /\brupee\b/i
    };
    const assetReasons = Object.fromEntries(Object.entries(ASSET_KEYS).map(([k, re]) => [k, firstHit(re)]).filter(([, v]) => v));
    const hhmm = clock(etNow.min);
    const out = {
      asOf: (_p = (_o = D.market) == null ? void 0 : _o.sessionDate) != null ? _p : null,
      asOfLabel: open ? `${sdLabel}, ${hhmm} ET` : `${sdLabel}, ${closeLbl}`,
      session: open ? `Live \xB7 ${hhmm} ET` : ((_q = D.market) == null ? void 0 : _q.status) === "pre" ? "Pre-market \xB7 last session report" : ((_r = D.market) == null ? void 0 : _r.sessionDate) === etNow.date ? `Closing Report \xB7 ${closeLbl}` : "Last session report",
      mood,
      summary,
      conclusion,
      bull,
      bear,
      pivots,
      risks: risks.slice(0, 6),
      events,
      trending,
      gainerReasons,
      loserReasons,
      sectorReasons,
      assetReasons,
      stockNews: stockNews.map(slim),
      econNews: econNews.map(slim),
      earnings: earnings.map(slim),
      analyst: analyst.map(slim),
      ipoNews: ipoNews.map(slim),
      commodNews: commodNews.map(slim),
      nextSession: nextSession(),
      generated: "Automatic: headlines from CNBC, MarketWatch, Seeking Alpha, Nasdaq, Yahoo Finance and Google News RSS; summary, mood and levels computed from prices."
    };
    for (const k of ["stockNews", "econNews", "earnings", "analyst", "ipoNews", "commodNews"]) if (!out[k].length && ((_s = prev[k]) == null ? void 0 : _s.length)) out[k] = prev[k];
    const strip = (o) => {
      const _a2 = o != null ? o : {}, { asOfLabel, session, updated, errors: _e2 } = _a2, rest = __objRest(_a2, ["asOfLabel", "session", "updated", "errors"]);
      return JSON.stringify(rest);
    };
    if (false) {
      console.log("No news changes; us/news.json unchanged.");
      return null;
    }
    out.updated = (/* @__PURE__ */ new Date()).toISOString();
    out.errors = errors;
    __result = out;
    console.log(`Wrote us/news.json: ${stockNews.length} stock, ${econNews.length} econ, ${earnings.length} earnings, ${analyst.length} analyst, ${ipoNews.length} IPO, ${commodNews.length} commodities headlines; mood=${mood}${errors.length ? "; errors: " + errors.join(", ") : ""}`);
    return __result;
  }
  const cache = () => CacheService.getScriptCache();
  const get = (k) => {
    try {
      const v = cache().get(k);
      return v ? JSON.parse(v) : null;
    } catch (e) {
      return null;
    }
  };
  const put = (k, o, s) => {
    try {
      const v = JSON.stringify(o);
      if (v.length < 95e3) cache().put(k, v, Math.max(30, Math.min(21600, Math.round(s))));
    } catch (e) {
    }
  };
  function toOpen(feed2) {
    const now = /* @__PURE__ */ new Date();
    const tz = feed2 === "india" ? "Asia/Kolkata" : "America/New_York";
    const p = Utilities.formatDate(now, tz, "u HH mm").split(" ").map(Number);
    const min = p[1] * 60 + p[2], open = feed2 === "india" ? 555 : 570;
    return p[0] <= 5 && min < open ? (open - min) * 60 + 5 : Infinity;
  }
  const B = { india: [indiaData, indiaNews], us: [usData, usNews] };
  function part(feed2, kind, build, ttl) {
    const key = "mkt:" + feed2 + ":" + kind;
    let v = get(key);
    if (v) return v;
    const busy = key + ":busy";
    if (cache().get(busy)) {
      for (let i = 0; i < 20 && !v; i++) {
        Utilities.sleep(1e3);
        v = get(key);
      }
      return v || get(key + ":last");
    }
    cache().put(busy, "1", 45);
    PART = feed2 + ":" + kind;
    MARKED = [];
    try {
      v = build();
      if (v) {
        put(key, v, ttl(v));
        put(key + ":last", v, 21600);
      }
    } catch (e) {
      console.error("market " + key + ": " + e);
      v = null;
    } finally {
      unmark();
      cache().remove(busy);
    }
    return v || get(key + ":last");
  }
  function feed(name, debug) {
    const b = B[name];
    if (!b) return { ok: false, error: "unknown feed" };
    T0 = Date.now();
    LOG = [];
    YA = null;
    YA_TRIES = 0;
    const cap = (s) => Math.min(s, toOpen(name));
    const live = (d) => d && d.market && d.market.status === "open";
    LIMIT = 45;
    const data = part(name, "data", () => b[0]({ data: get("mkt:" + name + ":data:last") || {}, news: get("mkt:" + name + ":news:last") || {} }), (d) => cap(live(d) ? 120 : 900));
    if (!data) return debug ? { ok: false, error: "no data", log: LOG } : { ok: false, error: "no data" };
    LIMIT = 100;
    const news = part(name, "news", () => b[1]({ data, news: get("mkt:" + name + ":news:last") || {} }), () => cap(live(data) ? 600 : 1800));
    const out = { ok: true, feed: name, data, news: news || {} };
    if (debug) out.log = LOG.concat(["total " + (Date.now() - T0) + "ms"]);
    return out;
  }
  return { feed };
})();
function marketFeed_(name, debug) {
  return MKT_.feed(name, debug);
}
// ===== END LIVE MARKET REPORTS =====
