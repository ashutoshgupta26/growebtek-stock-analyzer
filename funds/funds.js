/* Growebtek — Mutual Fund Analyzer: Indian funds (mfapi.in) and global funds & ETFs (backend). */
(function () {
  'use strict';
  if (!window.GW) return;
  var sess = GW.guard({ sub: 'Mutual Fund Analyzer' });
  if (!sess) return;
  var esc = GW.esc;

  // ------------------------------------------------------------------ constants
  var DAY = 86400000, YR = 365.25 * DAY;
  var MFAPI = 'https://api.mfapi.in/mf';
  var COLORS = ['#5b5bf6', '#ec4899', '#f97316', '#14b8a6'];
  var MF_POP = [[122639, 'Parag Parikh Flexi Cap'], [119598, 'SBI Large Cap (Bluechip)'], [118989, 'HDFC Mid Cap Opportunities'],
    [118778, 'Nippon India Small Cap'], [120377, 'ICICI Pru Balanced Advantage'], [120716, 'UTI Nifty 50 Index']];
  var GL_POP = [['VFIAX', 'Vanguard 500 Index Admiral'], ['SPY', 'SPDR S&P 500 ETF'], ['QQQ', 'Invesco QQQ'], ['VTI', 'Vanguard Total Stock Market ETF']];
  var LS_RECENT = 'gw_funds_recent', LS_CMP = 'gw_funds_cmp';
  var RANGES = [['1Y', 12], ['3Y', 36], ['5Y', 60], ['10Y', 120], ['Max', 0]];

  var S = {
    src: 'mf', mode: 'analyze', current: null, cmp: loadLS(LS_CMP, []).slice(0, 4),
    range: '5Y', cmpRange: 'Max', sipAmt: {}, sipYrs: 5, token: 0
  };
  var cache = {}; // key -> Promise<fund>

  function loadLS(k, d) { try { var v = JSON.parse(localStorage.getItem(k) || 'null'); return v == null ? d : v; } catch (e) { return d; } }
  function saveLS(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) {} }
  function $(id) { return document.getElementById(id); }

  // ------------------------------------------------------------------ formatting
  function ok(x) { return x != null && isFinite(x); }
  function pct(x, d, nosign) { if (!ok(x)) return '–'; var s = (x * 100).toFixed(d == null ? 1 : d); return (!nosign && x > 0 ? '+' : '') + s + '%'; }
  function cls(x) { return !ok(x) ? '' : x > 0 ? 'up' : x < 0 ? 'dn' : ''; }
  function num(x, d) { return ok(x) ? x.toFixed(d == null ? 2 : d) : '–'; }
  var nfCache = {};
  function nf(cur, opt) { var k = cur + JSON.stringify(opt); if (!nfCache[k]) { try { nfCache[k] = new Intl.NumberFormat('en-US', Object.assign({ style: 'currency', currency: cur }, opt)); } catch (e) { nfCache[k] = new Intl.NumberFormat('en-US', opt); } } return nfCache[k]; }
  function fmtNav(f, x) {
    if (!ok(x)) return '–';
    if (f.cur === 'INR') return '₹' + x.toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 4 });
    return nf(f.cur, { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(x);
  }
  function fmtAmt(f, x) {
    if (!ok(x)) return '–';
    if (f.cur === 'INR') return (x < 0 ? '-₹' : '₹') + Math.round(Math.abs(x)).toLocaleString('en-IN');
    return nf(f.cur, { maximumFractionDigits: 0 }).format(x);
  }
  function fmtBig(f, x) { return ok(x) ? nf(f.cur, { notation: 'compact', maximumFractionDigits: 2 }).format(x) : '–'; }
  function dfmt(ms) { return ok(ms) ? new Date(ms).toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric', timeZone: 'UTC' }) : '–'; }
  function mfmt(ms) { return new Date(ms).toLocaleDateString('en-GB', { month: 'short', year: 'numeric', timeZone: 'UTC' }); }
  function age(ms) {
    if (!ok(ms) || ms <= 0) return '–';
    var m = Math.floor(ms / (YR / 12)); var y = Math.floor(m / 12); m = m % 12;
    return y ? y + ' yr' + (y > 1 ? 's' : '') + (m ? ' ' + m + ' mo' : '') : m + ' mo';
  }
  function dur(days) { if (!ok(days)) return '–'; if (days < 60) return Math.round(days) + ' days'; var m = Math.round(days / 30.44); return m < 24 ? m + ' months' : (m / 12).toFixed(1) + ' years'; }

  // ------------------------------------------------------------------ date / series helpers
  function addMonths(ms, k) {
    var d = new Date(ms), y = d.getUTCFullYear(), m = d.getUTCMonth() + k, day = d.getUTCDate();
    var r = new Date(Date.UTC(y, m, 1)); var dim = new Date(Date.UTC(r.getUTCFullYear(), r.getUTCMonth() + 1, 0)).getUTCDate();
    r.setUTCDate(Math.min(day, dim)); return r.getTime();
  }
  function atOrBefore(t, x) { var lo = 0, hi = t.length - 1, r = -1; while (lo <= hi) { var m = (lo + hi) >> 1; if (t[m] <= x) { r = m; lo = m + 1; } else hi = m - 1; } return r; }
  function atOrAfter(t, x) { var lo = 0, hi = t.length - 1, r = t.length; while (lo <= hi) { var m = (lo + hi) >> 1; if (t[m] >= x) { r = m; hi = m - 1; } else lo = m + 1; } return r; }
  function clean(t, v) {
    // drop obviously bad single-day spikes (data errors) and non-positive values
    var T = [], V = [];
    for (var i = 0; i < t.length; i++) {
      if (!(v[i] > 0) || !isFinite(v[i])) continue;
      if (T.length && t[i] <= T[T.length - 1]) { V[V.length - 1] = v[i]; continue; }
      T.push(t[i]); V.push(v[i]);
    }
    var keep = [true];
    for (var j = 1; j < V.length - 1; j++) {
      var a = V[j] / V[j - 1] - 1, b = V[j + 1] / V[j] - 1;
      keep[j] = !(Math.abs(a) > 0.25 && Math.abs(b) > 0.2 && a * b < 0);
    }
    keep[V.length - 1] = true;
    var t2 = [], v2 = [];
    for (var k = 0; k < V.length; k++) if (keep[k]) { t2.push(T[k]); v2.push(V[k]); }
    return { t: t2, v: v2 };
  }

  // ------------------------------------------------------------------ classification
  function assetClass(f) {
    var c = (f.catFull + ' ' + f.name).toLowerCase();
    if (f.kind === 'mf') {
      if (/^debt|liquid|overnight|money market|gilt|arbitrage|bond|income/.test(c) && !/equity savings/.test(c)) return 'debt';
      if (/^hybrid|balanced|asset allocation|equity savings|multi asset/.test(c)) return 'hybrid';
      return 'equity';
    }
    if (/bond|treasury|muni|fixed income|money market|ultrashort|short-term|government|corporate|inflation/.test(c)) return 'debt';
    if (/allocation|conservative|balanced|target-date|retirement|moderate/.test(c)) return 'hybrid';
    return 'equity';
  }
  function plan(name) {
    var n = name.toLowerCase();
    return {
      plan: /direct/.test(n) ? 'Direct' : /regular|retail|institutional/.test(n) ? 'Regular' : '',
      opt: /idcw|dividend|payout|reinvest|bonus/.test(n) ? 'IDCW' : /growth/.test(n) ? 'Growth' : ''
    };
  }
  function planChips(p) {
    var h = '';
    if (p.plan) h += '<span class="gw-chip ' + (p.plan === 'Direct' ? 'green' : 'amber') + '">' + p.plan + '</span>';
    if (p.opt) h += '<span class="gw-chip ' + (p.opt === 'Growth' ? 'indigo' : 'pink') + '">' + p.opt + '</span>';
    return h;
  }
  // per-asset-class thresholds used by the score
  function TH(f) {
    var cl = f.cls, inr = f.cur === 'INR';
    var T = {
      equity: { r: inr ? [0.05, 0.20] : [0.02, 0.16], hurdle: inr ? 0.12 : 0.10, vol: [0.10, 0.30], mdd: [-0.10, -0.55], w1: [0.05, -0.40] },
      hybrid: { r: inr ? [0.05, 0.14] : [0.02, 0.11], hurdle: inr ? 0.09 : 0.07, vol: [0.05, 0.18], mdd: [-0.05, -0.35], w1: [0.06, -0.25] },
      debt: { r: inr ? [0.04, 0.085] : [0.0, 0.06], hurdle: inr ? 0.065 : 0.04, vol: [0.01, 0.08], mdd: [-0.01, -0.12], w1: [0.05, -0.08] }
    };
    return T[cl];
  }

  // ------------------------------------------------------------------ loading
  function fetchJSON(url, ms) {
    var ctl = new AbortController(); var to = setTimeout(function () { ctl.abort(); }, ms || 25000);
    return fetch(url, { signal: ctl.signal }).then(function (r) {
      clearTimeout(to); if (!r.ok) throw new Error('The fund data service returned an error (' + r.status + '). Please try again.'); return r.json();
    }, function (e) {
      clearTimeout(to);
      throw new Error(e && e.name === 'AbortError' ? 'The fund data service is taking too long. Please try again.' : 'Could not reach the fund data service. Check your internet and try again.');
    });
  }
  function loadFund(key) {
    if (!cache[key]) {
      var p = key.indexOf('mf:') === 0 ? loadMF(key.slice(3)) : loadGL(key.slice(4));
      cache[key] = p; p.catch(function () { delete cache[key]; });
    }
    return cache[key];
  }
  // Latest NAV straight from AMFI via the backend; the NAV-history API can lag a day. Never blocks the report.
  var MON = { Jan: 0, Feb: 1, Mar: 2, Apr: 3, May: 4, Jun: 5, Jul: 6, Aug: 7, Sep: 8, Oct: 9, Nov: 10, Dec: 11 };
  function amfiLatest(code) {
    var p = GW.api('nav', { code: String(code) }).then(function (r) {
      var m = r && r.nav > 0 && /^(\d{2})-([A-Za-z]{3})-(\d{4})$/.exec(r.date || '');
      return m && MON[m[2]] != null ? { t: Date.UTC(+m[3], MON[m[2]], +m[1]), v: r.nav } : null;
    }).catch(function () { return null; });
    return Promise.race([p, new Promise(function (res) { setTimeout(function () { res(null); }, 8000); })]);
  }
  function loadMF(code) {
    return Promise.all([fetchJSON(MFAPI + '/' + encodeURIComponent(code)), amfiLatest(code)]).then(function (all) {
      var j = all[0], a = all[1];
      if (!j || !j.meta || !j.data || !j.data.length || !j.meta.scheme_name) throw new Error('No NAV history found for scheme ' + code + '.');
      var n = j.data.length, t = new Array(n), v = new Array(n);
      for (var i = 0; i < n; i++) {
        var d = j.data[n - 1 - i], p = d.date.split('-');
        t[i] = Date.UTC(+p[2], +p[1] - 1, +p[0]); v[i] = parseFloat(d.nav);
      }
      if (a && n && a.t > t[n - 1]) { t.push(a.t); v.push(a.v); }
      var c = clean(t, v);
      if (c.t.length < 2) throw new Error('This scheme does not have enough NAV history to analyse.');
      var m = j.meta, name = m.scheme_name, catFull = m.scheme_category || '', parts = catFull.split(' - ');
      var f = {
        key: 'mf:' + code, kind: 'mf', id: String(code), name: name, short: name.split(/ - /)[0].trim() || name,
        house: m.fund_house || '', catFull: catFull, category: (parts[1] || parts[0] || '').trim() || '–',
        group: (parts[0] || '').replace(/ Scheme$/i, '').trim(), type: m.scheme_type || '', isin: m.isin_growth || m.isin_div_reinvestment || '',
        cur: 'INR', rf: 0.065, t: c.t, v: c.v, p: plan(name), x: null
      };
      var L = c.t.length;
      f.latest = c.v[L - 1]; f.latestT = c.t[L - 1]; f.prev = c.v[L - 2];
      f.chg = f.latest - f.prev; f.chgPct = f.latest / f.prev - 1; f.since = c.t[0];
      f.cls = assetClass(f);
      return f;
    });
  }
  function loadGL(sym) {
    return GW.api('fund', { symbol: sym }).then(function (j) {
      var ch = j && j.chart; if (!ch || !ch.t || !ch.t.length) throw new Error('No price history found for ' + sym + '.');
      var t = [], v = [], cl = [];
      for (var i = 0; i < ch.t.length; i++) {
        var a = ch.ac && ok(ch.ac[i]) ? ch.ac[i] : ch.c[i];
        if (!ok(a)) continue;
        t.push(Math.floor(ch.t[i] * 1000 / DAY) * DAY); v.push(a); cl.push(ch.c[i]);
      }
      var c = clean(t, v);
      if (c.t.length < 2) throw new Error('Not enough price history for ' + sym + '.');
      var s = j.summary || {}, meta = ch.meta || {}, pr = s.price || {}, fp = s.fundProfile || {}, dk = s.defaultKeyStatistics || {},
        sd = s.summaryDetail || {}, th = s.topHoldings || {}, perf = s.fundPerformance || {}, fe = fp.feesExpensesInvestment || {}, feC = fp.feesExpensesInvestmentCat || {};
      var name = pr.longName || meta.name || pr.shortName || j.symbol || sym;
      var cat = fp.categoryName || dk.category || perf.fundCategoryName || '';
      var qt = (pr.quoteType || meta.type || '').toUpperCase();
      var L = c.t.length;
      var latest = ok(meta.price) ? meta.price : ok(pr.regularMarketPrice) ? pr.regularMarketPrice : cl[cl.length - 1];
      var prev = ok(pr.regularMarketPreviousClose) ? pr.regularMarketPreviousClose : ok(sd.previousClose) ? sd.previousClose : cl[cl.length - 2];
      var risk = ((perf.riskOverviewStatistics || {}).riskStatistics || []).filter(function (r) { return r.year === '3y'; })[0] || {};
      var f = {
        key: 'etf:' + (j.symbol || sym).toUpperCase(), kind: 'gl', id: (j.symbol || sym).toUpperCase(), name: name, short: name,
        house: fp.family || dk.fundFamily || '', catFull: cat, category: cat || '–', group: qt === 'ETF' ? 'ETF' : qt === 'MUTUALFUND' ? 'Mutual fund' : (qt || 'Fund'),
        exchange: meta.exchange || pr.exchangeName || '', cur: (meta.currency || pr.currency || 'USD').toUpperCase(), t: c.t, v: c.v, p: { plan: '', opt: '' },
        latest: latest, latestT: c.t[L - 1], prev: prev,
        x: {
          expense: [fe.annualReportExpenseRatio, fe.netExpRatio, dk.annualReportExpenseRatio, sd.netExpenseRatio].filter(ok)[0],
          expenseCat: feC.annualReportExpenseRatio, aum: [sd.totalAssets, dk.totalAssets].filter(ok)[0], yld: [sd.yield, dk.yield].filter(ok)[0],
          ytd: [sd.ytdReturn, dk.ytdReturn].filter(ok)[0], msRating: dk.morningStarOverallRating, msRisk: dk.morningStarRiskRating,
          beta: [dk.beta3Year, risk.beta].filter(ok)[0], pe: sd.trailingPE, hi52: meta.hi52 || sd.fiftyTwoWeekHigh, lo52: meta.lo52 || sd.fiftyTwoWeekLow,
          holdings: (th.holdings || []).filter(function (h) { return h && ok(h.pct); }).slice(0, 10), sectors: (th.sectors || []).filter(function (h) { return h && ok(h.pct) && h.pct > 0; }),
          stock: th.stock, bond: th.bond, cash: th.cash, about: (s.assetProfile || {}).summary || '', inception: ok(dk.fundInceptionDate) ? dk.fundInceptionDate * 1000 : null,
          turnover: fe.annualHoldingsTurnover
        }
      };
      f.rf = f.cur === 'USD' ? 0.04 : f.cur === 'INR' ? 0.065 : 0.04;
      f.chg = ok(latest) && ok(prev) ? latest - prev : null; f.chgPct = ok(f.chg) ? latest / prev - 1 : null;
      f.since = f.x.inception && f.x.inception < c.t[0] ? f.x.inception : c.t[0];
      f.cls = assetClass(f);
      f.lev = /ultra|leverag|inverse|short|bear|2x|3x|-1x|daily/i.test(name);
      f.perf = perf; f.fp = fp;
      return f;
    });
  }

  // ------------------------------------------------------------------ analytics
  function cagr(a, b, yrs) { return yrs > 0 && a > 0 ? Math.pow(b / a, 1 / yrs) - 1 : null; }
  function retFor(f, months, annualise) {
    var t = f.t, v = f.v, n = t.length, end = t[n - 1], target = addMonths(end, -months);
    if (target < t[0] - 6 * DAY) return null;
    var i = Math.max(0, atOrBefore(t, target));
    return annualise ? cagr(v[i], v[n - 1], (end - t[i]) / YR) : v[n - 1] / v[i] - 1;
  }
  function riskWin(f, fromIdx) {
    var t = f.t, v = f.v, n = t.length, cnt = 0, s = 0, s2 = 0, dsum = 0;
    var yrs = (t[n - 1] - t[fromIdx]) / YR; if (yrs < 0.9 || n - fromIdx < 40) return null;
    var ppy = (n - 1 - fromIdx) / yrs, rfp = Math.pow(1 + f.rf, 1 / ppy) - 1;
    for (var i = fromIdx + 1; i < n; i++) { var r = v[i] / v[i - 1] - 1; cnt++; s += r; s2 += r * r; var d = Math.min(0, r - rfp); dsum += d * d; }
    var mean = s / cnt, sd = Math.sqrt(Math.max(0, s2 / cnt - mean * mean) * cnt / Math.max(1, cnt - 1));
    var vol = sd * Math.sqrt(ppy), dd = Math.sqrt(dsum / cnt) * Math.sqrt(ppy), g = cagr(v[fromIdx], v[n - 1], yrs);
    return { vol: vol, sharpe: vol > 0 ? (g - f.rf) / vol : null, sortino: dd > 0 ? (g - f.rf) / dd : null, yrs: yrs, cagr: g };
  }
  function drawdown(f) {
    var v = f.v, t = f.t, peak = v[0], pi = 0, mdd = 0, mp = 0, mt = 0, ath = v[0];
    for (var i = 1; i < v.length; i++) {
      if (v[i] > peak) { peak = v[i]; pi = i; }
      var d = v[i] / peak - 1; if (d < mdd) { mdd = d; mp = pi; mt = i; }
      if (v[i] > ath) ath = v[i];
    }
    var rec = -1;
    if (mdd < 0) for (var j = mt + 1; j < v.length; j++) if (v[j] >= v[mp]) { rec = j; break; }
    return { mdd: mdd, peakT: t[mp], troughT: t[mt], recT: rec >= 0 ? t[rec] : null, recDays: rec >= 0 ? (t[rec] - t[mt]) / DAY : null,
      fallDays: (t[mt] - t[mp]) / DAY, cur: v[v.length - 1] / ath - 1 };
  }
  function rolling(f, months) {
    var t = f.t, v = f.v, n = t.length, j = 0, yrs = months / 12, ot = [], ov = [];
    for (var i = 0; i < n; i++) {
      var target = addMonths(t[i], -months);
      if (target < t[0] - 6 * DAY) continue;
      while (j + 1 < n && t[j + 1] <= target) j++;
      ot.push(t[i]); ov.push(months > 12 ? Math.pow(v[i] / v[j], 1 / yrs) - 1 : v[i] / v[j] - 1);
    }
    if (ov.length < 5) return null;
    var mn = Infinity, mx = -Infinity, mnT, mxT, sum = 0, pos = 0;
    for (var k = 0; k < ov.length; k++) { var x = ov[k]; sum += x; if (x > 0) pos++; if (x < mn) { mn = x; mnT = ot[k]; } if (x > mx) { mx = x; mxT = ot[k]; } }
    return { t: ot, v: ov, min: mn, max: mx, minT: mnT, maxT: mxT, avg: sum / ov.length, pos: pos / ov.length,
      above: function (h) { var c = 0; for (var q = 0; q < ov.length; q++) if (ov[q] > h) c++; return c / ov.length; } };
  }
  function calYears(f) {
    var t = f.t, v = f.v, n = t.length, out = [], base = v[0], baseT = t[0], y0 = new Date(t[0]).getUTCFullYear();
    var startPartial = new Date(t[0]).getUTCMonth() > 0 || new Date(t[0]).getUTCDate() > 10;
    for (var i = 0; i < n; i++) {
      var y = new Date(t[i]).getUTCFullYear();
      var lastOfYear = i === n - 1 || new Date(t[i + 1]).getUTCFullYear() !== y;
      if (lastOfYear) {
        var cur = i === n - 1 && !(new Date(t[i]).getUTCMonth() === 11 && new Date(t[i]).getUTCDate() >= 24);
        out.push({ label: String(y), v: v[i] / base - 1, partial: (y === y0 && startPartial), ytd: cur, from: baseT });
        base = v[i]; baseT = t[i];
      }
    }
    return out;
  }
  function xirr(flows) {
    var t0 = flows[0].t;
    function npv(r) { var s = 0; for (var i = 0; i < flows.length; i++) s += flows[i].a / Math.pow(1 + r, (flows[i].t - t0) / (365 * DAY)); return s; }
    function d(r) { var s = 0; for (var i = 0; i < flows.length; i++) { var y = (flows[i].t - t0) / (365 * DAY); s -= y * flows[i].a / Math.pow(1 + r, y + 1); } return s; }
    var r = 0.1;
    for (var k = 0; k < 50; k++) { var fv = npv(r), dv = d(r); if (!dv) break; var nr = r - fv / dv; if (!isFinite(nr) || nr <= -0.999) break; if (Math.abs(nr - r) < 1e-8) return nr; r = nr; }
    var lo = -0.99, hi = 10, flo = npv(lo); if (flo * npv(hi) > 0) return null;
    for (var b = 0; b < 200; b++) { var mid = (lo + hi) / 2, fm = npv(mid); if (Math.abs(fm) < 1e-7) return mid; if (fm * flo > 0) { lo = mid; flo = fm; } else hi = mid; }
    return (lo + hi) / 2;
  }
  function sip(f, amt, years, withSeries) {
    var t = f.t, v = f.v, n = t.length, end = t[n - 1], months = years * 12;
    var start = addMonths(end, -months);
    if (start < t[0] - 6 * DAY) return null;
    var units = 0, flows = [], buys = [];
    for (var k = 0; k < months; k++) {
      var d = addMonths(end, -months + k), i = atOrAfter(t, d);
      if (i >= n) break;
      units += amt / v[i]; flows.push({ t: t[i], a: -amt }); buys.push(i);
    }
    if (!flows.length) return null;
    var value = units * v[n - 1], inv = amt * flows.length;
    flows.push({ t: end, a: value });
    var res = { invested: inv, value: value, gain: value - inv, gainPct: value / inv - 1, xirr: xirr(flows), n: buys.length, startT: t[buys[0]] };
    if (withSeries) {
      var st = [], sv = [], si = [], u = 0, bi = 0, invd = 0;
      for (var q = buys[0]; q < n; q++) {
        while (bi < buys.length && buys[bi] <= q) { u += amt / v[buys[bi]]; invd += amt; bi++; }
        st.push(t[q]); sv.push(u * v[q]); si.push(invd);
      }
      res.series = { t: st, value: sv, inv: si };
    }
    return res;
  }
  function metrics(f) {
    if (f._m) return f._m;
    var t = f.t, n = t.length, end = t[n - 1], yrs = (end - t[0]) / YR;
    var m = {
      r: { m1: retFor(f, 1), m3: retFor(f, 3), m6: retFor(f, 6), y1: retFor(f, 12), y3: retFor(f, 36, 1), y5: retFor(f, 60, 1), y7: retFor(f, 84, 1), y10: retFor(f, 120, 1) },
      yrs: yrs
    };
    m.r.si = yrs >= 1 ? cagr(f.v[0], f.v[n - 1], yrs) : f.v[n - 1] / f.v[0] - 1; m.siAbs = yrs < 1;
    var from3 = yrs >= 3 ? Math.max(0, atOrBefore(t, addMonths(end, -36))) : 0;
    m.risk = riskWin(f, from3); m.riskLbl = yrs >= 3 ? '3Y' : 'since launch';
    m.dd = drawdown(f);
    m.roll1 = rolling(f, 12); m.roll3 = rolling(f, 36);
    m.cal = calYears(f);
    m.sip5 = sip(f, 10000, 5);
    m.score = score(f, m);
    f._m = m; return m;
  }
  function clamp10(x) { return Math.max(0, Math.min(10, x)); }
  function lin(x, a, b) { return clamp10((x - a) / (b - a) * 10); } // a -> 0, b -> 10
  function score(f, m) {
    var T = TH(f), parts = [];
    var rb = ok(m.r.y5) ? ['5Y', m.r.y5] : ok(m.r.y3) ? ['3Y', m.r.y3] : ok(m.r.si) && !m.siAbs ? ['since-launch', m.r.si] : null;
    if (rb) parts.push({ k: 'Returns', s: lin(rb[1], T.r[0], T.r[1]), why: pct(rb[1]) + ' a year over ' + rb[0] + ' (scale ' + pct(T.r[0], 0, 1) + '→0, ' + pct(T.r[1], 0, 1) + '→10 for ' + f.cls + ' funds).' });
    var c3 = m.roll3, c1 = m.roll1;
    if (c3 || c1) {
      var s1 = c1 ? c1.pos * 10 : null, s3 = c3 ? c3.above(T.hurdle) * 10 : null;
      var sc = s1 != null && s3 != null ? 0.4 * s1 + 0.6 * s3 : (s1 != null ? s1 : s3);
      parts.push({ k: 'Consistency', s: sc, why: (c1 ? pct(c1.pos, 0, 1) + ' of rolling 1Y periods positive' : '') + (c1 && c3 ? '; ' : '') + (c3 ? pct(c3.above(T.hurdle), 0, 1) + ' of rolling 3Y periods beat ' + pct(T.hurdle, 0, 1) + ' a year' : '') + '.' });
    }
    if (m.risk) {
      var ss = lin(m.risk.sharpe, -0.2, 1.2), vs = lin(m.risk.vol, T.vol[1], T.vol[0]);
      parts.push({ k: 'Risk control', s: 0.6 * ss + 0.4 * vs, why: 'Sharpe ' + num(m.risk.sharpe) + ' and volatility ' + pct(m.risk.vol, 1, 1) + ' (' + m.riskLbl + ').' });
    }
    if (m.yrs >= 1) {
      var ds = lin(m.dd.mdd, T.mdd[1], T.mdd[0]), w = c1 ? lin(c1.min, T.w1[1], T.w1[0]) : ds;
      parts.push({ k: 'Downside protection', s: 0.7 * ds + 0.3 * w, why: 'Worst fall ' + pct(m.dd.mdd) + (c1 ? ', worst 1Y return ' + pct(c1.min) : '') + '.' });
    }
    if (f.kind === 'gl' && ok(f.x.expense)) {
      parts.push({ k: 'Cost', s: lin(f.x.expense, 0.015, 0.0005), why: 'Expense ratio ' + pct(f.x.expense, 2, 1) + ' a year' + (ok(f.x.expenseCat) ? ' vs category ' + pct(f.x.expenseCat, 2, 1) : '') + '.' });
    }
    if (!parts.length) return null;
    var tot = 0; parts.forEach(function (p) { p.s = Math.round(p.s * 10) / 10; tot += p.s; });
    var o = tot / parts.length;
    if (f.lev) o = Math.min(o, 4.4);
    o = Math.round(o * 10) / 10;
    return { parts: parts, overall: o, label: o >= 7.5 ? 'Excellent' : o >= 6 ? 'Good' : o >= 4.5 ? 'Average' : 'Weak', short: m.yrs < 3 };
  }

  // ------------------------------------------------------------------ charts (plain SVG)
  var charts = [], seq = 0;
  function niceTicks(lo, hi, n) {
    var span = hi - lo; if (!(span > 0)) return [lo];
    var step = Math.pow(10, Math.floor(Math.log10(span / n))), err = span / n / step;
    step *= err >= 7.5 ? 10 : err >= 3.5 ? 5 : err >= 1.5 ? 2 : 1;
    var out = []; for (var x = Math.ceil(lo / step) * step; x <= hi + step * 1e-9; x += step) out.push(+x.toFixed(10)); return out;
  }
  function xTicks(t0, t1, maxN) {
    var out = [], d0 = new Date(t0), spanY = (t1 - t0) / YR;
    if (spanY >= 2.5) {
      var st = [1, 2, 3, 5, 10, 20].filter(function (s) { return spanY / s <= maxN; })[0] || 20;
      for (var y = d0.getUTCFullYear() + 1; ; y++) { var ms = Date.UTC(y, 0, 1); if (ms > t1) break; if (y % st === 0) out.push([ms, String(y)]); }
    } else {
      var sm = spanY * 12, mst = [1, 2, 3, 6, 12].filter(function (s) { return sm / s <= maxN; })[0] || 12;
      for (var k = 1; ; k++) {
        var d = Date.UTC(d0.getUTCFullYear(), d0.getUTCMonth() + k, 1); if (d > t1) break;
        if (new Date(d).getUTCMonth() % mst === 0) out.push([d, new Date(d).toLocaleDateString('en-GB', { month: 'short', timeZone: 'UTC' }) + " '" + String(new Date(d).getUTCFullYear()).slice(2)]);
      }
    }
    return out;
  }
  function mount(el, draw) {
    var c = { el: el, draw: draw, w: 0 };
    c.run = function () { c.w = el.clientWidth; draw(); };
    charts = charts.filter(function (x) { return x.el !== el && document.body.contains(x.el); });
    charts.push(c); c.run(); return c;
  }
  var rzT;
  window.addEventListener('resize', function () {
    clearTimeout(rzT);
    rzT = setTimeout(function () { charts = charts.filter(function (c) { return document.body.contains(c.el); }); charts.forEach(function (c) { if (c.el.clientWidth !== c.w) c.run(); }); }, 150);
  });

  // series: [{name,color,t,v}], o: {h, fill, fmtY, tip(v, s) -> html, zero}
  function lineChart(el, series, o) {
    o = o || {};
    return mount(el, function () {
      var W = Math.max(260, el.clientWidth), H = o.h ? o.h(W) : (W < 560 ? 230 : 300);
      var lo = Infinity, hi = -Infinity, t0 = Infinity, t1 = -Infinity;
      series.forEach(function (s) {
        var n = s.t.length; if (!n) return;
        t0 = Math.min(t0, s.t[0]); t1 = Math.max(t1, s.t[n - 1]);
        for (var i = 0; i < n; i++) { var x = s.v[i]; if (x < lo) lo = x; if (x > hi) hi = x; }
      });
      if (!isFinite(lo)) { el.innerHTML = '<p class="muted">No data for this period.</p>'; return; }
      if (o.zero) { lo = Math.min(lo, 0); hi = Math.max(hi, 0); }
      var pad = (hi - lo) * 0.07 || Math.abs(hi) * 0.05 || 1; lo -= pad; hi += pad;
      if (o.floor0 && lo < 0 && series.every(function (s) { return Math.min.apply(null, s.v.slice(0, 1)) >= 0; })) lo = Math.max(lo, 0);
      var fy = o.fmtY || function (x) { return String(x); };
      var yt = niceTicks(lo, hi, W < 560 ? 4 : 5).filter(function (x) { return x >= lo && x <= hi; });
      var L = Math.max.apply(null, yt.map(function (x) { return fy(x).length; })) * 6.3 + 12, R = 10, Tp = 10, B = 24, pw = W - L - R, ph = H - Tp - B;
      var X = function (t) { return L + (t - t0) / ((t1 - t0) || 1) * pw; }, Y = function (v) { return Tp + (hi - v) / (hi - lo) * ph; };
      var id = 'fxg' + (++seq), h = '<svg width="' + W + '" height="' + H + '" viewBox="0 0 ' + W + ' ' + H + '" role="img" aria-label="' + esc(o.label || 'Chart') + '"><defs>';
      series.forEach(function (s, k) { h += '<linearGradient id="' + id + k + '" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="' + s.color + '" stop-opacity=".30"/><stop offset="1" stop-color="' + s.color + '" stop-opacity="0"/></linearGradient>'; });
      h += '</defs>';
      yt.forEach(function (y) { var yy = Y(y).toFixed(1); h += '<line class="grid" x1="' + L + '" x2="' + (W - R) + '" y1="' + yy + '" y2="' + yy + '"/><text x="' + (L - 7) + '" y="' + yy + '" dy="3.5" text-anchor="end">' + esc(fy(y)) + '</text>'; });
      if (o.zero && lo < 0 && hi > 0) h += '<line class="zero" x1="' + L + '" x2="' + (W - R) + '" y1="' + Y(0).toFixed(1) + '" y2="' + Y(0).toFixed(1) + '"/>';
      xTicks(t0, t1, W < 560 ? 4 : 7).forEach(function (x) { var xx = X(x[0]); if (xx < L + 14 || xx > W - R - 14) return; h += '<text x="' + xx.toFixed(1) + '" y="' + (H - 6) + '" text-anchor="middle">' + x[1] + '</text>'; });
      series.forEach(function (s, k) {
        var n = s.t.length, step = Math.max(1, Math.floor(n / (pw * 1.5))), d = '';
        for (var i = 0; i < n; i += step) d += (d ? 'L' : 'M') + X(s.t[i]).toFixed(1) + ' ' + Y(s.v[i]).toFixed(1);
        if ((n - 1) % step) d += 'L' + X(s.t[n - 1]).toFixed(1) + ' ' + Y(s.v[n - 1]).toFixed(1);
        if (s.fill || (o.fill && k === 0)) h += '<path d="' + d + 'L' + X(s.t[n - 1]).toFixed(1) + ' ' + (Tp + ph) + 'L' + X(s.t[0]).toFixed(1) + ' ' + (Tp + ph) + 'Z" fill="url(#' + id + k + ')"/>';
        h += '<path d="' + d + '" fill="none" stroke="' + s.color + '" stroke-width="' + (s.w || 2) + '" stroke-linejoin="round" stroke-linecap="round"' + (s.dash ? ' stroke-dasharray="5 4"' : '') + '/>';
      });
      h += '<line class="hl" y1="' + Tp + '" y2="' + (Tp + ph) + '" visibility="hidden"/>';
      series.forEach(function (s) { h += '<circle r="4.5" fill="#fff" stroke="' + s.color + '" stroke-width="2.5" visibility="hidden"/>'; });
      h += '<rect x="' + L + '" y="0" width="' + pw + '" height="' + H + '" fill="transparent"/></svg><div class="fx-tip" hidden></div>';
      el.innerHTML = '<div class="fx-chart">' + h + '</div>';
      var svg = el.querySelector('svg'), tip = el.querySelector('.fx-tip'), hl = svg.querySelector('.hl'), dots = svg.querySelectorAll('circle');
      function move(ev) {
        var r = svg.getBoundingClientRect(), px = (ev.clientX - r.left) * (W / r.width);
        var tx = t0 + (px - L) / pw * (t1 - t0), base = series[0], i = atOrBefore(base.t, tx);
        if (i < 0) i = 0; if (i < base.t.length - 1 && Math.abs(base.t[i + 1] - tx) < Math.abs(tx - base.t[i])) i++;
        var tt = base.t[i], xx = X(tt), rows = '';
        hl.setAttribute('x1', xx); hl.setAttribute('x2', xx); hl.setAttribute('visibility', 'visible');
        series.forEach(function (s, k) {
          var j = k === 0 ? i : atOrBefore(s.t, tt);
          if (j < 0 || (k && tt - s.t[j] > 10 * DAY)) { dots[k].setAttribute('visibility', 'hidden'); return; }
          dots[k].setAttribute('cx', X(s.t[j])); dots[k].setAttribute('cy', Y(s.v[j])); dots[k].setAttribute('visibility', 'visible');
          rows += '<div class="r"><span><i style="background:' + s.color + '"></i>' + esc(s.name) + '</span><b>' + (o.tip ? o.tip(s.v[j], s) : esc(fy(s.v[j]))) + '</b></div>';
        });
        tip.innerHTML = '<div class="d">' + dfmt(tt) + '</div>' + rows; tip.hidden = false;
        var tw = tip.offsetWidth, lx = xx + 14; if (lx + tw > W - 2) lx = xx - tw - 14; if (lx < 0) lx = 2;
        tip.style.left = lx + 'px';
      }
      function leave() { tip.hidden = true; hl.setAttribute('visibility', 'hidden'); dots.forEach(function (d) { d.setAttribute('visibility', 'hidden'); }); }
      svg.addEventListener('pointermove', move); svg.addEventListener('pointerdown', move); svg.addEventListener('pointerleave', leave);
    });
  }
  function barChart(el, items) {
    return mount(el, function () {
      var W = Math.max(260, el.clientWidth), H = W < 560 ? 210 : 240, L = 6, R = 6, Tp = 22, B = 34;
      var maxN = Math.max(4, Math.floor((W - L - R) / 34)), it = items.slice(-maxN), n = it.length;
      if (!n) { el.innerHTML = '<p class="muted">Not enough history yet.</p>'; return; }
      var lo = Math.min(0, Math.min.apply(null, it.map(function (x) { return x.v; }))), hi = Math.max(0, Math.max.apply(null, it.map(function (x) { return x.v; })));
      if (hi === lo) hi = lo + 0.01;
      var ph = H - Tp - B - (lo < 0 ? 16 : 0), Y = function (v) { return Tp + (hi - v) / (hi - lo) * ph; }, slot = (W - L - R) / n, bw = Math.min(40, slot * 0.66);
      var id = 'fxb' + (++seq);
      var h = '<svg width="' + W + '" height="' + H + '" role="img" aria-label="Calendar-year returns"><defs><linearGradient id="' + id + 'u" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#14b8a6"/><stop offset="1" stop-color="#5b5bf6"/></linearGradient><linearGradient id="' + id + 'd" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#f97316"/><stop offset="1" stop-color="#ec4899"/></linearGradient></defs>';
      var y0 = Y(0);
      it.forEach(function (x, k) {
        var cx = L + slot * k + slot / 2, y = Y(x.v), top = Math.min(y, y0), hh = Math.max(1.5, Math.abs(y - y0));
        h += '<rect x="' + (cx - bw / 2).toFixed(1) + '" y="' + top.toFixed(1) + '" width="' + bw.toFixed(1) + '" height="' + hh.toFixed(1) + '" rx="5" fill="url(#' + id + (x.v >= 0 ? 'u' : 'd') + ')"' + (x.partial || x.ytd ? ' opacity=".55"' : '') + '><title>' + x.label + (x.ytd ? ' (YTD)' : x.partial ? ' (part year)' : '') + ': ' + pct(x.v) + '</title></rect>';
        var ly = x.v >= 0 ? top - 5 : top + hh + 12;
        h += '<text class="bl" x="' + cx.toFixed(1) + '" y="' + ly.toFixed(1) + '" text-anchor="middle" style="fill:' + (x.v >= 0 ? 'var(--gw-up)' : 'var(--gw-dn)') + '">' + (Math.abs(x.v) >= 1 ? Math.round(x.v * 100) : (x.v * 100).toFixed(slot < 40 ? 0 : 1)) + '</text>';
        h += '<text x="' + cx.toFixed(1) + '" y="' + (H - 16) + '" text-anchor="middle">' + (slot < 38 ? "'" + x.label.slice(2) : x.label) + '</text>';
        if (x.ytd || x.partial) h += '<text x="' + cx.toFixed(1) + '" y="' + (H - 4) + '" text-anchor="middle" style="font-size:9px">' + (x.ytd ? 'YTD' : 'part') + '</text>';
      });
      h += '<line class="zero" x1="' + L + '" x2="' + (W - R) + '" y1="' + y0.toFixed(1) + '" y2="' + y0.toFixed(1) + '"/></svg>';
      el.innerHTML = '<div class="fx-chart">' + h + '</div>';
    });
  }
  function ring(score) {
    var r = 44, c = 2 * Math.PI * r, p = Math.max(0, Math.min(1, score / 10));
    return '<svg width="104" height="104" viewBox="0 0 104 104" aria-hidden="true"><circle cx="52" cy="52" r="' + r + '" fill="none" stroke="rgba(255,255,255,.22)" stroke-width="10"/>' +
      '<circle cx="52" cy="52" r="' + r + '" fill="none" stroke="#fff" stroke-width="10" stroke-linecap="round" stroke-dasharray="' + (c * p).toFixed(1) + ' ' + c.toFixed(1) + '" transform="rotate(-90 52 52)"/></svg>';
  }

  // ------------------------------------------------------------------ UI: tabs, picks, recent, tray
  function setSrc(src) {
    S.src = src;
    document.querySelectorAll('#srcTabs button').forEach(function (b) { b.setAttribute('aria-selected', String(b.dataset.src === src)); });
    $('q').placeholder = S.mode === 'compare' ? (src === 'mf' ? 'Add an Indian fund to compare…' : 'Add a fund or ETF to compare, e.g. QQQ') : (src === 'mf' ? 'Search a fund, e.g. Parag Parikh Flexi Cap' : 'Search a fund or ETF, e.g. VFIAX, SPY, Vanguard');
    closeDD(); ddItems = []; qSeq++; $('dd').innerHTML = ''; $('qSpin').hidden = true; renderPicks();
  }
  function setMode(mode) {
    S.mode = mode;
    document.querySelectorAll('#modeTabs button').forEach(function (b) { b.setAttribute('aria-selected', String(b.dataset.mode === mode)); });
    setSrc(S.src); renderTray();
  }
  var PCOL = ['c1', 'c2', 'c3', 'c4', 'c5', 'c6'];
  function renderPicks() {
    var list = S.src === 'mf' ? MF_POP.map(function (x) { return ['mf:' + x[0], x[1]]; }) : GL_POP.map(function (x) { return ['etf:' + x[0], x[0] + ' · ' + x[1]]; });
    $('picks').innerHTML = '<span class="lbl">Popular</span>' + list.map(function (x, i) { return '<button type="button" class="fx-pick ' + PCOL[i % 6] + '" data-key="' + esc(x[0]) + '">' + esc(x[1]) + '</button>'; }).join('');
    var rec = loadLS(LS_RECENT, []);
    $('recent').hidden = !rec.length;
    $('recent').innerHTML = '<span class="lbl">Recent</span>' + rec.map(function (x) { return '<button type="button" class="fx-pick" data-key="' + esc(x.k) + '" title="' + esc(x.n) + '">' + esc(x.n.length > 38 ? x.n.slice(0, 36) + '…' : x.n) + '</button>'; }).join('');
  }
  function addRecent(f) {
    var rec = loadLS(LS_RECENT, []).filter(function (x) { return x.k !== f.key; });
    rec.unshift({ k: f.key, n: f.kind === 'gl' ? f.id + ' · ' + f.short : f.short + (f.p.plan ? ' (' + f.p.plan + ')' : '') });
    saveLS(LS_RECENT, rec.slice(0, 8)); renderPicks();
  }
  var names = {}; // key -> label, for tray before load
  function renderTray() {
    $('cmpCnt').hidden = !S.cmp.length; $('cmpCnt').textContent = S.cmp.length;
    var tr = $('tray');
    tr.hidden = !(S.mode === 'compare' || S.cmp.length);
    tr.innerHTML = '<span class="fx-picks"><span class="lbl">Compare (' + S.cmp.length + '/4)</span></span>' + (S.cmp.length ? S.cmp.map(function (k, i) {
      return '<span class="fx-tchip" style="--c:' + COLORS[i] + '"><span class="d"></span><span class="t">' + esc(names[k] || k.replace(/^(mf|etf):/, '')) + '</span><button type="button" data-rm="' + esc(k) + '" aria-label="Remove from compare">×</button></span>';
    }).join('') : '<span class="muted" style="font-size:13px">Add 2 to 4 funds from search or the popular list.</span>') +
      (S.mode !== 'compare' && S.cmp.length >= 2 ? '<button type="button" class="gw-btn sm" data-go-cmp>Compare now</button>' : '') +
      (S.cmp.length ? '<button type="button" class="gw-btn ghost sm" data-clear-cmp>Clear</button>' : '');
  }
  function addCmp(key, silent) {
    if (S.cmp.indexOf(key) >= 0) { if (!silent) GW.toast('Already in compare'); return false; }
    if (S.cmp.length >= 4) { GW.toast('You can compare up to 4 funds'); return false; }
    S.cmp.push(key); saveLS(LS_CMP, S.cmp); renderTray();
    if (!silent) GW.toast('Added to compare (' + S.cmp.length + '/4)');
    return true;
  }
  function pick(key, label) {
    if (label) names[key] = label;
    closeDD(); $('q').value = '';
    if (S.mode === 'compare') { if (addCmp(key, true)) go(cmpHash()); }
    else go(keyHash(key));
  }
  function keyHash(k) { return k.indexOf('mf:') === 0 ? 'mf=' + k.slice(3) : 'etf=' + k.slice(4); }
  function cmpHash() { return 'cmp=' + S.cmp.join(','); }
  function go(h) { if (location.hash.slice(1) === h) route(); else location.hash = h; }

  document.addEventListener('click', function (e) {
    var b;
    if ((b = e.target.closest('#srcTabs button'))) { setSrc(b.dataset.src); $('q').focus(); return; }
    if ((b = e.target.closest('#modeTabs button'))) {
      if (b.dataset.mode === 'compare') go(cmpHash()); else go(S.current ? keyHash(S.current) : '');
      return;
    }
    if ((b = e.target.closest('[data-key]'))) { pick(b.dataset.key, b.title || b.textContent); return; }
    if ((b = e.target.closest('[data-rm]'))) { S.cmp = S.cmp.filter(function (k) { return k !== b.dataset.rm; }); saveLS(LS_CMP, S.cmp); renderTray(); if (S.mode === 'compare') go(cmpHash()); return; }
    if (e.target.closest('[data-clear-cmp]')) { S.cmp = []; saveLS(LS_CMP, S.cmp); renderTray(); if (S.mode === 'compare') go(cmpHash()); return; }
    if (e.target.closest('[data-go-cmp]')) { go(cmpHash()); return; }
    if ((b = e.target.closest('[data-add-cmp]'))) {
      if (addCmp(b.dataset.addCmp)) { b.textContent = 'In compare ✓'; }
      return;
    }
    if ((b = e.target.closest('[data-demo]'))) { S.cmp = b.dataset.demo.split(','); saveLS(LS_CMP, S.cmp); go(cmpHash()); return; }
    if ((b = e.target.closest('[data-retry]'))) { route(); return; }
    if (!e.target.closest('.fx-search')) closeDD();
  });

  // ------------------------------------------------------------------ search with autocomplete
  var qT, qCtl, ddItems = [], ddSel = -1, qSeq = 0;
  function closeDD() { $('dd').hidden = true; $('q').setAttribute('aria-expanded', 'false'); ddSel = -1; }
  function showDD(html) { $('dd').innerHTML = html; $('dd').hidden = false; $('q').setAttribute('aria-expanded', 'true'); }
  function renderDD(items, q) {
    ddItems = items; ddSel = -1;
    if (!items.length) { showDD('<li class="empty">No funds found for “' + esc(q) + '”.' + (S.src === 'mf' ? ' Try a shorter name.' : ' Try a ticker like VFIAX or SPY.') + '</li>'); return; }
    showDD(items.map(function (x, i) {
      return '<li role="option" id="dd' + i + '" data-i="' + i + '">' + (x.sym ? '<span class="sym">' + esc(x.sym) + '</span>' : '') + '<span class="nm">' + esc(x.name) + '</span>' + x.chips + '</li>';
    }).join(''));
  }
  $('dd').addEventListener('mousedown', function (e) { var li = e.target.closest('li[data-i]'); if (li) { e.preventDefault(); var x = ddItems[+li.dataset.i]; pick(x.key, x.label); } });
  $('q').addEventListener('input', function () {
    clearTimeout(qT); var q = this.value.trim();
    if (q.length < 2) { closeDD(); $('qSpin').hidden = true; return; }
    qT = setTimeout(function () { search(q); }, S.src === 'mf' ? 280 : 450);
  });
  $('q').addEventListener('focus', function () { if (ddItems.length && this.value.trim().length >= 2) renderDD(ddItems, this.value.trim()); });
  $('q').addEventListener('keydown', function (e) {
    var open = !$('dd').hidden && ddItems.length;
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      if (!open) return; e.preventDefault();
      ddSel = (ddSel + (e.key === 'ArrowDown' ? 1 : -1) + ddItems.length) % ddItems.length;
      $('dd').querySelectorAll('li').forEach(function (li, i) { li.classList.toggle('on', i === ddSel); if (i === ddSel) li.scrollIntoView({ block: 'nearest' }); });
    } else if (e.key === 'Enter') {
      e.preventDefault();
      if (open) { var x = ddItems[Math.max(0, ddSel)]; pick(x.key, x.label); return; }
      var q = this.value.trim();
      if (S.src === 'gl' && /^[A-Za-z0-9.\-^]{1,10}$/.test(q)) pick('etf:' + q.toUpperCase());
      else if (S.src === 'mf' && /^\d{5,6}$/.test(q)) pick('mf:' + q);
      else if (q.length >= 2) search(q);
    } else if (e.key === 'Escape') closeDD();
  });
  function search(q) {
    var my = ++qSeq; $('qSpin').hidden = false;
    var src = S.src, p;
    if (src === 'mf') {
      if (qCtl) qCtl.abort(); qCtl = new AbortController();
      var sig = qCtl.signal, get = function (s) { return fetch(MFAPI + '/search?q=' + encodeURIComponent(s), { signal: sig }).then(function (r) { if (!r.ok) throw new Error('Search failed (' + r.status + '). Please try again.'); return r.json(); }); };
      p = get(q).then(function (arr) {
        // mfapi matches the literal phrase; for multi-word queries fall back to the longest word and require every word
        var words = q.toLowerCase().split(/\s+/).filter(Boolean);
        if ((arr && arr.length) || words.length < 2) return arr;
        var lw = words.slice().sort(function (a, b) { return b.length - a.length; })[0];
        return get(lw).then(function (a2) { return (a2 || []).filter(function (x) { var n = x.schemeName.toLowerCase(); return words.every(function (w) { return n.indexOf(w) >= 0; }); }); });
      }).then(function (arr) {
        return (arr || []).map(function (x) { var pl = plan(x.schemeName); return { key: 'mf:' + x.schemeCode, name: x.schemeName, label: x.schemeName.split(/ - /)[0], chips: planChips(pl), rank: (pl.plan === 'Direct' ? 0 : 2) + (pl.opt === 'Growth' ? 0 : 1) }; })
          .sort(function (a, b) { return a.rank - b.rank || a.name.localeCompare(b.name); }).slice(0, 40);
      });
    } else {
      p = GW.api('search', { q: q, kind: 'fund' }).then(function (j) {
        return (j.results || []).filter(function (x) { return x.symbol && /MUTUALFUND|ETF/i.test(x.quoteType || x.type || ''); }).map(function (x) {
          var et = /ETF/i.test(x.quoteType) ? 'ETF' : 'Mutual fund';
          return { key: 'etf:' + x.symbol.toUpperCase(), sym: x.symbol, name: x.name || x.symbol, label: x.symbol + ' · ' + (x.name || ''), chips: '<span class="gw-chip ' + (et === 'ETF' ? 'pink' : 'indigo') + '">' + et + '</span>' + (x.exchange ? '<span class="gw-chip">' + esc(x.exchange) + '</span>' : '') };
        });
      });
    }
    p.then(function (items) { if (my !== qSeq || src !== S.src) return; $('qSpin').hidden = true; renderDD(items, q); },
      function (e) { if (e && e.name === 'AbortError') return; if (my !== qSeq) return; $('qSpin').hidden = true; showDD('<li class="empty">' + esc(e.message || 'Search failed. Please try again.') + '</li>'); ddItems = []; });
  }

  // ------------------------------------------------------------------ router
  window.addEventListener('hashchange', route);
  function route() {
    var h = location.hash.replace(/^#/, ''), prm = new URLSearchParams(h), tok = ++S.token;
    if (prm.has('mf') || prm.has('etf')) {
      var key = prm.has('mf') ? 'mf:' + prm.get('mf').replace(/\D/g, '') : 'etf:' + prm.get('etf').toUpperCase().replace(/[^A-Z0-9.\-^=]/g, '');
      S.current = key; setMode('analyze'); setSrc(key.indexOf('mf:') === 0 ? 'mf' : 'gl');
      showAnalysis(key, tok);
    } else if (prm.has('cmp')) {
      var list = (prm.get('cmp') || '').split(',').map(function (s) { s = s.trim(); var m = /^(mf|etf):(.+)$/i.exec(s); return m ? m[1].toLowerCase() + ':' + (m[1].toLowerCase() === 'mf' ? m[2].replace(/\D/g, '') : m[2].toUpperCase()) : null; })
        .filter(function (k, i, a) { return k && !/:$/.test(k) && a.indexOf(k) === i; }).slice(0, 4);
      S.cmp = list; saveLS(LS_CMP, S.cmp); setMode('compare');
      if (list.length && list.every(function (k) { return k.indexOf('etf:') === 0; })) setSrc('gl');
      showCompare(list, tok);
    } else { setMode('analyze'); showHome(); }
  }
  function loading(msg) { $('view').innerHTML = '<div class="gw-card fx-load"><span class="gw-spin dark"></span>' + esc(msg) + '</div>'; }
  function errorCard(msg) { $('view').innerHTML = '<div class="gw-card fx-errc"><p>' + esc(msg) + '</p><button class="gw-btn sm" type="button" data-retry>Try again</button></div>'; }
  function showHome() {
    var demo = 'mf:122639,mf:118989,mf:118778';
    $('view').innerHTML = '<section class="gw-card fx-empty"><h2>Analyze any fund in seconds</h2><p>Search any Indian mutual fund or a global fund / ETF above, or tap a popular pick. You get returns, SIP XIRR, risk, rolling-return consistency and an AI fund score, all computed from the full NAV history.</p>' +
      '<div style="display:flex;gap:10px;justify-content:center;flex-wrap:wrap"><button class="gw-btn" type="button" data-key="mf:122639">Analyze Parag Parikh Flexi Cap</button><button class="gw-btn ghost" type="button" data-demo="' + demo + '">Compare 3 popular funds</button></div></section>';
  }

  // ------------------------------------------------------------------ analysis view
  function showAnalysis(key, tok) {
    loading(key.indexOf('mf:') === 0 ? 'Fetching the full NAV history…' : 'Fetching fund data, this can take a few seconds…');
    loadFund(key).then(function (f) {
      if (tok !== S.token) return;
      names[key] = f.kind === 'gl' ? f.id + ' · ' + f.short : f.short + (f.p.plan ? ' (' + f.p.plan + ')' : '');
      addRecent(f); renderTray();
      document.title = f.short + ' · Mutual Fund Analyzer · Growebtek';
      renderAnalysis(f);
    }, function (e) { if (tok === S.token) errorCard(e.message || 'Could not load this fund.'); });
  }

  function retTile(lbl, x, sub) { return '<div class="fx-ret ' + cls(x) + '"><span>' + lbl + '</span><b class="num ' + cls(x) + '">' + pct(x) + '</b>' + (sub ? '<small>' + sub + '</small>' : '') + '</div>'; }
  function stat(lbl, val, sub, c) { return '<div class="fx-stat"><span>' + lbl + '</span><b class="num ' + (c || '') + '">' + val + (sub ? '<small>' + sub + '</small>' : '') + '</b></div>'; }

  function renderAnalysis(f) {
    var m = metrics(f), x = f.x, inCmp = S.cmp.indexOf(f.key) >= 0, T = TH(f);
    var chips = planChips(f.p) + (f.group ? '<span class="gw-chip ' + (f.kind === 'gl' ? (f.group === 'ETF' ? 'pink' : 'indigo') : 'indigo') + '">' + esc(f.group) + '</span>' : '') +
      (f.category && f.category !== '–' ? '<span class="gw-chip">' + esc(f.category) + '</span>' : '') + (f.kind === 'gl' && f.exchange ? '<span class="gw-chip">' + esc(f.exchange) + ' · ' + esc(f.cur) + '</span>' : '') +
      (f.lev ? '<span class="gw-chip red">Leveraged / inverse</span>' : '');
    var kv = [
      ['Fund age', age(f.latestT - f.since) + (f.kind === 'gl' && f.since < f.t[0] ? '' : '')],
      [f.kind === 'mf' ? 'First NAV' : (x.inception && x.inception <= f.t[0] ? 'Inception (reported)' : 'Data from'), dfmt(f.since)],
      ['Asset class', f.cls === 'debt' ? 'Debt / bonds' : f.cls === 'hybrid' ? 'Hybrid' : 'Equity']
    ];
    if (f.kind === 'mf') { kv.push(['Scheme code', f.id]); if (f.isin) kv.push(['ISIN', f.isin]); }
    else { kv.push(['52W range', fmtNav(f, x.lo52) + ' – ' + fmtNav(f, x.hi52)]); kv.push(['Total assets', fmtBig(f, x.aum)]); }

    var h = '<section class="gw-card fx-head"><div><h1>' + esc(f.kind === 'gl' ? f.id + ' · ' + f.name : f.name) + '</h1><div class="meta">' + esc([f.house, f.catFull].filter(Boolean).join(' · ')) + '</div><div class="chips">' + chips + '</div></div>' +
      '<div class="fx-nav"><div class="lab">' + (f.kind === 'mf' ? 'Latest NAV' : 'Last price') + ' · ' + dfmt(f.latestT) + '</div><div class="big num">' + fmtNav(f, f.latest) + '</div>' +
      '<span class="gw-chip ' + (f.chg > 0 ? 'green' : f.chg < 0 ? 'red' : '') + ' num">' + (ok(f.chg) ? (f.chg > 0 ? '▲ ' : f.chg < 0 ? '▼ ' : '') + fmtNav(f, Math.abs(f.chg)) + ' (' + pct(f.chgPct, 2) + ')' : '–') + ' 1D</span>' +
      '<div class="acts"><button class="gw-btn sm" type="button" data-add-cmp="' + esc(f.key) + '">' + (inCmp ? 'In compare ✓' : '+ Add to compare') + '</button></div></div>' +
      '<div class="fx-kv">' + kv.map(function (k) { return '<div><span>' + k[0] + '</span><b class="' + (/ISIN|code/.test(k[0]) ? 'num' : '') + '" title="' + esc(k[1]) + '">' + esc(k[1]) + '</b></div>'; }).join('') + '</div></section>';
    h += '<div id="rptTop">' + cardLoading('Executive summary') + '</div>';

    // chart
    h += '<section class="gw-card"><div class="fx-hrow"><h2>' + (f.kind === 'mf' ? 'NAV history' : 'Price history') + ' <span class="sub" id="chRet"></span></h2><div class="fx-seg sm" id="rng">' +
      RANGES.map(function (r) { var dis = r[1] && r[1] > 12 && m.yrs < r[1] / 12 - 0.05; return '<button type="button" data-r="' + r[0] + '" ' + (dis ? 'disabled' : '') + ' aria-selected="' + (r[0] === S.range) + '">' + r[0] + '</button>'; }).join('') +
      '</div></div><div id="navChart"></div>' + (f.kind === 'gl' ? '<p class="fx-note">Chart and returns use prices adjusted for dividends and splits (total return).</p>' : '') + '</section>';

    // score + takeaways
    var sc = m.score, tk = takeaways(f, m);
    h += '<div class="fx-score">';
    if (sc) {
      h += '<section class="gw-card fx-sc"><h2>AI Fund Score <span class="sub">rule-based</span></h2><div class="fx-sc-top"><div class="fx-ring">' + ring(sc.overall) + '<b>' + sc.overall.toFixed(1) + '</b></div><div><div class="fx-sc-lbl">' + sc.label + '</div><p>Average of ' + sc.parts.length + ' factors, each scored 0-10 against ' + f.cls + '-fund yardsticks' + (sc.short ? '. Short history: treat with caution' : '') + (f.lev ? '. Capped for leveraged / inverse products' : '') + '.</p></div></div><div class="fx-bars">' +
        sc.parts.map(function (p) { return '<div class="fx-bar"><div class="h"><span>' + p.k + '</span><span>' + p.s.toFixed(1) + '</span></div><div class="tr"><i style="width:' + (p.s * 10) + '%"></i></div><p>' + esc(p.why) + '</p></div>'; }).join('') + '</div></section>';
    } else h += '<section class="gw-card"><h2>AI Fund Score</h2><p class="muted">Not enough history to score this fund yet (needs at least a year of NAVs).</p></section>';
    h += '<section class="gw-card fx-take"><h3>✨ Key takeaways</h3><ul>' + tk.good.map(function (s) { return '<li>' + s + '</li>'; }).join('') + '</ul>' +
      (tk.watch.length ? '<h3>⚠️ Points to watch</h3><ul class="w">' + tk.watch.map(function (s) { return '<li>' + s + '</li>'; }).join('') + '</ul>' : '') + '</section></div>';

    // returns
    var r = m.r;
    h += '<section class="gw-card"><h2>Performance analysis <span class="sub">absolute up to 1Y, CAGR beyond · as of ' + dfmt(f.latestT) + '</span></h2><div class="fx-rets">' +
      retTile('1M', r.m1) + retTile('3M', r.m3) + retTile('6M', r.m6) + retTile('1Y', r.y1) + retTile('3Y', r.y3, 'CAGR') + retTile('5Y', r.y5, 'CAGR') + retTile('7Y', r.y7, 'CAGR') + retTile('10Y', r.y10, 'CAGR') +
      retTile(f.kind === 'gl' && f.since < f.t[0] ? 'Max' : 'Since launch', r.si, m.siAbs ? 'absolute' : 'CAGR') + '</div>' +
      (f.kind === 'gl' && f.since < f.t[0] ? '<p class="fx-note">"Max" covers the available data since ' + mfmt(f.t[0]) + '; the fund itself started in ' + mfmt(f.since) + '.</p>' : '') + '</section>';
    h += '<div id="rptMid">' + cardLoading('Performance vs category &amp; ranking') + '</div>';

    // SIP + risk
    var cur = f.cur === 'INR' ? '₹' : (nf(f.cur, {}).formatToParts(0).filter(function (p) { return p.type === 'currency'; })[0] || {}).value || f.cur;
    var amt = S.sipAmt[f.cur] || (f.cur === 'INR' ? 10000 : 500);
    h += '<div class="gw-grid gw-g2"><section class="gw-card"><h2>SIP calculator <span class="sub">from real NAV history</span></h2><div class="fx-sip-in"><div class="gw-field"><label for="sipAmt">Monthly amount (' + esc(cur) + ')</label><input class="gw-input num" id="sipAmt" type="number" inputmode="numeric" min="100" step="500" value="' + amt + '"></div>' +
      '<div class="gw-field"><label>Period</label><div class="fx-seg sm" id="sipYrs">' + [1, 3, 5, 10].map(function (y) { return '<button type="button" data-y="' + y + '" aria-selected="' + (y === S.sipYrs) + '">' + y + 'Y</button>'; }).join('') + '</div></div></div><div id="sipOut"></div><div id="sipChart"></div></section>';
    var rk = m.risk, dd = m.dd;
    h += '<section class="gw-card"><h2>Risk analysis <span class="sub">' + (rk ? 'volatility & ratios: ' + m.riskLbl : '') + '</span></h2><div class="fx-stats">' +
      stat('Volatility (annualised)', rk ? pct(rk.vol, 1, 1) : '–', rk ? (rk.vol < T.vol[0] + (T.vol[1] - T.vol[0]) * 0.35 ? 'low for its class' : rk.vol > T.vol[0] + (T.vol[1] - T.vol[0]) * 0.65 ? 'high for its class' : 'moderate for its class') : '') +
      stat('Sharpe ratio', rk ? num(rk.sharpe) : '–', 'risk-free ' + pct(f.rf, 1, 1) + ' (assumed)') +
      stat('Sortino ratio', rk ? num(rk.sortino) : '–', 'penalises only downside moves') +
      stat('Maximum drawdown', pct(dd.mdd), dd.mdd < 0 ? dfmt(dd.peakT) + ' → ' + dfmt(dd.troughT) : '', 'dn') +
      stat('Recovery time', dd.mdd >= 0 ? '–' : dd.recT ? dur(dd.recDays) : 'Not yet recovered', dd.recT ? 'back to peak on ' + dfmt(dd.recT) : '') +
      stat('Below all-time high now', pct(dd.cur), '', dd.cur < -0.0005 ? 'dn' : '') +
      stat('Best 1Y period', m.roll1 ? pct(m.roll1.max) : '–', m.roll1 ? 'year ending ' + dfmt(m.roll1.maxT) : '', 'up') +
      stat('Worst 1Y period', m.roll1 ? pct(m.roll1.min) : '–', m.roll1 ? 'year ending ' + dfmt(m.roll1.minT) : '', m.roll1 && m.roll1.min < 0 ? 'dn' : 'up') +
      (f.kind === 'gl' && ok(x.beta) ? stat('Beta (3Y)', num(x.beta), 'vs its benchmark, reported') : '') +
      '</div><p class="fx-note">Downside capture is not shown because no benchmark series is available here.</p></section></div>';

    // consistency
    var r1 = m.roll1, r3 = m.roll3;
    h += '<section class="gw-card"><h2>Consistency <span class="sub">rolling returns over every possible holding period</span></h2>';
    if (r1 || r3) {
      var row = function (lbl, fn) { return '<tr><td>' + lbl + '</td><td class="num">' + (r1 ? fn(r1, 1) : '–') + '</td><td class="num">' + (r3 ? fn(r3, 3) : '–') + '</td></tr>'; };
      h += '<div class="gw-grid gw-g2" style="align-items:start"><div class="gw-tbl-wrap"><table class="gw-tbl fx-roll"><thead><tr><th>Rolling</th><th>1 year</th><th>3 years (CAGR)</th></tr></thead><tbody>' +
        row('Minimum', function (s) { return '<span class="' + cls(s.min) + '">' + pct(s.min) + '</span>'; }) +
        row('Average', function (s) { return '<span class="' + cls(s.avg) + '">' + pct(s.avg) + '</span>'; }) +
        row('Maximum', function (s) { return '<span class="' + cls(s.max) + '">' + pct(s.max) + '</span>'; }) +
        row('% periods positive', function (s) { return pct(s.pos, 0, 1); }) +
        row('% periods &gt; ' + pct(T.hurdle, 0, 1), function (s, k) { return k === 3 ? pct(s.above(T.hurdle), 0, 1) : pct(s.above(T.hurdle), 0, 1); }) +
        row('Periods measured', function (s) { return s.v.length.toLocaleString('en-IN'); }) +
        '</tbody></table></div><div><div id="rollChart"></div><div class="fx-legend">' + (r1 ? '<span><i style="background:#5b5bf6"></i>Rolling 1Y</span>' : '') + (r3 ? '<span><i style="background:#f97316"></i>Rolling 3Y CAGR</span>' : '') + '</div></div></div>';
    } else h += '<p class="muted">Needs at least a year of NAV history.</p>';
    h += '</section>';

    // calendar
    h += '<section class="gw-card"><h2>Calendar-year returns <span class="sub">' + (m.cal.some(function (c) { return c.ytd; }) ? 'latest year is year-to-date' : '') + '</span></h2><div id="calChart"></div></section>';

    // detailed report (filled in once fund details arrive)
    h += '<div id="rptBot">' + cardLoading('Portfolio, costs &amp; verdict') + '</div>';

    h += '<p class="fx-note" style="text-align:center">All numbers are computed from historical ' + (f.kind === 'mf' ? 'NAVs' : 'adjusted prices') + ' and can differ slightly from the fund house\'s published figures.</p>';
    $('view').innerHTML = h;

    drawNav(f);
    drawSip(f);
    if (r1 || r3) {
      var ser = []; if (r1) ser.push({ name: 'Rolling 1Y', color: '#5b5bf6', t: r1.t, v: r1.v, w: 1.6 }); if (r3) ser.push({ name: 'Rolling 3Y CAGR', color: '#f97316', t: r3.t, v: r3.v, w: 2 });
      if (r3 && r1) ser.reverse();
      lineChart($('rollChart'), ser, { zero: true, h: function () { return 220; }, fmtY: function (v) { return Math.round(v * 100) + '%'; }, tip: function (v) { return '<span class="' + cls(v) + '">' + pct(v) + '</span>'; }, label: 'Rolling returns' });
    }
    barChart($('calChart'), m.cal);

    $('rng').addEventListener('click', function (e) { var b = e.target.closest('button[data-r]'); if (!b || b.disabled) return; S.range = b.dataset.r; this.querySelectorAll('button').forEach(function (x) { x.setAttribute('aria-selected', String(x === b)); }); drawNav(f); });
    $('sipYrs').addEventListener('click', function (e) { var b = e.target.closest('button[data-y]'); if (!b) return; S.sipYrs = +b.dataset.y; this.querySelectorAll('button').forEach(function (x) { x.setAttribute('aria-selected', String(x === b)); }); drawSip(f); });
    var sT; $('sipAmt').addEventListener('input', function () { clearTimeout(sT); var v = +this.value; sT = setTimeout(function () { if (v >= 1) { S.sipAmt[f.cur] = v; drawSip(f); } }, 250); });
    fillReport(f, m, S.token);
  }

  function drawNav(f) {
    var rg = RANGES.filter(function (r) { return r[0] === S.range; })[0] || RANGES[2], n = f.t.length, end = f.t[n - 1];
    var start = rg[1] ? addMonths(end, -rg[1]) : f.t[0];
    if (rg[1] && start < f.t[0]) { start = f.t[0]; }
    var i0 = Math.max(0, atOrBefore(f.t, start)), t = f.t.slice(i0), v = f.v.slice(i0);
    var chg = v[v.length - 1] / v[0] - 1, yrs = (t[t.length - 1] - t[0]) / YR;
    $('chRet').innerHTML = '<span class="' + cls(chg) + '">' + pct(chg) + '</span> in ' + (rg[1] && yrs >= rg[1] / 12 - 0.05 ? rg[0] : age(t[t.length - 1] - t[0])) + (yrs >= 1.5 ? ' · ' + pct(cagr(v[0], v[v.length - 1], yrs)) + ' a year' : '');
    var col = chg >= 0 ? '#5b5bf6' : '#ec4899';
    lineChart($('navChart'), [{ name: f.kind === 'mf' ? 'NAV' : 'Adj. price', color: col, t: t, v: v, w: 2.2 }], {
      fill: true, label: 'NAV chart', fmtY: function (y) { return f.cur === 'INR' ? (y >= 1000 ? Math.round(y).toLocaleString('en-IN') : +y.toFixed(y < 20 ? 2 : 0) + '') : (y >= 1000 ? Math.round(y).toLocaleString('en-US') : +y.toFixed(y < 20 ? 2 : 0) + ''); },
      tip: function (y) { return fmtNav(f, y) + ' <span class="' + cls(y / v[0] - 1) + '" style="opacity:.85">(' + pct(y / v[0] - 1) + ')</span>'; }
    });
  }
  function drawSip(f) {
    var amt = S.sipAmt[f.cur] || (f.cur === 'INR' ? 10000 : 500), s = sip(f, amt, S.sipYrs, true), out = $('sipOut');
    if (!s) { out.innerHTML = '<p class="muted">This fund does not have ' + S.sipYrs + ' years of NAV history yet (data from ' + dfmt(f.t[0]) + '). Pick a shorter period.</p>'; $('sipChart').innerHTML = ''; return; }
    out.innerHTML = '<div class="fx-sip-out"><div><span>Invested</span><b class="num">' + fmtAmt(f, s.invested) + '</b></div><div><span>Value today</span><b class="num">' + fmtAmt(f, s.value) + '</b></div>' +
      '<div><span>Gain</span><b class="num ' + cls(s.gain) + '">' + fmtAmt(f, s.gain) + '</b></div><div><span>XIRR</span><b class="num ' + cls(s.xirr) + '">' + pct(s.xirr) + '</b></div></div>' +
      '<p class="fx-note">' + s.n + ' monthly instalments of ' + fmtAmt(f, amt) + ' from ' + mfmt(s.startT) + ', bought at the ' + (f.kind === 'mf' ? 'NAV' : 'price') + ' on each date (next trading day if closed). Absolute gain ' + pct(s.gainPct) + '. Ignores exit load and taxes.</p>';
    lineChart($('sipChart'), [{ name: 'Value', color: '#14b8a6', t: s.series.t, v: s.series.value, fill: true }, { name: 'Invested', color: '#a3a6c4', t: s.series.t, v: s.series.inv, dash: true, w: 1.6 }], {
      h: function () { return 180; }, label: 'SIP growth', fmtY: function (y) { return compactAmt(f, y); }, tip: function (y) { return fmtAmt(f, y); }
    });
  }
  function compactAmt(f, y) {
    if (f.cur === 'INR') { var a = Math.abs(y); return a >= 1e7 ? '₹' + +(y / 1e7).toFixed(1) + 'Cr' : a >= 1e5 ? '₹' + +(y / 1e5).toFixed(1) + 'L' : a >= 1e3 ? '₹' + +(y / 1e3).toFixed(0) + 'K' : '₹' + Math.round(y); }
    return nf(f.cur, { notation: 'compact', maximumFractionDigits: 1 }).format(y);
  }
  function stars(n) {
    var h = '<span class="fx-stars" role="img" aria-label="' + n + ' out of 5 stars">';
    for (var i = 1; i <= 5; i++) h += '<svg width="15" height="15" viewBox="0 0 24 24" aria-hidden="true"><path d="M12 2.5l2.9 6.1 6.6.8-4.9 4.6 1.3 6.6L12 17.3l-5.9 3.3 1.3-6.6-4.9-4.6 6.6-.8z" fill="' + (i <= n ? '#f59e0b' : '#e3e5f1') + '"/></svg>';
    return h + '</span>';
  }
  function sectorName(s) { var M = { realestate: 'Real estate', consumer_cyclical: 'Consumer cyclical', basic_materials: 'Basic materials', consumer_defensive: 'Consumer defensive', communication_services: 'Communication', financial_services: 'Financial services' }; return M[s] || String(s).replace(/_/g, ' ').replace(/^./, function (c) { return c.toUpperCase(); }); }
  function portfolioHtml(f) {
    var x = f.x, BC = ['#5b5bf6', '#8b5cf6', '#ec4899', '#f97316', '#f59e0b', '#14b8a6', '#0ea5e9', '#16a34a', '#a855f7', '#ef4444', '#64748b'];
    var risk = ['', 'Low', 'Below average', 'Average', 'Above average', 'High'];
    var h = '<div class="gw-grid gw-g2"><section class="gw-card"><h2>Costs &amp; ratings</h2><div class="fx-stats">' +
      stat('Expense ratio', ok(x.expense) ? pct(x.expense, 2, 1) : 'Not available', ok(x.expenseCat) ? 'category average ' + pct(x.expenseCat, 2, 1) : '', ok(x.expense) && ok(x.expenseCat) ? (x.expense <= x.expenseCat ? 'up' : 'dn') : '') +
      stat('Total assets (AUM)', fmtBig(f, x.aum)) +
      stat('Yield (trailing)', ok(x.yld) ? pct(x.yld, 2, 1) : '–') +
      stat('YTD return (reported)', pct(x.ytd), '', cls(x.ytd)) +
      stat('Morningstar rating', ok(x.msRating) && x.msRating > 0 ? stars(x.msRating) + '<small>' + x.msRating + ' of 5</small>' : 'Not rated') +
      stat('Morningstar risk', ok(x.msRisk) && x.msRisk > 0 ? risk[x.msRisk] || x.msRisk : '–') +
      stat('P/E of holdings', ok(x.pe) ? num(x.pe, 1) : '–') +
      (ok(x.turnover) && x.turnover > 0 ? stat('Portfolio turnover', pct(x.turnover, 0, 1)) : '') +
      '</div></section>';
    var hasAlloc = ok(x.stock) || ok(x.bond) || ok(x.cash);
    h += '<section class="gw-card"><h2>Asset allocation</h2>';
    if (hasAlloc) {
      var st = x.stock || 0, bd = x.bond || 0, cs = x.cash || 0, ot = Math.max(0, 1 - st - bd - cs);
      var parts = [['Stocks', st, '#5b5bf6'], ['Bonds', bd, '#14b8a6'], ['Cash', cs, '#f59e0b'], ['Other', ot, '#ec4899']].filter(function (p) { return p[1] > 0.0005; });
      h += '<div class="fx-alloc">' + parts.map(function (p) { return '<i style="width:' + (p[1] * 100) + '%;background:' + p[2] + '" title="' + p[0] + ' ' + pct(p[1], 1, 1) + '"></i>'; }).join('') + '</div><div class="fx-legend" style="margin:0 0 12px">' +
        parts.map(function (p) { return '<span><i style="background:' + p[2] + ';height:10px;width:10px;border-radius:3px"></i>' + p[0] + ' ' + pct(p[1], 1, 1) + '</span>'; }).join('') + '</div>';
    } else h += '<p class="muted" style="margin-bottom:12px">Allocation data not available.</p>';
    if (x.sectors.length) {
      var sec = x.sectors.slice().sort(function (a, b) { return b.pct - a.pct; }), mx = sec[0].pct;
      h += '<h2 style="font-size:15px">Sector weights</h2>' + sec.map(function (s, i) { return '<div class="fx-hbar"><span class="n">' + esc(sectorName(s.sector)) + '</span><span class="v num">' + pct(s.pct, 1, 1) + '</span><span class="tr"><i style="width:' + (s.pct / mx * 100) + '%;background:' + BC[i % BC.length] + '"></i></span></div>'; }).join('');
    } else h += '<p class="muted">Sector data not available.</p>';
    h += '</section></div>';
    if (x.holdings.length) {
      var tot = x.holdings.reduce(function (a, b) { return a + b.pct; }, 0), hm = Math.max.apply(null, x.holdings.map(function (q) { return q.pct; }));
      h += '<section class="gw-card"><h2>Top ' + x.holdings.length + ' holdings <span class="sub">' + pct(tot, 1, 1) + ' of the fund</span></h2><div class="gw-grid gw-g2" style="gap:0 28px">' +
        x.holdings.map(function (q, i) { return '<div class="fx-hbar"><span class="n">' + (i + 1) + '. ' + esc(q.name || q.symbol) + (q.symbol ? ' <span class="muted num" style="font-weight:600">' + esc(q.symbol) + '</span>' : '') + '</span><span class="v num">' + pct(q.pct, 2, 1) + '</span><span class="tr"><i style="width:' + (q.pct / hm * 100) + '%;background:' + BC[i % BC.length] + '"></i></span></div>'; }).join('') + '</div></section>';
    }
    if (x.about) h += '<section class="gw-card"><h2>About the fund</h2><p class="fx-about">' + esc(x.about.length > 900 ? x.about.slice(0, 880) + '…' : x.about) + '</p></section>';
    return h;
  }

  // ------------------------------------------------------------------ fund report (details beyond NAV history)
  // Indian funds: the backend gathers AMC/portfolio data (mfinfo). Global funds: Yahoo's fund modules already loaded.
  var infoCache = {};
  function loadInfo(f) {
    if (f.info) return Promise.resolve(f.info);
    if (f.kind === 'gl') { f.info = glInfo(f); return Promise.resolve(f.info); }
    if (!infoCache[f.key]) {
      infoCache[f.key] = GW.api('mfinfo', { code: f.id, isin: f.isin, name: f.name, house: f.house, category: f.catFull }, { timeout: 40000, noRedirect: true })
        .then(function (j) { return mfInfo(f, j); }, function (e) { delete infoCache[f.key]; return { none: true, why: /unknown action/i.test(e.message || '') ? 'Detailed fund data is not switched on yet.' : 'Detailed fund data could not be loaded right now.' }; });
    }
    return infoCache[f.key].then(function (I) { f.info = I.none ? null : I; return I; });
  }
  function P(x) { return x != null && x !== '' && isFinite(+x) ? +x / 100 : null; } // percent -> fraction
  function pDate(s) { if (!s) return null; var t = Date.parse(s); if (!isFinite(t)) { var m = /^(\d{1,2})-([A-Za-z]{3})-(\d{4})$/.exec(s); if (m) t = Date.parse(m[2] + ' ' + m[1] + ', ' + m[3] + ' UTC'); } return isFinite(t) ? t : null; }
  function cap1(s) { s = String(s || '').trim(); return s ? s.charAt(0).toUpperCase() + s.slice(1).toLowerCase() : ''; }
  function mfInfo(f, j) {
    var g = j && j.g, k = j && j.k;
    if (!g && !k) return { none: !(j && j.news && j.news.length), why: 'No detailed data found for this scheme.', news: (j && j.news) || [], src: [] };
    var I = { src: [], news: j.news || [], approx: !!((g && g.approx) || (k && k.approx)) };
    if (g) {
      I.src.push('Groww');
      var rs = g.rs || {}, ca = g.catAvg || {};
      I.aumCr = ok(+g.aum) ? +g.aum : null; I.exp = P(g.exp); I.baseExp = P(g.baseExp); I.exitLoad = g.exitLoad || ''; I.benchmark = g.benchmark || '';
      I.launch = pDate(g.launch); I.minSip = +g.minSip || null; I.minLump = +g.minLump || null; I.riskLbl = g.risk || ''; I.turnover = P(g.turnover);
      var ly = g.lockIn || {}; I.lockIn = ly.years ? ly.years + ' years' : ly.months ? ly.months + ' months' : ly.days ? ly.days + ' days' : '';
      I.tax = g.tax || ''; I.desc = g.desc || '';
      var subW = String(g.sub || f.category).toLowerCase().split(/\s+/)[0];
      if (g.catDesc && subW && g.catDesc.toLowerCase().indexOf(subW) >= 0) I.catDesc = g.catDesc;
      I.sub = g.sub || ''; I.amcAumCr = +g.amcAum || null; I.amcRank = g.amcRank || null; I.stamp = g.stamp || '';
      I.ratings = []; if (ok(g.rating) && g.rating > 0) I.ratings.push({ src: 'Groww', v: g.rating });
      I.managers = (g.managers || []).map(function (m) { return { n: m.n, since: pDate(m.from), edu: m.edu, exp: m.exp, funds: m.funds }; });
      I.hold = (g.hold || []).map(function (h) { return { n: h.n, s: h.s || h.k || '', p: h.p / 100, k: h.k, r: h.r }; });
      I.holdN = g.holdN || I.hold.length; I.holdDate = pDate(g.holdDate);
      I.sectors = (g.sectors || []).map(function (s) { return [s[0], s[1] / 100]; });
      var MIX = { EQUITY: 'Equity', DEBT: 'Debt', CASH: 'Cash & equivalents', MF: 'Mutual fund units', REALEST: 'REITs / InvITs', GOLD: 'Gold', COMMODITY: 'Commodities', OTHERS: 'Others' };
      I.mix = (g.nature || []).map(function (s) { return [MIX[s[0]] || cap1(s[0]), s[1] / 100]; });
      I.top10 = I.hold.slice(0, 10).reduce(function (a, b) { return a + b.p; }, 0) || null;
      I.cat = {};
      [['y1', '1y', '1yr', 'stat_1y'], ['y3', '3y', '3yr', 'stat_3y'], ['y5', '5y', '5yr', 'stat_5y'], ['y10', '10y', '10yr', null]].forEach(function (q) {
        var c = { f: P(rs['return' + q[1]]), c: P(rs['cat_return' + q[1]]), rank: rs['rank' + q[2]], n: rs['rank_count' + q[2]] };
        if (!ok(c.c) && q[3] && ok(ca[q[3]])) c.c = ca[q[3]] / 100;
        if (ok(c.f) || ok(c.c) || ok(c.rank)) I.cat[q[0]] = c;
      });
      I.ratios = { sd: P(rs.standard_deviation), beta: ok(rs.beta) ? rs.beta : null, alpha: P(rs.alpha), sharpe: ok(rs.sharpe_ratio) ? rs.sharpe_ratio : null, sortino: ok(rs.sortino_ratio) ? rs.sortino_ratio : null, ir: ok(rs.information_ratio) ? rs.information_ratio : null };
      I.pros = (g.analysis || []).filter(function (a) { return a.t === 'PROS'; }).map(function (a) { return a.d; });
      I.cons = (g.analysis || []).filter(function (a) { return a.t === 'CONS'; }).map(function (a) { return a.d; });
    }
    if (k) {
      I.src.push('Kuvera');
      I.ratings = I.ratings || [];
      if (ok(k.rating) && k.rating > 0) I.ratings.push({ src: 'Kuvera', v: k.rating, d: k.ratingDate });
      I.objective = k.objective || '';
      if (!ok(I.aumCr) && ok(k.aum)) I.aumCr = k.aum;
      if (!ok(I.exp) && ok(k.exp)) I.exp = k.exp / 100;
      if (!I.riskLbl && k.riskLabel) I.riskLbl = k.riskLabel.replace(/\s*risk$/i, '');
      if (!I.launch && k.start) I.launch = pDate(k.start);
      if (!(I.managers && I.managers.length) && k.managers) I.managers = String(k.managers).split(/;\s*/).filter(Boolean).map(function (n) { return { n: n }; });
      I.vol = P(k.vol);
      I.peers = (k.peers || []).map(function (p) { return { n: p.n, y1: P(p.y1), y3: P(p.y3) || null, y5: P(p.y5) || null, exp: P(p.exp), aumCr: p.aum, vol: P(p.vol) }; });
    }
    I.riskLbl = (I.riskLbl || '').replace(/\s*risk$/i, '');
    return I;
  }
  function glInfo(f) {
    var perf = f.perf || {}, fp = f.fp || {}, x = f.x || {}, tr = perf.trailingReturns || {}, tc = perf.trailingReturnsCat || {}, rk = perf.rankInCategory || {};
    var I = { src: ['Yahoo Finance / Morningstar'], news: [], gl: true };
    I.aum = x.aum; I.exp = x.expense; I.expCat = x.expenseCat; I.turnover = x.turnover; I.launch = x.inception; I.desc = x.about || '';
    var fe = fp.feesExpensesInvestment || {}, ld = [];
    if (ok(fe.frontEndSalesLoad) && fe.frontEndSalesLoad > 0) ld.push('Front-end sales load ' + pct(fe.frontEndSalesLoad, 2, 1));
    if (ok(fe.deferredSalesLoad) && fe.deferredSalesLoad > 0) ld.push('deferred sales load ' + pct(fe.deferredSalesLoad, 2, 1));
    I.exitLoad = ld.length ? ld.join('; ') + '.' : (f.group === 'ETF' ? 'None. ETFs trade on the exchange; you pay only brokerage and the bid-ask spread.' : 'No sales load reported.');
    I.minLump = fp.initInvestment || null;
    var mi = fp.managementInfo || {};
    I.managers = mi.managerName || mi.managerBio ? [{ n: mi.managerName || '', since: ok(mi.startdate) ? mi.startdate * 1000 : null, exp: mi.managerBio || '' }] : [];
    I.ratings = []; if (ok(x.msRating) && x.msRating > 0) I.ratings.push({ src: 'Morningstar', v: x.msRating });
    I.riskLbl = ['', 'Low', 'Below average', 'Average', 'Above average', 'High'][x.msRisk] || '';
    I.cat = {};
    [['y1', 'oneYear'], ['y3', 'threeYear'], ['y5', 'fiveYear'], ['y10', 'tenYear']].forEach(function (q) {
      var c = { f: ok(tr[q[1]]) ? tr[q[1]] : null, c: ok(tc[q[1]]) ? tc[q[1]] : null, pctl: ok(rk[q[1]]) ? rk[q[1]] : null };
      if (ok(c.f) || ok(c.c) || ok(c.pctl)) I.cat[q[0]] = c;
    });
    var rs = ((perf.riskOverviewStatistics || {}).riskStatistics || []).filter(function (r) { return r.year === '3y'; })[0];
    if (rs) I.ratios = { sd: P(rs.stdDev), beta: rs.beta, alpha: P(rs.alpha), sharpe: rs.sharpeRatio, r2: rs.rSquared };
    var po = perf.performanceOverview || {};
    I.yearsUp = po.numYearsUp; I.yearsDown = po.numYearsDown; I.bull = tr.lastBullMkt; I.bear = tr.lastBearMkt; I.bullCat = tc.lastBullMkt; I.bearCat = tc.lastBearMkt;
    I.hold = (x.holdings || []).map(function (h) { return { n: h.name || h.symbol, s: h.symbol || '', p: h.pct }; });
    I.top10 = I.hold.reduce(function (a, b) { return a + b.p; }, 0) || null;
    I.sectors = (x.sectors || []).slice().sort(function (a, b) { return b.pct - a.pct; }).map(function (s) { return [sectorName(s.sector), s.pct]; });
    I.mix = [['Stocks', x.stock], ['Bonds', x.bond], ['Cash', x.cash]].filter(function (p) { return ok(p[1]) && p[1] > 0.0005; });
    I.pros = []; I.cons = [];
    return I;
  }

  // --- derived judgements shared by the analyzer and the comparison
  function fmtCr(x) { return ok(x) ? '₹' + Math.round(x).toLocaleString('en-IN') + ' Cr' : '–'; }
  function aumTxt(f, I) { return I && f.kind === 'mf' ? fmtCr(I.aumCr) : I && ok(I.aum) ? fmtBig(f, I.aum) : '–'; }
  function horizon(f) {
    var c = (f.catFull + ' ' + f.name).toLowerCase();
    if (/overnight|liquid|money market/.test(c)) return [0, 'a few days to 1 year'];
    if (/ultra short|low duration|arbitrage/.test(c)) return [1, '6 months to 2 years'];
    if (/short duration|banking and psu|banking & psu|corporate bond|floater|medium duration|credit risk/.test(c)) return [2, '2 to 4 years'];
    if (/gilt|dynamic bond|long duration|medium to long/.test(c)) return [3, '3 to 5 years'];
    if (f.cls === 'debt') return [2, '2 to 4 years'];
    if (/conservative hybrid|equity savings/.test(c)) return [3, '3 years or more'];
    if (f.cls === 'hybrid') return [4, '4 to 5 years or more'];
    if (/small cap|sectoral|thematic|sector|international|fof overseas|technology|pharma|infra/.test(c)) return [7, '7 years or more'];
    if (/mid cap/.test(c)) return [6, '6 to 7 years or more'];
    return [5, '5 years or more'];
  }
  function riskLevel(f, m, I) {
    if (I && I.riskLbl) return I.riskLbl;
    var T = TH(f), v = m.risk ? m.risk.vol : null;
    if (!ok(v)) return f.cls === 'debt' ? 'Low to moderate' : f.cls === 'hybrid' ? 'Moderately high' : 'High';
    var r = (v - T.vol[0]) / (T.vol[1] - T.vol[0]);
    return f.cls === 'debt' ? (r < 0.4 ? 'Low' : r < 0.7 ? 'Moderate' : 'Moderately high') : r < 0.35 ? 'Moderate' : r < 0.65 ? 'High' : 'Very high';
  }
  function verdict(f, m, I) {
    var sc = m.score, o = sc ? sc.overall : null, adj = 0, why = [];
    var c3 = I && I.cat && (I.cat.y5 || I.cat.y3);
    if (c3 && ok(c3.f) && ok(c3.c)) { var d = c3.f - c3.c; if (d > 0.015) { adj += 0.3; why.push('beats its category average'); } else if (d < -0.015) { adj -= 0.3; why.push('trails its category average'); } }
    if (I && f.kind === 'mf' && ok(I.exp)) { if (I.exp > 0.018) { adj -= 0.2; why.push('costs are high'); } else if (I.exp < 0.008) { adj += 0.1; why.push('costs are low'); } }
    if (f.lev) return { k: 'Avoid for long-term', c: 'red', s: o, why: 'Leveraged / inverse products are built for short-term trading.' };
    if (o == null) return { k: 'Too new to judge', c: 'amber', s: null, why: 'Less than a year of history.' };
    var s = Math.max(0, Math.min(10, o + adj));
    var k = s >= 7.5 ? ['Strong pick', 'green'] : s >= 6 ? ['Good, worth considering', 'green'] : s >= 4.5 ? ['Average, compare first', 'amber'] : ['Weak, look at alternatives', 'red'];
    return { k: k[0], c: k[1], s: Math.round(s * 10) / 10, why: why.join(', ') };
  }
  function quantile(arr, q) { var a = arr.slice().sort(function (x, y) { return x - y; }), i = (a.length - 1) * q, lo = Math.floor(i); return a.length ? a[lo] + (a[Math.min(lo + 1, a.length - 1)] - a[lo]) * (i - lo) : null; }
  function scenarios(f, m, I) {
    var out = [], r1 = m.roll1, r3 = m.roll3;
    if (r1 && r1.v.length > 30) out.push({ h: '1 year', bear: quantile(r1.v, 0.1), base: quantile(r1.v, 0.5), bull: quantile(r1.v, 0.9), yrs: 1, n: r1.v.length });
    if (r3 && r3.v.length > 30) out.push({ h: '3 years (a year)', bear: quantile(r3.v, 0.1), base: quantile(r3.v, 0.5), bull: quantile(r3.v, 0.9), yrs: 3, n: r3.v.length });
    var beta = I && I.ratios && ok(I.ratios.beta) && I.ratios.beta > 0 ? I.ratios.beta : null;
    var crash = f.cls === 'debt' ? null : { mkt: f.cls === 'hybrid' ? -0.2 : -0.2, fund: beta ? -0.2 * beta : f.cls === 'hybrid' ? -0.2 * 0.6 : -0.2, beta: beta };
    return { rows: out, crash: crash, worst: m.dd.mdd };
  }
  function suitability(f, m, I) {
    var hz = horizon(f), rl = riskLevel(f, m, I), fits = [], not = [];
    var elss = /elss|tax sav/i.test(f.catFull + ' ' + f.name);
    if (f.cls === 'equity') { fits.push('Investors building long-term wealth who can hold for ' + hz[1] + '.'); fits.push('SIP investors: monthly investing smooths out the swings.'); not.push('Money needed within ' + Math.max(2, hz[0] - 2) + ' years, or an emergency fund.'); not.push('Anyone who would panic-sell in a ' + Math.round(Math.abs(Math.min(m.dd.mdd || -0.3, -0.2)) * 100) + '% fall.'); }
    else if (f.cls === 'hybrid') { fits.push('Moderate-risk investors wanting equity growth with a debt cushion, for ' + hz[1] + '.'); fits.push('First-time investors stepping up from FDs.'); not.push('Very short goals (under 2 years).'); }
    else { fits.push('Parking money or near-term goals over ' + hz[1] + '.'); fits.push('Conservative investors who want steadier returns than equity.'); not.push('Long-term wealth creation: equity usually beats debt over 7+ years.'); }
    if (elss) fits.push('Tax saving under Section 80C (old tax regime) with a 3-year lock-in.');
    if (f.p.plan === 'Regular') not.push('Do-it-yourself investors: the Direct plan of this scheme is cheaper.');
    if (f.p.opt === 'IDCW') not.push('Compounding: the Growth option reinvests gains; IDCW pays them out.');
    if (/international|overseas|global|us /i.test(f.catFull + ' ' + f.name) || f.cur !== 'INR') fits.push('Diversifying outside Indian markets (returns also depend on currency moves).');
    return { hz: hz[1], risk: rl, fits: fits, not: not, mode: f.cls === 'debt' ? 'Lump sum or STP is fine' : 'SIP preferred; lump sum on big dips', lock: (I && I.lockIn) || (elss ? '3 years' : 'None') };
  }
  function prosCons(f, m, I) {
    var pros = [], cons = [], r = m.r, T = TH(f), c = I && I.cat;
    var c5 = c && (c.y5 || c.y3), lbl = c && c.y5 ? '5Y' : '3Y';
    if (c5 && ok(c5.f) && ok(c5.c)) (c5.f >= c5.c ? pros : cons).push((c5.f >= c5.c ? 'Beat' : 'Trailed') + ' its category average over ' + lbl + ' (' + pct(c5.f) + ' vs ' + pct(c5.c) + ' a year).');
    var rk = c && (c.y3 || c.y5);
    if (rk && ok(rk.rank) && rk.n) (rk.rank <= rk.n / 3 ? pros : rk.rank > rk.n * 2 / 3 ? cons : []).push('Ranked ' + rk.rank + ' of ' + rk.n + ' in its category over ' + (c.y3 ? '3' : '5') + ' years.');
    if (rk && ok(rk.pctl)) (rk.pctl <= 33 ? pros : rk.pctl > 66 ? cons : []).push('In the ' + (rk.pctl <= 50 ? 'top ' + rk.pctl + '%' : 'bottom ' + (100 - rk.pctl) + '%') + ' of its Morningstar category over 3 years.');
    if (m.roll3 && m.roll3.pos > 0.95) pros.push('Positive in ' + pct(m.roll3.pos, 0, 1) + ' of rolling 3-year periods.');
    if (m.roll3 && m.roll3.above(T.hurdle) < 0.5) cons.push('Beat ' + pct(T.hurdle, 0, 1) + ' a year in only ' + pct(m.roll3.above(T.hurdle), 0, 1) + ' of rolling 3-year periods.');
    if (m.risk && ok(m.risk.sharpe)) (m.risk.sharpe >= 0.8 ? pros : m.risk.sharpe < 0.3 ? cons : []).push('Sharpe ratio ' + num(m.risk.sharpe) + ': ' + (m.risk.sharpe >= 0.8 ? 'good' : 'weak') + ' return for the risk taken.');
    if (I && ok(I.exp)) { var hiE = f.kind === 'mf' ? (f.cls === 'equity' ? 0.012 : 0.008) : 0.0075, loE = f.kind === 'mf' ? (f.cls === 'equity' ? 0.007 : 0.004) : 0.002; if (I.exp <= loE) pros.push('Low expense ratio of ' + pct(I.exp, 2, 1) + '.'); else if (I.exp >= hiE) cons.push('Expense ratio of ' + pct(I.exp, 2, 1) + ' is on the higher side.'); }
    if (I && f.kind === 'mf' && ok(I.aumCr)) { if (I.aumCr > 50000 && /small|mid/i.test(f.catFull)) cons.push('Very large fund (' + fmtCr(I.aumCr) + ') for a ' + (/small/i.test(f.catFull) ? 'small' : 'mid') + '-cap mandate; harder to stay nimble.'); else if (I.aumCr < 500) cons.push('Small fund (' + fmtCr(I.aumCr) + '); size and costs can be less stable.'); else if (I.aumCr > 10000) pros.push('Large, established fund (' + fmtCr(I.aumCr) + ' AUM).'); }
    if (I && ok(I.top10) && I.top10 > 0.55) cons.push('Concentrated: top 10 holdings are ' + pct(I.top10, 0, 1) + ' of the portfolio.');
    else if (I && ok(I.top10) && I.top10 < 0.35 && f.cls !== 'debt') pros.push('Well diversified: top 10 holdings are ' + pct(I.top10, 0, 1) + ' of the portfolio.');
    if (m.dd.mdd < T.mdd[1] * 0.8) cons.push('Deep worst fall of ' + pct(m.dd.mdd) + '.');
    if (m.yrs < 3) cons.push('Short track record (' + age(f.latestT - f.t[0]) + ').');
    if (f.p.plan === 'Regular') cons.push('Regular plan: higher cost than the Direct plan.');
    if (f.lev) cons.push('Leveraged / inverse: not for long-term holding.');
    return { pros: pros.concat((I && I.pros) || []).slice(0, 7), cons: cons.concat((I && I.cons) || []).slice(0, 7) };
  }

  // --- analyzer sections
  function cardLoading(t) { return '<section class="gw-card"><h2>' + t + '</h2><p class="muted"><span class="gw-spin dark" style="width:14px;height:14px;vertical-align:-2px;margin-right:8px"></span>Loading fund details…</p></section>'; }
  function naCard(t, msg) { return '<section class="gw-card"><h2>' + t + '</h2><p class="muted">' + msg + '</p></section>'; }
  function kvList(rows) { return '<div class="fx-kv2">' + rows.filter(function (r) { return r && r[1] != null && r[1] !== '' && r[1] !== '–'; }).map(function (r) { return '<div><span>' + r[0] + '</span><b>' + r[1] + '</b></div>'; }).join('') + '</div>'; }
  function src(I, extra) { return I && I.src && I.src.length ? '<p class="fx-note">Source: ' + esc(I.src.join(', ')) + (extra || '') + (I.approx ? '. Portfolio, ratios and costs are for the Direct Growth plan of this scheme; this plan\'s expense ratio is higher' : '') + '.</p>' : ''; }

  function execSummary(f, m, I) {
    var v = verdict(f, m, I), r = m.r, b = [];
    var lp = ok(r.y5) ? ['5', r.y5] : ok(r.y3) ? ['3', r.y3] : ok(r.y1) ? ['1', r.y1] : null;
    b.push('<b>' + esc(f.short) + '</b> is ' + (/^[aeiou]/i.test(f.category) ? 'an ' : 'a ') + esc(f.category !== '–' ? f.category : f.cls) + (/\bfunds?$/i.test(f.category) ? '' : ' fund') + (f.house ? ' from ' + esc(f.house.replace(/ Mutual Fund$/i, '')) : '') + (I && (ok(I.aumCr) || ok(I.aum)) ? ' managing <b>' + aumTxt(f, I) + '</b>' : '') + ', running for ' + age(f.latestT - f.since) + '.');
    if (lp) b.push('It returned <b>' + pct(lp[1]) + (lp[0] === '1' ? '' : ' a year') + '</b> over ' + lp[0] + ' year' + (lp[0] === '1' ? '' : 's') + (I && I.cat && I.cat['y' + lp[0]] && ok(I.cat['y' + lp[0]].c) ? ' vs a category average of ' + pct(I.cat['y' + lp[0]].c) : '') + '.');
    var rk = I && I.cat && (I.cat.y3 || I.cat.y1);
    if (rk && ok(rk.rank) && rk.n) b.push('Category rank: <b>' + rk.rank + ' of ' + rk.n + '</b> over ' + (I.cat.y3 ? '3 years' : '1 year') + '.');
    else if (rk && ok(rk.pctl)) b.push('Morningstar category percentile: <b>' + rk.pctl + '</b> over ' + (I.cat.y3 ? '3 years' : '1 year') + ' (lower is better).');
    b.push('Risk: <b>' + esc(riskLevel(f, m, I)) + '</b>' + (m.risk ? ', volatility ' + pct(m.risk.vol, 1, 1) : '') + ', worst fall ' + pct(m.dd.mdd) + '.');
    if (I && ok(I.exp)) b.push('Expense ratio <b>' + pct(I.exp, 2, 1) + '</b>; exit load: ' + esc(shortLoad(I.exitLoad)) + '.');
    return '<section class="gw-card fx-exec"><div class="fx-hrow"><h2>Executive summary</h2><span class="gw-chip ' + v.c + '">' + esc(v.k) + (v.s != null ? ' · ' + v.s.toFixed(1) + '/10' : '') + '</span></div><ul class="fx-sum">' + b.map(function (s) { return '<li>' + s + '</li>'; }).join('') + '</ul>' +
      '<p class="fx-note">Suits: ' + esc(suitability(f, m, I).hz) + ' horizon, ' + esc(riskLevel(f, m, I).toLowerCase()) + ' risk appetite.' + (I ? '' : ' Fund details are loading or unavailable, so this summary uses NAV history only.') + '</p></section>';
  }
  function shortLoad(s) { s = String(s || '').trim().replace(/\.+$/, ''); if (!s) return 'not available'; if (/^nil|^none|^0(\.0+)?%?$/i.test(s)) return 'Nil'; var m = /(\d+(?:\.\d+)?)\s*%[^.]*?(\d+)\s*(day|days|month|months|year|years)/i.exec(s); return m ? m[1] + '% if redeemed within ' + m[2] + ' ' + m[3].toLowerCase().replace(/s$/, '') + (m[2] === '1' ? '' : 's') : s.length > 70 ? s.slice(0, 68) + '…' : s; }

  function snapshotHtml(f, m, I) {
    var x = f.x || {}, iv = f.t.length > 260 ? f.v.slice(-260) : f.v, hi = Math.max.apply(null, iv), lo = Math.min.apply(null, iv);
    var snap = kvList([
      ['Fund house', esc(f.house || '–')], ['Category', esc(f.catFull || f.category)], ['Plan / option', esc([f.p.plan, f.p.opt].filter(Boolean).join(' · ') || f.group || '–')],
      ['Benchmark', I && I.benchmark ? esc(I.benchmark) : '–'], ['Launched', I && I.launch ? dfmt(I.launch) : dfmt(f.since)], ['Riskometer / risk', esc(riskLevel(f, m, I))],
      ['Min SIP', I && I.minSip ? fmtAmt(f, I.minSip) : '–'], ['Min lump sum', I && I.minLump ? fmtAmt(f, I.minLump) : '–'], ['Lock-in', I ? esc(I.lockIn || (/elss|tax sav/i.test(f.catFull) ? '3 years' : 'None')) : '–'],
      ['Investment horizon', esc(horizon(f)[1])]
    ]);
    var nav = kvList([
      [f.kind === 'mf' ? 'Latest NAV' : 'Last price', '<span class="num">' + fmtNav(f, f.latest) + '</span> <small class="muted">' + dfmt(f.latestT) + '</small>'],
      ['1-day change', '<span class="num ' + cls(f.chg) + '">' + pct(f.chgPct, 2) + '</span>'],
      ['52-week high / low', '<span class="num">' + fmtNav(f, hi) + ' / ' + fmtNav(f, lo) + '</span>'],
      ['From all-time high', '<span class="num ' + cls(m.dd.cur) + '">' + pct(m.dd.cur) + '</span>'],
      ['AUM (fund size)', I ? '<span class="num">' + aumTxt(f, I) + '</span>' : (f.kind === 'gl' ? fmtBig(f, x.aum) : '–')],
      ['AMC total AUM', I && ok(I.amcAumCr) ? '<span class="num">' + fmtCr(I.amcAumCr) + '</span>' + (I.amcRank ? ' <small class="muted">#' + I.amcRank + ' AMC</small>' : '') : '–'],
      ['YTD return', '<span class="num ' + cls(ytd(f)) + '">' + pct(ytd(f)) + '</span>']
    ]);
    return '<div class="gw-grid gw-g2"><section class="gw-card"><h2>Fund snapshot</h2>' + snap + '</section><section class="gw-card"><h2>Latest NAV &amp; AUM</h2>' + nav + (I && I.aumCr ? '<p class="fx-note">AUM as last reported by the fund house; NAV from AMFI.</p>' : '') + '</section></div>';
  }
  function ytd(f) { var y0 = Date.UTC(new Date(f.latestT).getUTCFullYear(), 0, 1), i = atOrBefore(f.t, y0 - 1); return i >= 0 ? f.latest / f.v[i] - 1 : null; }
  function strategyHtml(f, I) {
    var h = '';
    if (I && I.objective) h += '<h3>Objective</h3><p class="fx-about">' + esc(I.objective) + '</p>';
    if (I && I.desc && I.desc !== I.objective) h += '<h3>' + (I.objective ? 'Strategy' : 'Objective &amp; strategy') + '</h3><p class="fx-about">' + esc(I.desc.length > 900 ? I.desc.slice(0, 880) + '…' : I.desc) + '</p>';
    if (I && I.catDesc) h += '<h3>About the ' + esc(I.sub || f.category) + ' category</h3><p class="fx-about">' + esc(I.catDesc) + '</p>';
    if (I && I.benchmark) h += '<p class="fx-about">Benchmark: <b>' + esc(I.benchmark) + '</b>' + (ok(I.turnover) ? ' · Portfolio turnover: <b>' + pct(I.turnover, 0, 1) + '</b> a year (' + (I.turnover > 0.8 ? 'active trading' : I.turnover > 0.3 ? 'moderate trading' : 'mostly buy-and-hold') + ')' : '') + '.</p>';
    if (!h) h = '<p class="muted">' + (I ? 'The fund\'s objective is not available from the data sources.' : 'Not available right now.') + '</p>';
    return '<section class="gw-card"><h2>Fund strategy &amp; objective</h2>' + h + '</section>';
  }
  function rankHtml(f, m, I) {
    var c = I && I.cat || {}, keys = ['y1', 'y3', 'y5', 'y10'].filter(function (k) { return c[k]; }), L = { y1: '1 year', y3: '3 years', y5: '5 years', y10: '10 years' };
    var h = '<section class="gw-card"><h2>Performance vs category &amp; ranking <span class="sub">' + (f.kind === 'mf' ? 'CAGR beyond 1Y, as reported' : 'trailing returns, as reported') + '</span></h2>';
    if (!keys.length) return h + '<p class="muted">Category comparison is not available for this fund.</p></section>';
    h += '<div class="gw-tbl-wrap"><table class="gw-tbl"><thead><tr><th>Period</th><th>Fund</th><th>Category avg</th><th>Difference</th><th>' + (f.kind === 'mf' ? 'Rank in category' : 'Category percentile') + '</th></tr></thead><tbody>' +
      keys.map(function (k) { var q = c[k], d = ok(q.f) && ok(q.c) ? q.f - q.c : null; var rk = ok(q.rank) && q.n ? '<b>' + q.rank + '</b> / ' + q.n + ' <small class="muted">' + (q.rank <= q.n / 4 ? 'top quartile' : q.rank <= q.n / 2 ? '2nd quartile' : q.rank <= q.n * 3 / 4 ? '3rd quartile' : 'bottom quartile') + '</small>' : ok(q.pctl) ? '<b>' + q.pctl + '</b> <small class="muted">' + (q.pctl <= 25 ? 'top quartile' : q.pctl <= 50 ? '2nd quartile' : q.pctl <= 75 ? '3rd quartile' : 'bottom quartile') + '</small>' : '–';
        return '<tr><td>' + L[k] + '</td><td class="num ' + cls(q.f) + '">' + pct(q.f) + '</td><td class="num">' + pct(q.c) + '</td><td class="num ' + cls(d) + '">' + (ok(d) ? pct(d) : '–') + '</td><td class="num">' + rk + '</td></tr>'; }).join('') +
      '</tbody></table></div>';
    if (I.gl && ok(I.bull)) h += '<p class="fx-about">Last bull market: <b class="' + cls(I.bull) + '">' + pct(I.bull) + '</b> (category ' + pct(I.bullCat) + ') · last bear market: <b class="' + cls(I.bear) + '">' + pct(I.bear) + '</b> (category ' + pct(I.bearCat) + ')' + (ok(I.yearsUp) ? ' · ' + I.yearsUp + ' up years, ' + (I.yearsDown || 0) + ' down years' : '') + '.</p>';
    return h + (f.kind === 'mf' ? '<p class="fx-note">Rank 1 is the best performer among funds in the same category with that much history.</p>' : '<p class="fx-note">Percentile 1 is the best; 100 the worst.</p>') + '</section>';
  }
  function peersHtml(f, m, I) {
    var p = I && I.peers || [];
    var h = '<section class="gw-card"><h2>Competitor funds in the same category</h2>';
    if (!p.length) return h + '<p class="muted">' + (f.kind === 'gl' ? 'A peer list is not available for global funds here. Use Compare to line this fund up against others.' : 'A peer list is not available for this scheme.') + '</p></section>';
    var me = { n: f.short + ' (this fund)', y1: m.r.y1, y3: m.r.y3, y5: m.r.y5, exp: I.exp, aumCr: I.aumCr, vol: m.risk && m.risk.vol, me: true };
    var all = p.concat([me]).sort(function (a, b) { return (ok(b.y3) ? b.y3 : -9) - (ok(a.y3) ? a.y3 : -9); });
    h += '<div class="gw-tbl-wrap"><table class="gw-tbl"><thead><tr><th>Fund</th><th>1Y</th><th>3Y CAGR</th><th>5Y CAGR</th><th>Expense</th><th>AUM</th><th>Volatility</th></tr></thead><tbody>' +
      all.map(function (q) { return '<tr' + (q.me ? ' class="me"' : '') + '><td>' + (q.me ? '<b>' + esc(q.n) + '</b>' : esc(q.n)) + '</td><td class="num ' + cls(q.y1) + '">' + pct(q.y1) + '</td><td class="num ' + cls(q.y3) + '">' + pct(q.y3) + '</td><td class="num ' + cls(q.y5) + '">' + pct(q.y5) + '</td><td class="num">' + (ok(q.exp) ? pct(q.exp, 2, 1) : '–') + '</td><td class="num">' + fmtCr(q.aumCr) + '</td><td class="num">' + (ok(q.vol) ? pct(q.vol, 1, 1) : '–') + '</td></tr>'; }).join('') +
      '</tbody></table></div><p class="fx-note">Leading funds in the category by recent performance (Direct plans), plus this fund for reference. Sorted by 3Y CAGR.</p></section>';
    return h;
  }
  function riskRatiosHtml(f, m, I) {
    var r = I && I.ratios; if (!r) return '';
    var it = [
      ['Standard deviation', ok(r.sd) ? pct(r.sd, 2, 1) : null, 'how much returns swing; lower is steadier'],
      ['Beta', ok(r.beta) ? num(r.beta) : null, ok(r.beta) ? (r.beta < 0.9 ? 'moves less than its benchmark' : r.beta > 1.1 ? 'moves more than its benchmark' : 'moves in line with its benchmark') : ''],
      ['Alpha', ok(r.alpha) ? pct(r.alpha, 2) : null, ok(r.alpha) ? (r.alpha > 0 ? 'beat its benchmark after adjusting for risk' : 'lagged its benchmark after adjusting for risk') : ''],
      ['Sharpe ratio', ok(r.sharpe) ? num(r.sharpe) : null, 'return per unit of risk'],
      ['Sortino ratio', ok(r.sortino) ? num(r.sortino) : null, 'return per unit of downside risk'],
      ['Information ratio', ok(r.ir) ? num(r.ir) : null, 'consistency of beating the benchmark'],
      ['R-squared', ok(r.r2) ? num(r.r2, 0) : null, 'how closely it tracks its benchmark (100 = exactly)']
    ].filter(function (x) { return x[1] != null; });
    if (!it.length) return '';
    return '<section class="gw-card"><h2>Risk analysis <span class="sub">reported ratios, 3 years</span></h2><div class="fx-stats">' + it.map(function (x) { return stat(x[0], x[1], x[2]); }).join('') + stat('Riskometer', esc(riskLevel(f, m, I)), f.kind === 'mf' ? 'SEBI risk label' : 'Morningstar risk') + '</div></section>';
  }
  var BCOL = ['#5b5bf6', '#8b5cf6', '#ec4899', '#f97316', '#f59e0b', '#14b8a6', '#0ea5e9', '#16a34a', '#a855f7', '#ef4444', '#64748b', '#0f766e'];
  function portfolioMF(f, I) {
    var h = '<div class="gw-grid gw-g2"><section class="gw-card"><h2>Portfolio composition</h2>';
    if (I.mix && I.mix.length) {
      h += '<div class="fx-alloc">' + I.mix.map(function (p, i) { return '<i style="width:' + (p[1] * 100) + '%;background:' + BCOL[i % 12] + '" title="' + esc(p[0]) + ' ' + pct(p[1], 1, 1) + '"></i>'; }).join('') + '</div><div class="fx-legend" style="margin:0 0 12px">' +
        I.mix.map(function (p, i) { return '<span><i style="background:' + BCOL[i % 12] + ';height:10px;width:10px;border-radius:3px"></i>' + esc(p[0]) + ' ' + pct(p[1], 1, 1) + '</span>'; }).join('') + '</div>';
    }
    if (I.sectors && I.sectors.length) {
      var mx = I.sectors[0][1];
      h += '<h2 style="font-size:15px">Sector weights</h2>' + I.sectors.slice(0, 10).map(function (s, i) { return '<div class="fx-hbar"><span class="n">' + esc(s[0]) + '</span><span class="v num">' + pct(s[1], 1, 1) + '</span><span class="tr"><i style="width:' + (s[1] / mx * 100) + '%;background:' + BCOL[i % 12] + '"></i></span></div>'; }).join('');
    }
    if (!(I.mix && I.mix.length) && !(I.sectors && I.sectors.length)) h += '<p class="muted">Portfolio data not available.</p>';
    h += '<p class="fx-note">' + (I.holdN ? I.holdN + ' holdings' : '') + (I.holdDate ? ' · portfolio as of ' + dfmt(I.holdDate) : '') + (ok(I.top10) ? ' · top 10 = ' + pct(I.top10, 1, 1) + ' of the fund' : '') + '</p></section>';
    h += '<section class="gw-card"><h2>Top holdings</h2>';
    if (I.hold && I.hold.length) {
      var hm = I.hold[0].p;
      h += I.hold.slice(0, 15).map(function (q, i) { return '<div class="fx-hbar"><span class="n">' + (i + 1) + '. ' + esc(q.n) + ' <span class="muted" style="font-weight:600">' + esc(q.r || q.s) + '</span></span><span class="v num">' + pct(q.p, 2, 1) + '</span><span class="tr"><i style="width:' + (q.p / hm * 100) + '%;background:' + BCOL[i % 12] + '"></i></span></div>'; }).join('');
    } else h += '<p class="muted">Holdings not available.</p>';
    return h + '</section></div>';
  }
  function mgmtHtml(f, I) {
    var h = '<section class="gw-card"><h2>Fund management &amp; expenses</h2><div class="gw-grid gw-g2" style="align-items:start"><div>';
    var ms = (I && I.managers) || [];
    if (ms.length) h += '<h3>Fund manager' + (ms.length > 1 ? 's' : '') + '</h3>' + ms.slice(0, 6).map(function (q) { return '<div class="fx-mgr"><b>' + esc(q.n || 'Fund manager') + '</b>' + (q.since ? ' <small class="muted">since ' + mfmt(q.since) + ' (' + age(Date.now() - q.since) + ')</small>' : '') + (q.edu ? '<p>' + esc(q.edu) + '</p>' : '') + (q.exp ? '<p class="muted">' + esc(q.exp.length > 300 ? q.exp.slice(0, 298) + '…' : q.exp) + '</p>' : '') + '</div>'; }).join('');
    else h += '<p class="muted">Manager details not available.</p>';
    h += '</div><div><h3>Costs</h3>' + kvList([
      ['Expense ratio (TER)', I && ok(I.exp) ? '<span class="num">' + pct(I.exp, 2, 1) + '</span>' + (ok(I.expCat) ? ' <small class="muted">category ' + pct(I.expCat, 2, 1) + '</small>' : '') : '–'],
      ['Base expense (before GST etc.)', I && ok(I.baseExp) ? '<span class="num">' + pct(I.baseExp, 2, 1) + '</span>' : null],
      ['Cost of ' + (f.cur === 'INR' ? '₹1 lakh' : fmtAmt(f, 10000)) + ' a year', I && ok(I.exp) ? '<span class="num">' + fmtAmt(f, (f.cur === 'INR' ? 100000 : 10000) * I.exp) + '</span>' : null],
      ['Portfolio turnover', I && ok(I.turnover) ? '<span class="num">' + pct(I.turnover, 0, 1) + '</span>' : null],
      ['Stamp duty on purchase', I && I.stamp ? esc(I.stamp) : null]
    ]) + (f.p.plan === 'Regular' ? '<p class="fx-note">Regular plans pay a distributor commission inside the expense ratio, typically 0.5–1% a year more than Direct.</p>' : '') + '</div></div></section>';
    return h;
  }
  function exitHtml(f, I) {
    var h = '<section class="gw-card"><h2>Exit load, lock-in &amp; tax</h2>';
    h += kvList([['Exit load', I && I.exitLoad ? esc(I.exitLoad) : 'Not available; check the scheme document.'], ['Lock-in', I ? esc(I.lockIn || (/elss|tax sav/i.test(f.catFull) ? '3 years' : 'None')) : '–'], ['Tax on gains', I && I.tax ? esc(I.tax) : f.kind === 'gl' ? 'Depends on your country of residence; for Indian residents, overseas funds are taxed as non-equity.' : null]]);
    return h + '</section>';
  }
  function newsHtml(f, I) {
    var n = (I && I.news) || [], tag = { fund: ['This fund', 'indigo'], amc: ['Fund house', 'pink'], category: ['Category', 'amber'] };
    var h = '<section class="gw-card"><h2>Latest news <span class="sub">fund, fund house &amp; category</span></h2>';
    if (!n.length) return h + '<p class="muted">' + (f.kind === 'gl' ? 'News for global funds is not available here.' : 'No recent news found for this fund or its category.') + '</p></section>';
    return h + '<ul class="fx-news">' + n.slice(0, 10).map(function (x) { var t = tag[x.kind] || ['News', '']; return '<li><a href="' + esc(x.url) + '" target="_blank" rel="noopener">' + esc(x.title) + '</a><div><span class="gw-chip ' + t[1] + '">' + t[0] + '</span> <small class="muted">' + esc(x.src) + (x.ts ? ' · ' + dfmt(x.ts) : '') + '</small></div></li>'; }).join('') + '</ul></section>';
  }
  function prosConsHtml(f, m, I) {
    var pc = prosCons(f, m, I);
    return '<section class="gw-card"><h2>Pros &amp; cons</h2><div class="gw-grid gw-g2" style="align-items:start"><div><h3>👍 Pros</h3><ul class="fx-pc up">' + (pc.pros.length ? pc.pros.map(function (s) { return '<li>' + esc(s) + '</li>'; }).join('') : '<li class="muted">No clear strengths stand out.</li>') + '</ul></div>' +
      '<div><h3>👎 Cons</h3><ul class="fx-pc dn">' + (pc.cons.length ? pc.cons.map(function (s) { return '<li>' + esc(s) + '</li>'; }).join('') : '<li class="muted">No major weaknesses found.</li>') + '</ul></div></div></section>';
  }
  function scoringHtml(f, m) {
    var sc = m.score, T = TH(f);
    var h = '<section class="gw-card"><h2>Scoring system <span class="sub">how the AI Fund Score works</span></h2><p class="fx-about">Each factor gets 0–10 against yardsticks for <b>' + f.cls + '</b> funds; the score is their simple average. 7.5+ is Excellent, 6+ Good, 4.5+ Average, below that Weak.</p>';
    h += '<div class="gw-tbl-wrap"><table class="gw-tbl"><thead><tr><th>Factor</th><th>What it measures</th><th>Scale</th><th>This fund</th></tr></thead><tbody>';
    var D = {
      'Returns': ['Long-term CAGR (5Y, else 3Y)', pct(T.r[0], 0, 1) + ' → 0, ' + pct(T.r[1], 0, 1) + ' → 10'],
      'Consistency': ['Share of rolling 1Y periods positive (40%) and rolling 3Y periods above ' + pct(T.hurdle, 0, 1) + ' (60%)', '0% → 0, 100% → 10'],
      'Risk control': ['Sharpe ratio (60%) and volatility (40%)', 'Sharpe −0.2 → 0, 1.2 → 10; volatility ' + pct(T.vol[1], 0, 1) + ' → 0, ' + pct(T.vol[0], 0, 1) + ' → 10'],
      'Downside protection': ['Worst fall (70%) and worst 1Y return (30%)', 'fall ' + pct(T.mdd[1], 0) + ' → 0, ' + pct(T.mdd[0], 0) + ' → 10'],
      'Cost': ['Expense ratio', '1.5% → 0, 0.05% → 10']
    };
    (sc ? sc.parts : []).forEach(function (p) { var d = D[p.k] || ['', '']; h += '<tr><td><b>' + p.k + '</b></td><td>' + d[0] + '</td><td>' + d[1] + '</td><td class="num"><b>' + p.s.toFixed(1) + '</b></td></tr>'; });
    h += '</tbody></table></div>' + (sc ? '<p class="fx-about">Overall: <b>' + sc.overall.toFixed(1) + '/10 (' + sc.label + ')</b>.' + (f.lev ? ' Capped at 4.4 for leveraged / inverse products.' : '') + ' The final verdict also nudges this by category-relative performance and cost.</p>' : '<p class="muted">Not enough history to score.</p>') + '</section>';
    return h;
  }
  function scenarioHtml(f, m, I) {
    var s = scenarios(f, m, I), amt = f.cur === 'INR' ? 100000 : 10000;
    var h = '<section class="gw-card"><h2>Scenario analysis <span class="sub">what ' + fmtAmt(f, amt) + ' could become, based on this fund\'s own history</span></h2>';
    if (!s.rows.length) return h + '<p class="muted">Needs more than a year of history.</p></section>';
    h += '<div class="gw-tbl-wrap"><table class="gw-tbl"><thead><tr><th>Holding period</th><th>🐻 Bear (bad 10%)</th><th>Base (median)</th><th>🐂 Bull (good 10%)</th></tr></thead><tbody>' +
      s.rows.map(function (r) { var v = function (x) { return '<span class="num ' + cls(x) + '">' + pct(x) + '</span><br><small class="muted num">' + fmtAmt(f, amt * Math.pow(1 + x, r.yrs)) + '</small>'; }; return '<tr><td>' + r.h + '</td><td>' + v(r.bear) + '</td><td>' + v(r.base) + '</td><td>' + v(r.bull) + '</td></tr>'; }).join('') + '</tbody></table></div>';
    var stress = [];
    if (s.crash) stress.push('If the broad market falls 20%, this fund could fall about <b>' + pct(s.crash.fund, 0) + '</b>' + (s.crash.beta ? ' (beta ' + num(s.crash.beta) + ')' : ' (estimate for its asset class)') + ': ' + fmtAmt(f, amt) + ' → ' + fmtAmt(f, amt * (1 + s.crash.fund)) + '.');
    if (s.worst < -0.01) stress.push('Worst case seen so far: a <b>' + pct(s.worst) + '</b> fall from peak (' + fmtAmt(f, amt) + ' → ' + fmtAmt(f, amt * (1 + s.worst)) + ')' + (m.dd.recT ? ', recovered in ' + dur(m.dd.recDays) + '.' : '.'));
    if (stress.length) h += '<h3>Stress test</h3><ul class="fx-sum">' + stress.map(function (x) { return '<li>' + x + '</li>'; }).join('') + '</ul>';
    return h + '<p class="fx-note">Bear / base / bull are the 10th, 50th and 90th percentile of every rolling period in the fund\'s history. The past does not guarantee future returns.</p></section>';
  }
  function suitHtml(f, m, I) {
    var s = suitability(f, m, I);
    return '<section class="gw-card"><h2>Investment suitability</h2>' + kvList([['Risk level', esc(s.risk)], ['Ideal horizon', esc(s.hz)], ['How to invest', esc(s.mode)], ['Lock-in', esc(s.lock)]]) +
      '<div class="gw-grid gw-g2" style="align-items:start;margin-top:10px"><div><h3>✅ Suitable for</h3><ul class="fx-pc up">' + s.fits.map(function (x) { return '<li>' + esc(x) + '</li>'; }).join('') + '</ul></div><div><h3>⛔ Not suitable for</h3><ul class="fx-pc dn">' + s.not.map(function (x) { return '<li>' + esc(x) + '</li>'; }).join('') + '</ul></div></div></section>';
  }
  function expertHtml(f, m, I) {
    var rt = (I && I.ratings) || [], h = '<section class="gw-card"><h2>Analyst &amp; expert views</h2>';
    var rows = rt.map(function (r) { return [esc(r.src) + ' rating', stars(r.v) + ' <small class="muted">' + r.v + ' of 5' + (r.d ? ', ' + dfmt(pDate(r.d)) : '') + '</small>']; });
    rows.push([f.kind === 'mf' ? 'Riskometer (SEBI)' : 'Morningstar risk', esc(riskLevel(f, m, I))]);
    if (I && I.cat) { var c = I.cat.y3 || I.cat.y5; if (c && ok(c.rank) && c.n) rows.push(['Category rank (3Y)', c.rank + ' of ' + c.n]); }
    h += kvList(rows);
    var views = ((I && I.pros) || []).concat((I && I.cons) || []);
    if (views.length) h += '<h3>Research notes</h3><ul class="fx-sum">' + views.slice(0, 6).map(function (x) { return '<li>' + esc(x) + '</li>'; }).join('') + '</ul>';
    var fn = ((I && I.news) || []).filter(function (n) { return n.kind === 'fund'; }).slice(0, 3);
    if (fn.length) h += '<h3>In the press</h3><ul class="fx-news">' + fn.map(function (x) { return '<li><a href="' + esc(x.url) + '" target="_blank" rel="noopener">' + esc(x.title) + '</a> <small class="muted">' + esc(x.src) + '</small></li>'; }).join('') + '</ul>';
    if (!rt.length && !views.length) h += '<p class="muted">No third-party ratings available for this fund.</p>';
    return h + '<p class="fx-note">Ratings and notes come from third-party platforms and are shown as-is.</p></section>';
  }
  function verdictHtml(f, m, I) {
    var v = verdict(f, m, I), s = suitability(f, m, I), pc = prosCons(f, m, I), r = m.r;
    var lp = ok(r.y5) ? ['5-year', r.y5] : ok(r.y3) ? ['3-year', r.y3] : null;
    var concl = esc(f.short) + ' is ' + (v.c === 'green' ? 'a solid' : v.c === 'amber' ? 'a middling' : 'a weak') + ' choice in its category' + (lp ? ', with a ' + lp[0] + ' return of ' + pct(lp[1]) + ' a year' : '') + '. ' +
      (pc.pros[0] ? 'Its biggest strength: ' + pc.pros[0].replace(/\.$/, '').replace(/^./, function (c) { return c.toLowerCase(); }) + '. ' : '') + (pc.cons[0] ? 'Main thing to watch: ' + pc.cons[0].replace(/\.$/, '').replace(/^./, function (c) { return c.toLowerCase(); }) + '. ' : '') +
      'It fits investors with a ' + s.hz + ' horizon and ' + s.risk.toLowerCase() + ' risk appetite' + (f.p.plan === 'Regular' ? '; prefer the Direct plan if you invest on your own' : '') + '.';
    return '<section class="gw-card fx-verdict ' + v.c + '"><h2>Final verdict</h2><div class="fx-v"><b>' + esc(v.k) + '</b>' + (v.s != null ? '<span class="num">' + v.s.toFixed(1) + '/10</span>' : '') + '</div>' + (v.why ? '<p class="fx-about">Adjusted from the AI Fund Score because it ' + esc(v.why) + '.</p>' : '') +
      '<h2 style="margin-top:14px">Conclusion</h2><p class="fx-about">' + concl + '</p><p class="fx-note"><b>Not investment advice.</b> For information only; mutual fund investments are subject to market risks. Read the scheme documents before investing.</p></section>';
  }
  function reportTop(f, m, I) { return execSummary(f, m, I) + snapshotHtml(f, m, I) + strategyHtml(f, I); }
  function reportMid(f, m, I) { return rankHtml(f, m, I) + peersHtml(f, m, I); }
  function reportBot(f, m, I) {
    return riskRatiosHtml(f, m, I) + (f.kind === 'gl' ? portfolioHtml(f) : I ? portfolioMF(f, I) : '') + mgmtHtml(f, I) + exitHtml(f, I) + newsHtml(f, I) + prosConsHtml(f, m, I) +
      scoringHtml(f, m) + scenarioHtml(f, m, I) + suitHtml(f, m, I) + expertHtml(f, m, I) + verdictHtml(f, m, I);
  }
  function fillReport(f, m, tok) {
    var put = function (I, why) {
      if (tok !== S.token || !$('rptTop')) return;
      $('rptTop').innerHTML = reportTop(f, m, I); $('rptMid').innerHTML = reportMid(f, m, I);
      $('rptBot').innerHTML = (why ? '<div class="gw-card fx-errc" style="padding:12px 16px"><p style="margin:0">' + esc(why) + ' Sections below use NAV history only.</p></div>' : '') + reportBot(f, m, I);
    };
    loadInfo(f).then(function (I) { put(I && !I.none ? I : null, I && I.none ? I.why : ''); }, function () { put(null, 'Detailed fund data could not be loaded right now.'); });
  }

  function takeaways(f, m) {
    var good = [], watch = [], r = m.r, T = TH(f), rk = m.risk, dd = m.dd, x = f.x || {};
    var big = f.cur === 'INR' ? 100000 : 10000, bigL = f.cur === 'INR' ? '₹1 lakh' : fmtAmt(f, 10000);
    var lp = ok(r.y5) ? [5, r.y5] : ok(r.y3) ? [3, r.y3] : null;
    if (lp) good.push('Grew <b>' + pct(lp[1]) + ' a year</b> over ' + lp[0] + ' years: ' + bigL + ' became <b>' + fmtAmt(f, big * Math.pow(1 + lp[1], lp[0])) + '</b>.');
    else if (ok(r.y1)) good.push('Returned <b>' + pct(r.y1) + '</b> over the last year; it is too young for long-term numbers.');
    if (m.sip5 && ok(m.sip5.xirr)) good.push('A ' + (f.cur === 'INR' ? '₹10,000' : fmtAmt(f, 10000)) + ' monthly SIP for 5 years would be worth <b>' + fmtAmt(f, m.sip5.value) + '</b> today (XIRR <b>' + pct(m.sip5.xirr) + '</b>).');
    if (m.roll3) good.push('Positive in <b>' + pct(m.roll3.pos, 0, 1) + '</b> of all rolling 3-year periods, averaging <b>' + pct(m.roll3.avg) + '</b> a year.');
    else if (m.roll1) good.push('Positive in <b>' + pct(m.roll1.pos, 0, 1) + '</b> of rolling 1-year periods.');
    if (dd.mdd < -0.005) good.push('Its worst fall was <b>' + pct(dd.mdd) + '</b> (' + mfmt(dd.peakT) + ' to ' + mfmt(dd.troughT) + ')' + (dd.recT ? ', recovered in ' + dur(dd.recDays) + '.' : ', and it has <b>not fully recovered</b> yet.'));
    if (rk && ok(rk.sharpe)) good.push('Sharpe ratio of <b>' + num(rk.sharpe) + '</b> (' + m.riskLbl + '): ' + (rk.sharpe >= 1 ? 'strong' : rk.sharpe >= 0.5 ? 'decent' : rk.sharpe >= 0 ? 'thin' : 'negative') + ' reward for the risk taken.');
    if (f.kind === 'gl' && ok(x.expense)) good.push('Costs <b>' + pct(x.expense, 2, 1) + '</b> a year' + (ok(x.expenseCat) ? (x.expense < x.expenseCat ? ', below' : ', above') + ' the category average of ' + pct(x.expenseCat, 2, 1) : '') + '.');

    if (f.lev) watch.push('<b>Leveraged or inverse product</b>: daily resetting makes long-term returns unpredictable. Meant for short-term trading only.');
    if (m.yrs < 3) watch.push('Short track record (' + age(f.latestT - f.t[0]) + '): long-term risk and return numbers are limited.');
    if (rk && rk.vol > T.vol[0] + (T.vol[1] - T.vol[0]) * 0.65) watch.push('High volatility (' + pct(rk.vol, 1, 1) + ' a year): expect large swings.');
    if (dd.cur < -0.1) watch.push('Currently <b>' + pct(dd.cur) + '</b> below its all-time high.');
    if (ok(r.y1) && lp && r.y1 < lp[1] - 0.08) watch.push('Momentum has cooled: last 1Y ' + pct(r.y1) + ' vs ' + pct(lp[1]) + ' a year over ' + lp[0] + 'Y.');
    if (m.roll1 && m.roll1.min < -0.2) watch.push('Lost as much as ' + pct(m.roll1.min) + ' in its worst 1-year period; needs a long holding horizon.');
    if (f.p.plan === 'Regular') watch.push('This is a <b>Regular</b> plan; the Direct plan of the same scheme has a lower expense ratio and usually higher returns.');
    if (f.p.opt === 'IDCW') watch.push('IDCW (dividend) option: NAV drops on each payout, so NAV-based returns understate total returns. Growth option is better for comparison.');
    if (f.kind === 'gl') {
      var sec = (x.sectors || []).slice().sort(function (a, b) { return b.pct - a.pct; })[0];
      if (sec && sec.pct > 0.35) watch.push('Concentrated in ' + sectorName(sec.sector).toLowerCase() + ' (' + pct(sec.pct, 0, 1) + ' of the portfolio).');
      var tot = (x.holdings || []).reduce(function (a, b) { return a + b.pct; }, 0);
      if (tot > 0.5) watch.push('Top 10 holdings make up ' + pct(tot, 0, 1) + ' of the fund.');
      if (ok(x.expense) && x.expense > 0.0075) watch.push('Relatively expensive at ' + pct(x.expense, 2, 1) + ' a year.');
      if (f.cur !== 'INR') watch.push('Priced in ' + f.cur + '; for an Indian investor, rupee returns also depend on the exchange rate.');
    }
    return { good: good.slice(0, 5), watch: watch.slice(0, 4) };
  }

  // ------------------------------------------------------------------ compare view
  function showCompare(list, tok) {
    document.title = 'Compare funds · Mutual Fund Analyzer · Growebtek';
    renderTray();
    if (list.length < 2) {
      var demo = S.src === 'gl' ? 'etf:VFIAX,etf:QQQ,etf:VTI' : 'mf:122639,mf:118989,mf:118778';
      $('view').innerHTML = '<section class="gw-card fx-empty"><h2>Compare 2 to 4 funds</h2><p>' + (list.length ? 'Add at least one more fund' : 'Add funds') + ' using the search box or popular picks above. You can also open any fund and tap <b>Add to compare</b>.</p><button class="gw-btn" type="button" data-demo="' + demo + '">Try: ' + (S.src === 'gl' ? 'VFIAX vs QQQ vs VTI' : 'Parag Parikh vs HDFC Mid Cap vs Nippon Small Cap') + '</button></section>';
      list.forEach(function (k) { loadFund(k).then(function (f) { names[k] = f.kind === 'gl' ? f.id + ' · ' + f.short : f.short + (f.p.plan ? ' (' + f.p.plan + ')' : ''); if (tok === S.token) renderTray(); }, function () {}); });
      return;
    }
    loading('Loading ' + list.length + ' funds…');
    Promise.all(list.map(function (k) { return loadFund(k).then(function (f) { return f; }, function (e) { return { err: e.message || 'Failed', key: k }; }); })).then(function (fs) {
      if (tok !== S.token) return;
      var bad = fs.filter(function (f) { return f.err; }), good = fs.filter(function (f) { return !f.err; });
      good.forEach(function (f) { names[f.key] = f.kind === 'gl' ? f.id + ' · ' + f.short : f.short + (f.p.plan ? ' (' + f.p.plan + ')' : ''); });
      renderTray();
      if (good.length < 2) { errorCard(bad.length ? 'Could not load: ' + bad.map(function (b) { return b.key.replace(/^(mf|etf):/, '') + ' (' + b.err + ')'; }).join(', ') : 'Add at least two funds to compare.'); return; }
      loading('Loading fund details…');
      Promise.all(good.map(function (f) { return Promise.race([loadInfo(f).then(null, function () { return null; }), new Promise(function (r) { setTimeout(r, 25000); })]); })).then(function () { if (tok === S.token) renderCompare(good, bad); });
    });
  }

  function renderCompare(fs, bad) {
    fs.forEach(function (f) { metrics(f); });
    var colorOf = function (f) { return COLORS[Math.max(0, S.cmp.indexOf(f.key))]; };
    var common = Math.max.apply(null, fs.map(function (f) { return f.t[0]; })), cyrs = (Math.min.apply(null, fs.map(function (f) { return f.t[f.t.length - 1]; })) - common) / YR;
    var mixed = fs.some(function (f) { return f.cur !== fs[0].cur; });
    var h = bad.length ? '<div class="gw-card fx-errc" style="padding:12px 16px"><p style="margin:0">Could not load: ' + bad.map(function (b) { return esc(b.key.replace(/^(mf|etf):/, '')) + ' (' + esc(b.err) + ')'; }).join(', ') + '</p></div>' : '';
    if (!S.cmpRange || RANGES.every(function (r) { return r[0] !== S.cmpRange; })) S.cmpRange = 'Max';
    h += cmpExec(fs);
    h += '<section class="gw-card"><div class="fx-hrow"><h2>Growth of 100 <span class="sub">rebased over the common period' + (mixed ? ' · each in its own currency' : '') + '</span></h2><div class="fx-seg sm" id="crng">' +
      RANGES.map(function (r) { var dis = r[1] && r[1] > 12 && cyrs < r[1] / 12 - 0.05; return '<button type="button" data-r="' + r[0] + '" ' + (dis ? 'disabled' : '') + ' aria-selected="' + (r[0] === S.cmpRange) + '">' + r[0] + '</button>'; }).join('') +
      '</div></div><div id="cmpChart"></div><div class="fx-legend" id="cmpLeg"></div><p class="fx-note">Common history starts ' + dfmt(common) + ' (' + age(Date.now() - common) + ').</p></section>';

    var best = function (vals, dir) { var b = null; vals.forEach(function (v) { if (ok(v) && (b == null || (dir === 'hi' ? v > b : v < b))) b = v; }); return b; };
    var g = function (f) { return f._m; };
    var rows = [
      ['sec', 'Snapshot'],
      ['Latest NAV / price', function (f) { return null; }, function (f) { return fmtNav(f, f.latest); }],
      ['Category', null, function (f) { return esc(f.category); }],
      ['Plan', null, function (f) { return f.kind === 'mf' ? [f.p.plan, f.p.opt].filter(Boolean).join(' · ') || '–' : esc(f.group); }],
      ['Fund age', function (f) { return f.latestT - f.since; }, function (f) { return age(f.latestT - f.since); }, null],
      ['Fund size (AUM)', function (f) { var I = f.info; return I ? (f.kind === 'mf' ? I.aumCr : I.aum) : null; }, function (f) { return f.info ? aumTxt(f, f.info) : '–'; }, null],
      ['Benchmark', null, function (f) { return f.info && f.info.benchmark ? '<span title="' + esc(f.info.benchmark) + '">' + esc(f.info.benchmark.length > 28 ? f.info.benchmark.slice(0, 26) + '…' : f.info.benchmark) + '</span>' : '–'; }],
      ['Fund manager', null, function (f) { var ms = f.info && f.info.managers || []; return ms.length ? esc(ms[0].n) + (ms.length > 1 ? ' <span class="muted">+' + (ms.length - 1) + '</span>' : '') : '–'; }],
      ['Riskometer / risk', null, function (f) { return esc(riskLevel(f, g(f), f.info)); }],
      ['Rating', function (f) { var r = f.info && f.info.ratings || []; return r.length ? r[0].v : null; }, function (f) { var r = f.info && f.info.ratings || []; return r.length ? stars(r[0].v) + ' <span class="muted">' + esc(r[0].src) + '</span>' : '–'; }, 'hi'],
      ['sec', 'Returns'],
      ['1Y return', function (f) { return g(f).r.y1; }, null, 'hi'],
      ['3Y CAGR', function (f) { return g(f).r.y3; }, null, 'hi'],
      ['5Y CAGR', function (f) { return g(f).r.y5; }, null, 'hi'],
      ['10Y CAGR', function (f) { return g(f).r.y10; }, null, 'hi'],
      ['SIP 5Y XIRR', function (f) { return g(f).sip5 ? g(f).sip5.xirr : null; }, null, 'hi'],
      ['Category avg 3Y', function (f) { return null; }, function (f) { var c = f.info && f.info.cat && f.info.cat.y3; return c && ok(c.c) ? pct(c.c) : '–'; }],
      ['3Y vs category', function (f) { var c = f.info && f.info.cat && f.info.cat.y3; return c && ok(c.f) && ok(c.c) ? c.f - c.c : null; }, null, 'hi'],
      ['Category rank 3Y', function (f) { var c = f.info && f.info.cat && f.info.cat.y3; return c && ok(c.rank) && c.n ? c.rank / c.n : c && ok(c.pctl) ? c.pctl / 100 : null; }, function (f) { var c = f.info && f.info.cat && f.info.cat.y3; return c && ok(c.rank) && c.n ? c.rank + ' / ' + c.n : c && ok(c.pctl) ? 'percentile ' + c.pctl : '–'; }, 'lo'],
      ['sec', 'Risk'],
      ['Volatility (3Y)', function (f) { return g(f).risk ? g(f).risk.vol : null; }, function (f) { return g(f).risk ? pct(g(f).risk.vol, 1, 1) : '–'; }, 'lo'],
      ['Sharpe ratio', function (f) { return g(f).risk ? g(f).risk.sharpe : null; }, function (f) { return g(f).risk ? num(g(f).risk.sharpe) : '–'; }, 'hi'],
      ['Sortino ratio', function (f) { return g(f).risk ? g(f).risk.sortino : null; }, function (f) { return g(f).risk ? num(g(f).risk.sortino) : '–'; }, 'hi'],
      ['Max drawdown', function (f) { return g(f).dd.mdd; }, null, 'hi'],
      ['Std deviation (reported)', function (f) { var r = f.info && f.info.ratios; return r && ok(r.sd) ? r.sd : null; }, function (f) { var r = f.info && f.info.ratios; return r && ok(r.sd) ? pct(r.sd, 2, 1) : '–'; }, 'lo'],
      ['Beta', function (f) { var r = f.info && f.info.ratios; return r && ok(r.beta) ? r.beta : null; }, function (f) { var r = f.info && f.info.ratios; return r && ok(r.beta) ? num(r.beta) : '–'; }, 'lo'],
      ['Alpha', function (f) { var r = f.info && f.info.ratios; return r && ok(r.alpha) ? r.alpha : null; }, function (f) { var r = f.info && f.info.ratios; return r && ok(r.alpha) ? '<span class="' + cls(r.alpha) + '">' + pct(r.alpha, 2) + '</span>' : '–'; }, 'hi'],
      ['sec', 'Consistency'],
      ['Rolling 3Y avg', function (f) { return g(f).roll3 ? g(f).roll3.avg : null; }, null, 'hi'],
      ['Rolling 3Y % positive', function (f) { return g(f).roll3 ? g(f).roll3.pos : null; }, function (f) { return g(f).roll3 ? pct(g(f).roll3.pos, 0, 1) : '–'; }, 'hi'],
      ['Worst 1Y period', function (f) { return g(f).roll1 ? g(f).roll1.min : null; }, null, 'hi']
    ];
    var expOf = function (f) { return f.info && ok(f.info.exp) ? f.info.exp : f.x && ok(f.x.expense) ? f.x.expense : null; };
    rows.push(['sec', 'Costs']);
    rows.push(['Expense ratio', expOf, function (f) { return ok(expOf(f)) ? pct(expOf(f), 2, 1) : '–'; }, 'lo']);
    rows.push(['Exit load', null, function (f) { var l = f.info && f.info.exitLoad; return l ? '<span title="' + esc(l) + '">' + esc(shortLoad(l)) + '</span>' : '–'; }]);
    rows.push(['Lock-in', null, function (f) { return f.info ? esc(f.info.lockIn || (/elss|tax sav/i.test(f.catFull) ? '3 years' : 'None')) : '–'; }]);
    rows.push(['sec', 'Portfolio']);
    rows.push(['Holdings', function (f) { return null; }, function (f) { var I = f.info; return I && (I.holdN || (I.hold && I.hold.length)) ? String(I.holdN || I.hold.length) + (I.gl ? ' <span class="muted">top shown</span>' : '') : '–'; }]);
    rows.push(['Top 10 weight', function (f) { return f.info && ok(f.info.top10) ? f.info.top10 : null; }, function (f) { return f.info && ok(f.info.top10) ? pct(f.info.top10, 1, 1) : '–'; }, 'lo']);
    rows.push(['Top holding', null, function (f) { var h = f.info && f.info.hold && f.info.hold[0]; return h ? '<span title="' + esc(h.n) + '">' + esc(h.n.length > 22 ? h.n.slice(0, 20) + '…' : h.n) + '</span> <span class="muted">' + pct(h.p, 1, 1) + '</span>' : '–'; }]);
    rows.push(['Top sector', null, function (f) { var x = f.info && f.info.sectors && f.info.sectors[0]; return x ? esc(x[0]) + ' <span class="muted">' + pct(x[1], 1, 1) + '</span>' : '–'; }]);
    rows.push(['Asset mix', null, function (f) { var mx = f.info && f.info.mix || []; return mx.length ? mx.slice(0, 3).map(function (p) { return esc(p[0].split(/[ &]/)[0]) + ' ' + pct(p[1], 0, 1); }).join(' · ') : '–'; }]);
    rows.push(['sec', 'Verdict']);
    rows.push(['AI Fund Score', function (f) { return g(f).score ? g(f).score.overall : null; }, function (f) { return g(f).score ? '<b>' + g(f).score.overall.toFixed(1) + '</b> <span class="muted">' + g(f).score.label + '</span>' : '–'; }, 'hi']);
    rows.push(['Final verdict (score)', function (f) { return verdict(f, g(f), f.info).s; }, function (f) { var v = verdict(f, g(f), f.info); return '<span class="gw-chip ' + v.c + '">' + esc(v.k) + (v.s != null ? ' · ' + v.s.toFixed(1) + '/10' : '') + '</span>'; }, 'hi']);
    rows.push(['Suitable horizon', null, function (f) { return esc(horizon(f)[1]); }]);

    h += '<section class="gw-card"><h2>Side by side <span class="sub">best value in each row is green</span></h2><div class="gw-tbl-wrap"><table class="gw-tbl fx-cmp-tbl"><thead><tr><th></th>' +
      fs.map(function (f) { return '<th><span class="d" style="background:' + colorOf(f) + '"></span><a href="#' + keyHash(f.key) + '">' + esc(f.kind === 'gl' ? f.id : f.short) + '</a>' + (f.kind === 'mf' && f.p.plan ? ' <span class="muted" style="font-weight:600">' + f.p.plan + '</span>' : '') + '</th>'; }).join('') + '</tr></thead><tbody>';
    rows.forEach(function (row) {
      if (row[0] === 'sec') { h += '<tr class="sec"><td colspan="' + (fs.length + 1) + '">' + row[1] + '</td></tr>'; return; }
      var vals = fs.map(function (f) { return row[1] ? row[1](f) : null; }), b = row[3] ? best(vals, row[3]) : null, cnt = vals.filter(ok).length;
      h += '<tr><td>' + row[0] + '</td>' + fs.map(function (f, i) {
        var txt = row[2] ? row[2](f) : '<span class="' + cls(vals[i]) + '">' + pct(vals[i]) + '</span>';
        return '<td class="num' + (b != null && cnt > 1 && vals[i] === b ? ' best' : '') + '">' + txt + '</td>';
      }).join('') + '</tr>';
    });
    h += '</tbody></table></div><p class="fx-note">Sharpe and Sortino use a risk-free rate of 6.5% for INR funds and 4% for USD funds (assumption). "–" means the fund is too young for that period.</p></section>';
    h += '<section class="gw-card"><h2>✨ Summary</h2><ul class="fx-sum">' + cmpSummary(fs).map(function (s) { return '<li>' + s + '</li>'; }).join('') + '</ul></section>';
    h += cmpReport(fs, colorOf);
        $('view').innerHTML = h;

    function draw() {
      var rg = RANGES.filter(function (r) { return r[0] === S.cmpRange; })[0], end = Math.min.apply(null, fs.map(function (f) { return f.t[f.t.length - 1]; }));
      var start = rg[1] ? Math.max(common, addMonths(end, -rg[1])) : common, legend = '';
      var ser = fs.map(function (f) {
        var i0 = atOrAfter(f.t, start), i1 = atOrBefore(f.t, end), base = f.v[i0], t = [], v = [];
        for (var i = i0; i <= i1; i++) { t.push(f.t[i]); v.push(f.v[i] / base * 100); }
        var last = v[v.length - 1];
        legend += '<span><i style="background:' + colorOf(f) + '"></i>' + esc(f.kind === 'gl' ? f.id : f.short) + ' <b class="num ' + cls(last - 100) + '">' + (ok(last) ? last.toFixed(1) : '–') + '</b></span>';
        return { name: f.kind === 'gl' ? f.id : f.short, color: colorOf(f), t: t, v: v, w: 2.2 };
      });
      $('cmpLeg').innerHTML = legend;
      lineChart($('cmpChart'), ser, { label: 'Comparison chart', fmtY: function (y) { return String(Math.round(y)); }, tip: function (y) { return y.toFixed(1) + ' <span class="' + cls(y - 100) + '">(' + pct(y / 100 - 1) + ')</span>'; } });
    }
    draw();
    $('crng').addEventListener('click', function (e) { var b = e.target.closest('button[data-r]'); if (!b || b.disabled) return; S.cmpRange = b.dataset.r; this.querySelectorAll('button').forEach(function (x) { x.setAttribute('aria-selected', String(x === b)); }); draw(); });
  }

  function cmpName(f) { return f.kind === 'gl' ? f.id : f.short + (f.p.plan ? ' (' + f.p.plan + ')' : ''); }
  function cmpRank(fs) { return fs.map(function (f) { return { f: f, v: verdict(f, f._m, f.info) }; }).sort(function (a, b) { return (b.v.s == null ? -1 : b.v.s) - (a.v.s == null ? -1 : a.v.s); }); }
  function cmpExec(fs) {
    var rk = cmpRank(fs), top = rk[0], b = [];
    rk.forEach(function (x) {
      var f = x.f, m = f._m, I = f.info, c = I && I.cat && I.cat.y3, e = I && ok(I.exp) ? I.exp : f.x && f.x.expense;
      b.push('<b>' + esc(cmpName(f)) + '</b>: <span class="gw-chip ' + x.v.c + '">' + esc(x.v.k) + (x.v.s != null ? ' · final score ' + x.v.s.toFixed(1) + '/10' : '') + '</span> ' +
        [ok(m.r.y3) ? '3Y ' + pct(m.r.y3) + ' a year' + (c && ok(c.c) ? ' (category ' + pct(c.c) + ')' : '') : ok(m.r.y1) ? '1Y ' + pct(m.r.y1) : '', esc(riskLevel(f, m, I).toLowerCase()) + ' risk', ok(e) ? 'expense ' + pct(e, 2, 1) : '', I ? 'AUM ' + aumTxt(f, I) : ''].filter(Boolean).join(' · '));
    });
    var lead = top.v.s != null && rk.length > 1 && rk[1].v.s != null ? '<p class="fx-about">On balance, <b>' + esc(cmpName(top.f)) + '</b> comes out ahead' + (top.v.s - rk[1].v.s < 0.3 ? ', but it is close; pick on cost, risk and your horizon' : '') + '.</p>' : '';
    return '<section class="gw-card fx-exec"><h2>Executive summary</h2>' + lead + '<ul class="fx-sum">' + b.map(function (s) { return '<li>' + s + '</li>'; }).join('') + '</ul></section>';
  }
  function cmpReport(fs, colorOf) {
    var h = '', amt = function (f) { return f.cur === 'INR' ? 100000 : 10000; };
    var dot = function (f) { return '<span class="d" style="display:inline-block;width:10px;height:10px;border-radius:50%;margin-right:6px;background:' + colorOf(f) + '"></span>'; };
    // scenarios
    h += '<section class="gw-card"><h2>Scenario analysis <span class="sub">10th / 50th / 90th percentile of each fund\'s rolling returns</span></h2><div class="gw-tbl-wrap"><table class="gw-tbl fx-cmp-tbl"><thead><tr><th>Fund</th><th>1Y bear</th><th>1Y base</th><th>1Y bull</th><th>3Y bear</th><th>3Y base</th><th>3Y bull</th><th>If market −20%</th></tr></thead><tbody>' +
      fs.map(function (f) {
        var s = scenarios(f, f._m, f.info), r1 = s.rows.filter(function (r) { return r.yrs === 1; })[0], r3 = s.rows.filter(function (r) { return r.yrs === 3; })[0];
        var c = function (r, k) { return r ? '<td class="num ' + cls(r[k]) + '">' + pct(r[k]) + '</td>' : '<td class="num">–</td>'; };
        return '<tr><td>' + dot(f) + esc(cmpName(f)) + '</td>' + c(r1, 'bear') + c(r1, 'base') + c(r1, 'bull') + c(r3, 'bear') + c(r3, 'base') + c(r3, 'bull') + '<td class="num ' + (s.crash ? 'dn' : '') + '">' + (s.crash ? pct(s.crash.fund, 0) : '–') + '</td></tr>';
      }).join('') + '</tbody></table></div><p class="fx-note">3Y values are a year (CAGR). Market −20% uses each fund\'s reported beta where available. Past patterns, not forecasts.</p></section>';
    // suitability
    h += '<section class="gw-card"><h2>Investment suitability</h2><div class="gw-grid gw-g2">' + fs.map(function (f) {
      var s = suitability(f, f._m, f.info);
      return '<div class="fx-box"><h3>' + dot(f) + esc(cmpName(f)) + '</h3><p class="fx-about">' + esc(s.risk) + ' risk · ' + esc(s.hz) + ' · lock-in ' + esc(s.lock) + '</p><ul class="fx-pc up">' + s.fits.slice(0, 2).map(function (x) { return '<li>' + esc(x) + '</li>'; }).join('') + '</ul><ul class="fx-pc dn">' + s.not.slice(0, 2).map(function (x) { return '<li>' + esc(x) + '</li>'; }).join('') + '</ul></div>';
    }).join('') + '</div></section>';
    // pros & cons
    h += '<section class="gw-card"><h2>Pros &amp; cons</h2><div class="gw-grid gw-g2">' + fs.map(function (f) {
      var pc = prosCons(f, f._m, f.info);
      return '<div class="fx-box"><h3>' + dot(f) + esc(cmpName(f)) + '</h3><ul class="fx-pc up">' + (pc.pros.slice(0, 4).map(function (x) { return '<li>' + esc(x) + '</li>'; }).join('') || '<li class="muted">No clear strengths.</li>') + '</ul><ul class="fx-pc dn">' + (pc.cons.slice(0, 4).map(function (x) { return '<li>' + esc(x) + '</li>'; }).join('') || '<li class="muted">No major weaknesses.</li>') + '</ul></div>';
    }).join('') + '</div></section>';
    // analyst views + news
    var nw = fs.map(function (f) { return { f: f, n: ((f.info && f.info.news) || []).slice(0, 3) }; }).filter(function (x) { return x.n.length; });
    h += '<section class="gw-card"><h2>Analyst views &amp; latest news</h2><div class="gw-grid gw-g2">' + fs.map(function (f) {
      var I = f.info, rt = (I && I.ratings) || [], n = ((I && I.news) || []).slice(0, 3);
      return '<div class="fx-box"><h3>' + dot(f) + esc(cmpName(f)) + '</h3>' + (rt.length ? rt.map(function (r) { return '<div>' + stars(r.v) + ' <small class="muted">' + esc(r.src) + '</small></div>'; }).join('') : '<p class="muted">No third-party rating.</p>') +
        (n.length ? '<ul class="fx-news">' + n.map(function (x) { return '<li><a href="' + esc(x.url) + '" target="_blank" rel="noopener">' + esc(x.title) + '</a> <small class="muted">' + esc(x.src) + (x.ts ? ' · ' + dfmt(x.ts) : '') + '</small></li>'; }).join('') + '</ul>' : '<p class="muted">No recent news.</p>') + '</div>';
    }).join('') + '</div></section>';
    // verdict + conclusion
    var rk = cmpRank(fs), top = rk[0];
    var by = function (fn, dir) { var b = null; fs.forEach(function (f) { var v = fn(f); if (ok(v) && (b == null || (dir > 0 ? v > b.v : v < b.v))) b = { f: f, v: v }; }); return b; };
    var lr = by(function (f) { return f._m.r.y5 != null ? f._m.r.y5 : f._m.r.y3; }, 1), lv = by(function (f) { return f._m.risk && f._m.risk.vol; }, -1), lc = by(function (f) { return f.info && ok(f.info.exp) ? f.info.exp : f.x && f.x.expense; }, -1);
    var pts = [];
    if (lr) pts.push('Highest long-term return: <b>' + esc(cmpName(lr.f)) + '</b> (' + pct(lr.v) + ' a year).');
    if (lv) pts.push('Steadiest ride: <b>' + esc(cmpName(lv.f)) + '</b> (volatility ' + pct(lv.v, 1, 1) + ').');
    if (lc) pts.push('Cheapest: <b>' + esc(cmpName(lc.f)) + '</b> (expense ' + pct(lc.v, 2, 1) + ').');
    h += '<section class="gw-card fx-verdict ' + top.v.c + '"><h2>Final verdict</h2><div class="gw-tbl-wrap"><table class="gw-tbl fx-cmp-tbl"><tbody>' + rk.map(function (x, i) { return '<tr><td>' + (i + 1) + '. ' + dot(x.f) + esc(cmpName(x.f)) + '</td><td><span class="gw-chip ' + x.v.c + '">' + esc(x.v.k) + '</span></td><td class="num"><b>' + (x.v.s != null ? x.v.s.toFixed(1) + '/10' : '–') + '</b></td></tr>'; }).join('') + '</tbody></table></div>' +
      '<ul class="fx-sum" style="margin-top:10px">' + pts.map(function (s) { return '<li>' + s + '</li>'; }).join('') + '</ul>' +
      '<h2 style="margin-top:14px">Conclusion</h2><p class="fx-about">' + (top.v.s != null ? '<b>' + esc(cmpName(top.f)) + '</b> is the strongest all-rounder here. ' : '') + 'Funds in different categories serve different goals, so match the choice to your horizon and risk comfort rather than past returns alone' + (fs.some(function (f) { return f.p.plan === 'Regular'; }) ? '; prefer Direct plans if you invest on your own' : '') + '.</p>' +
      '<p class="fx-note"><b>Not investment advice.</b> For information only; mutual fund investments are subject to market risks.</p></section>';
    return h;
  }
  function cmpSummary(fs) {
    var out = [], nm = function (f) { return '<b>' + esc(f.kind === 'gl' ? f.id : f.short) + '</b>'; };
    function top(fn, dir) { var b = null, bv = null; fs.forEach(function (f) { var v = fn(f); if (ok(v) && (bv == null || (dir === 'lo' ? v < bv : v > bv))) { bv = v; b = f; } }); return b ? [b, bv] : null; }
    var sc = top(function (f) { return f._m.score && f._m.score.overall; });
    if (sc) out.push(nm(sc[0]) + ' has the highest AI Fund Score at <b>' + sc[1].toFixed(1) + '/10</b> (' + sc[0]._m.score.label + ').');
    var r5 = top(function (f) { return f._m.r.y5; }), r3 = top(function (f) { return f._m.r.y3; });
    if (r5) out.push(nm(r5[0]) + ' delivered the best 5-year return: <b>' + pct(r5[1]) + '</b> a year.');
    else if (r3) out.push(nm(r3[0]) + ' delivered the best 3-year return: <b>' + pct(r3[1]) + '</b> a year.');
    var sp = top(function (f) { return f._m.sip5 && f._m.sip5.xirr; });
    if (sp) out.push('For a 5-year monthly SIP, ' + nm(sp[0]) + ' did best with an XIRR of <b>' + pct(sp[1]) + '</b>.');
    var vl = top(function (f) { return f._m.risk && f._m.risk.vol; }, 'lo'), md = top(function (f) { return f._m.dd.mdd; });
    if (vl) out.push(nm(vl[0]) + ' was the smoothest ride (volatility ' + pct(vl[1], 1, 1) + ')' + (md && md[0] === vl[0] ? ' and also had the smallest worst fall (' + pct(md[1]) + ').' : md ? ', while ' + nm(md[0]) + ' had the smallest worst fall (' + pct(md[1]) + ').' : '.'));
    var cs = top(function (f) { return f._m.roll3 && f._m.roll3.pos; });
    if (cs) out.push(nm(cs[0]) + ' was the most consistent: positive in <b>' + pct(cs[1], 0, 1) + '</b> of rolling 3-year periods.');
    var cls2 = fs.map(function (f) { return f.cls; });
    if (cls2.some(function (c) { return c !== cls2[0]; })) out.push('These funds belong to different asset classes, so compare risk alongside return rather than return alone.');
    var reg = fs.filter(function (f) { return f.p.plan === 'Regular'; });
    if (reg.length) out.push(reg.map(nm).join(', ') + (reg.length > 1 ? ' are Regular plans' : ' is a Regular plan') + '; Direct plans cost less.');
    return out;
  }

  // ------------------------------------------------------------------ boot
  renderPicks(); renderTray(); route();
})();
