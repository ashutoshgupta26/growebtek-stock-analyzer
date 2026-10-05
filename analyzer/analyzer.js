/* Growebtek AI Stock & Fund Analyzer — Stock Analyzer (analyze + compare). No external libraries. */
(function () {
  'use strict';
  if (!window.GW || !GW.guard({ sub: 'Stock Analyzer' })) return;
  var esc = GW.esc;
  var $ = function (s, r) { return (r || document).querySelector(s); };
  var $$ = function (s, r) { return Array.prototype.slice.call((r || document).querySelectorAll(s)); };
  $('#yr').textContent = new Date().getFullYear();

  var QUICK = [['Reliance', 'RELIANCE.NS'], ['TCS', 'TCS.NS'], ['HDFC Bank', 'HDFCBANK.NS'], ['Infosys', 'INFY.NS'], ['Apple', 'AAPL'], ['Microsoft', 'MSFT'], ['Nvidia', 'NVDA'], ['Toyota', '7203.T']];
  var CMP_COLORS = ['#5b5bf6', '#ec4899', '#f97316', '#14b8a6'];
  var RANGES = [['1M', 31], ['6M', 183], ['1Y', 366], ['3Y', 1096], ['5Y', 1830]];
  var KEY_RECENT = 'gw_an_recent';
  var DAY = 86400;

  var S = { tab: 'analyze', sym: null, cmp: [], cache: {}, req: 0, cmpReq: 0, range: '1Y', cmpRange: '1Y', charts: {} };

  // ================================================================ number formatting
  var SUBUNIT = { GBp: { c: 'GBP', d: 100, s: 'p' }, GBX: { c: 'GBP', d: 100, s: 'p' }, ZAc: { c: 'ZAR', d: 100, s: 'c' }, ZAC: { c: 'ZAR', d: 100, s: 'c' }, ILA: { c: 'ILS', d: 100, s: ' ag' } };
  var fmtCache = {};
  function nf(loc, o) { var k = loc + JSON.stringify(o); return fmtCache[k] || (fmtCache[k] = new Intl.NumberFormat(loc, o)); }
  function ok(v) { return typeof v === 'number' && isFinite(v); }
  function locOf(cur) { return cur === 'INR' ? 'en-IN' : 'en-US'; }
  function mainCur(cur) { return SUBUNIT[cur] ? SUBUNIT[cur].c : (cur || 'USD'); }
  // price in the quote currency (handles pence etc.)
  function money(v, cur, dp) {
    if (!ok(v)) return '–';
    var sub = SUBUNIT[cur];
    if (sub) return nf('en-GB', { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(v) + sub.s;
    var a = Math.abs(v), d = dp != null ? dp : a < 1 ? 4 : 2;
    try {
      var f = nf(locOf(cur), { style: 'currency', currency: cur || 'USD', currencyDisplay: 'narrowSymbol' });
      var md = f.resolvedOptions().maximumFractionDigits;
      if (md === 0 && a >= 1) return f.format(v);
      return nf(locOf(cur), { style: 'currency', currency: cur || 'USD', currencyDisplay: 'narrowSymbol', minimumFractionDigits: Math.min(d, 2), maximumFractionDigits: d }).format(v);
    } catch (e) { return num(v, d) + ' ' + (cur || ''); }
  }
  // large amounts (market cap, cash flow) in a main currency unit
  function big(v, cur) {
    if (!ok(v)) return '–';
    cur = mainCur(cur);
    var sym = '';
    try { sym = nf('en-US', { style: 'currency', currency: cur, currencyDisplay: 'narrowSymbol' }).formatToParts(0).filter(function (p) { return p.type === 'currency'; })[0].value; } catch (e) { sym = cur + ' '; }
    if (cur === 'INR') {
      var cr = v / 1e7, neg = v < 0 ? '-' : '';
      cr = Math.abs(cr);
      if (cr >= 1e5) return neg + '₹' + nf('en-IN', { maximumFractionDigits: 2 }).format(cr / 1e5) + ' lakh Cr';
      if (cr >= 1) return neg + '₹' + nf('en-IN', { maximumFractionDigits: cr >= 100 ? 0 : 1 }).format(cr) + ' Cr';
      return neg + '₹' + nf('en-IN', { maximumFractionDigits: 0 }).format(Math.abs(v));
    }
    try { return nf('en-US', { style: 'currency', currency: cur, currencyDisplay: 'narrowSymbol', notation: 'compact', maximumFractionDigits: 2 }).format(v); }
    catch (e) { return sym + nf('en-US', { notation: 'compact', maximumFractionDigits: 2 }).format(v); }
  }
  function num(v, d) { return ok(v) ? nf('en-US', { minimumFractionDigits: d == null ? 2 : d, maximumFractionDigits: d == null ? 2 : d }).format(v) : '–'; }
  function pct(v, d, sign) { // v is a fraction
    if (!ok(v)) return '–';
    var s = nf('en-US', { minimumFractionDigits: d == null ? 1 : d, maximumFractionDigits: d == null ? 1 : d }).format(v * 100) + '%';
    return sign && v > 0 ? '+' + s : s;
  }
  function pctHtml(v, d) { return ok(v) ? '<span class="num ' + (v > 0 ? 'up' : v < 0 ? 'dn' : '') + '">' + pct(v, d, true) + '</span>' : '<span class="muted">–</span>'; }
  function ratio(v, d, suf) { return ok(v) ? num(v, d == null ? 1 : d) + (suf || '') : '–'; }
  function clamp(v, a, b) { return Math.max(a, Math.min(b, v)); }
  function dateFmt(sec, tz, withTime) {
    try {
      var o = { day: 'numeric', month: 'short', year: 'numeric', timeZone: tz || undefined };
      if (withTime) { o.hour = 'numeric'; o.minute = '2-digit'; o.timeZoneName = 'short'; }
      return new Intl.DateTimeFormat('en-GB', o).format(new Date(sec * 1000));
    } catch (e) { return new Date(sec * 1000).toDateString(); }
  }
  function ago(ms) {
    var s = (Date.now() - ms) / 1000;
    if (s < 3600) return Math.max(1, Math.round(s / 60)) + 'm ago';
    if (s < 86400) return Math.round(s / 3600) + 'h ago';
    if (s < 86400 * 30) return Math.round(s / 86400) + 'd ago';
    return dateFmt(ms / 1000);
  }

  // ================================================================ data loading
  function load(sym) {
    if (!S.cache[sym]) {
      S.cache[sym] = GW.api('stock', { symbol: sym }, { timeout: 60000 }).then(function (raw) {
        if (!raw || !raw.chart || !raw.chart.c || raw.chart.c.length < 2) throw new Error('No price history is available for ' + sym + '. Please check the symbol.');
        return compute(raw, sym);
      });
      S.cache[sym].catch(function () { delete S.cache[sym]; });
    }
    return S.cache[sym];
  }

  // ================================================================ maths
  function sma(a, n) { var o = new Array(a.length).fill(null), s = 0; for (var i = 0; i < a.length; i++) { s += a[i]; if (i >= n) s -= a[i - n]; if (i >= n - 1) o[i] = s / n; } return o; }
  function ema(a, n) { var k = 2 / (n + 1), o = [], e = a[0]; for (var i = 0; i < a.length; i++) { e = i ? a[i] * k + e * (1 - k) : a[0]; o.push(e); } return o; }
  function rsi(a, n) {
    if (a.length <= n + 1) return null;
    var g = 0, l = 0, i;
    for (i = 1; i <= n; i++) { var d = a[i] - a[i - 1]; if (d > 0) g += d; else l -= d; }
    g /= n; l /= n;
    for (i = n + 1; i < a.length; i++) { var d2 = a[i] - a[i - 1]; g = (g * (n - 1) + Math.max(d2, 0)) / n; l = (l * (n - 1) + Math.max(-d2, 0)) / n; }
    return l === 0 ? 100 : 100 - 100 / (1 + g / l);
  }
  function idxAt(t, target) { // last index with t <= target, or -1
    var lo = 0, hi = t.length - 1, r = -1;
    while (lo <= hi) { var m = (lo + hi) >> 1; if (t[m] <= target) { r = m; lo = m + 1; } else hi = m - 1; }
    return r;
  }
  function backVal(t, a, days) {
    var target = t[t.length - 1] - days * DAY, i = idxAt(t, target);
    if (i < 0) { if (t[0] - target < 12 * DAY) i = 0; else return null; }
    return a[i];
  }
  function maxDD(a, from) { var pk = -Infinity, dd = 0; for (var i = Math.max(0, from); i < a.length; i++) { if (a[i] > pk) pk = a[i]; var d = a[i] / pk - 1; if (d < dd) dd = d; } return dd; }
  function vol(a, n) {
    var r = []; for (var i = Math.max(1, a.length - n); i < a.length; i++) if (a[i - 1] > 0 && a[i] > 0) r.push(Math.log(a[i] / a[i - 1]));
    if (r.length < 10) return null;
    var m = r.reduce(function (s, x) { return s + x; }, 0) / r.length;
    var v = r.reduce(function (s, x) { return s + (x - m) * (x - m); }, 0) / (r.length - 1);
    return Math.sqrt(v * 252);
  }
  function levels(arr, price, above) { // dedupe nearby levels, nearest first
    arr = arr.filter(function (x) { return above ? x > price * 1.004 : x < price * 0.996; }).sort(function (a, b) { return above ? a - b : b - a; });
    var out = [];
    arr.forEach(function (x) { if (!out.some(function (y) { return Math.abs(x / y - 1) < 0.015; })) out.push(x); });
    return out;
  }
  function pick(o, path) { var p = path.split('.'); for (var i = 0; i < p.length; i++) { if (o == null) return null; o = o[p[i]]; } return ok(o) ? o : null; }

  // ================================================================ analysis model
  function compute(raw, sym) {
    var ch = raw.chart, meta = ch.meta || {}, sm = raw.summary || {};
    var sd = sm.summaryDetail || {}, ks = sm.defaultKeyStatistics || {}, fd = sm.financialData || {}, pr = sm.price || {}, ap = sm.assetProfile || {};
    // clean series
    var t = [], c = [], ac = [], h = [], l = [];
    for (var i = 0; i < ch.t.length; i++) {
      var cv = ch.c[i]; if (!ok(cv) || cv <= 0) continue;
      t.push(ch.t[i]); c.push(cv);
      var a = ch.ac && ok(ch.ac[i]) && ch.ac[i] > 0 ? ch.ac[i] : cv; ac.push(a);
      h.push(ch.h && ok(ch.h[i]) ? ch.h[i] : cv); l.push(ch.l && ok(ch.l[i]) ? ch.l[i] : cv);
    }
    var n = c.length;
    var m = { sym: raw.symbol || sym, t: t, c: c, ac: ac, h: h, l: l };
    m.cur = meta.currency || pr.currency || sd.currency || 'USD';
    m.name = pr.longName || meta.name || pr.shortName || m.sym;
    m.exch = pr.exchangeName || meta.exchange || '';
    m.tz = meta.tz;
    m.sector = ap.sector || ''; m.industry = ap.industry || ''; m.country = ap.country || '';
    m.website = ap.website || ''; m.employees = ap.employees; m.about = ap.summary || '';
    m.price = pick(pr, 'regularMarketPrice') || (ok(meta.price) ? meta.price : c[n - 1]);
    m.prev = pick(pr, 'regularMarketPreviousClose') || pick(sd, 'previousClose') || pick(sd, 'regularMarketPreviousClose') || c[n - 2];
    m.chg = m.price - m.prev; m.chgPct = m.prev ? m.chg / m.prev : null;
    m.time = pick(pr, 'regularMarketTime') || meta.time || t[n - 1];
    m.dayHi = pick(pr, 'regularMarketDayHigh') || meta.dayHigh; m.dayLo = pick(pr, 'regularMarketDayLow') || meta.dayLow;
    var y1i = Math.max(0, idxAt(t, t[n - 1] - 365 * DAY));
    m.hi52 = pick(sd, 'fiftyTwoWeekHigh') || meta.hi52 || Math.max.apply(null, h.slice(y1i));
    m.lo52 = pick(sd, 'fiftyTwoWeekLow') || meta.lo52 || Math.min.apply(null, l.slice(y1i));
    m.hi52 = Math.max(m.hi52, m.price); m.lo52 = Math.min(m.lo52, m.price);
    m.mcap = pick(sd, 'marketCap') || pick(pr, 'marketCap');
    m.vol = pick(sd, 'volume') || pick(pr, 'regularMarketVolume');
    m.avgVol = pick(sd, 'averageVolume');

    // returns (adjusted close)
    var last = ac[n - 1];
    function r(days) { var b = backVal(t, ac, days); return ok(b) && b > 0 ? last / b - 1 : null; }
    function cagr(years) { var b = backVal(t, ac, Math.round(365.25 * years)); return ok(b) && b > 0 ? Math.pow(last / b, 1 / years) - 1 : null; }
    var yr = new Date(t[n - 1] * 1000).getUTCFullYear(), yi = idxAt(t, Date.UTC(yr, 0, 1) / 1000 - 1);
    m.ret = { w1: r(7), m1: r(30), m3: r(91), m6: r(182), ytd: yi >= 0 ? last / ac[yi] - 1 : null, y1: r(365), y3: cagr(3), y5: cagr(5) };

    // technicals (close)
    var s20 = sma(c, 20), s50 = sma(c, 50), s200 = sma(c, 200);
    m.s50 = s50; m.s200 = s200;
    var T = m.tech = { sma20: s20[n - 1], sma50: s50[n - 1], sma200: s200[n - 1] };
    T.rsi = rsi(c.slice(-300), 14);
    var e12 = ema(c, 12), e26 = ema(c, 26), macd = e12.map(function (x, k) { return x - e26[k]; }), sig = ema(macd.slice(26), 9);
    T.macd = macd[n - 1]; T.macdSig = sig.length ? sig[sig.length - 1] : null;
    T.macdHist = ok(T.macdSig) ? T.macd - T.macdSig : null;
    if (sig.length > 6) {
      var hPrev = macd[n - 6] - sig[sig.length - 6];
      T.macdCross = (hPrev < 0 && T.macdHist > 0) ? 'fresh bullish crossover' : (hPrev > 0 && T.macdHist < 0) ? 'fresh bearish crossover' : '';
    }
    T.pos52 = m.hi52 > m.lo52 ? (m.price - m.lo52) / (m.hi52 - m.lo52) : null;
    T.vol = vol(ac, 252);
    T.dd1 = maxDD(ac, y1i); T.dd5 = maxDD(ac, 0);
    var p = m.price, a50 = ok(T.sma50) && p > T.sma50, a200 = ok(T.sma200) && p > T.sma200, g = ok(T.sma50) && ok(T.sma200) && T.sma50 > T.sma200;
    if (a50 && a200 && g) { T.trend = 'Strong uptrend'; T.tone = 'green'; }
    else if (a200 && (a50 || g)) { T.trend = 'Uptrend'; T.tone = 'green'; }
    else if (!a50 && !a200 && ok(T.sma200) && !g) { T.trend = 'Downtrend'; T.tone = 'red'; }
    else if (!a200 && ok(T.sma200)) { T.trend = 'Weak / below 200-DMA'; T.tone = 'red'; }
    else { T.trend = 'Sideways'; T.tone = 'amber'; }
    // support / resistance: swing highs & lows in the last ~year, else pivot levels
    var from = Math.max(5, n - 250), sh = [], sl = [];
    for (var j = from; j < n - 3; j++) {
      var w0 = Math.max(0, j - 5), w1 = Math.min(n - 1, j + 5), isH = true, isL = true;
      for (var k = w0; k <= w1; k++) { if (h[k] > h[j]) isH = false; if (l[k] < l[j]) isL = false; }
      if (isH) sh.push(h[j]); if (isL) sl.push(l[j]);
    }
    var res = levels(sh, p, true), sup = levels(sl, p, false);
    var H20 = Math.max.apply(null, h.slice(-20)), L20 = Math.min.apply(null, l.slice(-20)), P = (H20 + L20 + c[n - 1]) / 3;
    var pivR = [2 * P - L20, P + (H20 - L20)], pivS = [2 * P - H20, P - (H20 - L20)];
    T.res = res.slice(0, 2); T.sup = sup.slice(0, 2);
    pivR.forEach(function (x) { if (T.res.length < 2 && x > p * 1.004 && !T.res.some(function (y) { return Math.abs(x / y - 1) < 0.015; })) T.res.push(x); });
    pivS.forEach(function (x) { if (T.sup.length < 2 && x < p * 0.996 && x > 0 && !T.sup.some(function (y) { return Math.abs(x / y - 1) < 0.015; })) T.sup.push(x); });
    T.res.sort(function (a, b) { return a - b; }); T.sup.sort(function (a, b) { return b - a; });

    // fundamentals
    var finCur = fd.financialCurrency || m.cur, curMismatch = mainCur(finCur) !== mainCur(m.cur);
    var dy = pick(sd, 'dividendYield'); if (ok(dy) && dy > 0.3) dy = dy / 100;
    var de = pick(fd, 'debtToEquity');
    var ev = pick(ks, 'enterpriseToEbitda');
    if (ok(ev) && (ev <= 0 || (curMismatch && ev > 80))) ev = null; // Yahoo mixes currencies for some listings
    var pe = pick(sd, 'trailingPE'); if (!ok(pe) && ok(pick(ks, 'trailingEps')) && ks.trailingEps > 0 && !curMismatch) pe = m.price / ks.trailingEps;
    m.fund = {
      pe: pe, fpe: pick(sd, 'forwardPE') || pick(ks, 'forwardPE'), pb: pick(ks, 'priceToBook'), peg: pick(ks, 'pegRatio'), ev: ev,
      dy: dy || (sd.dividendYield === 0 ? 0 : null), roe: pick(fd, 'returnOnEquity'), margin: pick(fd, 'profitMargins') || pick(ks, 'profitMargins'),
      revG: pick(fd, 'revenueGrowth'), earnG: pick(fd, 'earningsGrowth') || pick(ks, 'earningsQuarterlyGrowth'),
      de: ok(de) ? de / 100 : null, cr: pick(fd, 'currentRatio'), fcf: pick(fd, 'freeCashflow'), finCur: finCur, beta: pick(sd, 'beta') || pick(ks, 'beta'),
      opm: pick(fd, 'operatingMargins')
    };
    if (ok(m.fund.pe) && m.fund.pe > 2000) m.fund.pe = null;
    var et = sm.earningsTrend || [];
    et.forEach(function (x) { if (x.period === '+1y' && ok(x.growth)) m.fund.epsNext = x.growth; if (x.period === '0y' && ok(x.growth)) m.fund.epsCur = x.growth; });
    var yrs = pick(sm, 'earnings') !== null ? null : (sm.earnings && sm.earnings.financialsChart && sm.earnings.financialsChart.yearly) || [];
    if (yrs && yrs.length >= 3 && yrs[0].revenue > 0 && yrs[yrs.length - 1].revenue > 0) m.fund.rev3 = Math.pow(yrs[yrs.length - 1].revenue / yrs[0].revenue, 1 / (yrs.length - 1)) - 1;

    // analyst
    var rt = sm.recommendationTrend && sm.recommendationTrend.trend && sm.recommendationTrend.trend[0];
    m.an = {
      key: fd.recommendationKey && fd.recommendationKey !== 'none' ? fd.recommendationKey : '', mean: pick(fd, 'targetMeanPrice'), hi: pick(fd, 'targetHighPrice'), lo: pick(fd, 'targetLowPrice'),
      n: pick(fd, 'numberOfAnalystOpinions'), score: pick(fd, 'recommendationMean'),
      trend: rt ? [rt.strongBuy || 0, rt.buy || 0, rt.hold || 0, rt.sell || 0, rt.strongSell || 0] : null
    };
    m.an.upside = ok(m.an.mean) && m.an.mean > 0 ? m.an.mean / m.price - 1 : null;
    if (ok(m.an.upside) && Math.abs(m.an.upside) > 3) { m.an.mean = m.an.hi = m.an.lo = m.an.upside = null; } // unit mismatch guard

    var ce = sm.calendarEvents && sm.calendarEvents.earnings;
    var ed = ce && ce.earningsDate && ce.earningsDate.filter(function (x) { return x * 1000 > Date.now() - DAY * 1000; })[0];
    m.earnDate = ed || null; m.earnEst = ce && ce.isEarningsDateEstimate;
    var exd = sm.calendarEvents && sm.calendarEvents.exDividendDate;
    m.exDiv = ok(exd) && exd * 1000 > Date.now() ? exd : null;
    var seenT = {}; m.news = (raw.news || []).filter(function (x) { if (!x || !x.title || !/^https?:\/\//.test(x.url || '')) return false; var k = x.title.toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 60); if (seenT[k]) return false; seenT[k] = 1; return true; }).slice(0, 8);

    score(m); story(m);
    return m;
  }

  // weighted average of available components (each 0..1) -> 0..10
  function blend(parts) {
    var w = 0, s = 0; parts.forEach(function (x) { if (x && ok(x[0])) { s += x[0] * x[1]; w += x[1]; } });
    return w >= 1.5 ? Math.round(s / w * 100) / 10 : null;
  }
  function step(v, cuts) { for (var i = 0; i < cuts.length; i++) if (v >= cuts[i][0]) return cuts[i][1]; return cuts[cuts.length - 1][2] != null ? cuts[cuts.length - 1][2] : 0.05; }
  function growthPts(v) { return ok(v) ? step(v, [[0.25, 1], [0.15, 0.85], [0.08, 0.7], [0.03, 0.55], [0, 0.4], [-0.1, 0.2], [-Infinity, 0.05]]) : null; }

  function score(m) {
    var F = m.fund, T = m.tech, R = m.ret, A = m.an, out = [];
    // Fundamentals
    var f = blend([
      [ok(F.roe) ? step(F.roe, [[0.25, 1], [0.18, 0.85], [0.12, 0.65], [0.06, 0.4], [0, 0.2], [-Infinity, 0]]) : null, 3],
      [ok(F.margin) ? step(F.margin, [[0.25, 1], [0.15, 0.85], [0.08, 0.6], [0.03, 0.4], [0, 0.25], [-Infinity, 0.05]]) : null, 2.5],
      [ok(F.de) ? step(-F.de, [[-0.3, 1], [-0.7, 0.8], [-1.5, 0.5], [-3, 0.25], [-Infinity, 0.1]]) : null, 2],
      [ok(F.cr) ? step(F.cr, [[1.5, 1], [1.1, 0.75], [0.8, 0.45], [-Infinity, 0.2]]) : null, 1],
      [ok(F.fcf) ? (F.fcf > 0 ? 1 : 0.15) : null, 1.5]
    ]);
    out.push({ k: 'f', name: 'Fundamentals', v: f, note: f == null ? 'Not enough financial data' : 'ROE ' + pct(F.roe, 0) + ' · margin ' + pct(F.margin, 0) + ' · D/E ' + ratio(F.de, 2, 'x') + ' · FCF ' + (ok(F.fcf) ? (F.fcf > 0 ? 'positive' : 'negative') : '–') });
    // Valuation
    var pe = F.pe, v = blend([
      [ok(pe) ? (pe <= 0 ? 0.05 : step(-pe, [[-12, 1], [-18, 0.8], [-25, 0.6], [-35, 0.4], [-50, 0.25], [-80, 0.12], [-Infinity, 0.05]])) : null, 3],
      [ok(F.pb) && F.pb > 0 ? step(-F.pb, [[-1.5, 1], [-3, 0.75], [-6, 0.5], [-12, 0.3], [-Infinity, 0.12]]) : null, 1.5],
      [ok(F.peg) && F.peg > 0 ? step(-F.peg, [[-1, 1], [-1.5, 0.75], [-2, 0.55], [-3, 0.35], [-Infinity, 0.15]]) : null, 1.5],
      [ok(A.upside) ? step(A.upside, [[0.25, 1], [0.12, 0.8], [0.03, 0.6], [-0.05, 0.4], [-Infinity, 0.15]]) : null, 2],
      [ok(F.fpe) && ok(pe) && pe > 0 && F.fpe > 0 ? step(-F.fpe / pe, [[-0.85, 1], [-1, 0.7], [-Infinity, 0.35]]) : null, 1]
    ]);
    out.push({ k: 'v', name: 'Valuation', v: v, note: v == null ? 'Not enough valuation data' : 'P/E ' + ratio(pe, 1) + ' · P/B ' + ratio(F.pb, 1) + (ok(F.peg) ? ' · PEG ' + ratio(F.peg, 2) : '') + (ok(A.upside) ? ' · analyst upside ' + pct(A.upside, 0, true) : '') });
    // Technicals
    var p = m.price, rs = T.rsi;
    var t = blend([
      [ok(T.sma50) ? (p > T.sma50 ? 1 : 0.15) : null, 1.5],
      [ok(T.sma200) ? (p > T.sma200 ? 1 : 0.1) : null, 2],
      [ok(T.sma50) && ok(T.sma200) ? (T.sma50 > T.sma200 ? 1 : 0.2) : null, 1],
      [ok(rs) ? (rs >= 45 && rs <= 65 ? 1 : rs > 65 && rs <= 75 ? 0.7 : rs >= 35 && rs < 45 ? 0.55 : rs > 75 ? 0.35 : 0.3) : null, 1],
      [ok(T.macdHist) ? (T.macdHist > 0 ? 1 : 0.2) : null, 1],
      [ok(R.m3) ? step(R.m3, [[0.1, 1], [0.03, 0.8], [0, 0.6], [-0.08, 0.35], [-Infinity, 0.1]]) : null, 1.5]
    ]);
    out.push({ k: 't', name: 'Technicals', v: t, note: (ok(T.sma50) ? (p > T.sma50 ? 'Above' : 'Below') + ' 50-DMA' : '') + (ok(T.sma200) ? ', ' + (p > T.sma200 ? 'above' : 'below') + ' 200-DMA' : '') + ' · RSI ' + num(rs, 0) + ' · 3M ' + pct(R.m3, 1, true) });
    // Growth
    var gr = blend([[growthPts(F.revG), 2], [growthPts(F.earnG), 2], [growthPts(F.epsNext), 1.5], [growthPts(F.rev3), 2]]);
    out.push({ k: 'g', name: 'Growth', v: gr, note: gr == null ? 'Not enough growth data' : 'Revenue ' + pct(F.revG, 0, true) + ' · earnings ' + pct(F.earnG, 0, true) + ' YoY' + (ok(F.rev3) ? ' · ' + 'sales CAGR ' + pct(F.rev3, 0) : '') + (ok(F.epsNext) ? ' · next-yr EPS ' + pct(F.epsNext, 0, true) : '') });
    // Risk (higher = safer)
    var rk = blend([
      [ok(T.vol) ? step(-T.vol, [[-0.2, 1], [-0.28, 0.8], [-0.38, 0.55], [-0.5, 0.3], [-Infinity, 0.1]]) : null, 2.5],
      [ok(F.beta) ? step(-Math.abs(F.beta), [[-0.8, 1], [-1.1, 0.75], [-1.5, 0.45], [-Infinity, 0.2]]) : null, 1],
      [ok(T.dd1) ? step(T.dd1, [[-0.15, 1], [-0.25, 0.7], [-0.4, 0.4], [-Infinity, 0.15]]) : null, 2],
      [ok(F.de) ? step(-F.de, [[-0.5, 1], [-1, 0.7], [-2, 0.4], [-Infinity, 0.15]]) : null, 1.5]
    ]);
    out.push({ k: 'r', name: 'Risk', v: rk, note: 'Higher = safer · volatility ' + pct(T.vol, 0) + ' · 1Y max fall ' + pct(T.dd1, 0) + (ok(F.beta) ? ' · beta ' + num(F.beta, 2) : '') });

    m.scores = out;
    var av = out.filter(function (x) { return x.v != null; });
    m.overall = av.length ? Math.round(av.reduce(function (s, x) { return s + x.v; }, 0) / av.length * 10) / 10 : null;
    var o = m.overall, tech = t == null ? 5 : t;
    m.verdict = o == null ? 'Hold' : o >= 7 ? 'Buy' : o >= 5.8 ? 'Accumulate' : o >= 4.5 ? 'Hold' : 'Avoid';
    if (m.verdict === 'Buy' && tech < 3.5) m.verdict = 'Accumulate';
    var rr = rk == null ? 5 : rk;
    m.risk = rr >= 6.5 ? 'Low' : rr >= 4.2 ? 'Medium' : 'High';
  }
  function verdictTone(v) { return v === 'Buy' ? 'green' : v === 'Accumulate' ? 'indigo' : v === 'Hold' ? 'amber' : 'red'; }
  function riskTone(r) { return r === 'Low' ? 'green' : r === 'Medium' ? 'amber' : 'red'; }
  function scoreColor(v) { return v == null ? '#cbd5e1' : v >= 7 ? '#16a34a' : v >= 5.5 ? '#14b8a6' : v >= 4 ? '#f59e0b' : '#ef4444'; }

  function story(m) {
    var F = m.fund, T = m.tech, R = m.ret, A = m.an, pros = [], cons = [], short = m.name.replace(/\s+(Limited|Ltd\.?|Inc\.?|Corporation|Corp\.?|plc|PLC|N\.V\.|S\.A\.|AG|SE|Co\.,? Ltd\.?|Company)\b.*$/i, '').trim() || m.sym;
    m.short = short;
    function P(w, s) { pros.push([w, s]); } function C(w, s) { cons.push([w, s]); }
    if (ok(F.roe)) { if (F.roe >= 0.18) P(F.roe, 'High return on equity of ' + pct(F.roe, 0)); else if (F.roe < 0.08) C(0.5 - F.roe, 'Low return on equity of ' + pct(F.roe, 0)); }
    if (ok(F.margin)) { if (F.margin >= 0.15) P(F.margin + 0.1, 'Healthy profit margin of ' + pct(F.margin, 0)); else if (F.margin < 0.05) C(0.4 - F.margin, (F.margin < 0 ? 'Loss-making: margin ' : 'Thin profit margin of ') + pct(F.margin, 1)); }
    if (ok(F.de)) { if (F.de < 0.3) P(0.5, 'Low debt (debt/equity ' + num(F.de, 2) + 'x)'); else if (F.de > 1.5) C(0.4 + F.de / 10, 'High debt (debt/equity ' + num(F.de, 1) + 'x)'); }
    if (ok(F.revG)) { if (F.revG >= 0.1) P(0.3 + F.revG, 'Revenue growing ' + pct(F.revG, 0) + ' year on year'); else if (F.revG < 0) C(0.4 - F.revG, 'Revenue shrinking ' + pct(F.revG, 0) + ' year on year'); }
    if (ok(F.earnG)) { if (F.earnG >= 0.15) P(0.3 + Math.min(F.earnG, 1), 'Earnings up ' + pct(F.earnG, 0) + ' year on year'); else if (F.earnG < -0.05) C(0.4 - Math.max(F.earnG, -1), 'Earnings down ' + pct(Math.abs(F.earnG), 0) + ' year on year'); }
    if (ok(F.pe) && F.pe > 0) { if (F.pe < 15) P(0.45, 'Inexpensive at ' + num(F.pe, 1) + 'x earnings'); else if (F.pe > 45) C(0.35 + F.pe / 300, 'Rich valuation at ' + num(F.pe, 0) + 'x earnings'); }
    else if (ok(F.pe) && F.pe < 0) C(0.6, 'Negative earnings (no meaningful P/E)');
    if (ok(F.dy) && F.dy >= 0.025) P(0.3 + F.dy * 4, 'Dividend yield of ' + pct(F.dy, 1));
    if (ok(A.upside) && A.n >= 3) { if (A.upside >= 0.12) P(0.3 + A.upside, 'Analysts see ' + pct(A.upside, 0) + ' upside to target'); else if (A.upside < -0.03) C(0.4 - A.upside, 'Price is above the average analyst target'); }
    if (T.trend === 'Strong uptrend') P(0.55, 'Strong uptrend: above 50 & 200-day averages');
    else if (T.trend === 'Downtrend') C(0.6, 'In a downtrend: below 50 & 200-day averages');
    else if (T.tone === 'red') C(0.45, 'Trading below its 200-day average');
    if (ok(R.y1)) { if (R.y1 >= 0.25) P(0.3 + R.y1 / 2, 'Up ' + pct(R.y1, 0) + ' over the past year'); else if (R.y1 <= -0.15) C(0.3 - R.y1, 'Down ' + pct(Math.abs(R.y1), 0) + ' over the past year'); }
    if (ok(T.rsi)) { if (T.rsi > 75) C(0.35, 'Overbought: RSI at ' + num(T.rsi, 0)); else if (T.rsi < 30) C(0.3, 'Oversold, weak momentum (RSI ' + num(T.rsi, 0) + ')'); }
    if (ok(T.vol)) { if (T.vol < 0.2) P(0.3, 'Low price volatility (' + pct(T.vol, 0) + ' a year)'); else if (T.vol > 0.45) C(0.3 + T.vol / 3, 'Highly volatile (' + pct(T.vol, 0) + ' a year)'); }
    if (ok(F.fcf)) { if (F.fcf > 0) P(0.25, 'Generates positive free cash flow'); else C(0.4, 'Negative free cash flow'); }
    if (ok(R.y5) && R.y5 > 0.15) P(0.25 + R.y5, '5-year return of ' + pct(R.y5, 0) + ' a year');
    if (ok(T.dd1) && T.dd1 < -0.35) C(0.3, 'Fell ' + pct(Math.abs(T.dd1), 0) + ' from peak in the past year');
    if (!m.fund.pe && !m.fund.roe) C(0.05, 'Limited fundamental data available');
    pros.sort(function (a, b) { return b[0] - a[0]; }); cons.sort(function (a, b) { return b[0] - a[0]; });
    m.pros = pros.slice(0, 5).map(function (x) { return x[1]; });
    m.cons = cons.slice(0, 5).map(function (x) { return x[1]; });
    var extraC = [];
    if (ok(F.pe) && F.pe > 25 && F.pe <= 45) extraC.push('Premium valuation at ' + num(F.pe, 0) + 'x earnings');
    if (ok(F.pb) && F.pb > 8) extraC.push('High price-to-book of ' + num(F.pb, 1) + 'x');
    if (ok(A.upside) && A.upside < 0.05 && A.upside >= -0.03) extraC.push('Little upside left to the average analyst target (' + pct(A.upside, 0, true) + ')');
    if (ok(F.beta) && F.beta > 1.2) extraC.push('Moves more than the market (beta ' + num(F.beta, 2) + ')');
    if (ok(T.pos52) && T.pos52 > 0.9) extraC.push('Trading near its 52-week high, so less margin of safety');
    if (ok(F.revG) && F.revG >= 0 && F.revG < 0.05) extraC.push('Slow revenue growth of ' + pct(F.revG, 0));
    extraC.push('Market-wide or sector sell-offs can hit the price');
    extraC.push('Results can miss expectations and move the price sharply');
    var extraP = [];
    if (ok(T.pos52) && T.pos52 < 0.25 && ok(F.roe) && F.roe > 0.12) extraP.push('Quality business trading near its 52-week low');
    if (ok(F.cr) && F.cr >= 1.5) extraP.push('Strong short-term liquidity (current ratio ' + num(F.cr, 1) + ')');
    if (ok(F.epsNext) && F.epsNext > 0.08) extraP.push('Analysts expect EPS growth of ' + pct(F.epsNext, 0) + ' next year');
    if (ok(R.y3) && R.y3 > 0.1) extraP.push('3-year return of ' + pct(R.y3, 0) + ' a year');
    if (ok(m.mcap)) extraP.push('Large, liquid listed company (' + big(m.mcap, m.cur) + ' market value)');
    extraC.forEach(function (x) { if (m.cons.length < 3 && m.cons.indexOf(x) < 0) m.cons.push(x); });
    extraP.forEach(function (x) { if (m.pros.length < 3 && m.pros.indexOf(x) < 0) m.pros.push(x); });

    // 12-month scenarios
    var p = m.price, vlt = ok(T.vol) ? clamp(T.vol, 0.12, 0.8) : 0.3, base, src;
    if (ok(A.mean) && A.n >= 2) { base = A.mean; src = 'Average target of ' + A.n + ' analysts'; }
    else {
      var mu = clamp(0.5 * (ok(R.y1) ? R.y1 : 0) + 0.5 * (ok(R.y3) ? R.y3 : 0), -0.15, 0.2);
      base = p * (1 + mu); src = 'Trend-based estimate from past returns';
    }
    var bull = ok(A.hi) && A.n >= 2 && A.hi > base ? A.hi : base * (1 + vlt * 0.8);
    var bear = ok(A.lo) && A.n >= 2 && A.lo < base ? Math.min(A.lo, p * (1 - vlt * 0.6)) : base * (1 - vlt * 0.9);
    bull = Math.max(bull, p * 1.03, base * 1.03); bear = clamp(bear, p * 0.3, Math.min(p, base) * 0.97);
    var sup = T.sup[0], res = T.res[0];
    m.scen = [
      { k: 'bull', name: 'Bull case', p: bull, txt: (ok(A.hi) && bull === A.hi ? 'Highest analyst target. ' : 'Upside of about one year’s volatility. ') + (ok(res) ? 'Needs a clean break above ' + money(res, m.cur) + '.' : 'Momentum and earnings beat expectations.') },
      { k: 'base', name: 'Base case', p: base, txt: src + '. ' + (ok(F.epsNext) ? 'Next-year EPS growth seen at ' + pct(F.epsNext, 0, true) + '.' : 'Business continues on its current path.') },
      { k: 'bear', name: 'Bear case', p: bear, txt: (ok(sup) ? 'Losing support at ' + money(sup, m.cur) + ' opens the way down. ' : '') + (ok(F.de) && F.de > 1 ? 'High debt adds pressure.' : 'Weak results or a market sell-off.') }
    ];
    m.scen.forEach(function (s) { s.chg = s.p / p - 1; });

    // one-line verdict text
    var sc = m.scores.filter(function (x) { return x.v != null; }).slice().sort(function (a, b) { return b.v - a.v; });
    var txt = short + ' scores ' + num(m.overall, 1) + '/10. ';
    if (sc.length >= 2) {
      var best = sc[0], worst = sc[sc.length - 1];
      txt += 'Strongest on ' + best.name.toLowerCase() + ' (' + num(best.v, 1) + ')';
      txt += worst.v < 5 ? ', weakest on ' + worst.name.toLowerCase() + ' (' + num(worst.v, 1) + '). ' : '. ';
    }
    txt += 'Trend: ' + T.trend.toLowerCase() + '. ' + (ok(A.upside) ? 'Analysts’ average target is ' + pct(A.upside, 0, true) + ' from here.' : '');
    m.summary = txt;
  }

  // ================================================================ search + autocomplete
  var q = $('#q'), dd = $('#dd'), spin = $('#q-spin'), sTimer, sSeq = 0, sItems = [], sAct = -1;
  function recent() { try { return JSON.parse(localStorage.getItem(KEY_RECENT) || '[]').slice(0, 8); } catch (e) { return []; } }
  function addRecent(sym, name) {
    var r = recent().filter(function (x) { return x.s !== sym; }); r.unshift({ s: sym, n: name || sym });
    try { localStorage.setItem(KEY_RECENT, JSON.stringify(r.slice(0, 8))); } catch (e) {}
    renderPicks();
  }
  function renderPicks() {
    $('#picks').innerHTML = '<span class="lb">Quick picks</span>' + QUICK.map(function (x) { return '<button type="button" class="an-pick" data-pick="' + esc(x[1]) + '" data-name="' + esc(x[0]) + '">' + esc(x[0]) + ' <small>' + esc(x[1]) + '</small></button>'; }).join('');
    var r = recent(), el = $('#recent');
    el.hidden = !r.length;
    el.innerHTML = '<span class="lb">Recent</span>' + r.map(function (x) { return '<button type="button" class="an-pick rec" data-pick="' + esc(x.s) + '" data-name="' + esc(x.n) + '" title="' + esc(x.n) + '">' + esc(x.n.length > 22 ? x.n.slice(0, 21) + '…' : x.n) + ' <small>' + esc(x.s) + '</small></button>'; }).join('') + '<button type="button" class="an-clear" data-clear-recent>Clear</button>';
  }
  function closeDD() { dd.hidden = true; q.setAttribute('aria-expanded', 'false'); sAct = -1; }
  function showDD(html) { dd.innerHTML = html; dd.hidden = false; q.setAttribute('aria-expanded', 'true'); }
  function doSearch() {
    var v = q.value.trim(); if (!v) { closeDD(); return; }
    var my = ++sSeq; spin.hidden = false;
    GW.api('search', { q: v, kind: 'stock' }).then(function (j) {
      if (my !== sSeq) return;
      sItems = (j.results || []).filter(function (x) { return x && x.symbol; }); sAct = -1;
      if (!sItems.length) showDD('<div class="empty">No matches for “' + esc(v) + '”. Try the company name or its ticker (e.g. RELIANCE.NS, AAPL, 7203.T). Press Enter to try “' + esc(v.toUpperCase()) + '” as a symbol.</div>');
      else showDD(sItems.map(function (x, i) {
        return '<button type="button" role="option" data-i="' + i + '"><span class="nm"><b>' + esc(x.name || x.symbol) + '</b><small>' + esc(x.symbol) + '</small></span>' +
          (x.exchange ? '<span class="gw-chip indigo">' + esc(x.exchange) + '</span>' : '') + (x.quoteType && x.quoteType !== 'EQUITY' ? '<span class="gw-chip pink">' + esc(x.type || x.quoteType) + '</span>' : '') + '</button>';
      }).join(''));
    }).catch(function (e) { if (my === sSeq) showDD('<div class="empty">' + esc(e.message) + '</div>'); })
      .then(function () { if (my === sSeq) spin.hidden = true; });
  }
  function choose(sym, name) {
    sym = String(sym || '').trim().toUpperCase(); if (!sym) return;
    closeDD(); q.value = ''; q.blur(); sSeq++; spin.hidden = true;
    addRecent(sym, name);
    if (S.tab === 'compare') addCompare(sym); else go('s', [sym]);
  }
  q.addEventListener('input', function () { clearTimeout(sTimer); if (!q.value.trim()) { sSeq++; spin.hidden = true; closeDD(); return; } sTimer = setTimeout(doSearch, 320); });
  q.addEventListener('keydown', function (e) {
    var btns = $$('button', dd);
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      if (!btns.length) return; e.preventDefault();
      sAct = (sAct + (e.key === 'ArrowDown' ? 1 : -1) + btns.length) % btns.length;
      btns.forEach(function (b, i) { b.classList.toggle('act', i === sAct); }); btns[sAct].scrollIntoView({ block: 'nearest' });
    } else if (e.key === 'Enter') {
      e.preventDefault();
      if (sAct >= 0 && sItems[sAct]) choose(sItems[sAct].symbol, sItems[sAct].name);
      else if (!dd.hidden && sItems.length && sItems[0]) choose(sItems[0].symbol, sItems[0].name);
      else if (q.value.trim()) choose(q.value.trim());
    } else if (e.key === 'Escape') closeDD();
  });
  dd.addEventListener('click', function (e) { var b = e.target.closest('button[data-i]'); if (b) { var x = sItems[+b.dataset.i]; choose(x.symbol, x.name); } });
  document.addEventListener('click', function (e) {
    if (!e.target.closest('.an-sbox')) closeDD();
    var p = e.target.closest('[data-pick]'); if (p) choose(p.dataset.pick, p.dataset.name);
    if (e.target.closest('[data-clear-recent]')) { try { localStorage.removeItem(KEY_RECENT); } catch (x) {} renderPicks(); }
  });

  // ================================================================ tabs + routing
  function setTab(tab) {
    S.tab = tab;
    $('#tab-analyze').setAttribute('aria-selected', tab === 'analyze'); $('#tab-compare').setAttribute('aria-selected', tab === 'compare');
    $('#panel-analyze').hidden = tab !== 'analyze'; $('#panel-compare').hidden = tab !== 'compare';
    q.placeholder = tab === 'compare' ? 'Add a stock to compare, e.g. TCS, Apple, Samsung' : 'Search a company or symbol, e.g. Reliance, Apple, Toyota';
  }
  function go(kind, syms) {
    var h = '#' + kind + '=' + syms.map(encodeURIComponent).join(',');
    if (kind === 'c' && !syms.length) h = '#c=';
    if (location.hash === h) route(); else location.hash = h;
  }
  $('#tab-analyze').addEventListener('click', function () { if (S.sym) go('s', [S.sym]); else { setTab('analyze'); history.replaceState(null, '', location.pathname + location.search); renderEmpty(); } });
  $('#tab-compare').addEventListener('click', function () {
    if (!S.cmp.length && S.sym) S.cmp = [S.sym];
    go('c', S.cmp);
  });
  function parseHash() {
    var h = location.hash.slice(1), o = {};
    h.split('&').forEach(function (kv) { var i = kv.indexOf('='); if (i > 0) o[kv.slice(0, i)] = kv.slice(i + 1); });
    return o;
  }
  function route() {
    var o = parseHash();
    if (o.c != null) {
      setTab('compare');
      var list = []; o.c.split(',').forEach(function (s) { s = decodeURIComponent(s).trim().toUpperCase(); if (s && list.indexOf(s) < 0 && list.length < 4) list.push(s); });
      S.cmp = list; renderCompare();
    } else if (o.s) {
      setTab('analyze'); analyze(decodeURIComponent(o.s).trim().toUpperCase());
    } else { setTab('analyze'); renderEmpty(); }
    $('#cmp-cnt').textContent = S.cmp.length;
  }
  window.addEventListener('hashchange', route);

  // ================================================================ analyze view
  var out = $('#an-out');
  function renderEmpty() {
    S.sym = null;
    out.innerHTML = '<div class="gw-card an-empty"><div class="big">🔎</div><h3>Pick a stock to analyze</h3><p>Search any company above, or tap a quick pick. You will get price trends, returns, technicals, fundamentals, analyst targets, an AI scorecard and 12-month scenarios — all in the stock’s own currency.</p></div>';
  }
  function loadingCard(title) {
    return '<div class="gw-card"><div class="an-load"><span class="gw-spin dark"></span><div><b>' + title + '</b><span data-load-msg>Fetching 5 years of prices…</span></div></div><div class="an-skel" style="width:90%"></div><div class="an-skel" style="width:70%"></div><div class="an-skel" style="width:80%"></div></div>';
  }
  var LOAD_MSGS = ['Fetching 5 years of prices…', 'Reading fundamentals and analyst views…', 'Computing technicals and scores…', 'Collecting the latest news…', 'Almost there…'];
  function cycleMsgs(root, my, cur) {
    var i = 0, t = setInterval(function () {
      var el = $('[data-load-msg]', root); if (!el || my !== cur()) { clearInterval(t); return; }
      i = Math.min(i + 1, LOAD_MSGS.length - 1); el.textContent = LOAD_MSGS[i];
    }, 2600);
  }
  function errorCard(msg, retry) {
    return '<div class="gw-card an-error"><div class="big">😕</div><div><b>We couldn’t load this stock</b><p class="muted">' + esc(msg) + '</p>' + (retry ? '<button class="gw-btn sm ghost" style="margin-top:10px" type="button" data-retry="' + esc(retry) + '">Try again</button>' : '') + '</div></div>';
  }
  out.addEventListener('click', function (e) {
    var r = e.target.closest('[data-retry]'); if (r) { delete S.cache[r.dataset.retry]; S.sym = null; analyze(r.dataset.retry); }
  });

  function analyze(sym) {
    if (S.sym === sym && out.querySelector('.an-head')) { return; }
    S.sym = sym; var my = ++S.req;
    out.innerHTML = loadingCard('Analyzing ' + esc(sym) + '…');
    cycleMsgs(out, my, function () { return S.req; });
    load(sym).then(function (m) {
      if (my !== S.req) return;
      addRecent(sym, m.short || m.name);
      out.innerHTML = analysisHtml(m);
      drawPrice(m);
      document.title = m.short + ' (' + m.sym + ') · Stock Analyzer';
    }).catch(function (e) { if (my === S.req) { out.innerHTML = errorCard(e.message, sym); S.sym = null; } });
  }

  function stat(lbl, val, cls) { return '<div class="an-stat' + (cls ? ' ' + cls : '') + '"><span>' + lbl + '</span><b>' + val + '</b></div>'; }
  function kv(lbl, val, title) { return '<div' + (title ? ' title="' + esc(title) + '"' : '') + '><span>' + lbl + '</span><b>' + val + '</b></div>'; }
  function seg(id, cur) { return '<div class="an-seg" role="group" aria-label="Chart range" data-seg="' + id + '">' + RANGES.map(function (r) { return '<button type="button" data-r="' + r[0] + '" aria-pressed="' + (r[0] === cur) + '">' + r[0] + '</button>'; }).join('') + '</div>'; }

  function analysisHtml(m) {
    var F = m.fund, T = m.tech, R = m.ret, A = m.an, cur = m.cur, inCmp = S.cmp.indexOf(m.sym) >= 0;
    var pos = ok(T.pos52) ? clamp(T.pos52, 0, 1) * 100 : 50;
    var h = '';
    // header
    h += '<div class="gw-card an-head"><div>' +
      '<h1 class="an-name">' + esc(m.name) + '</h1>' +
      '<div class="an-tags"><span class="gw-chip indigo num">' + esc(m.sym) + '</span>' + (m.exch ? '<span class="gw-chip">' + esc(m.exch) + '</span>' : '') +
      (m.sector ? '<span class="gw-chip pink">' + esc(m.sector) + '</span>' : '') + (m.industry ? '<span class="gw-chip amber">' + esc(m.industry) + '</span>' : '') + (m.country ? '<span class="gw-chip">' + esc(m.country) + '</span>' : '') + '</div>' +
      '<div class="an-price"><span class="p num">' + money(m.price, cur) + '</span><span class="gw-chip ' + (m.chg >= 0 ? 'green' : 'red') + ' num">' + (m.chg >= 0 ? '▲ ' : '▼ ') + money(Math.abs(m.chg), cur) + ' (' + pct(m.chgPct, 2, true) + ')</span></div>' +
      '<div class="an-time">Last price ' + esc(dateFmt(m.time, m.tz, true)) + ' · in ' + esc(mainCur(cur)) + (SUBUNIT[cur] ? ' (quoted in ' + esc(SUBUNIT[cur].s.trim()) + ')' : '') + '</div>' +
      '<div class="an-acts"><button class="gw-btn sm" type="button" data-addcmp="' + esc(m.sym) + '"' + (inCmp ? ' disabled' : '') + '>' + (inCmp ? '✓ In compare list' : '⚖️ Add to compare') + '</button><button class="gw-btn sm ghost" type="button" data-share>🔗 Copy link</button></div>' +
      '</div><div class="an-stats">' +
      stat('Market cap', big(m.mcap, cur)) + stat('Day range', ok(m.dayLo) ? money(m.dayLo, cur) + ' – ' + money(m.dayHi, cur) : '–') +
      stat('Volume', ok(m.vol) ? nf(locOf(cur), { notation: cur === 'INR' ? 'standard' : 'compact', maximumFractionDigits: 1 }).format(m.vol) : '–') + stat('Prev close', money(m.prev, cur)) +
      '<div class="an-stat full"><span>52-week range · ' + (ok(T.pos52) ? Math.round(T.pos52 * 100) + '% of the way up' : '') + '</span><div class="an-range" role="img" aria-label="Price at ' + Math.round(pos) + '% of 52 week range"><i style="left:' + pos.toFixed(1) + '%"></i></div><div class="an-range-l"><span class="num">' + money(m.lo52, cur) + '</span><span class="num">' + money(m.hi52, cur) + '</span></div></div>' +
      '</div></div>';

    // chart
    h += '<div class="gw-card"><div class="an-ctop"><h2>📈 Price chart <span class="an-chg" id="pc-chg"></span></h2>' + seg('price', S.range) + '</div><div class="an-chart" id="pc"></div>' +
      '<div class="an-legend"><span><i id="pc-sw" style="background:var(--gw-up)"></i>Price</span><span style="color:#f59e0b"><i class="dash"></i>SMA 50</span><span style="color:#8b5cf6"><i class="dash"></i>SMA 200</span></div></div>';

    // verdict banner
    var circ = 2 * Math.PI * 50, ov = m.overall == null ? 0 : m.overall / 10;
    h += '<div class="gw-card an-verdict"><div class="an-ring"><svg viewBox="0 0 118 118" aria-hidden="true"><circle cx="59" cy="59" r="50" fill="none" stroke="rgba(255,255,255,.25)" stroke-width="11"/><circle cx="59" cy="59" r="50" fill="none" stroke="#fff" stroke-width="11" stroke-linecap="round" stroke-dasharray="' + (circ * ov).toFixed(1) + ' ' + circ.toFixed(1) + '"/></svg><div><span><b>' + num(m.overall, 1) + '</b><small>out of 10</small></span></div></div>' +
      '<div class="an-vtxt"><div class="lbl">AI verdict</div><div class="an-vbadge"><span class="v">' + m.verdict + '</span><span class="r">Risk: ' + m.risk + '</span><span class="r">' + esc(T.trend) + '</span></div><p>' + esc(m.summary) + '</p></div></div>';

    // scorecard + returns
    h += '<div class="gw-grid gw-g2"><div class="gw-card"><h2>🧠 AI Scorecard <span class="sub">rule-based, from the data below</span></h2>' +
      m.scores.map(function (s) {
        return '<div class="an-score"><div class="t"><span>' + s.name + '</span><b style="color:' + scoreColor(s.v) + '">' + (s.v == null ? '–' : num(s.v, 1)) + '<span class="muted" style="font-size:12px">/10</span></b></div><div class="an-bar"><i style="width:' + (s.v == null ? 0 : s.v * 10) + '%;background:' + scoreColor(s.v) + '"></i></div><p>' + esc(s.note) + '</p></div>';
      }).join('') +
      '<p class="gw-disc">Overall = average of the five scores. Buy ≥ 7 · Accumulate ≥ 5.8 · Hold ≥ 4.5 · else Avoid. Risk level from the Risk score.</p></div>';
    var rets = [['1W', R.w1], ['1M', R.m1], ['3M', R.m3], ['6M', R.m6], ['YTD', R.ytd], ['1Y', R.y1], ['3Y CAGR', R.y3], ['5Y CAGR', R.y5]];
    h += '<div class="an-col"><div class="gw-card"><h2>🚀 Returns <span class="sub">dividend-adjusted, in ' + esc(mainCur(cur)) + '</span></h2><div class="an-rets">' +
      rets.map(function (r) { return '<div class="an-ret ' + (ok(r[1]) ? (r[1] >= 0 ? 'pos' : 'neg') : '') + '"><span>' + r[0] + '</span><b class="num">' + pct(r[1], 1, true) + '</b></div>'; }).join('') + '</div>' +
      '</div>';

    // pros / cons
    h += '<div class="gw-card"><h2>💪 Strengths</h2><ul class="an-list pro">' + m.pros.map(function (x) { return '<li><i><svg width="12" height="12" viewBox="0 0 12 12" aria-hidden="true"><path d="M2.5 6.3l2.3 2.3 4.7-5" fill="none" stroke="#fff" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg></i><span>' + esc(x) + '</span></li>'; }).join('') + '</ul></div>' +
      '<div class="gw-card"><h2>⚠️ Risks</h2><ul class="an-list con">' + m.cons.map(function (x) { return '<li><i>!</i><span>' + esc(x) + '</span></li>'; }).join('') + '</ul></div></div></div>';

    // scenarios detail
    h += '<div class="gw-card"><h2>🎯 12-month scenarios <span class="sub">from today’s ' + money(m.price, cur) + '</span></h2><div class="an-scen">' +
      m.scen.map(function (s) { return '<div class="an-sc ' + s.k + '"><span>' + s.name + '</span><b class="num">' + money(s.p, cur) + '</b><em class="num">' + pct(s.chg, 1, true) + '</em><p>' + esc(s.txt) + '</p></div>'; }).join('') +
      '</div></div>';

    // technicals + fundamentals
    function vs(ma) { return ok(ma) ? money(ma, cur) + ' <small class="' + (m.price >= ma ? 'up' : 'dn') + '">' + (m.price >= ma ? '▲ ' : '▼ ') + pct(Math.abs(m.price / ma - 1), 1) + '</small>' : '–'; }
    var rsiTxt = ok(T.rsi) ? num(T.rsi, 0) + ' <small class="' + (T.rsi > 70 ? 'dn' : T.rsi < 30 ? 'dn' : 'muted') + '">' + (T.rsi > 70 ? 'overbought' : T.rsi < 30 ? 'oversold' : T.rsi >= 50 ? 'positive' : 'neutral') + '</small>' : '–';
    var macdTxt = ok(T.macdHist) ? '<span class="' + (T.macdHist > 0 ? 'up' : 'dn') + '">' + (T.macdHist > 0 ? 'Bullish' : 'Bearish') + '</span>' + (T.macdCross ? ' <small class="muted">' + esc(T.macdCross) + '</small>' : '') : '–';
    var lad = '';
    T.res.slice().reverse().forEach(function (x, i) { lad += '<div class="res"><span>Resistance R' + (T.res.length - i) + '</span><span class="num">' + money(x, cur) + ' <small>' + pct(x / m.price - 1, 1, true) + '</small></span></div>'; });
    lad += '<div class="now"><span>Current price</span><span class="num">' + money(m.price, cur) + '</span></div>';
    T.sup.forEach(function (x, i) { lad += '<div class="sup"><span>Support S' + (i + 1) + '</span><span class="num">' + money(x, cur) + ' <small>' + pct(x / m.price - 1, 1, true) + '</small></span></div>'; });
    h += '<div class="gw-grid gw-g2"><div class="gw-card"><h2>📐 Technicals <span class="gw-chip ' + T.tone + '">' + esc(T.trend) + '</span></h2><div class="an-kv">' +
      kv('SMA 20', vs(T.sma20)) + kv('SMA 50', vs(T.sma50)) + kv('SMA 200', vs(T.sma200)) + kv('RSI (14)', rsiTxt) + kv('MACD (12,26,9)', macdTxt) +
      kv('52W position', ok(T.pos52) ? Math.round(T.pos52 * 100) + '%' : '–') + kv('Volatility (1Y)', pct(T.vol, 0)) + kv('Beta', ratio(F.beta, 2)) +
      kv('Max drawdown 1Y', '<span class="dn">' + pct(T.dd1, 1) + '</span>') + kv('Max drawdown 5Y', '<span class="dn">' + pct(T.dd5, 1) + '</span>') +
      '</div><div class="an-h3">Support &amp; resistance</div><div class="an-sr">' + lad + '</div></div>';
    var fcfTxt = ok(F.fcf) ? big(F.fcf, F.finCur) + (mainCur(F.finCur) !== mainCur(cur) ? ' <small class="muted">(' + esc(F.finCur) + ')</small>' : '') : '–';
    h += '<div class="gw-card"><h2>🏦 Fundamentals</h2><div class="an-kv">' +
      kv('P/E (TTM)', ratio(F.pe, 1, 'x')) + kv('Forward P/E', ratio(F.fpe, 1, 'x')) + kv('Price / Book', ratio(F.pb, 2, 'x')) + kv('PEG', ratio(F.peg, 2)) +
      kv('EV / EBITDA', ratio(F.ev, 1, 'x')) + kv('Dividend yield', pct(F.dy, 2)) + kv('ROE', pct(F.roe, 1)) + kv('Profit margin', pct(F.margin, 1)) +
      kv('Revenue growth', pctHtml(F.revG)) + kv('Earnings growth', pctHtml(F.earnG)) + kv('Debt / Equity', ratio(F.de, 2, 'x')) + kv('Current ratio', ratio(F.cr, 2)) +
      kv('Free cash flow', fcfTxt) + kv('Market cap', big(m.mcap, cur)) +
      '</div><p class="gw-disc">Growth is latest quarter vs a year ago. “–” means the figure is not available.</p></div></div>';

    // analyst + profile
    var ah = '<div class="gw-card"><h2>🧑‍💼 Analyst view</h2>';
    if (A.key || ok(A.mean) || A.trend) {
      var lbl = A.key ? A.key.replace(/_/g, ' ').replace(/\b\w/g, function (x) { return x.toUpperCase(); }) : '–';
      var tone = /buy/i.test(A.key) ? 'green' : /sell|under/i.test(A.key) ? 'red' : 'amber';
      ah += '<div class="an-rec"><span class="big">' + esc(lbl) + '</span><span class="gw-chip ' + tone + '">' + (ok(A.n) ? A.n + ' analysts' : 'consensus') + '</span>' + (ok(A.score) ? '<span class="muted" style="font-size:13px">Score ' + num(A.score, 2) + ' (1 = strong buy, 5 = sell)</span>' : '') + '</div>';
      if (ok(A.mean)) {
        var lo = Math.min(A.lo || A.mean, m.price), hi = Math.max(A.hi || A.mean, m.price), sp = hi - lo || 1;
        var px = function (v) { return clamp((v - lo) / sp * 100, 0, 100).toFixed(1) + '%'; };
        ah += '<div class="an-kv k3" style="margin-top:12px">' + kv('Target low', money(A.lo, cur) + ' <small class="' + (A.lo >= m.price ? 'up' : 'dn') + '">' + pct(ok(A.lo) ? A.lo / m.price - 1 : null, 0, true) + '</small>') +
          kv('Target mean', money(A.mean, cur) + ' <small class="' + (A.upside >= 0 ? 'up' : 'dn') + '">' + pct(A.upside, 0, true) + '</small>') +
          kv('Target high', money(A.hi, cur) + ' <small class="up">' + pct(ok(A.hi) ? A.hi / m.price - 1 : null, 0, true) + '</small>') + '</div>';
        ah += '<div class="an-tgt" aria-hidden="true"><div class="ln"></div>' + (ok(A.lo) ? '<div class="mk" style="left:' + px(A.lo) + '"><i></i></div>' : '') + (ok(A.hi) ? '<div class="mk" style="left:' + px(A.hi) + '"><i></i></div>' : '') +
          '<div class="mk mean" style="left:' + px(A.mean) + '"><small style="color:var(--gw-indigo)">Target</small><i></i></div><div class="mk" style="left:' + px(m.price) + '"><i style="background:var(--gw-pink);width:6px"></i></div></div>' +
          '<div class="an-stk-l" style="justify-content:center"><span><i style="background:var(--gw-pink)"></i>Price now</span><span><i style="background:var(--gw-indigo)"></i>Mean target</span><span><i style="background:var(--gw-ink)"></i>Low / high target</span></div>';
      }
      if (A.trend && A.trend.some(function (x) { return x > 0; })) {
        var tot = A.trend.reduce(function (s, x) { return s + x; }, 0), cols = ['#0f8a3c', '#4ade80', '#fbbf24', '#fb923c', '#ef4444'], nm = ['Strong buy', 'Buy', 'Hold', 'Sell', 'Strong sell'];
        ah += '<div class="an-h3">Recommendation trend</div><div class="an-stack" role="img" aria-label="Analyst ratings">' + A.trend.map(function (x, i) { return x ? '<i style="width:' + (x / tot * 100).toFixed(1) + '%;background:' + cols[i] + '" title="' + nm[i] + ': ' + x + '"></i>' : ''; }).join('') + '</div>' +
          '<div class="an-stk-l">' + A.trend.map(function (x, i) { return '<span><i style="background:' + cols[i] + '"></i>' + nm[i] + ' <b>' + x + '</b></span>'; }).join('') + '</div>';
      }
    } else ah += '<p class="muted">No analyst coverage is available for this stock.</p>';
    ah += '</div>';
    var about = m.about || '', cut = about.length > 420;
    var ph = '<div class="gw-card"><h2>🏢 Company profile</h2>' +
      (about ? '<p class="an-about" data-full="' + esc(about) + '">' + esc(cut ? about.slice(0, 400).replace(/\s+\S*$/, '') + '…' : about) + (cut ? ' <button class="an-more" type="button" data-more>Read more</button>' : '') + '</p>' : '<p class="muted">No company description available.</p>') +
      '<div class="an-kv" style="margin-top:14px">' + kv('Sector', esc(m.sector || '–')) + kv('Industry', esc(m.industry || '–'), m.industry) + kv('Employees', ok(m.employees) ? nf(locOf(cur), {}).format(m.employees) : '–') + kv('Country', esc(m.country || '–')) +
      kv('Next earnings', m.earnDate ? esc(dateFmt(m.earnDate, m.tz)) + (m.earnEst ? ' <small class="muted">(est.)</small>' : '') : '–') + kv('Ex-dividend', m.exDiv ? esc(dateFmt(m.exDiv, m.tz)) : '–') + '</div>' +
      (m.website ? '<p style="margin-top:12px"><a href="' + esc(m.website) + '" target="_blank" rel="noopener noreferrer">🌐 ' + esc(m.website.replace(/^https?:\/\/(www\.)?/, '').replace(/\/$/, '')) + '</a></p>' : '') + '</div>';
    h += '<div class="gw-grid gw-g2">' + ah + ph + '</div>';

    // news
    h += '<div class="gw-card"><h2>📰 Latest news</h2>' + (m.news.length ? '<ul class="an-news">' + m.news.map(function (x) {
      return '<li><a href="' + esc(x.url) + '" target="_blank" rel="noopener noreferrer">' + esc(x.title) + '</a><small>' + esc(x.src || '') + (x.ts ? ' · ' + esc(ago(x.ts)) : '') + '</small></li>';
    }).join('') + '</ul>' : '<p class="muted">No recent news found for this stock.</p>') + '</div>';

    h += '<div class="an-discl">⚠️ Not investment advice. Scores, verdicts and scenarios are automatic, rule-based summaries of public market data for education only. Data may be delayed or incomplete. Please do your own research or consult a registered adviser before investing.</div>';
    return h;
  }

  out.addEventListener('click', function (e) {
    var b = e.target.closest('[data-addcmp]');
    if (b) { addCompare(b.dataset.addcmp, true); b.disabled = true; b.textContent = '✓ In compare list'; GW.toast('Added to compare (' + S.cmp.length + '/4)'); }
    if (e.target.closest('[data-share]')) GW.copy(location.href, 'Link copied');
    var mo = e.target.closest('[data-more]');
    if (mo) { var p = mo.parentNode; p.textContent = p.dataset.full; }
  });
  document.addEventListener('click', function (e) {
    var b = e.target.closest('[data-seg] button'); if (!b) return;
    var sg = b.parentNode, id = sg.dataset.seg;
    $$('button', sg).forEach(function (x) { x.setAttribute('aria-pressed', x === b); });
    if (id === 'price') { S.range = b.dataset.r; var m = S.charts.price; if (m) drawPrice(m); }
    else { S.cmpRange = b.dataset.r; drawCompare(); }
  });

  // ================================================================ SVG chart engine
  var NS = 'http://www.w3.org/2000/svg';
  function niceTicks(min, max, count) {
    var span = max - min || Math.abs(max) || 1, raw = span / count, mag = Math.pow(10, Math.floor(Math.log10(raw))), st = [1, 2, 2.5, 5, 10].map(function (x) { return x * mag; }).filter(function (x) { return x >= raw; })[0];
    var out = [], v = Math.ceil(min / st) * st; for (; v <= max + st * 1e-6; v += st) out.push(+v.toFixed(10)); return out;
  }
  // series: [{ys:[], xs:[], color, width, dash, fill}] ; opts: {x0,x1,labelX(x), fmtY(v), tip(x) -> html, hoverXs:[] }
  function chart(el, series, opts) {
    var W = Math.max(280, el.clientWidth), H = W < 520 ? 230 : 320, padL = 8, padR = W < 520 ? 52 : 64, padT = 14, padB = 26;
    var ymin = Infinity, ymax = -Infinity;
    series.forEach(function (s) { s.ys.forEach(function (y) { if (ok(y)) { if (y < ymin) ymin = y; if (y > ymax) ymax = y; } }); });
    if (!isFinite(ymin)) { el.innerHTML = '<p class="muted">No data for this range.</p>'; return; }
    var pad = (ymax - ymin) * 0.08 || ymax * 0.02 || 1; ymin -= pad; ymax += pad;
    var X = function (x) { return padL + (x - opts.x0) / ((opts.x1 - opts.x0) || 1) * (W - padL - padR); };
    var Y = function (y) { return padT + (1 - (y - ymin) / (ymax - ymin)) * (H - padT - padB); };
    var s = '<svg viewBox="0 0 ' + W + ' ' + H + '" height="' + H + '" role="img" aria-label="' + esc(opts.label || 'Chart') + '"><defs>';
    series.forEach(function (sr, i) { if (sr.fill) s += '<linearGradient id="g' + opts.id + i + '" x1="0" x2="0" y1="0" y2="1"><stop offset="0" stop-color="' + sr.color + '" stop-opacity=".28"/><stop offset="1" stop-color="' + sr.color + '" stop-opacity="0"/></linearGradient>'; });
    s += '</defs>';
    niceTicks(ymin, ymax, W < 520 ? 4 : 5).forEach(function (v) {
      var y = Y(v); if (y < padT - 1 || y > H - padB + 1) return;
      s += '<line x1="' + padL + '" x2="' + (W - padR) + '" y1="' + y.toFixed(1) + '" y2="' + y.toFixed(1) + '" stroke="#e6e8f3" stroke-dasharray="3 4"/><text class="ax" x="' + (W - padR + 6) + '" y="' + (y + 4).toFixed(1) + '">' + esc(opts.fmtY(v)) + '</text>';
    });
    var nl = W < 520 ? 3 : 5;
    for (var i = 0; i <= nl; i++) {
      var xv = opts.x0 + (opts.x1 - opts.x0) * i / nl, xx = X(xv);
      s += '<text class="ax" x="' + xx.toFixed(1) + '" y="' + (H - 6) + '" text-anchor="' + (i === 0 ? 'start' : i === nl ? 'end' : 'middle') + '">' + esc(opts.labelX(xv)) + '</text>';
    }
    if (opts.base != null) s += '<line x1="' + padL + '" x2="' + (W - padR) + '" y1="' + Y(opts.base).toFixed(1) + '" y2="' + Y(opts.base).toFixed(1) + '" stroke="#94a3b8" stroke-width="1"/>';
    series.forEach(function (sr, si) {
      var d = '', first = null, lastX = null, started = false;
      for (var k = 0; k < sr.ys.length; k++) {
        if (!ok(sr.ys[k])) { started = false; continue; }
        var px = X(sr.xs[k]).toFixed(1), py = Y(sr.ys[k]).toFixed(1);
        d += (started ? 'L' : 'M') + px + ' ' + py; started = true; if (first == null) first = px; lastX = px;
      }
      if (!d) return;
      if (sr.fill) s += '<path d="' + d + 'L' + lastX + ' ' + (H - padB) + 'L' + first + ' ' + (H - padB) + 'Z" fill="url(#g' + opts.id + si + ')"/>';
      s += '<path d="' + d + '" fill="none" stroke="' + sr.color + '" stroke-width="' + (sr.width || 2) + '" stroke-linejoin="round" stroke-linecap="round"' + (sr.dash ? ' stroke-dasharray="' + sr.dash + '"' : '') + '/>';
    });
    s += '<g data-hover style="display:none"><line data-vl y1="' + padT + '" y2="' + (H - padB) + '" stroke="#141532" stroke-opacity=".35" stroke-dasharray="3 3"/>' + series.map(function (sr, i) { return sr.dot === false ? '' : '<circle data-dot="' + i + '" r="4.5" fill="#fff" stroke="' + sr.color + '" stroke-width="2.5"/>'; }).join('') + '</g>';
    s += '<rect x="' + padL + '" y="0" width="' + (W - padL - padR) + '" height="' + H + '" fill="transparent" data-ov/></svg><div class="an-tip"></div>';
    el.innerHTML = s;
    var svg = el.firstChild, g = $('[data-hover]', el), vl = $('[data-vl]', el), tip = $('.an-tip', el);
    function move(ev) {
      var r = svg.getBoundingClientRect(), mx = (ev.clientX - r.left) * W / r.width;
      var xv = opts.x0 + (mx - padL) / (W - padL - padR) * (opts.x1 - opts.x0);
      var hx = opts.snap(xv); if (hx == null) return;
      var px = X(hx.x); g.style.display = ''; vl.setAttribute('x1', px); vl.setAttribute('x2', px);
      series.forEach(function (sr, i) {
        var dot = $('[data-dot="' + i + '"]', el); if (!dot) return; var y = hx.ys[i];
        if (ok(y)) { dot.style.display = ''; dot.setAttribute('cx', X(hx.xs ? hx.xs[i] : hx.x)); dot.setAttribute('cy', Y(y)); } else dot.style.display = 'none';
      });
      tip.innerHTML = hx.html; tip.style.display = 'block';
      var tw = tip.offsetWidth, left = px * r.width / W + 14; if (left + tw > r.width) left = px * r.width / W - tw - 14;
      tip.style.left = Math.max(0, left) + 'px';
    }
    function leave() { g.style.display = 'none'; tip.style.display = 'none'; }
    svg.addEventListener('pointermove', move); svg.addEventListener('pointerdown', move); svg.addEventListener('pointerleave', leave);
  }
  function shortDate(sec, span) {
    var d = new Date(sec * 1000), mo = d.toLocaleString('en-GB', { month: 'short', timeZone: 'UTC' });
    return span > 400 * DAY ? mo + ' ’' + String(d.getUTCFullYear()).slice(2) : d.getUTCDate() + ' ' + mo;
  }
  function rangeDays(r) { for (var i = 0; i < RANGES.length; i++) if (RANGES[i][0] === r) return RANGES[i][1]; return 366; }
  function axisMoney(v, cur) {
    var sub = SUBUNIT[cur]; if (sub) return nf('en-GB', { maximumFractionDigits: v < 10 ? 2 : 0 }).format(v) + sub.s;
    var a = Math.abs(v), o = { maximumFractionDigits: a < 10 ? 2 : a < 1000 ? 1 : 0 };
    if (a >= 1e5) o.notation = 'compact';
    try { return nf(locOf(cur), Object.assign({ style: 'currency', currency: cur, currencyDisplay: 'narrowSymbol' }, o)).format(v); } catch (e) { return num(v, 0); }
  }

  function drawPrice(m) {
    S.charts.price = m;
    var el = $('#pc'); if (!el) return;
    var n = m.t.length, i0 = Math.max(0, idxAt(m.t, m.t[n - 1] - rangeDays(S.range) * DAY));
    if (S.range === '5Y') i0 = 0;
    var idx = []; for (var i = i0; i < n; i++) idx.push(i);
    var c = idx.map(function (i) { return m.c[i]; }), up = c[c.length - 1] >= c[0], col = up ? '#0f9d58' : '#e0393e';
    var chg = c[c.length - 1] / c[0] - 1, cg = $('#pc-chg');
    if (cg) { cg.className = 'an-chg ' + (up ? 'up' : 'dn'); cg.textContent = (chg >= 0 ? '▲ ' : '▼ ') + pct(chg, 1, true) + ' in ' + S.range; }
    var sw = $('#pc-sw'); if (sw) sw.style.background = col;
    var xs = idx.map(function (_, k) { return k; }), span = m.t[n - 1] - m.t[i0];
    var series = [
      { xs: xs, ys: c, color: col, width: 2.2, fill: true },
      { xs: xs, ys: idx.map(function (i) { return m.s50[i]; }), color: '#f59e0b', width: 1.6, dash: '5 4', dot: false },
      { xs: xs, ys: idx.map(function (i) { return m.s200[i]; }), color: '#8b5cf6', width: 1.6, dash: '5 4', dot: false }
    ];
    chart(el, series, {
      id: 'p', x0: 0, x1: xs.length - 1, label: m.name + ' price chart, ' + S.range,
      labelX: function (x) { return shortDate(m.t[idx[Math.round(x)]], span); },
      fmtY: function (v) { return axisMoney(v, m.cur); },
      snap: function (x) {
        var k = clamp(Math.round(x), 0, xs.length - 1), i = idx[k], fc = c[k] / c[0] - 1;
        return { x: k, ys: [c[k], null, null], html: '<b>' + esc(dateFmt(m.t[i], 'UTC')) + '</b><br>Close <b class="num">' + money(c[k], m.cur) + '</b> <span style="color:' + (fc >= 0 ? '#86efac' : '#fca5a5') + '">' + pct(fc, 1, true) + '</span>' +
          (ok(m.s50[i]) ? '<br><span class="sw" style="background:#f59e0b"></span>SMA50 ' + money(m.s50[i], m.cur) : '') + (ok(m.s200[i]) ? '<br><span class="sw" style="background:#8b5cf6"></span>SMA200 ' + money(m.s200[i], m.cur) : '') };
      }
    });
  }

  // ================================================================ compare
  var cmpOut = $('#cmp-out'), cmpData = {};
  function addCompare(sym, stay) {
    if (S.cmp.indexOf(sym) >= 0) { if (!stay) GW.toast(sym + ' is already in the list'); return; }
    if (S.cmp.length >= 4) { GW.toast('You can compare up to 4 stocks. Remove one first.'); return; }
    S.cmp.push(sym); $('#cmp-cnt').textContent = S.cmp.length;
    if (!stay) go('c', S.cmp);
  }
  $('#cmp-chips').addEventListener('click', function (e) {
    var b = e.target.closest('[data-rm]'); if (!b) return;
    S.cmp = S.cmp.filter(function (x) { return x !== b.dataset.rm; }); go('c', S.cmp);
  });
  function renderChips() {
    $('#cmp-chips').innerHTML = S.cmp.map(function (s, i) {
      var d = cmpData[s];
      return '<span class="an-cchip' + (d && d.err ? ' err' : '') + '" style="--c:' + CMP_COLORS[i] + '"><i></i>' + esc(d && d.m ? d.m.short : s) + ' <small>' + esc(s) + '</small>' + (!d ? '<span class="gw-spin dark"></span>' : '') + '<button type="button" data-rm="' + esc(s) + '" aria-label="Remove ' + esc(s) + '">×</button></span>';
    }).join('') || '<span class="muted">No stocks added yet.</span>';
    $('#cmp-hint').textContent = S.cmp.length < 4 ? 'Use the search box above or the quick picks to add ' + (S.cmp.length < 2 ? (2 - S.cmp.length) + ' more stock' + (S.cmp.length === 1 ? '' : 's') + ' (up to 4).' : 'more stocks (up to 4).') : 'Maximum of 4 stocks reached.';
  }
  function renderCompare() {
    var my = ++S.cmpReq; cmpData = {};
    S.cmp.forEach(function (s) { if (S.cache[s]) S.cache[s].then(function (m) { cmpData[s] = { m: m }; }, function () {}); });
    renderChips();
    if (S.cmp.length < 2) {
      cmpOut.innerHTML = '<div class="gw-card an-empty"><div class="big">⚖️</div><h3>Add ' + (S.cmp.length ? 'one more stock' : 'two or more stocks') + '</h3><p>Compare up to 4 stocks from any country: performance rebased to 100, returns, risk, valuation, quality and our AI score — with the best value in each row highlighted.</p>' +
        '<div class="an-picks" style="justify-content:center;margin-top:14px"><button type="button" class="an-pick" data-try="INFY.NS,TCS.NS,AAPL">Try: Infosys vs TCS vs Apple</button><button type="button" class="an-pick" data-try="RELIANCE.NS,HDFCBANK.NS">Reliance vs HDFC Bank</button><button type="button" class="an-pick" data-try="AAPL,MSFT,NVDA">Apple vs Microsoft vs Nvidia</button></div></div>';
      S.cmp.forEach(function (s) { load(s).then(function (m) { if (my === S.cmpReq) { cmpData[s] = { m: m }; renderChips(); } }, function (e) { if (my === S.cmpReq) { cmpData[s] = { err: e.message }; renderChips(); } }); });
      return;
    }
    cmpOut.innerHTML = loadingCard('Comparing ' + S.cmp.map(esc).join(', ') + '…');
    cycleMsgs(cmpOut, my, function () { return S.cmpReq; });
    var list = S.cmp.slice();
    Promise.all(list.map(function (s) {
      return load(s).then(function (m) { cmpData[s] = { m: m }; }, function (e) { cmpData[s] = { err: e.message }; }).then(function () { if (my === S.cmpReq) renderChips(); });
    })).then(function () {
      if (my !== S.cmpReq) return;
      var good = list.filter(function (s) { return cmpData[s].m; });
      var bad = list.filter(function (s) { return cmpData[s].err; });
      var errs = bad.map(function (s) { return '<div class="gw-card an-error"><div class="big">😕</div><div><b>' + esc(s) + ' could not be loaded</b><p class="muted">' + esc(cmpData[s].err) + '</p><button class="gw-btn sm ghost" style="margin-top:10px" type="button" data-cretry="' + esc(s) + '">Try again</button></div></div>'; }).join('');
      if (good.length < 2) { cmpOut.innerHTML = errs + '<div class="gw-card an-empty"><h3>Need at least two stocks with data</h3><p>Remove the one that failed or add another stock.</p></div>'; return; }
      cmpOut.innerHTML = errs + compareHtml(good.map(function (s) { return cmpData[s].m; }));
      drawCompare();
    });
  }
  document.addEventListener('click', function (e) {
    var t = e.target.closest('[data-try]'); if (t) go('c', t.dataset.try.split(','));
    var r = e.target.closest('[data-cretry]'); if (r) renderCompare();
    var a = e.target.closest('[data-goan]'); if (a) go('s', [a.dataset.goan]);
  });
  function colorOf(sym) { return CMP_COLORS[S.cmp.indexOf(sym)] || '#64748b'; }

  function compareHtml(ms) {
    var curs = {}; ms.forEach(function (m) { curs[mainCur(m.cur)] = 1; });
    var multi = Object.keys(curs).length > 1;
    var h = '<div class="gw-card"><div class="an-ctop"><h2>📈 Performance <span class="sub">rebased to 100</span></h2>' + seg('cmp', S.cmpRange) + '</div><div class="an-chart" id="cc"></div><div class="an-legend" id="cc-leg"></div>' +
      (multi ? '<p class="an-note">These stocks trade in different currencies (' + Object.keys(curs).join(', ') + '). Prices and returns are shown in each stock’s local currency, without currency conversion.</p>' : '') + '</div>';
    // table rows: [label, fn(m) -> value, fmt(v, m), better: 'hi'|'lo'|'loPos'|null] — same parameters as the single-stock analysis
    function sc(k) { return function (m) { var s = (m.scores || []).filter(function (x) { return x.k === k; })[0]; return s ? s.v : null; }; }
    function scFmt(v) { return ok(v) ? '<b style="color:' + scoreColor(v) + '">' + num(v, 1) + '</b>/10' : '–'; }
    function scen(k) { return function (m) { var s = (m.scen || []).filter(function (x) { return x.k === k; })[0]; return s && ok(s.p) ? s : null; }; }
    function scenFmt(s, m) { return money(s.p, m.cur) + ' <small class="' + (s.chg >= 0 ? 'up' : 'dn') + '">' + pct(s.chg, 1, true) + '</small>'; }
    function vsMa(k) { return function (m) { var ma = m.tech[k]; return ok(ma) ? m.price / ma - 1 : null; }; }
    function vsMaFmt(k) { return function (v, m) { return money(m.tech[k], m.cur) + ' <small class="' + (v >= 0 ? 'up' : 'dn') + '">' + (v >= 0 ? '▲ ' : '▼ ') + pct(Math.abs(v), 1) + '</small>'; }; }
    function lvl(arr) { return function (m) { var x = m.tech[arr] && m.tech[arr][0]; return ok(x) ? x : null; }; }
    function lvlFmt(v, m) { return money(v, m.cur) + ' <small class="muted">' + pct(v / m.price - 1, 1, true) + '</small>'; }
    function anLbl(m) { var A = m.an; return A.key ? A.key.replace(/_/g, ' ').replace(/\b\w/g, function (x) { return x.toUpperCase(); }) : null; }
    function txt(v) { return esc(v); }
    var rows = [
      ['grp', 'Company'],
      ['Sector', function (m) { return m.sector || null; }, txt, null],
      ['Industry', function (m) { return m.industry || null; }, txt, null],
      ['Country', function (m) { return m.country || null; }, txt, null],
      ['Exchange', function (m) { return m.exch || null; }, txt, null],
      ['Employees', function (m) { return m.employees; }, function (v, m) { return nf(locOf(m.cur), {}).format(v); }, null],
      ['Next earnings', function (m) { return m.earnDate || null; }, function (v, m) { return esc(dateFmt(v, m.tz)) + (m.earnEst ? ' <small class="muted">(est.)</small>' : ''); }, null],
      ['Ex-dividend', function (m) { return m.exDiv || null; }, function (v, m) { return esc(dateFmt(v, m.tz)); }, null],
      ['grp', 'Price'],
      ['Price', function (m) { return m.price; }, function (v, m) { return money(v, m.cur); }, null],
      ['Day change', function (m) { return m.chgPct; }, pctHtmlPlain, 'hi'],
      ['Prev close', function (m) { return m.prev; }, function (v, m) { return money(v, m.cur); }, null],
      ['Day range', function (m) { return ok(m.dayLo) ? m.dayLo : null; }, function (v, m) { return money(m.dayLo, m.cur) + ' – ' + money(m.dayHi, m.cur); }, null],
      ['52W low', function (m) { return m.lo52; }, function (v, m) { return money(v, m.cur); }, null],
      ['52W high', function (m) { return m.hi52; }, function (v, m) { return money(v, m.cur); }, null],
      ['52W position', function (m) { return m.tech.pos52; }, function (v) { return Math.round(v * 100) + '%'; }, null],
      ['Volume', function (m) { return m.vol; }, function (v, m) { return nf(locOf(m.cur), { notation: m.cur === 'INR' ? 'standard' : 'compact', maximumFractionDigits: 1 }).format(v); }, null],
      ['grp', 'Returns'],
      ['1 week', function (m) { return m.ret.w1; }, pctHtmlPlain, 'hi'],
      ['1 month', function (m) { return m.ret.m1; }, pctHtmlPlain, 'hi'],
      ['3 months', function (m) { return m.ret.m3; }, pctHtmlPlain, 'hi'],
      ['6 months', function (m) { return m.ret.m6; }, pctHtmlPlain, 'hi'],
      ['YTD', function (m) { return m.ret.ytd; }, pctHtmlPlain, 'hi'],
      ['1 year', function (m) { return m.ret.y1; }, pctHtmlPlain, 'hi'],
      ['3Y CAGR', function (m) { return m.ret.y3; }, pctHtmlPlain, 'hi'],
      ['5Y CAGR', function (m) { return m.ret.y5; }, pctHtmlPlain, 'hi'],
      ['grp', 'Technicals'],
      ['Trend', function (m) { return m.tech.trend; }, function (v, m) { return '<span class="gw-chip ' + m.tech.tone + '">' + esc(v) + '</span>'; }, null],
      ['SMA 20', vsMa('sma20'), vsMaFmt('sma20'), null],
      ['SMA 50', vsMa('sma50'), vsMaFmt('sma50'), null],
      ['SMA 200', vsMa('sma200'), vsMaFmt('sma200'), null],
      ['RSI (14)', function (m) { return m.tech.rsi; }, function (v) { return num(v, 0) + ' <small class="' + (v > 70 || v < 30 ? 'dn' : 'muted') + '">' + (v > 70 ? 'overbought' : v < 30 ? 'oversold' : v >= 50 ? 'positive' : 'neutral') + '</small>'; }, null],
      ['MACD (12,26,9)', function (m) { return m.tech.macdHist; }, function (v, m) { return '<span class="' + (v > 0 ? 'up' : 'dn') + '">' + (v > 0 ? 'Bullish' : 'Bearish') + '</span>' + (m.tech.macdCross ? ' <small class="muted">' + esc(m.tech.macdCross) + '</small>' : ''); }, null],
      ['Nearest support', lvl('sup'), lvlFmt, null],
      ['Nearest resistance', lvl('res'), lvlFmt, null],
      ['grp', 'Risk'],
      ['Volatility (1Y)', function (m) { return m.tech.vol; }, function (v) { return pct(v, 0); }, 'lo'],
      ['Beta', function (m) { return m.fund.beta; }, function (v) { return ratio(v, 2); }, 'lo'],
      ['Max drawdown 1Y', function (m) { return m.tech.dd1; }, function (v) { return '<span class="dn">' + pct(v, 1) + '</span>'; }, 'hi'],
      ['Max drawdown 5Y', function (m) { return m.tech.dd5; }, function (v) { return '<span class="dn">' + pct(v, 1) + '</span>'; }, 'hi'],
      ['grp', 'Fundamentals'],
      ['Market cap', function (m) { return m.mcap; }, function (v, m) { return big(v, m.cur); }, null],
      ['P/E (TTM)', function (m) { return m.fund.pe; }, function (v) { return ratio(v, 1, 'x'); }, 'loPos'],
      ['Forward P/E', function (m) { return m.fund.fpe; }, function (v) { return ratio(v, 1, 'x'); }, 'loPos'],
      ['Price / Book', function (m) { return m.fund.pb; }, function (v) { return ratio(v, 2, 'x'); }, 'loPos'],
      ['PEG', function (m) { return m.fund.peg; }, function (v) { return ratio(v, 2); }, 'loPos'],
      ['EV / EBITDA', function (m) { return m.fund.ev; }, function (v) { return ratio(v, 1, 'x'); }, 'loPos'],
      ['Dividend yield', function (m) { return m.fund.dy; }, function (v) { return pct(v, 2); }, 'hi'],
      ['ROE', function (m) { return m.fund.roe; }, function (v) { return pct(v, 1); }, 'hi'],
      ['Profit margin', function (m) { return m.fund.margin; }, function (v) { return pct(v, 1); }, 'hi'],
      ['Revenue growth', function (m) { return m.fund.revG; }, pctHtmlPlain, 'hi'],
      ['Earnings growth', function (m) { return m.fund.earnG; }, pctHtmlPlain, 'hi'],
      ['Debt / Equity', function (m) { return m.fund.de; }, function (v) { return ratio(v, 2, 'x'); }, 'lo'],
      ['Current ratio', function (m) { return m.fund.cr; }, function (v) { return ratio(v, 2); }, 'hi'],
      ['Free cash flow', function (m) { return m.fund.fcf; }, function (v, m) { return big(v, m.fund.finCur); }, null],
      ['grp', 'Analyst view'],
      ['Rating', anLbl, txt, null],
      ['Analysts', function (m) { return m.an.n; }, function (v) { return num(v, 0); }, null],
      ['Rating score', function (m) { return m.an.score; }, function (v) { return num(v, 2) + ' <small class="muted">(1 = strong buy)</small>'; }, 'lo'],
      ['Target low', function (m) { return m.an.lo; }, function (v, m) { return money(v, m.cur); }, null],
      ['Target mean', function (m) { return m.an.mean; }, function (v, m) { return money(v, m.cur); }, null],
      ['Target high', function (m) { return m.an.hi; }, function (v, m) { return money(v, m.cur); }, null],
      ['Upside to mean', function (m) { return m.an.upside; }, pctHtmlPlain, 'hi'],
      ['grp', 'AI scorecard'],
      ['Fundamentals', sc('f'), scFmt, 'hi'],
      ['Valuation', sc('v'), scFmt, 'hi'],
      ['Technicals', sc('t'), scFmt, 'hi'],
      ['Growth', sc('g'), scFmt, 'hi'],
      ['Risk (higher = safer)', sc('r'), scFmt, 'hi'],
      ['Overall score', function (m) { return m.overall; }, function (v) { return '<b>' + num(v, 1) + '</b>/10'; }, 'hi'],
      ['Verdict', function (m) { return m.verdict; }, function (v) { return '<span class="gw-chip ' + verdictTone(v) + '">' + esc(v) + '</span>'; }, null],
      ['Risk level', function (m) { return m.risk; }, function (v) { return '<span class="gw-chip ' + riskTone(v) + '">' + esc(v) + '</span>'; }, null],
      ['grp', '12-month scenarios'],
      ['Bull case', scen('bull'), scenFmt, null],
      ['Base case', scen('base'), scenFmt, null],
      ['Bear case', scen('bear'), scenFmt, null]
    ];
    h += '<div class="gw-card"><h2>📋 Side by side <span class="sub">best in each row in green</span></h2><div class="gw-tbl-wrap"><table class="gw-tbl an-ctbl"><thead><tr><th>Metric</th>' +
      ms.map(function (m) { return '<th class="sym"><i style="background:' + colorOf(m.sym) + '"></i>' + esc(m.short) + '<br><span class="muted num" style="font-size:11px">' + esc(m.sym) + ' · ' + esc(mainCur(m.cur)) + '</span></th>'; }).join('') + '</tr></thead><tbody>';
    rows.forEach(function (r) {
      if (r[0] === 'grp') { h += '<tr class="grp"><td colspan="' + (ms.length + 1) + '">' + r[1] + '</td></tr>'; return; }
      var vals = ms.map(r[1]), best = null;
      if (r[3]) {
        var cand = vals.map(function (v, i) { return [v, i]; }).filter(function (x) { return typeof x[0] === 'number' && ok(x[0]) && (r[3] !== 'loPos' || x[0] > 0); });
        if (cand.length >= 2) { cand.sort(function (a, b) { return r[3] === 'hi' ? b[0] - a[0] : a[0] - b[0]; }); if (cand[0][0] !== cand[1][0]) best = cand[0][1]; }
      }
      h += '<tr><td>' + r[0] + '</td>' + vals.map(function (v, i) { return '<td class="r num' + (i === best ? ' best' : '') + '">' + (v == null || (typeof v === 'number' && !ok(v)) ? '<span class="muted">–</span>' : r[2](v, ms[i])) + '</td>'; }).join('') + '</tr>';
    });
    h += '</tbody></table></div><div class="an-picks" style="margin-top:12px"><span class="lb">Full analysis</span>' + ms.map(function (m) { return '<button type="button" class="an-pick" data-goan="' + esc(m.sym) + '">' + esc(m.short) + ' →</button>'; }).join('') + '</div></div>';

    // strengths, risks and news for each stock, side by side
    var g = 'gw-grid ' + (ms.length >= 4 ? 'gw-g4' : ms.length === 3 ? 'gw-g3' : 'gw-g2');
    function colHead(m) { return '<h2 class="an-chd"><i style="background:' + colorOf(m.sym) + '"></i>' + esc(m.short) + '</h2>'; }
    h += '<div class="gw-card"><h2>💪 Strengths &amp; ⚠️ risks</h2><div class="' + g + '">' + ms.map(function (m) {
      return '<div class="an-ccol">' + colHead(m) +
        '<ul class="an-list pro">' + (m.pros || []).map(function (x) { return '<li><i><svg width="12" height="12" viewBox="0 0 12 12" aria-hidden="true"><path d="M2.5 6.3l2.3 2.3 4.7-5" fill="none" stroke="#fff" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg></i><span>' + esc(x) + '</span></li>'; }).join('') + '</ul>' +
        '<ul class="an-list con" style="margin-top:10px">' + (m.cons || []).map(function (x) { return '<li><i>!</i><span>' + esc(x) + '</span></li>'; }).join('') + '</ul></div>';
    }).join('') + '</div></div>';
    h += '<div class="gw-card"><h2>📰 Latest news</h2><div class="' + g + '">' + ms.map(function (m) {
      var n = (m.news || []).slice(0, 4);
      return '<div class="an-ccol">' + colHead(m) + (n.length ? '<ul class="an-news">' + n.map(function (x) {
        return '<li><a href="' + esc(x.url) + '" target="_blank" rel="noopener noreferrer">' + esc(x.title) + '</a><small>' + esc(x.src || '') + (x.ts ? ' · ' + esc(ago(x.ts)) : '') + '</small></li>';
      }).join('') + '</ul>' : '<p class="muted">No recent news.</p>') + '</div>';
    }).join('') + '</div></div>';

    // summary
    function top(fn, dir, filt) {
      var c = ms.filter(function (m) { var v = fn(m); return ok(v) && (!filt || filt(v)); });
      if (c.length < 2) return null;
      c.sort(function (a, b) { return dir === 'hi' ? fn(b) - fn(a) : fn(a) - fn(b); }); return c[0];
    }
    var lines = [], x;
    if ((x = top(function (m) { return m.ret.y1; }, 'hi'))) lines.push('<b>' + esc(x.short) + '</b> has the strongest 1-year return (' + pct(x.ret.y1, 1, true) + ').');
    if ((x = top(function (m) { return m.ret.y5; }, 'hi'))) lines.push('<b>' + esc(x.short) + '</b> compounded fastest over 5 years (' + pct(x.ret.y5, 1) + ' a year).');
    if ((x = top(function (m) { return m.fund.pe; }, 'lo', function (v) { return v > 0; }))) lines.push('<b>' + esc(x.short) + '</b> is the cheapest on P/E (' + num(x.fund.pe, 1) + 'x).');
    if ((x = top(function (m) { return m.fund.roe; }, 'hi'))) lines.push('<b>' + esc(x.short) + '</b> has the highest return on equity (' + pct(x.fund.roe, 0) + ').');
    if ((x = top(function (m) { return m.tech.vol; }, 'lo'))) lines.push('<b>' + esc(x.short) + '</b> is the least volatile (' + pct(x.tech.vol, 0) + ' a year).');
    if ((x = top(function (m) { return m.an.upside; }, 'hi'))) lines.push('Analysts see the most upside in <b>' + esc(x.short) + '</b> (' + pct(x.an.upside, 0, true) + ' to target).');
    if ((x = top(function (m) { return m.overall; }, 'hi'))) lines.push('Overall, <b>' + esc(x.short) + '</b> scores best: ' + num(x.overall, 1) + '/10 (' + x.verdict + ', ' + x.risk.toLowerCase() + ' risk).');
    h += '<div class="gw-card"><h2>🧠 AI summary</h2><ul class="an-sum">' + lines.map(function (l) { return '<li>' + l + '</li>'; }).join('') + '</ul>' +
      (multi ? '<p class="an-note">Returns are in each stock’s local currency (' + Object.keys(curs).join(', ') + '); currency moves are not included.</p>' : '') + '</div>';
    h += '<div class="an-discl">⚠️ Not investment advice. Comparisons and scores are automatic, rule-based summaries of public market data for education only. Please do your own research before investing.</div>';
    S.cmpMs = ms;
    return h;
  }
  function pctHtmlPlain(v) { return ok(v) ? '<span class="' + (v > 0 ? 'up' : v < 0 ? 'dn' : '') + '">' + pct(v, 1, true) + '</span>' : '–'; }

  function drawCompare() {
    var el = $('#cc'), ms = S.cmpMs; if (!el || !ms) return;
    var tEnd = Math.max.apply(null, ms.map(function (m) { return m.t[m.t.length - 1]; }));
    var tStart = tEnd - rangeDays(S.cmpRange) * DAY;
    if (S.cmpRange === '5Y') tStart = Math.max(tStart, Math.max.apply(null, ms.map(function (m) { return m.t[0]; })));
    var series = ms.map(function (m) {
      var i0 = Math.max(0, idxAt(m.t, tStart)); if (m.t[i0] < tStart && i0 + 1 < m.t.length) i0 = i0 + 1;
      var b = m.ac[i0], xs = [], ys = [];
      for (var i = i0; i < m.t.length; i++) { xs.push(m.t[i]); ys.push(m.ac[i] / b * 100); }
      return { xs: xs, ys: ys, color: colorOf(m.sym), width: 2.2, m: m };
    });
    var x0 = Math.min.apply(null, series.map(function (s) { return s.xs[0]; }));
    $('#cc-leg').innerHTML = series.map(function (s) {
      var last = s.ys[s.ys.length - 1] / 100 - 1;
      return '<span><i style="background:' + s.color + '"></i>' + esc(s.m.short) + ' <span class="num ' + (last >= 0 ? 'up' : 'dn') + '">' + pct(last, 1, true) + '</span></span>';
    }).join('');
    chart(el, series, {
      id: 'c', x0: x0, x1: tEnd, base: 100, label: 'Rebased performance comparison, ' + S.cmpRange,
      labelX: function (x) { return shortDate(x, tEnd - x0); },
      fmtY: function (v) { return num(v, 0); },
      snap: function (x) {
        var ys = [], xs = [], rows = [];
        series.forEach(function (s) {
          var i = idxAt(s.xs, x); if (i < 0) i = 0;
          if (i + 1 < s.xs.length && Math.abs(s.xs[i + 1] - x) < Math.abs(s.xs[i] - x)) i++;
          ys.push(s.ys[i]); xs.push(s.xs[i]);
          rows.push('<span class="sw" style="background:' + s.color + '"></span>' + esc(s.m.short) + ' <b class="num">' + num(s.ys[i], 1) + '</b> <span style="opacity:.8">' + money(s.m.c[s.m.t.indexOf(s.xs[i])], s.m.cur) + '</span>');
        });
        var hx = xs.reduce(function (a, b) { return Math.abs(b - x) < Math.abs(a - x) ? b : a; }, xs[0]);
        return { x: hx, xs: xs, ys: ys, html: '<b>' + esc(dateFmt(hx, 'UTC')) + '</b><br>' + rows.join('<br>') };
      }
    });
  }

  // ================================================================ boot
  var rT; window.addEventListener('resize', function () { clearTimeout(rT); rT = setTimeout(function () { if (S.tab === 'analyze' && S.charts.price && $('#pc')) drawPrice(S.charts.price); if (S.tab === 'compare') drawCompare(); }, 150); });
  renderPicks();
  route();
})();
