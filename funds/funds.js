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
  function loadMF(code) {
    return fetchJSON(MFAPI + '/' + encodeURIComponent(code)).then(function (j) {
      if (!j || !j.meta || !j.data || !j.data.length || !j.meta.scheme_name) throw new Error('No NAV history found for scheme ' + code + '.');
      var n = j.data.length, t = new Array(n), v = new Array(n);
      for (var i = 0; i < n; i++) {
        var d = j.data[n - 1 - i], p = d.date.split('-');
        t[i] = Date.UTC(+p[2], +p[1] - 1, +p[0]); v[i] = parseFloat(d.nav);
      }
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
    h += '<section class="gw-card"><h2>Returns <span class="sub">absolute up to 1Y, CAGR beyond · as of ' + dfmt(f.latestT) + '</span></h2><div class="fx-rets">' +
      retTile('1M', r.m1) + retTile('3M', r.m3) + retTile('6M', r.m6) + retTile('1Y', r.y1) + retTile('3Y', r.y3, 'CAGR') + retTile('5Y', r.y5, 'CAGR') + retTile('7Y', r.y7, 'CAGR') + retTile('10Y', r.y10, 'CAGR') +
      retTile(f.kind === 'gl' && f.since < f.t[0] ? 'Max' : 'Since launch', r.si, m.siAbs ? 'absolute' : 'CAGR') + '</div>' +
      (f.kind === 'gl' && f.since < f.t[0] ? '<p class="fx-note">"Max" covers the available data since ' + mfmt(f.t[0]) + '; the fund itself started in ' + mfmt(f.since) + '.</p>' : '') + '</section>';

    // SIP + risk
    var cur = f.cur === 'INR' ? '₹' : (nf(f.cur, {}).formatToParts(0).filter(function (p) { return p.type === 'currency'; })[0] || {}).value || f.cur;
    var amt = S.sipAmt[f.cur] || (f.cur === 'INR' ? 10000 : 500);
    h += '<div class="gw-grid gw-g2"><section class="gw-card"><h2>SIP calculator <span class="sub">from real NAV history</span></h2><div class="fx-sip-in"><div class="gw-field"><label for="sipAmt">Monthly amount (' + esc(cur) + ')</label><input class="gw-input num" id="sipAmt" type="number" inputmode="numeric" min="100" step="500" value="' + amt + '"></div>' +
      '<div class="gw-field"><label>Period</label><div class="fx-seg sm" id="sipYrs">' + [1, 3, 5, 10].map(function (y) { return '<button type="button" data-y="' + y + '" aria-selected="' + (y === S.sipYrs) + '">' + y + 'Y</button>'; }).join('') + '</div></div></div><div id="sipOut"></div><div id="sipChart"></div></section>';
    var rk = m.risk, dd = m.dd;
    h += '<section class="gw-card"><h2>Risk <span class="sub">' + (rk ? 'volatility & ratios: ' + m.riskLbl : '') + '</span></h2><div class="fx-stats">' +
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

    // portfolio / costs
    if (f.kind === 'gl') h += portfolioHtml(f);
    else h += '<section class="gw-card"><h2>Costs &amp; portfolio</h2><p class="fx-about">Expense ratio, AUM, holdings and sector data are <b>not available</b> from the NAV data source used for Indian funds, so they are not shown or scored. Check the latest factsheet on the ' + esc(f.house || 'AMC') + ' website' + (f.p.plan === 'Regular' ? '. Regular plans include distributor commission, so their expense ratio is higher than the Direct plan of the same scheme' : '') + '.</p></section>';

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
      renderCompare(good, bad);
    });
  }

  function renderCompare(fs, bad) {
    fs.forEach(function (f) { metrics(f); });
    var colorOf = function (f) { return COLORS[Math.max(0, S.cmp.indexOf(f.key))]; };
    var common = Math.max.apply(null, fs.map(function (f) { return f.t[0]; })), cyrs = (Math.min.apply(null, fs.map(function (f) { return f.t[f.t.length - 1]; })) - common) / YR;
    var mixed = fs.some(function (f) { return f.cur !== fs[0].cur; });
    var h = bad.length ? '<div class="gw-card fx-errc" style="padding:12px 16px"><p style="margin:0">Could not load: ' + bad.map(function (b) { return esc(b.key.replace(/^(mf|etf):/, '')) + ' (' + esc(b.err) + ')'; }).join(', ') + '</p></div>' : '';
    if (!S.cmpRange || RANGES.every(function (r) { return r[0] !== S.cmpRange; })) S.cmpRange = 'Max';
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
      ['sec', 'Returns'],
      ['1Y return', function (f) { return g(f).r.y1; }, null, 'hi'],
      ['3Y CAGR', function (f) { return g(f).r.y3; }, null, 'hi'],
      ['5Y CAGR', function (f) { return g(f).r.y5; }, null, 'hi'],
      ['10Y CAGR', function (f) { return g(f).r.y10; }, null, 'hi'],
      ['SIP 5Y XIRR', function (f) { return g(f).sip5 ? g(f).sip5.xirr : null; }, null, 'hi'],
      ['sec', 'Risk'],
      ['Volatility (3Y)', function (f) { return g(f).risk ? g(f).risk.vol : null; }, function (f) { return g(f).risk ? pct(g(f).risk.vol, 1, 1) : '–'; }, 'lo'],
      ['Sharpe ratio', function (f) { return g(f).risk ? g(f).risk.sharpe : null; }, function (f) { return g(f).risk ? num(g(f).risk.sharpe) : '–'; }, 'hi'],
      ['Sortino ratio', function (f) { return g(f).risk ? g(f).risk.sortino : null; }, function (f) { return g(f).risk ? num(g(f).risk.sortino) : '–'; }, 'hi'],
      ['Max drawdown', function (f) { return g(f).dd.mdd; }, null, 'hi'],
      ['sec', 'Consistency'],
      ['Rolling 3Y avg', function (f) { return g(f).roll3 ? g(f).roll3.avg : null; }, null, 'hi'],
      ['Rolling 3Y % positive', function (f) { return g(f).roll3 ? g(f).roll3.pos : null; }, function (f) { return g(f).roll3 ? pct(g(f).roll3.pos, 0, 1) : '–'; }, 'hi'],
      ['Worst 1Y period', function (f) { return g(f).roll1 ? g(f).roll1.min : null; }, null, 'hi']
    ];
    if (fs.some(function (f) { return f.kind === 'gl'; })) {
      rows.push(['sec', 'Costs']);
      rows.push(['Expense ratio', function (f) { return f.x && ok(f.x.expense) ? f.x.expense : null; }, function (f) { return f.x && ok(f.x.expense) ? pct(f.x.expense, 2, 1) : (f.kind === 'mf' ? 'n/a' : '–'); }, 'lo']);
      rows.push(['Total assets', function (f) { return null; }, function (f) { return f.x ? fmtBig(f, f.x.aum) : 'n/a'; }]);
    }
    rows.push(['sec', 'Verdict']);
    rows.push(['AI Fund Score', function (f) { return g(f).score ? g(f).score.overall : null; }, function (f) { return g(f).score ? '<b>' + g(f).score.overall.toFixed(1) + '</b> <span class="muted">' + g(f).score.label + '</span>' : '–'; }, 'hi']);

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
