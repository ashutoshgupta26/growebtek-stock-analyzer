/* Growebtek — Crypto Analysis: live market report, coin analyzer and comparison (CoinGecko public data). */
(function () {
  'use strict';
  if (!window.GW || !window.GK) return;
  var sess = GW.guard({ sub: 'Crypto Analysis' });
  if (!sess) return;
  var esc = GK.esc, ok = GK.ok, pct = GK.pct, cls = GK.cls, DAY = GK.DAY;
  var CG = 'https://api.coingecko.com/api/v3';
  var COLORS = ['#5b5bf6', '#ec4899', '#f97316', '#14b8a6'];
  var POP = [['bitcoin', 'Bitcoin'], ['ethereum', 'Ethereum'], ['solana', 'Solana'], ['ripple', 'XRP'], ['binancecoin', 'BNB'], ['dogecoin', 'Dogecoin'], ['cardano', 'Cardano'], ['tron', 'TRON']];
  var NEWS_WORDS = 'crypto|bitcoin|btc|ethereum|ether|blockchain|token|coin|binance|stablecoin|web3|defi|solana|xrp|altcoin|memecoin';
  var LS_CMP = 'gw_cx_cmp', LS_CUR = 'gw_cx_cur';
  var RANGES = [['24H', 1], ['7D', 7], ['30D', 30], ['90D', 90], ['1Y', 365]];
  var S = { tab: 'report', mode: 'analyze', cur: GK.loadLS(LS_CUR, 'usd'), coin: null, cmp: GK.loadLS(LS_CMP, []).slice(0, 4), range: '1Y', token: 0, showAll: false, sort: null };
  function $(id) { return document.getElementById(id); }

  // ------------------------------------------------------------------ data (cached, polite to the free API)
  var mem = {}, queue = Promise.resolve();
  function sleep(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }
  function cg(path, ttlSec) {
    var key = 'gw_cg_' + path;
    var m = mem[path];
    if (m && Date.now() - m.at < ttlSec * 1000) return m.p;
    var c = GK.loadLS(key, null);
    if (c && Date.now() - c.at < ttlSec * 1000) { mem[path] = { at: c.at, p: Promise.resolve(c.d) }; return mem[path].p; }
    var p = queue = queue.catch(function () {}).then(function () { return get(0); });
    function get(n) {
      return fetch(CG + path).then(function (r) {
        if (r.status === 429 && n < 2) return sleep([2000, 5000][n]).then(function () { return get(n + 1); });
        if (!r.ok) throw new Error('HTTP ' + r.status);
        return r.json();
      });
    }
    p = p.then(function (d) { try { localStorage.setItem(key, JSON.stringify({ at: Date.now(), d: d })); } catch (e) { pruneLS(); } return d; })
      .catch(function (e) { delete mem[path]; if (c) return c.d; throw e; });
    mem[path] = { at: Date.now(), p: p };
    return p;
  }
  function pruneLS() { try { Object.keys(localStorage).filter(function (k) { return k.indexOf('gw_cg_/coins/') === 0 && k.indexOf('market_chart') > 0; }).forEach(function (k) { localStorage.removeItem(k); }); } catch (e) {} }
  function fng() {
    var c = GK.loadLS('gw_fng', null);
    if (c && Date.now() - c.at < 3600e3) return Promise.resolve(c.d);
    return fetch('https://api.alternative.me/fng/?limit=31').then(function (r) { return r.json(); }).then(function (j) {
      var d = (j.data || []).map(function (x) { return { v: +x.value, c: x.value_classification, t: +x.timestamp * 1000 }; });
      GK.saveLS('gw_fng', { at: Date.now(), d: d }); return d;
    }).catch(function () { return c ? c.d : []; });
  }
  // Binance fallback for prices when the main feed is busy (USDT pairs, daily candles)
  function binance(sym, days) {
    var iv = days <= 1 ? '15m' : days <= 7 ? '1h' : days <= 90 ? '4h' : '1d', lim = days <= 1 ? 96 : days <= 7 ? 168 : days <= 90 ? Math.min(540, days * 6) : 365;
    return fetch('https://api.binance.com/api/v3/klines?symbol=' + sym.toUpperCase() + 'USDT&interval=' + iv + '&limit=' + lim).then(function (r) { if (!r.ok) throw 0; return r.json(); })
      .then(function (k) { return { prices: k.map(function (x) { return [x[0], +x[4]]; }), total_volumes: k.map(function (x) { return [x[0], +x[7]]; }), fx: true }; });
  }
  function chart(id, sym, days) {
    var path = '/coins/' + id + '/market_chart?vs_currency=' + S.cur + '&days=' + days + (days > 90 ? '&interval=daily' : '');
    return cg(path, days <= 1 ? 120 : days <= 7 ? 600 : 3600).catch(function () {
      return binance(sym, days).then(function (d) {
        if (S.cur === 'usd') return d;
        return market().then(function (m) { var r = usdInr(m); d.prices = d.prices.map(function (p) { return [p[0], p[1] * r]; }); d.total_volumes = d.total_volumes.map(function (p) { return [p[0], p[1] * r]; }); return d; });
      });
    });
  }
  function usdInr(m) { var g = m.global; return g && g.total_market_cap && g.total_market_cap.inr / g.total_market_cap.usd || 88; }
  function market() {
    var cur = S.cur;
    return Promise.all([
      cg('/coins/markets?vs_currency=' + cur + '&order=market_cap_desc&per_page=100&page=1&sparkline=true&price_change_percentage=1h,24h,7d,30d,1y', 60),
      cg('/global', 120).then(function (j) { return j.data; }).catch(function () { return null; })
    ]).then(function (r) { return { coins: r[0], global: r[1], cur: cur }; });
  }
  function coinDetail(id) {
    return cg('/coins/' + id + '?localization=false&tickers=false&community_data=false&developer_data=false&sparkline=false', 300).catch(function (e) {
      // feed busy: rebuild the basics from the cached top-100 list
      return market().then(function (mk) {
        var c = (mk.coins || []).filter(function (x) { return x.id === id; })[0]; if (!c) throw e;
        var o = function (v) { var r = {}; r[S.cur] = v; return r; };
        return { id: c.id, symbol: c.symbol, name: c.name, image: { large: c.image }, market_cap_rank: c.market_cap_rank, categories: [], description: { en: '' },
          market_data: { current_price: o(c.current_price), market_cap: o(c.market_cap), fully_diluted_valuation: o(c.fully_diluted_valuation), total_volume: o(c.total_volume),
            high_24h: o(c.high_24h), low_24h: o(c.low_24h), ath: o(c.ath), ath_change_percentage: o(c.ath_change_percentage), ath_date: o(c.ath_date), atl: o(c.atl), atl_change_percentage: o(c.atl_change_percentage),
            price_change_percentage_1h_in_currency: o(c.price_change_percentage_1h_in_currency), price_change_percentage_24h_in_currency: o(c.price_change_percentage_24h_in_currency),
            price_change_percentage_7d_in_currency: o(c.price_change_percentage_7d_in_currency), price_change_percentage_30d_in_currency: o(c.price_change_percentage_30d_in_currency),
            price_change_percentage_1y_in_currency: o(c.price_change_percentage_1y_in_currency), circulating_supply: c.circulating_supply, total_supply: c.total_supply, max_supply: c.max_supply } };
      });
    });
  }

  // ------------------------------------------------------------------ formatting
  function money(x, opt) {
    if (!ok(x)) return '–';
    opt = opt || {};
    var a = Math.abs(x), d = opt.d != null ? opt.d : a >= 1000 ? 0 : a >= 1 ? 2 : a >= 0.01 ? 4 : a >= 0.0001 ? 6 : 8;
    if (a >= 1000 && a < 1e5 && !opt.d) d = a >= 10000 ? 0 : 2;
    var s = (x < 0 ? '-' : '') + (S.cur === 'inr' ? '₹' : '$');
    return s + a.toLocaleString(S.cur === 'inr' ? 'en-IN' : 'en-US', { minimumFractionDigits: d > 2 ? Math.min(d, 2) : d, maximumFractionDigits: d });
  }
  function big(x) {
    if (!ok(x)) return '–';
    var a = Math.abs(x), s = x < 0 ? '-' : '';
    if (S.cur === 'inr') {
      if (a >= 1e12) return s + '₹' + (a / 1e12).toFixed(2) + ' lakh Cr';
      if (a >= 1e7) return s + '₹' + (a / 1e7).toLocaleString('en-IN', { maximumFractionDigits: a >= 1e10 ? 0 : 2 }) + ' Cr';
      if (a >= 1e5) return s + '₹' + (a / 1e5).toFixed(2) + ' L';
      return s + '₹' + Math.round(a).toLocaleString('en-IN');
    }
    if (a >= 1e12) return s + '$' + (a / 1e12).toFixed(2) + 'T';
    if (a >= 1e9) return s + '$' + (a / 1e9).toFixed(2) + 'B';
    if (a >= 1e6) return s + '$' + (a / 1e6).toFixed(2) + 'M';
    return s + '$' + Math.round(a).toLocaleString('en-US');
  }
  function units(x) { if (!ok(x)) return '–'; if (x >= 1e9) return (x / 1e9).toFixed(2) + 'B'; if (x >= 1e6) return (x / 1e6).toFixed(2) + 'M'; return Math.round(x).toLocaleString('en-US'); }
  function p100(x, d) { return ok(x) ? pct(x / 100, d) : '–'; }
  function retCell(x) { return '<td class="num ' + cls(x) + '">' + p100(x) + '</td>'; }
  function spark(v, up) {
    if (!v || v.length < 2) return '';
    var n = v.length, step = Math.max(1, Math.floor(n / 60)), lo = Infinity, hi = -Infinity, pts = [];
    for (var i = 0; i < n; i++) { if (v[i] < lo) lo = v[i]; if (v[i] > hi) hi = v[i]; }
    for (var j = 0; j < n; j += step) pts.push((j / (n - 1) * 100).toFixed(1) + ',' + (28 - (v[j] - lo) / ((hi - lo) || 1) * 26 - 1).toFixed(1));
    pts.push('100,' + (28 - (v[n - 1] - lo) / ((hi - lo) || 1) * 26 - 1).toFixed(1));
    return '<svg class="kx-spark" viewBox="0 0 100 28" preserveAspectRatio="none" aria-hidden="true"><polyline points="' + pts.join(' ') + '" fill="none" stroke="' + (up ? '#0f8a3c' : '#d02a2a') + '" stroke-width="1.6" vector-effect="non-scaling-stroke"/></svg>';
  }
  function img(u, cl) { return u ? '<img class="' + (cl || 'kx-ci') + '" src="' + esc(u) + '" alt="" loading="lazy" referrerpolicy="no-referrer">' : ''; }
  function loading(t) { return '<section class="gw-card fx-load"><span class="gw-spin dark"></span>' + esc(t) + '</section>'; }
  function errCard(t, retry) { return '<section class="gw-card fx-errc"><p>' + esc(t) + '</p>' + (retry ? '<button class="gw-btn ghost" type="button" data-retry>Try again</button>' : '') + '</section>'; }
  function newsCard(title, q, must, id) {
    setTimeout(function () {
      GK.news(q, must).then(function (n) { var el = $(id); if (el) el.innerHTML = GK.newsList(n, 10); });
    }, 0);
    return '<section class="gw-card"><h2>📰 ' + esc(title) + ' <span class="sub">Latest first</span></h2><div id="' + id + '"><div class="fx-load" style="padding:16px"><span class="gw-spin dark"></span>Loading headlines…</div></div></section>';
  }

  // ------------------------------------------------------------------ indicators
  function sma(v, n) { if (v.length < n) return null; var s = 0; for (var i = v.length - n; i < v.length; i++) s += v[i]; return s / n; }
  function ema(v, n) { if (v.length < n) return []; var k = 2 / (n + 1), e = [], s = 0; for (var i = 0; i < n; i++) s += v[i]; e[n - 1] = s / n; for (var j = n; j < v.length; j++) e[j] = v[j] * k + e[j - 1] * (1 - k); return e; }
  function rsi(v, n) {
    n = n || 14; if (v.length <= n) return null;
    var g = 0, l = 0;
    for (var i = 1; i <= n; i++) { var d = v[i] - v[i - 1]; if (d > 0) g += d; else l -= d; }
    g /= n; l /= n;
    for (var j = n + 1; j < v.length; j++) { var e = v[j] - v[j - 1]; g = (g * (n - 1) + Math.max(e, 0)) / n; l = (l * (n - 1) + Math.max(-e, 0)) / n; }
    return l === 0 ? 100 : 100 - 100 / (1 + g / l);
  }
  function macd(v) {
    var a = ema(v, 12), b = ema(v, 26); if (!b.length) return null;
    var m = []; for (var i = 25; i < v.length; i++) m.push(a[i] - b[i]);
    var sg = ema(m, 9); if (!sg.length) return null;
    return { m: m[m.length - 1], s: sg[sg.length - 1], h: m[m.length - 1] - sg[sg.length - 1] };
  }
  function daily(prices) { // one close per UTC day
    var out = [], last = -1;
    prices.forEach(function (p) { var d = Math.floor(p[0] / DAY); if (d === last) out[out.length - 1] = p; else { out.push(p); last = d; } });
    return out;
  }
  function logRets(v) { var r = []; for (var i = 1; i < v.length; i++) if (v[i] > 0 && v[i - 1] > 0) r.push(Math.log(v[i] / v[i - 1])); return r; }
  function stdev(r) { if (r.length < 2) return null; var m = 0; r.forEach(function (x) { m += x; }); m /= r.length; var s = 0; r.forEach(function (x) { s += (x - m) * (x - m); }); return Math.sqrt(s / (r.length - 1)); }
  function maxDD(v) { var pk = -Infinity, dd = 0; v.forEach(function (x) { if (x > pk) pk = x; var d = x / pk - 1; if (d < dd) dd = d; }); return dd; }
  function corr(a, b) {
    var n = Math.min(a.length, b.length); if (n < 20) return null; a = a.slice(-n); b = b.slice(-n);
    var ma = 0, mb = 0; for (var i = 0; i < n; i++) { ma += a[i]; mb += b[i]; } ma /= n; mb /= n;
    var c = 0, va = 0, vb = 0; for (var j = 0; j < n; j++) { c += (a[j] - ma) * (b[j] - mb); va += (a[j] - ma) * (a[j] - ma); vb += (b[j] - mb) * (b[j] - mb); }
    return va && vb ? { r: c / Math.sqrt(va * vb), beta: c / vb } : null;
  }

  // Full metric set for one coin. d = /coins/{id}, h = 365-day chart, b = bitcoin 365-day chart (optional)
  function metrics(d, h, b, fg) {
    var md = d.market_data || {}, cur = S.cur;
    var px = daily(h.prices || []), v = px.map(function (p) { return p[1]; });
    var price = md.current_price && md.current_price[cur] || v[v.length - 1];
    var r = logRets(v), sd = stdev(r), vol = sd ? sd * Math.sqrt(365) : null;
    var m = {
      id: d.id, name: d.name, sym: (d.symbol || '').toUpperCase(), image: d.image && (d.image.large || d.image.small), rank: d.market_cap_rank,
      price: price, mcap: md.market_cap && md.market_cap[cur], fdv: md.fully_diluted_valuation && md.fully_diluted_valuation[cur], vol24: md.total_volume && md.total_volume[cur],
      hi24: md.high_24h && md.high_24h[cur], lo24: md.low_24h && md.low_24h[cur],
      ath: md.ath && md.ath[cur], athPct: md.ath_change_percentage && md.ath_change_percentage[cur], athDate: md.ath_date && Date.parse(md.ath_date[cur]),
      atl: md.atl && md.atl[cur], atlPct: md.atl_change_percentage && md.atl_change_percentage[cur],
      r1h: md.price_change_percentage_1h_in_currency && md.price_change_percentage_1h_in_currency[cur],
      r24: md.price_change_percentage_24h_in_currency && md.price_change_percentage_24h_in_currency[cur],
      r7: md.price_change_percentage_7d_in_currency && md.price_change_percentage_7d_in_currency[cur],
      r30: md.price_change_percentage_30d_in_currency && md.price_change_percentage_30d_in_currency[cur],
      r60: md.price_change_percentage_60d_in_currency && md.price_change_percentage_60d_in_currency[cur],
      r200: md.price_change_percentage_200d_in_currency && md.price_change_percentage_200d_in_currency[cur],
      r1y: md.price_change_percentage_1y_in_currency && md.price_change_percentage_1y_in_currency[cur],
      circ: md.circulating_supply, total: md.total_supply, max: md.max_supply, maxInf: md.max_supply_infinite,
      up: d.sentiment_votes_up_percentage, watch: d.watchlist_portfolio_users, cats: (d.categories || []).filter(function (c) { return c && !/FTX|Portfolio|Index|Holdings|Alleged/i.test(c); }).slice(0, 6),
      genesis: d.genesis_date, algo: d.hashing_algorithm, home: d.links && (d.links.homepage || []).filter(Boolean)[0], desc: d.description && d.description.en || '',
      chain: d.asset_platform_id, series: px, vol: vol, dd: v.length > 20 ? maxDD(v) : null,
      sma20: sma(v, 20), sma50: sma(v, 50), sma200: sma(v, 200), rsi: rsi(v.slice(-120)), macd: macd(v.slice(-200)),
      hi30: v.length ? Math.max.apply(null, v.slice(-30)) : null, lo30: v.length ? Math.min.apply(null, v.slice(-30)) : null,
      hi1y: v.length ? Math.max.apply(null, v) : null, lo1y: v.length ? Math.min.apply(null, v) : null, fx: h.fx, fg: fg
    };
    if (v.length > 90) m.r90 = (v[v.length - 1] / v[v.length - 91] - 1) * 100;
    if (!ok(m.r1y) && v.length > 360) m.r1y = (v[v.length - 1] / v[0] - 1) * 100;
    var upDays = r.slice(-90).filter(function (x) { return x > 0; }).length; m.upShare = r.length ? upDays / Math.min(90, r.length) : null;
    var vv = (h.total_volumes || []).map(function (p) { return p[1]; }); m.vol30 = vv.length >= 30 ? sma(vv, 30) : null;
    m.liq = ok(m.vol24) && m.mcap ? m.vol24 / m.mcap : null;
    m.circPct = m.max ? m.circ / m.max : m.total ? m.circ / m.total : null;
    m.mcapFdv = m.fdv && m.mcap ? m.mcap / m.fdv : null;
    if (b && d.id !== 'bitcoin') { var bv = daily(b.prices || []).map(function (p) { return p[1]; }); var c = corr(r, logRets(bv)); if (c) { m.corr = c.r; m.beta = c.beta; } }
    m.score = score(m); m.pros = pros(m); m.cons = cons(m);
    return m;
  }
  function clamp(x, a, b) { return Math.max(a, Math.min(b, x)); }
  function score(m) {
    var parts = [];
    // Momentum: trend vs moving averages + medium-term returns
    var mo = 5;
    if (ok(m.sma200)) mo += m.price > m.sma200 ? 1.5 : -1.5;
    if (ok(m.sma50)) mo += m.price > m.sma50 ? 1 : -1;
    if (ok(m.r90)) mo += clamp(m.r90 / 25, -1.5, 1.5);
    if (ok(m.r30)) mo += clamp(m.r30 / 20, -1, 1);
    parts.push({ k: 'Momentum', s: clamp(mo, 0, 10), d: ok(m.sma200) ? (m.price > m.sma200 ? 'Above' : 'Below') + ' its 200-day average; 90-day return ' + p100(m.r90) : '30-day return ' + p100(m.r30) });
    // Risk: lower volatility and smaller drawdowns score higher
    if (ok(m.vol)) {
      var rk = 10 - clamp((m.vol - 0.35) / 0.09, 0, 7) - (ok(m.dd) ? clamp((-m.dd - 0.25) / 0.12, 0, 3) : 1.5);
      parts.push({ k: 'Risk control', s: clamp(rk, 0, 10), d: 'Volatility ' + pct(m.vol, 0, true) + ' a year; worst fall in 1Y ' + pct(m.dd, 0) });
    }
    // Size & liquidity
    var sz = m.rank ? (m.rank <= 2 ? 10 : m.rank <= 10 ? 8.5 : m.rank <= 25 ? 7 : m.rank <= 50 ? 6 : m.rank <= 100 ? 5 : m.rank <= 300 ? 3.5 : 2) : 2;
    if (ok(m.liq)) sz += m.liq < 0.005 ? -2 : m.liq < 0.015 ? -0.7 : m.liq > 0.06 ? 0.5 : 0;
    parts.push({ k: 'Size & liquidity', s: clamp(sz, 0, 10), d: (m.rank ? 'Rank #' + m.rank : 'Unranked') + (ok(m.liq) ? '; daily trading ' + pct(m.liq, 1, true) + ' of its value' : '') });
    // Supply / tokenomics
    var tk = 5;
    if (m.max) tk += 1.5; else if (m.maxInf) tk -= 1;
    if (ok(m.circPct)) tk += m.circPct > 0.9 ? 2 : m.circPct > 0.7 ? 1 : m.circPct > 0.4 ? -0.5 : -2;
    if (ok(m.mcapFdv)) tk += m.mcapFdv > 0.9 ? 1 : m.mcapFdv < 0.5 ? -1.5 : 0;
    if (/stable/i.test(m.cats.join(' '))) tk = 6;
    parts.push({ k: 'Supply health', s: clamp(tk, 0, 10), d: (m.max ? 'Hard cap of ' + units(m.max) : m.maxInf ? 'No supply cap' : 'Supply cap not set') + (ok(m.circPct) ? '; ' + pct(m.circPct, 0, true) + ' already in circulation' : '') });
    // Sentiment
    if (ok(m.up) || ok(m.rsi)) {
      var se = 5;
      if (ok(m.up)) se += clamp((m.up - 60) / 8, -2.5, 2.5);
      if (ok(m.rsi)) se += m.rsi > 75 ? -1 : m.rsi < 28 ? -0.5 : m.rsi >= 50 ? 1 : 0;
      parts.push({ k: 'Sentiment', s: clamp(se, 0, 10), d: (ok(m.up) ? pct(m.up / 100, 0, true) + ' of community votes bullish' : '') + (ok(m.rsi) ? (ok(m.up) ? '; ' : '') + 'RSI ' + m.rsi.toFixed(0) : '') });
    }
    var tot = 0, w = { 'Momentum': 1.2, 'Risk control': 1.1, 'Size & liquidity': 1.1, 'Supply health': 0.8, 'Sentiment': 0.6 }, ws = 0;
    parts.forEach(function (p) { p.s = Math.round(p.s * 10) / 10; tot += p.s * w[p.k]; ws += w[p.k]; });
    var o = Math.round(tot / ws * 10) / 10;
    return { parts: parts, overall: o, label: o >= 7.5 ? 'Strong' : o >= 6.2 ? 'Positive' : o >= 4.8 ? 'Neutral' : o >= 3.5 ? 'Cautious' : 'Weak' };
  }
  function pros(m) {
    var p = [];
    if (m.rank && m.rank <= 10) p.push('One of the 10 largest crypto assets (rank #' + m.rank + '), with deep liquidity.');
    if (ok(m.sma200) && m.price > m.sma200) p.push('Trading above its 200-day average: the long-term trend is up.');
    if (ok(m.r1y) && m.r1y > 30) p.push('Up ' + p100(m.r1y, 0) + ' over the past year.');
    if (m.max && ok(m.circPct) && m.circPct > 0.85) p.push('Fixed maximum supply, ' + pct(m.circPct, 0, true) + ' already issued: little dilution ahead.');
    if (ok(m.vol) && m.vol < 0.5) p.push('Calmer than most coins: about ' + pct(m.vol, 0, true) + ' annual volatility.');
    if (ok(m.up) && m.up >= 75) p.push(pct(m.up / 100, 0, true) + ' of community votes are bullish.');
    if (ok(m.liq) && m.liq > 0.05) p.push('Heavy trading volume relative to its size makes it easy to buy and sell.');
    if (ok(m.rsi) && m.rsi < 32) p.push('RSI ' + m.rsi.toFixed(0) + ': oversold, which has often come before a bounce.');
    return p.slice(0, 5);
  }
  function cons(m) {
    var c = [];
    if (ok(m.vol) && m.vol > 0.8) c.push('Very volatile: about ' + pct(m.vol, 0, true) + ' a year, so big swings are normal.');
    if (ok(m.athPct) && m.athPct < -60) c.push('Still ' + p100(-m.athPct, 0).replace('+', '') + ' below its all-time high.');
    if (ok(m.sma200) && m.price < m.sma200) c.push('Below its 200-day average: the long-term trend is down.');
    if (ok(m.dd) && m.dd < -0.5) c.push('Fell ' + pct(-m.dd, 0, true) + ' from peak to trough in the past year.');
    if (m.maxInf || (!m.max && !/stable/i.test(m.cats.join(' ')))) c.push('No hard supply cap: new coins can keep diluting holders.');
    if (ok(m.mcapFdv) && m.mcapFdv < 0.6) c.push('Only ' + pct(m.mcapFdv, 0, true) + ' of the fully diluted value is circulating: token unlocks can pressure the price.');
    if (ok(m.liq) && m.liq < 0.01) c.push('Thin trading relative to its size.');
    if (ok(m.rsi) && m.rsi > 72) c.push('RSI ' + m.rsi.toFixed(0) + ': overbought in the short term.');
    if (!m.rank || m.rank > 100) c.push('Small coin outside the top 100: higher risk of sharp falls.');
    c.push('Crypto is unregulated in India; gains are taxed at 30% with 1% TDS.');
    return c.slice(0, 5);
  }
  function verdict(m) {
    var o = m.score.overall;
    var c = o >= 6.2 ? 'green' : o >= 4.8 ? 'amber' : 'red';
    var t = o >= 7.5 ? 'Strong profile: trend, size and supply all look healthy.' : o >= 6.2 ? 'Positive profile, with a few points to watch.' : o >= 4.8 ? 'Mixed signals: wait for a clearer trend or invest small.' : o >= 3.5 ? 'Weak trend or high risk: only for money you can afford to lose.' : 'Weak on most measures: very high risk.';
    return { c: c, t: t };
  }

  // ------------------------------------------------------------------ Market Report
  function renderReport() {
    var tk = ++S.token;
    if (!S.mkt) $('view').innerHTML = loading('Loading live crypto market…');
    Promise.all([market(), fng(), cg('/search/trending', 600).catch(function () { return null; }), cg('/coins/categories', 1800).catch(function () { return null; })]).then(function (r) {
      if (tk !== S.token) return;
      S.mkt = r[0]; drawReport(r[0], r[1], r[2], r[3]);
    }).catch(function () {
      if (tk !== S.token) return;
      $('view').innerHTML = errCard('Live crypto prices are busy right now. Please try again in a minute.', true);
    });
  }
  function drawReport(M, F, T, C) {
    var coins = M.coins || [], g = M.global || {}, cur = S.cur;
    var mc = g.total_market_cap && g.total_market_cap[cur], tv = coins.reduce(function (a, c) { return a + (c.total_volume || 0); }, 0) || null, mcc = g.market_cap_change_percentage_24h_usd;
    var dom = g.market_cap_percentage || {}, f0 = F && F[0];
    var btc = coins.filter(function (c) { return c.id === 'bitcoin'; })[0], eth = coins.filter(function (c) { return c.id === 'ethereum'; })[0];
    var real = coins.filter(function (c) { return !/usd|dai|eur|fdusd|usde|pyusd|tusd|usds|rlusd|usd0|usdtb|bfusd|xaut|paxg|wbtc|steth|wsteth|weeth|weth|cbbtc|bsc-usd|lbtc|jitosol|reth|meth|susde|syrupusdc/i.test(c.symbol + '|' + c.id) || /bitcoin|ethereum$/.test(c.id); });
    real = real.filter(function (c) { return !(/^(usdt|usdc|dai|fdusd|usde|usds|pyusd|tusd|rlusd|usd1|usdtb|bfusd|susde)$/.test(c.symbol)) && !/wrapped|staked|bridged/i.test(c.name); });
    var adv = real.filter(function (c) { return c.price_change_percentage_24h_in_currency > 0; }).length;
    var by = function (k, dir) { return real.filter(function (c) { return ok(c[k]); }).slice().sort(function (a, b) { return dir * (b[k] - a[k]); }); };
    var gain = by('price_change_percentage_24h_in_currency', 1).slice(0, 6), lose = by('price_change_percentage_24h_in_currency', -1).slice(0, 6);
    var g7 = by('price_change_percentage_7d_in_currency', 1)[0], l7 = by('price_change_percentage_7d_in_currency', -1)[0];
    var mood = !ok(mcc) ? 'Mixed' : mcc > 2 ? 'Strong rally' : mcc > 0.5 ? 'Positive' : mcc > -0.5 ? 'Flat' : mcc > -2 ? 'Weak' : 'Sell-off';
    var h = '';
    // KPIs
    h += '<section class="kx-kpis">' +
      kpi('Total market value', big(mc), ok(mcc) ? p100(mcc) + ' in 24h' : '', cls(mcc)) +
      kpi('24h volume (top 100)', big(tv), mc && tv ? pct(tv / mc, 1, true) + ' of market value' : '') +
      kpi('Bitcoin dominance', ok(dom.btc) ? dom.btc.toFixed(1) + '%' : '–', ok(dom.eth) ? 'Ethereum ' + dom.eth.toFixed(1) + '%' : '') +
      kpi('Fear & Greed', f0 ? f0.v + ' / 100' : '–', f0 ? f0.c + (F[1] ? ' (yesterday ' + F[1].v + ')' : '') : '', f0 ? (f0.v >= 55 ? 'up' : f0.v <= 45 ? 'dn' : '') : '') +
      kpi('Bitcoin', btc ? money(btc.current_price) : '–', btc ? p100(btc.price_change_percentage_24h_in_currency) + ' in 24h' : '', btc ? cls(btc.price_change_percentage_24h_in_currency) : '') +
      kpi('Ethereum', eth ? money(eth.current_price) : '–', eth ? p100(eth.price_change_percentage_24h_in_currency) + ' in 24h' : '', eth ? cls(eth.price_change_percentage_24h_in_currency) : '') +
      '</section>';
    // Summary
    var sum = [];
    sum.push('<b>Market mood: ' + mood + '.</b> The whole crypto market is worth ' + big(mc) + (ok(mcc) ? ', ' + (mcc >= 0 ? 'up ' : 'down ') + Math.abs(mcc).toFixed(2) + '% in 24 hours.' : '.'));
    sum.push('<b>Breadth:</b> ' + adv + ' of the top ' + real.length + ' coins (excluding stablecoins and wrapped tokens) are up today.');
    if (btc) sum.push('<b>Bitcoin</b> is at ' + money(btc.current_price) + ' (' + p100(btc.price_change_percentage_24h_in_currency) + ' 24h, ' + p100(btc.price_change_percentage_7d_in_currency) + ' 7d), ' + p100(btc.ath_change_percentage, 1).replace('+', '') + ' from its all-time high of ' + money(btc.ath) + '.');
    if (f0) sum.push('<b>Sentiment:</b> the Fear & Greed index reads ' + f0.v + ' (' + f0.c + ')' + (F.length > 7 ? ', against ' + F[7].v + ' a week ago' : '') + '. ' + (f0.v >= 75 ? 'Extreme greed has often preceded pullbacks.' : f0.v <= 25 ? 'Extreme fear has often been a better time to accumulate than to sell.' : ''));
    if (gain[0] && lose[0]) sum.push('<b>Biggest moves today:</b> ' + esc(gain[0].name) + ' ' + p100(gain[0].price_change_percentage_24h_in_currency) + ', ' + esc(lose[0].name) + ' ' + p100(lose[0].price_change_percentage_24h_in_currency) + '.');
    if (g7 && l7) sum.push('<b>This week:</b> best ' + esc(g7.name) + ' ' + p100(g7.price_change_percentage_7d_in_currency) + ', worst ' + esc(l7.name) + ' ' + p100(l7.price_change_percentage_7d_in_currency) + '.');
    h += '<section class="gw-card fx-exec"><div class="fx-hrow"><h2>📊 Crypto Market Report <span class="sub">' + new Date().toLocaleString('en-GB', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' }) + ' · live</span></h2><button class="gw-btn-ic" type="button" data-refresh>Refresh</button></div><ul class="fx-sum">' + sum.map(function (s) { return '<li>' + s + '</li>'; }).join('') + '</ul></section>';
    // BTC & ETH 7d chart + Fear & Greed
    h += '<div class="kx-2">';
    h += '<section class="gw-card"><h2>Bitcoin vs Ethereum <span class="sub">Last 7 days, % change</span></h2><div id="be7"></div><div class="fx-legend"><span><i style="background:' + COLORS[2] + '"></i>Bitcoin</span><span><i style="background:' + COLORS[0] + '"></i>Ethereum</span></div></section>';
    h += '<section class="gw-card"><h2>😨 Fear & Greed <span class="sub">Last 30 days</span></h2>' + (f0 ? gauge(f0.v, f0.c) + '<div id="fg30"></div>' : '<p class="muted">Not available right now.</p>') + '</section>';
    h += '</div>';
    // Movers
    h += '<div class="kx-2">' + moversCard('🚀 Top gainers (24h)', gain) + moversCard('📉 Top losers (24h)', lose) + '</div>';
    // Trending + categories
    var tr = T && T.coins ? T.coins.slice(0, 8).map(function (x) { return x.item; }) : [];
    var cats = C ? C.filter(function (c) { return c.market_cap > (cur === 'usd' ? 1e9 : 1e9) && ok(c.market_cap_change_24h); }).sort(function (a, b) { return b.market_cap_change_24h - a.market_cap_change_24h; }) : [];
    h += '<div class="kx-2">';
    h += '<section class="gw-card"><h2>🔥 Trending searches</h2>' + (tr.length ? '<div class="kx-trend">' + tr.map(function (x) { var p = x.data && x.data.price_change_percentage_24h && x.data.price_change_percentage_24h[cur]; return '<button type="button" class="kx-tr" data-coin="' + esc(x.id) + '">' + img(x.small || x.thumb) + '<span><b>' + esc(x.name) + '</b><small>' + esc((x.symbol || '').toUpperCase()) + (x.market_cap_rank ? ' · #' + x.market_cap_rank : '') + '</small></span>' + (ok(p) ? '<em class="' + cls(p) + '">' + p100(p) + '</em>' : '') + '</button>'; }).join('') + '</div>' : '<p class="muted">Not available right now.</p>') + '</section>';
    h += '<section class="gw-card"><h2>🧩 Sectors today <span class="sub">Market value change, 24h</span></h2>' + (cats.length ? sectorBars(cats.slice(0, 5).concat(cats.slice(-3))) : '<p class="muted">Not available right now.</p>') + '</section>';
    h += '</div>';
    // Table
    h += '<section class="gw-card"><div class="fx-hrow"><h2>🏆 Top 100 coins <span class="sub">By market value</span></h2><input class="gw-input kx-filter" id="tf" type="search" placeholder="Filter, e.g. sol" aria-label="Filter coins"></div><div class="gw-tbl-wrap"><table class="gw-tbl kx-tbl" id="tt"></table></div>' +
      '<div style="text-align:center;margin-top:10px"><button class="gw-btn ghost" type="button" id="more">' + (S.showAll ? 'Show top 25' : 'Show all 100') + '</button></div></section>';
    // Outlook
    if (btc) h += outlookCard(btc, F);
    h += newsCard('Latest crypto news', 'cryptocurrency bitcoin market', NEWS_WORDS, 'rnews');
    $('view').innerHTML = h;
    S.rows = coins; drawTable();
    if (btc && eth) {
      var mk = function (c, col, nm) { var s = c.sparkline_in_7d && c.sparkline_in_7d.price || []; var t1 = Date.parse(c.last_updated) || Date.now(), n = s.length; return { name: nm, color: col, t: s.map(function (_, i) { return t1 - (n - 1 - i) * 3600e3; }), v: s.map(function (x) { return x / s[0] - 1; }) }; };
      GK.lineChart($('be7'), [mk(btc, COLORS[2], 'Bitcoin'), mk(eth, COLORS[0], 'Ethereum')], { zero: true, fmtY: function (x) { return pct(x, 0); }, tip: function (v) { return pct(v, 2); }, h: function () { return 220; } });
    }
    if (f0 && F.length > 2 && $('fg30')) { var fr = F.slice().reverse(); GK.lineChart($('fg30'), [{ name: 'Index', color: '#f97316', t: fr.map(function (x) { return x.t; }), v: fr.map(function (x) { return x.v; }), fill: true }], { h: function () { return 150; }, fmtY: function (x) { return String(Math.round(x)); }, tip: function (v) { return v + ''; } }); }
  }
  function kpi(l, v, s, c) { return '<div class="kx-kpi"><span>' + esc(l) + '</span><b class="num">' + v + '</b>' + (s ? '<small class="' + (c || '') + '">' + s + '</small>' : '') + '</div>'; }
  function gauge(v, c) {
    var col = v >= 75 ? '#0f8a3c' : v >= 55 ? '#16a34a' : v > 45 ? '#f59e0b' : v > 25 ? '#f97316' : '#d02a2a';
    return '<div class="kx-gauge"><div class="tr"><i style="left:' + v + '%;background:' + col + '"></i></div><div class="lb"><span>Extreme fear</span><span>Neutral</span><span>Extreme greed</span></div><p><b style="color:' + col + '">' + v + ' · ' + esc(c) + '</b></p></div>';
  }
  function moversCard(t, a) {
    return '<section class="gw-card"><h2>' + t + '</h2><div class="kx-mov">' + a.map(function (c) {
      return '<button type="button" data-coin="' + esc(c.id) + '">' + img(c.image) + '<span class="n"><b>' + esc(c.name) + '</b><small>' + esc(c.symbol.toUpperCase()) + ' · ' + money(c.current_price) + '</small></span><em class="' + cls(c.price_change_percentage_24h_in_currency) + '">' + p100(c.price_change_percentage_24h_in_currency) + '</em></button>';
    }).join('') + '</div></section>';
  }
  function sectorBars(a) {
    var mx = Math.max.apply(null, a.map(function (c) { return Math.abs(c.market_cap_change_24h); })) || 1;
    return a.map(function (c) { var x = c.market_cap_change_24h; return '<div class="fx-hbar"><span class="n">' + esc(c.name) + '</span><span class="v ' + cls(x) + '">' + p100(x) + '</span><span class="tr"><i style="width:' + (Math.abs(x) / mx * 100).toFixed(0) + '%;background:' + (x >= 0 ? 'var(--gw-up)' : 'var(--gw-dn)') + '"></i></span></div>'; }).join('');
  }
  function outlookCard(b, F) {
    var s = b.sparkline_in_7d && b.sparkline_in_7d.price || [], hi7 = s.length ? Math.max.apply(null, s) : null, lo7 = s.length ? Math.min.apply(null, s) : null, p = b.current_price;
    var pos = hi7 && lo7 ? (p - lo7) / ((hi7 - lo7) || 1) : null, f = F && F[0] ? F[0].v : null;
    var view = b.price_change_percentage_30d_in_currency > 5 && b.price_change_percentage_7d_in_currency > 0 ? 'Uptrend intact' : b.price_change_percentage_30d_in_currency < -5 && b.price_change_percentage_7d_in_currency < 0 ? 'Downtrend' : 'Range-bound';
    return '<section class="gw-card"><h2>🧭 Bitcoin levels to watch</h2><div class="fx-kv2">' +
      '<div><span>Price now</span><b class="num">' + money(p) + '</b></div><div><span>24h range</span><b class="num">' + money(b.low_24h) + ' – ' + money(b.high_24h) + '</b></div>' +
      '<div><span>7-day support (low)</span><b class="num">' + money(lo7) + '</b></div><div><span>7-day resistance (high)</span><b class="num">' + money(hi7) + '</b></div>' +
      '<div><span>All-time high</span><b class="num">' + money(b.ath) + '</b></div><div><span>30-day change</span><b class="num ' + cls(b.price_change_percentage_30d_in_currency) + '">' + p100(b.price_change_percentage_30d_in_currency) + '</b></div>' +
      '<div><span>1-year change</span><b class="num ' + cls(b.price_change_percentage_1y_in_currency) + '">' + p100(b.price_change_percentage_1y_in_currency) + '</b></div><div><span>Short-term view</span><b>' + view + '</b></div>' +
      '</div><p class="fx-note">' + (ok(pos) ? 'Bitcoin is in the ' + (pos > 0.66 ? 'upper' : pos < 0.33 ? 'lower' : 'middle') + ' part of its 7-day range. ' : '') + 'A daily close above ' + money(hi7) + ' would break the weekly range upward; below ' + money(lo7) + ' would open a deeper pullback.' + (f >= 75 ? ' Greed is high, so chase rallies with care.' : f <= 25 ? ' Fear is high; long-term buyers often average in at such times.' : '') + '</p></section>';
  }
  function drawTable() {
    var el = $('tt'); if (!el) return;
    var q = ($('tf') && $('tf').value || '').trim().toLowerCase(), rows = S.rows || [];
    if (q) rows = rows.filter(function (c) { return c.name.toLowerCase().indexOf(q) >= 0 || c.symbol.toLowerCase().indexOf(q) >= 0; });
    if (S.sort) { var k = S.sort[0], dir = S.sort[1]; rows = rows.slice().sort(function (a, b) { var x = a[k], y = b[k]; if (!ok(x)) return 1; if (!ok(y)) return -1; return dir * (y - x); }); }
    if (!q && !S.showAll) rows = rows.slice(0, 25);
    var th = function (k, l) { return '<th data-sort="' + k + '" class="kx-sort' + (S.sort && S.sort[0] === k ? ' on' : '') + '">' + l + (S.sort && S.sort[0] === k ? (S.sort[1] > 0 ? ' ↓' : ' ↑') : '') + '</th>'; };
    el.innerHTML = '<thead><tr><th>#</th><th>Coin</th>' + th('current_price', 'Price') + th('price_change_percentage_1h_in_currency', '1h') + th('price_change_percentage_24h_in_currency', '24h') + th('price_change_percentage_7d_in_currency', '7d') + th('price_change_percentage_30d_in_currency', '30d') + th('price_change_percentage_1y_in_currency', '1y') + th('market_cap', 'Market value') + th('total_volume', 'Volume 24h') + '<th>Last 7 days</th></tr></thead><tbody>' +
      (rows.length ? rows.map(function (c) {
        var sp = c.sparkline_in_7d && c.sparkline_in_7d.price;
        return '<tr data-coin="' + esc(c.id) + '" tabindex="0"><td class="muted">' + (c.market_cap_rank || '') + '</td><td><span class="kx-coin">' + img(c.image) + '<b>' + esc(c.name) + '</b><small>' + esc(c.symbol.toUpperCase()) + '</small></span></td><td class="num">' + money(c.current_price) + '</td>' +
          retCell(c.price_change_percentage_1h_in_currency) + retCell(c.price_change_percentage_24h_in_currency) + retCell(c.price_change_percentage_7d_in_currency) + retCell(c.price_change_percentage_30d_in_currency) + retCell(c.price_change_percentage_1y_in_currency) +
          '<td class="num">' + big(c.market_cap) + '</td><td class="num">' + big(c.total_volume) + '</td><td>' + spark(sp, sp && sp[sp.length - 1] >= sp[0]) + '</td></tr>';
      }).join('') : '<tr><td colspan="11" class="muted">No coin in the top 100 matches. Use Coin Analyzer to search all coins.</td></tr>') + '</tbody>';
  }

  // ------------------------------------------------------------------ Coin Analyzer
  function analyze(id) {
    S.coin = id; S.tab = 'coin'; S.mode = 'analyze'; syncTabs();
    try { history.replaceState(null, '', '#coin=' + encodeURIComponent(id)); } catch (e) {}
    var tk = ++S.token;
    $('view').innerHTML = loading('Analyzing ' + id.replace(/-/g, ' ') + '…');
    var need = [coinDetail(id), chart(id, '', 365).catch(function () { return null; }), fng()];
    if (id !== 'bitcoin') need.push(chart('bitcoin', 'btc', 365).catch(function () { return null; }));
    Promise.all(need).then(function (r) {
      if (tk !== S.token) return;
      var d = r[0], h = r[1];
      if (!h) return chart(id, d.symbol, 365).then(function (h2) { go(d, h2, r[2], r[3]); }, function () { go(d, { prices: [] }, r[2], r[3]); });
      go(d, h, r[2], r[3]);
    }).catch(function () {
      if (tk !== S.token) return;
      $('view').innerHTML = errCard('Could not load this coin right now. The live feed may be busy; please try again in a minute.', true);
    });
    function go(d, h, f, b) { if (tk !== S.token) return; var m = metrics(d, h, id === 'bitcoin' ? null : b, f && f[0]); S.cur_m = m; drawCoin(m); }
  }
  function drawCoin(m) {
    var v = verdict(m), h = '';
    h += '<section class="gw-card fx-head"><div><h1>' + img(m.image, 'kx-logo') + esc(m.name) + ' <span class="muted" style="font-size:.7em">' + esc(m.sym) + '</span></h1>' +
      '<div class="meta">' + (m.rank ? 'Rank #' + m.rank + ' by market value' : 'Not ranked') + (m.genesis ? ' · Launched ' + esc(m.genesis.slice(0, 4)) : '') + (m.chain ? ' · Token on ' + esc(m.chain) : '') + '</div>' +
      '<div class="chips">' + m.cats.map(function (c) { return '<span class="gw-chip indigo">' + esc(c) + '</span>'; }).join('') + '</div></div>' +
      '<div class="fx-nav"><div class="lab">Price</div><div class="big num">' + money(m.price) + '</div><div class="num ' + cls(m.r24) + '" style="font-weight:800">' + p100(m.r24) + ' today</div>' +
      '<div class="acts"><button class="gw-btn ghost" type="button" data-addcmp="' + esc(m.id) + '" style="height:38px;font-size:13px">' + (S.cmp.indexOf(m.id) >= 0 ? '✓ In compare' : '+ Compare') + '</button></div></div>' +
      '<div class="fx-kv">' +
      kv('Market value', big(m.mcap)) + kv('Fully diluted value', big(m.fdv)) + kv('Volume 24h', big(m.vol24)) + kv('24h range', money(m.lo24) + ' – ' + money(m.hi24)) +
      kv('All-time high', money(m.ath) + ' <small class="dn">' + p100(m.athPct, 0) + '</small>') + kv('All-time low', money(m.atl)) +
      kv('Circulating supply', units(m.circ) + ' ' + esc(m.sym)) + kv('Max supply', m.max ? units(m.max) : m.maxInf ? 'Unlimited' : '–') +
      '</div></section>';
    // returns
    var rt = [['1h', m.r1h], ['24h', m.r24], ['7d', m.r7], ['30d', m.r30], ['60d', m.r60], ['90d', m.r90], ['200d', m.r200], ['1y', m.r1y], ['From ATH', m.athPct]];
    h += '<section class="gw-card"><h2>📈 Returns</h2><div class="fx-rets">' + rt.map(function (x) { return '<div class="fx-ret ' + cls(x[1]) + '"><span>' + x[0] + '</span><b class="num ' + cls(x[1]) + '">' + p100(x[1], Math.abs(x[1]) >= 100 ? 0 : 1) + '</b></div>'; }).join('') + '</div></section>';
    // chart
    h += '<section class="gw-card"><div class="fx-hrow"><h2>Price chart</h2><div class="fx-seg sm" id="rng">' + RANGES.map(function (r) { return '<button type="button" data-r="' + r[0] + '" aria-selected="' + (S.range === r[0]) + '">' + r[0] + '</button>'; }).join('') + '</div></div><div id="pc"></div><p class="fx-note" id="pcn"></p></section>';
    // score + takeaways
    var sc = m.score;
    h += '<div class="fx-score"><section class="gw-card fx-sc"><h2>🤖 AI Coin Score <span class="sub">out of 10</span></h2><div class="fx-sc-top"><div class="fx-ring">' + GK.ring(sc.overall) + '<b>' + sc.overall.toFixed(1) + '</b></div><div><div class="fx-sc-lbl">' + sc.label + '</div><p>' + esc(v.t) + '</p></div></div><div class="fx-bars">' +
      sc.parts.map(function (p) { return '<div class="fx-bar"><div class="h"><span>' + p.k + '</span><span>' + p.s.toFixed(1) + '</span></div><div class="tr"><i style="width:' + p.s * 10 + '%"></i></div><p>' + esc(p.d) + '</p></div>'; }).join('') + '</div></section>' +
      '<section class="gw-card fx-take"><h3>👍 Strengths</h3>' + (m.pros.length ? '<ul>' + m.pros.map(function (x) { return '<li>' + esc(x) + '</li>'; }).join('') + '</ul>' : '<p class="muted">No standout strengths right now.</p>') + '<h3>⚠️ Risks</h3><ul class="w">' + m.cons.map(function (x) { return '<li>' + esc(x) + '</li>'; }).join('') + '</ul></section></div>';
    // technicals + risk
    var trend = ok(m.sma50) && ok(m.sma200) ? (m.sma50 > m.sma200 ? 'Golden cross (50-day above 200-day): bullish' : 'Death cross (50-day below 200-day): bearish') : '–';
    h += '<div class="kx-2"><section class="gw-card"><h2>🛠️ Technical indicators <span class="sub">Daily</span></h2><div class="fx-stats">' +
      stat('RSI (14)', ok(m.rsi) ? m.rsi.toFixed(1) : '–', ok(m.rsi) ? (m.rsi > 70 ? 'Overbought' : m.rsi < 30 ? 'Oversold' : m.rsi >= 50 ? 'Bullish zone' : 'Bearish zone') : '') +
      stat('MACD', m.macd ? (m.macd.h >= 0 ? 'Bullish' : 'Bearish') : '–', m.macd ? 'Histogram ' + (m.macd.h >= 0 ? 'above' : 'below') + ' zero' : '') +
      stat('20-day average', money(m.sma20), ok(m.sma20) ? 'Price ' + (m.price >= m.sma20 ? 'above' : 'below') : '') +
      stat('50-day average', money(m.sma50), ok(m.sma50) ? 'Price ' + (m.price >= m.sma50 ? 'above' : 'below') : '') +
      stat('200-day average', money(m.sma200), ok(m.sma200) ? 'Price ' + (m.price >= m.sma200 ? 'above' : 'below') : '') +
      stat('Trend signal', trend.split(':')[0], trend.split(':')[1] || '') +
      stat('30-day support / resistance', money(m.lo30) + ' / ' + money(m.hi30), '') +
      '</div></section>' +
      '<section class="gw-card"><h2>🛡️ Risk & tokenomics</h2><div class="fx-stats">' +
      stat('Volatility (annual)', ok(m.vol) ? pct(m.vol, 0, true) : '–', ok(m.vol) ? (m.vol > 0.9 ? 'Extreme' : m.vol > 0.6 ? 'High' : m.vol > 0.35 ? 'Moderate' : 'Low for crypto') : '') +
      stat('Worst fall in 1 year', pct(m.dd, 0), '') +
      stat('Up days (last 90)', ok(m.upShare) ? pct(m.upShare, 0, true) : '–', '') +
      (ok(m.corr) ? stat('Moves with Bitcoin', m.corr.toFixed(2), m.corr > 0.7 ? 'Strongly linked' : m.corr > 0.4 ? 'Partly linked' : 'Mostly independent') : '') +
      (ok(m.beta) ? stat('Beta vs Bitcoin', m.beta.toFixed(2), m.beta > 1.2 ? 'Swings more than BTC' : m.beta < 0.8 ? 'Swings less than BTC' : 'Similar to BTC') : '') +
      stat('Supply in circulation', ok(m.circPct) ? pct(m.circPct, 0, true) : '–', m.max ? 'of the fixed cap' : 'of total supply') +
      stat('Market value / fully diluted', ok(m.mcapFdv) ? pct(m.mcapFdv, 0, true) : '–', ok(m.mcapFdv) && m.mcapFdv < 0.7 ? 'Unlocks ahead' : '') +
      stat('Daily trading / market value', ok(m.liq) ? pct(m.liq, 1, true) : '–', '') +
      '</div></section></div>';
    // scenarios
    if (ok(m.vol) && ok(m.price)) {
      var sg = Math.min(m.vol, 1.6), bull = m.price * Math.exp(sg * 0.85), bear = m.price * Math.exp(-sg * 0.85);
      h += '<section class="gw-card"><h2>🔮 12-month scenarios <span class="sub">From past volatility, not a forecast</span></h2><div class="kx-scn">' +
        '<div class="dn"><span>Bear case</span><b class="num">' + money(bear) + '</b><small>' + pct(bear / m.price - 1, 0) + '</small></div>' +
        '<div><span>Base case</span><b class="num">' + money(m.price) + '</b><small>Range-bound</small></div>' +
        '<div class="up"><span>Bull case</span><b class="num">' + money(bull) + '</b><small>' + pct(bull / m.price - 1, 0) + '</small></div></div>' +
        '<p class="fx-note">Roughly 6 in 10 one-year outcomes have fallen inside this band for an asset this volatile. A move outside it is entirely possible.</p></section>';
    }
    // verdict
    h += '<section class="gw-card fx-verdict ' + v.c + '"><h2>🧾 Verdict</h2><div class="fx-v">' + sc.label + ' <span class="num">' + sc.overall.toFixed(1) + ' / 10</span></div><p style="margin-top:6px">' + esc(v.t) + ' ' +
      (ok(m.vol) && m.vol > 0.7 ? 'If you invest, keep it a small share of your savings and consider buying in instalments rather than all at once.' : 'Even large coins can fall 50% or more, so size your position for that.') + '</p></section>';
    // about
    var ab = m.desc.replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim(), sents = ab.match(/[^.!?]+[.!?]+/g) || [ab];
    h += '<section class="gw-card"><h2>ℹ️ About ' + esc(m.name) + '</h2><p class="fx-about">' + esc(sents.slice(0, 3).join(' ').slice(0, 700)) + '</p><div class="fx-kv2" style="margin-top:8px">' +
      (m.algo ? '<div><span>Algorithm</span><b>' + esc(m.algo) + '</b></div>' : '') + (m.genesis ? '<div><span>Launched</span><b>' + esc(m.genesis) + '</b></div>' : '') +
      (m.watch ? '<div><span>Watchlists</span><b>' + units(m.watch) + ' users</b></div>' : '') + (m.home ? '<div><span>Website</span><b><a href="' + esc(m.home) + '" target="_blank" rel="noopener">' + esc(m.home.replace(/^https?:\/\/(www\.)?/, '').replace(/\/$/, '')) + '</a></b></div>' : '') +
      '</div></section>';
    var w = [m.name.toLowerCase(), m.sym.toLowerCase()].filter(function (x) { return x.length > 1; }).join('|');
    h += newsCard(m.name + ' news', m.name + ' ' + m.sym + ' crypto', w, 'cnews');
    $('view').innerHTML = h;
    drawRange(m);
  }
  function kv(l, v) { return '<div><span>' + esc(l) + '</span><b class="num">' + v + '</b></div>'; }
  function stat(l, v, s) { return '<div class="fx-stat"><span>' + esc(l) + '</span><b class="num">' + v + (s ? '<small>' + esc(s) + '</small>' : '') + '</b></div>'; }
  function drawRange(m) {
    var el = $('pc'); if (!el) return;
    var days = RANGES.filter(function (r) { return r[0] === S.range; })[0][1], tk = S.token;
    var put = function (p) {
      if (tk !== S.token || !$('pc')) return;
      if (!p.length) { el.innerHTML = '<p class="muted">Chart not available right now.</p>'; return; }
      var t = p.map(function (x) { return x[0]; }), v = p.map(function (x) { return x[1]; }), ch = v[v.length - 1] / v[0] - 1;
      var col = ch >= 0 ? '#0f8a3c' : '#d02a2a';
      GK.lineChart(el, [{ name: m.sym, color: col, t: t, v: v, fill: true }], { fmtY: function (x) { return money(x).replace(/\.\d+$/, function (s) { return Math.abs(x) >= 100 ? '' : s; }); }, tip: function (x) { return money(x); }, label: m.name + ' price' });
      $('pcn').innerHTML = S.range + ' change <b class="' + cls(ch) + '">' + pct(ch) + '</b> · High ' + money(Math.max.apply(null, v)) + ' · Low ' + money(Math.min.apply(null, v));
    };
    if (days === 365) return put(m.series);
    el.innerHTML = '<div class="fx-load" style="padding:30px"><span class="gw-spin dark"></span></div>';
    chart(m.id, m.sym, days).then(function (h) { put(h.prices || []); }).catch(function () { put([]); });
  }

  // ------------------------------------------------------------------ Compare
  function renderCompare() {
    var tk = ++S.token; drawTray();
    if (!S.cmp.length) {
      $('view').innerHTML = '<section class="gw-card fx-empty"><h2>⚖️ Compare coins</h2><p>Search above or tap a popular coin to add it. Compare up to 4 coins on returns, risk, supply and the AI score.</p></section>';
      return;
    }
    $('view').innerHTML = loading('Comparing ' + S.cmp.length + ' coin' + (S.cmp.length > 1 ? 's' : '') + '…');
    var b = chart('bitcoin', 'btc', 365).catch(function () { return null; });
    Promise.all([fng(), b].concat(S.cmp.map(function (id) { return Promise.all([coinDetail(id), chart(id, '', 365).catch(function () { return { prices: [] }; })]).catch(function () { return null; }); }))).then(function (r) {
      if (tk !== S.token) return;
      var f = r[0], bb = r[1], ms = r.slice(2).map(function (x) { return x && metrics(x[0], x[1], bb, f && f[0]); }).filter(Boolean);
      if (!ms.length) { $('view').innerHTML = errCard('Could not load these coins right now. Please try again in a minute.', true); return; }
      drawCompare(ms);
    });
  }
  function drawCompare(ms) {
    var h = '', col = function (m) { return COLORS[S.cmp.indexOf(m.id) % 4] || COLORS[0]; };
    var rank = ms.slice().sort(function (a, b) { return b.score.overall - a.score.overall; });
    var best = function (k, dir) { var a = ms.filter(function (m) { return ok(m[k]); }); if (a.length < 2) return null; return a.sort(function (x, y) { return dir * (y[k] - x[k]); })[0].id; };
    var rows = [
      ['Overview'], ['Price', function (m) { return money(m.price); }], ['Rank', function (m) { return m.rank ? '#' + m.rank : '–'; }, 'rank', -1], ['Market value', function (m) { return big(m.mcap); }, 'mcap', 1], ['Volume 24h', function (m) { return big(m.vol24); }, 'vol24', 1],
      ['Returns'], ['24h', function (m) { return p100(m.r24); }, 'r24', 1, 1], ['7 days', function (m) { return p100(m.r7); }, 'r7', 1, 1], ['30 days', function (m) { return p100(m.r30); }, 'r30', 1, 1], ['90 days', function (m) { return p100(m.r90); }, 'r90', 1, 1], ['1 year', function (m) { return p100(m.r1y); }, 'r1y', 1, 1], ['From all-time high', function (m) { return p100(m.athPct, 0); }, 'athPct', 1, 1],
      ['Risk'], ['Volatility (annual)', function (m) { return pct(m.vol, 0, true); }, 'vol', -1], ['Worst fall in 1Y', function (m) { return pct(m.dd, 0); }, 'dd', 1], ['Moves with Bitcoin', function (m) { return ok(m.corr) ? m.corr.toFixed(2) : m.id === 'bitcoin' ? '1.00' : '–'; }], ['RSI (14)', function (m) { return ok(m.rsi) ? m.rsi.toFixed(0) : '–'; }],
      ['Supply'], ['Max supply', function (m) { return m.max ? units(m.max) : m.maxInf ? 'Unlimited' : '–'; }], ['In circulation', function (m) { return ok(m.circPct) ? pct(m.circPct, 0, true) : '–'; }, 'circPct', 1], ['Market value / FDV', function (m) { return ok(m.mcapFdv) ? pct(m.mcapFdv, 0, true) : '–'; }, 'mcapFdv', 1],
      ['Score'], ['AI Coin Score', function (m) { return m.score.overall.toFixed(1) + ' · ' + m.score.label; }, '_s', 1]
    ];
    ms.forEach(function (m) { m._s = m.score.overall; });
    h += '<section class="gw-card fx-exec"><h2>🏁 Ranking</h2><ol class="fx-sum">' + rank.map(function (m, i) { return '<li><b>' + esc(m.name) + '</b> · ' + m.score.overall.toFixed(1) + '/10 (' + m.score.label + ')' + (i === 0 ? ' · best overall' : '') + '</li>'; }).join('') + '</ol>' + cmpSummary(ms) + '</section>';
    h += '<section class="gw-card"><h2>Growth of 100 <span class="sub">Last 1 year</span></h2><div id="cg"></div><div class="fx-legend">' + ms.map(function (m) { return '<span><i style="background:' + col(m) + '"></i>' + esc(m.name) + '</span>'; }).join('') + '</div></section>';
    h += '<section class="gw-card"><h2>Side by side</h2><div class="gw-tbl-wrap"><table class="gw-tbl fx-cmp-tbl"><thead><tr><th></th>' + ms.map(function (m) { return '<th><span class="d" style="background:' + col(m) + '"></span>' + esc(m.name) + '</th>'; }).join('') + '</tr></thead><tbody>' +
      rows.map(function (r) {
        if (r.length === 1) return '<tr class="sec"><td colspan="' + (ms.length + 1) + '">' + r[0] + '</td></tr>';
        var b = r[2] ? best(r[2], r[3]) : null;
        return '<tr><td>' + r[0] + '</td>' + ms.map(function (m) { return '<td class="num' + (b === m.id ? ' best' : '') + (r[4] ? ' ' + cls(m[r[2]]) : '') + '">' + r[1](m) + '</td>'; }).join('') + '</tr>';
      }).join('') + '</tbody></table></div><p class="fx-note">Green marks the best value in each row.</p></section>';
    var q = ms.map(function (m) { return m.name; }).join(' ') + ' crypto', w = ms.map(function (m) { return m.name.toLowerCase() + '|' + m.sym.toLowerCase(); }).join('|');
    h += newsCard('News on these coins', q, w, 'mnews');
    $('view').innerHTML = h;
    var series = ms.filter(function (m) { return m.series.length > 10; }).map(function (m) {
      var t0 = Date.now() - 365 * DAY, s = m.series.filter(function (p) { return p[0] >= t0; }); var b0 = s[0] && s[0][1];
      return { name: m.name, color: col(m), t: s.map(function (p) { return p[0]; }), v: s.map(function (p) { return p[1] / b0 * 100; }) };
    });
    if (series.length) GK.lineChart($('cg'), series, { fmtY: function (x) { return Math.round(x) + ''; }, tip: function (v) { return v.toFixed(1); } });
    else $('cg').innerHTML = '<p class="muted">Chart not available right now.</p>';
  }
  function cmpSummary(ms) {
    if (ms.length < 2) return '<p class="fx-note">Add another coin to compare.</p>';
    var by = function (k, d) { return ms.filter(function (m) { return ok(m[k]); }).sort(function (a, b) { return d * (b[k] - a[k]); })[0]; };
    var a = by('r1y', 1), c = by('vol', -1), w = by('vol', 1), dd = by('dd', 1), out = [];
    if (a) out.push('<b>Best 1-year return:</b> ' + esc(a.name) + ' (' + p100(a.r1y, 0) + ').');
    if (c && w && c !== w) out.push('<b>Steadiest:</b> ' + esc(c.name) + ' (' + pct(c.vol, 0, true) + ' volatility) vs the wildest, ' + esc(w.name) + ' (' + pct(w.vol, 0, true) + ').');
    if (dd) out.push('<b>Smallest fall in the past year:</b> ' + esc(dd.name) + ' (' + pct(dd.dd, 0) + ').');
    return '<ul class="fx-sum" style="margin-top:8px">' + out.map(function (x) { return '<li>' + x + '</li>'; }).join('') + '</ul>';
  }
  function toggleCmp(id) {
    var i = S.cmp.indexOf(id);
    if (i >= 0) S.cmp.splice(i, 1);
    else { if (S.cmp.length >= 4) { GW.toast('You can compare up to 4 coins'); return false; } S.cmp.push(id); }
    GK.saveLS(LS_CMP, S.cmp); drawTray(); return true;
  }
  function drawTray() {
    var t = $('tray'), c = $('cmpCnt');
    c.hidden = !S.cmp.length; c.textContent = S.cmp.length;
    if (S.tab !== 'coin' || S.mode !== 'compare' || !S.cmp.length) { t.hidden = true; return; }
    t.hidden = false;
    t.innerHTML = S.cmp.map(function (id, i) { return '<span class="fx-tchip" style="--c:' + COLORS[i] + '"><span class="d"></span><span class="t">' + esc(nameOf(id)) + '</span><button type="button" data-rm="' + esc(id) + '" aria-label="Remove">×</button></span>'; }).join('');
  }
  var names = GK.loadLS('gw_cx_names', {});
  function nameOf(id) { return names[id] || id.replace(/-/g, ' ').replace(/\b\w/g, function (c) { return c.toUpperCase(); }); }
  function remember(id, n) { if (n && names[id] !== n) { names[id] = n; GK.saveLS('gw_cx_names', names); } }

  // ------------------------------------------------------------------ search
  var ddItems = [], ddOn = -1, qT, qSeq = 0;
  function closeDD() { $('dd').hidden = true; $('q').setAttribute('aria-expanded', 'false'); ddOn = -1; }
  function search(q) {
    var my = ++qSeq; q = q.trim();
    if (!q) { closeDD(); return; }
    var loc = (S.rows || (S.mkt && S.mkt.coins) || []).filter(function (c) { return c.name.toLowerCase().indexOf(q.toLowerCase()) === 0 || c.symbol.toLowerCase() === q.toLowerCase(); })
      .slice(0, 5).map(function (c) { return { id: c.id, name: c.name, symbol: c.symbol, market_cap_rank: c.market_cap_rank, thumb: c.image }; });
    if (loc.length) showDD(loc);
    if (q.length < 2) return;
    $('qSpin').hidden = false;
    cg('/search?query=' + encodeURIComponent(q), 3600).then(function (j) {
      if (my !== qSeq) return; $('qSpin').hidden = true;
      var seen = {}, all = loc.concat(j.coins || []).filter(function (c) { if (seen[c.id]) return false; seen[c.id] = 1; return true; }).slice(0, 10);
      showDD(all);
    }).catch(function () { if (my === qSeq) { $('qSpin').hidden = true; if (!loc.length) showDD([]); } });
  }
  function showDD(a) {
    ddItems = a; ddOn = a.length ? 0 : -1;
    $('dd').innerHTML = a.length ? a.map(function (c, i) { return '<li role="option" data-i="' + i + '"' + (i === 0 ? ' class="on"' : '') + '>' + img(c.thumb || c.large, 'kx-ci') + '<span class="sym">' + esc((c.symbol || '').toUpperCase()) + '</span><span class="nm">' + esc(c.name) + '</span>' + (c.market_cap_rank ? '<span class="gw-chip">#' + c.market_cap_rank + '</span>' : '') + '</li>'; }).join('') : '<li class="empty">No coin found. Try the full name or symbol.</li>';
    $('dd').hidden = false; $('q').setAttribute('aria-expanded', 'true');
  }
  function choose(c) {
    if (!c) return;
    remember(c.id, c.name); $('q').value = ''; closeDD();
    if (S.mode === 'compare') { if (S.cmp.indexOf(c.id) < 0 && toggleCmp(c.id)) renderCompare(); }
    else analyze(c.id);
  }
  function renderPicks() {
    $('picks').innerHTML = '<span class="lbl">Popular</span>' + POP.map(function (p, i) { return '<button type="button" class="fx-pick c' + (i % 6 + 1) + '" data-pick="' + p[0] + '">' + esc(p[1]) + '</button>'; }).join('');
    POP.forEach(function (p) { remember(p[0], p[1]); });
  }

  // ------------------------------------------------------------------ tabs & events
  function syncTabs() {
    document.querySelectorAll('#tabs button').forEach(function (b) { b.setAttribute('aria-selected', String(b.dataset.tab === S.tab)); });
    document.querySelectorAll('#modeTabs button').forEach(function (b) { b.setAttribute('aria-selected', String(b.dataset.mode === S.mode)); });
    document.querySelectorAll('#curTabs button').forEach(function (b) { b.setAttribute('aria-selected', String(b.dataset.cur === S.cur)); });
    $('modeTabs').hidden = S.tab !== 'coin'; $('searchBox').hidden = S.tab !== 'coin'; $('rptNote').hidden = S.tab !== 'report';
    $('q').placeholder = S.mode === 'compare' ? 'Add a coin to compare, e.g. Ethereum' : 'Search a coin, e.g. Bitcoin, SOL, Dogecoin';
    drawTray();
  }
  function show() {
    syncTabs();
    if (S.tab === 'report') { try { history.replaceState(null, '', '#report'); } catch (e) {} renderReport(); }
    else if (S.mode === 'compare') { try { history.replaceState(null, '', '#compare'); } catch (e) {} renderCompare(); }
    else if (S.coin) analyze(S.coin);
    else { S.token++; $('view').innerHTML = '<section class="gw-card fx-empty"><h2>🔎 Analyze any coin</h2><p>Search over 15,000 coins by name or symbol, or tap a popular one above. You get price, returns, technicals, risk, supply, an AI score, scenarios and news.</p></section>'; }
  }
  $('tabs').addEventListener('click', function (e) { var b = e.target.closest('button'); if (!b || b.dataset.tab === S.tab) return; S.tab = b.dataset.tab; show(); });
  $('modeTabs').addEventListener('click', function (e) { var b = e.target.closest('button'); if (!b || b.dataset.mode === S.mode) return; S.mode = b.dataset.mode; show(); });
  $('curTabs').addEventListener('click', function (e) { var b = e.target.closest('button'); if (!b || b.dataset.cur === S.cur) return; S.cur = b.dataset.cur; GK.saveLS(LS_CUR, S.cur); S.mkt = null; S.rows = null; show(); });
  $('q').addEventListener('input', function () { clearTimeout(qT); var v = this.value; qT = setTimeout(function () { search(v); }, 250); });
  $('q').addEventListener('keydown', function (e) {
    if ($('dd').hidden) return;
    var li = $('dd').querySelectorAll('li[data-i]');
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') { e.preventDefault(); if (!li.length) return; ddOn = (ddOn + (e.key === 'ArrowDown' ? 1 : -1) + li.length) % li.length; li.forEach(function (x, i) { x.classList.toggle('on', i === ddOn); }); }
    else if (e.key === 'Enter') { e.preventDefault(); choose(ddItems[ddOn]); }
    else if (e.key === 'Escape') closeDD();
  });
  document.addEventListener('click', function (e) {
    var t = e.target;
    if (!t.closest('.fx-search')) closeDD();
    var li = t.closest('#dd li[data-i]'); if (li) return choose(ddItems[+li.dataset.i]);
    var pk = t.closest('[data-pick]'); if (pk) { if (S.mode === 'compare' && S.tab === 'coin') { if (S.cmp.indexOf(pk.dataset.pick) < 0 && toggleCmp(pk.dataset.pick)) renderCompare(); } else analyze(pk.dataset.pick); return; }
    var co = t.closest('[data-coin]'); if (co) { var nm = co.querySelector('b'); if (nm) remember(co.dataset.coin, nm.textContent); window.scrollTo({ top: 0, behavior: 'smooth' }); return analyze(co.dataset.coin); }
    var rm = t.closest('[data-rm]'); if (rm) { toggleCmp(rm.dataset.rm); return renderCompare(); }
    var ad = t.closest('[data-addcmp]'); if (ad) { var id = ad.dataset.addcmp; if (S.cur_m) remember(id, S.cur_m.name); if (toggleCmp(id)) ad.textContent = S.cmp.indexOf(id) >= 0 ? '✓ In compare' : '+ Compare'; return; }
    var rg = t.closest('#rng button'); if (rg) { S.range = rg.dataset.r; document.querySelectorAll('#rng button').forEach(function (b) { b.setAttribute('aria-selected', String(b === rg)); }); if (S.cur_m) drawRange(S.cur_m); return; }
    var so = t.closest('th[data-sort]'); if (so) { var k = so.dataset.sort; S.sort = S.sort && S.sort[0] === k ? (S.sort[1] > 0 ? [k, -1] : null) : [k, 1]; return drawTable(); }
    if (t.closest('#more')) { S.showAll = !S.showAll; t.closest('#more').textContent = S.showAll ? 'Show top 25' : 'Show all 100'; return drawTable(); }
    if (t.closest('[data-refresh]')) { mem = {}; Object.keys(localStorage).forEach(function (k) { if (k.indexOf('gw_cg_/coins/markets') === 0 || k.indexOf('gw_cg_/global') === 0) localStorage.removeItem(k); }); return renderReport(); }
    if (t.closest('[data-retry]')) return show();
  });
  document.addEventListener('keydown', function (e) { if (e.key === 'Enter' && e.target.matches && e.target.matches('tr[data-coin]')) e.target.click(); });
  document.addEventListener('input', function (e) { if (e.target.id === 'tf') drawTable(); });
  // keep the report live
  setInterval(function () { if (S.tab === 'report' && !document.hidden && !($('tf') && $('tf').value)) renderReport(); }, 65000);

  renderPicks();
  window.addEventListener('hashchange', function () { var h = decodeURIComponent(location.hash.slice(1)); if (/^coin=/.test(h) && h.slice(5) !== S.coin) { S.tab = 'coin'; S.mode = 'analyze'; S.coin = h.slice(5); show(); } else if (h === 'compare' && S.mode !== 'compare') { S.tab = 'coin'; S.mode = 'compare'; show(); } else if (h === 'report' && S.tab !== 'report') { S.tab = 'report'; show(); } });
  var hs = decodeURIComponent(location.hash.slice(1));
  if (/^coin=/.test(hs)) { S.tab = 'coin'; S.coin = hs.slice(5); }
  else if (hs === 'compare') { S.tab = 'coin'; S.mode = 'compare'; }
  else if (hs === 'analyze' || hs === 'coin') S.tab = 'coin';
  show();
})();
