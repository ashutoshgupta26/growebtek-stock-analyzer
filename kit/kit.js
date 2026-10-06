/* Growebtek — shared helpers for the Crypto, Insurance, Investment and Loan pages: formatting, SVG charts, news. */
(function () {
  'use strict';
  var esc = function (s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); };
  var DAY = 86400000, YR = 365.25 * DAY;
  function ok(x) { return x != null && isFinite(x); }
  function pct(x, d, nosign) { if (!ok(x)) return '–'; var s = (x * 100).toFixed(d == null ? 1 : d); return (!nosign && x > 0 ? '+' : '') + s + '%'; }
  function cls(x) { return !ok(x) ? '' : x > 0 ? 'up' : x < 0 ? 'dn' : ''; }
  function dfmt(ms) { return ok(ms) ? new Date(ms).toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' }) : '–'; }
  function ago(ms) { if (!ok(ms) || !ms) return ''; var m = Math.round((Date.now() - ms) / 60000); if (m < 60) return Math.max(1, m) + ' min ago'; var h = Math.round(m / 60); if (h < 36) return h + ' hr ago'; return dfmt(ms); }
  function atOrBefore(t, x) { var lo = 0, hi = t.length - 1, r = -1; while (lo <= hi) { var m = (lo + hi) >> 1; if (t[m] <= x) { r = m; lo = m + 1; } else hi = m - 1; } return r; }
  function loadLS(k, d) { try { var v = JSON.parse(localStorage.getItem(k) || 'null'); return v == null ? d : v; } catch (e) { return d; } }
  function saveLS(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) {} }
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
    if (t1 - t0 < 50 * DAY) { var sp = t1 - t0, hs = [1, 2, 3, 6, 12, 24, 48, 96, 168].map(function (h) { return h * 3600000; }).filter(function (s) { return sp / s <= maxN; })[0] || 7 * DAY, tz = 330 * 60000; for (var q = Math.ceil((t0 + tz) / hs) * hs - tz; q <= t1; q += hs) out.push([q, hs < DAY ? new Date(q).toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" }) : new Date(q).toLocaleDateString("en-GB", { day: "numeric", month: "short" })]); return out; }
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
        tip.innerHTML = '<div class="d">' + dfmtT(tt, t1 - t0) + '</div>' + rows; tip.hidden = false;
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

  function dfmtT(ms, span) { return span < 3 * DAY ? new Date(ms).toLocaleString('en-GB', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' }) : dfmt(ms); }
  function newsList(n, max) {
    if (!n || !n.length) return '<p class="muted">No fresh headlines right now. Try again in a little while.</p>';
    return '<ul class="fx-news">' + n.slice(0, max || 10).map(function (x) { return '<li><a href="' + esc(x.url) + '" target="_blank" rel="noopener">' + esc(x.title) + '</a><div><small class="muted">' + esc(x.src) + (x.ts ? ' · ' + ago(x.ts) : '') + '</small></div></li>'; }).join('') + '</ul>';
  }
  var newsMem = {};
  // Latest headlines on a topic from the backend (Google News, India edition). must = "word|word" filter.
  function news(q, must) {
    var k = q + '|' + (must || '');
    if (newsMem[k]) return newsMem[k];
    var c = loadLS('gw_tn_' + k, null);
    if (c && Date.now() - c.at < 20 * 60000) return (newsMem[k] = Promise.resolve(c.n));
    var url = (window.GW_CONFIG || {}).API_URL;
    if (!url) return Promise.resolve([]);
    newsMem[k] = fetch(url + (url.indexOf('?') < 0 ? '?' : '&') + 'topic=' + encodeURIComponent(q) + '&must=' + encodeURIComponent(must || ''))
      .then(function (r) { return r.json(); })
      .then(function (j) { var n = (j && j.news) || []; if (n.length) saveLS('gw_tn_' + k, { at: Date.now(), n: n }); return n; })
      .catch(function () { delete newsMem[k]; return c ? c.n : []; });
    return newsMem[k];
  }
  window.GK = { esc: esc, ok: ok, pct: pct, cls: cls, dfmt: dfmt, ago: ago, loadLS: loadLS, saveLS: saveLS, DAY: DAY, YR: YR,
    lineChart: lineChart, barChart: barChart, ring: ring, news: news, newsList: newsList };
})();
