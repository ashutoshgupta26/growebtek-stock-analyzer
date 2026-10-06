/* Growebtek — product analyzer engine (insurance, investments, loans & cards).
   Each page sets window.PX = { sub, cats:[{id,label,icon}], calc:{<cat>:{type:'dep'|'emi', rate:'<param>'}} }.
   Data: products/data/<cat>.json (see products/SCHEMA.md). Flow: report → analyze → compare, with news. */
(function () {
  'use strict';
  if (!window.GW || !window.GK || !window.PX) return;
  var PX = window.PX;
  var sess = GW.guard({ sub: PX.sub });
  if (!sess) return;
  var esc = GK.esc, ok = GK.ok;
  var COLORS = ['#5b5bf6', '#ec4899', '#f97316', '#14b8a6'];
  var LS = 'gw_px_' + PX.key + '_';
  var S = { cat: PX.cats[0].id, tab: 'report', id: null, kind: '', sort: null, cmp: {} };
  PX.cats.forEach(function (c) { S.cmp[c.id] = GK.loadLS(LS + 'cmp_' + c.id, []).slice(0, 4); });
  function $(id) { return document.getElementById(id); }

  // ------------------------------------------------------------------ data
  var mem = {};
  function load(cat) {
    if (mem[cat]) return mem[cat];
    return (mem[cat] = fetch('../products/data/' + cat + '.json?v=' + (PX.v || 1)).then(function (r) { if (!r.ok) throw new Error('HTTP ' + r.status); return r.json(); })
      .then(prep).catch(function (e) { delete mem[cat]; throw e; }));
  }
  function scored(p) { return p.better === 'high' || p.better === 'low'; }
  function num(p, v) { if (v == null) return null; if (p.fmt === 'yes') return v === true ? 1 : v === false ? 0 : null; return typeof v === 'number' && isFinite(v) ? v : null; }
  function prep(D) {
    var items = D.items, byId = {};
    items.forEach(function (it) { byId[it.id] = it; it.v = it.v || {}; });
    // a param is shown if any item has it; scored if it has a direction and enough coverage
    D.params.forEach(function (p) {
      var have = items.filter(function (it) { return it.v[p.k] != null && it.v[p.k] !== ''; }).length;
      p.show = have > 0; p.cov = have / items.length;
      p.use = scored(p) && p.fmt !== 'text' && p.cov >= 0.4 && (p.w || 0) > 0;
    });
    var groupOf = function (it) { return D.peer ? it[D.peer] || '' : ''; };
    // percentile of each value among its peers (same kind for loans/bonds), 0 = worst, 1 = best
    items.forEach(function (it) { it.pr = {}; it.rk = {}; });
    D.params.forEach(function (p) {
      if (!scored(p) || p.fmt === 'text') return;
      var pools = {};
      items.forEach(function (it) { var g = groupOf(it); (pools[g] = pools[g] || []).push(it); });
      Object.keys(pools).forEach(function (g) {
        var pool = pools[g].filter(function (it) { return num(p, it.v[p.k]) != null && (it.noScore || []).indexOf(p.k) < 0; });
        if (pool.length < 3) pool = items.filter(function (it) { return num(p, it.v[p.k]) != null && (it.noScore || []).indexOf(p.k) < 0; });
        var vals = pool.map(function (it) { return num(p, it.v[p.k]); }), n = vals.length;
        var sorted = vals.slice().sort(function (a, b) { return a - b; });
        var med = n ? (n % 2 ? sorted[(n - 1) / 2] : (sorted[n / 2 - 1] + sorted[n / 2]) / 2) : null;
        pools[g].forEach(function (it) {
          var x = num(p, it.v[p.k]); if (x == null || (it.noScore || []).indexOf(p.k) >= 0) return;
          var lo = vals.filter(function (y) { return y < x; }).length, eq = vals.filter(function (y) { return y === x; }).length, hi = n - lo - eq;
          var f = n > 1 ? (lo + (eq - 1) / 2) / (n - 1) : 0.5;
          it.pr[p.k] = p.better === 'low' ? 1 - f : f;
          it.rk[p.k] = { r: (p.better === 'low' ? lo : hi) + 1, n: n, med: med, peer: pool === pools[g] ? g : '' };
        });
      });
    });
    var groups = (D.groups || []).slice();
    items.forEach(function (it) {
      var sc = function (ps) {
        var W = 0, Wh = 0, s = 0;
        ps.forEach(function (p) { W += p.w; if (it.pr[p.k] != null) { Wh += p.w; s += p.w * it.pr[p.k]; } });
        if (!Wh) return null;
        var avg = s / Wh, c = Wh / W, k = Math.min(1, c / 0.6);
        return Math.round((1 + 9 * (0.5 + (avg - 0.5) * k)) * 10) / 10;
      };
      var use = D.params.filter(function (p) { return p.use; });
      it.score = sc(use);
      it.cov = use.length ? use.reduce(function (a, p) { return a + (it.pr[p.k] != null ? p.w : 0); }, 0) / use.reduce(function (a, p) { return a + p.w; }, 0) : 0;
      it.gs = groups.map(function (g) { var ps = use.filter(function (p) { return p.g === g.id; }); return ps.length ? { id: g.id, label: g.label, s: sc(ps), ps: ps } : null; }).filter(function (x) { return x && x.s != null; });
    });
    D.byId = byId;
    D.kinds = []; items.forEach(function (it) { if (it.kind && D.kinds.indexOf(it.kind) < 0) D.kinds.push(it.kind); });
    return D;
  }
  function label(s) { return s == null ? 'Not rated' : s >= 7.5 ? 'Excellent' : s >= 6 ? 'Good' : s >= 4.5 ? 'Average' : 'Below par'; }
  function vcls(s) { return s == null ? '' : s >= 7.5 ? 'green' : s >= 4.5 ? 'amber' : 'red'; }
  function sc1(s) { return s == null ? '–' : s.toFixed(1); }

  // ------------------------------------------------------------------ formatting
  function inr(x) { return '₹' + Math.round(x).toLocaleString('en-IN'); }
  function fv(p, v) {
    if (v == null || v === '') return '–';
    switch (p.fmt) {
      case 'pct': return (Math.abs(v) < 10 && v % 1 ? v.toFixed(2).replace(/0$/, '') : +v.toFixed(2)) + '%';
      case 'num': return Number(v).toLocaleString('en-IN');
      case 'inr': return inr(v);
      case 'x': return Number(v).toFixed(2) + 'x';
      case 'years': return v + (v === 1 ? ' year' : ' years');
      case 'days': return v + (v === 1 ? ' day' : ' days');
      case 'yes': return v === true ? 'Yes' : v === false ? 'No' : '–';
      default: return String(v);
    }
  }
  function sorted(D, list) { return list.slice().sort(function (a, b) { return (b.score == null ? -1 : b.score) - (a.score == null ? -1 : a.score); }); }
  function visible(D) { return D.items.filter(function (it) { return !S.kind || it.kind === S.kind; }); }
  function bestOf(D, list, p) {
    var c = list.filter(function (it) { return num(p, D.byId[it.id].v[p.k]) != null && (it.noScore || []).indexOf(p.k) < 0; });
    if (!c.length) return null;
    return c.reduce(function (a, b) { var x = num(p, a.v[p.k]), y = num(p, b.v[p.k]); return (p.better === 'low' ? y < x : y > x) ? b : a; });
  }
  function catDef() { return PX.cats.filter(function (c) { return c.id === S.cat; })[0]; }
  function hbars(list, max) {
    return list.slice(0, max || 10).map(function (it, i) {
      return '<div class="fx-hbar" data-open="' + esc(it.id) + '" style="cursor:pointer"><span class="n">' + (i + 1) + '. ' + esc(it.name) + '</span><span class="v">' + sc1(it.score) + '</span><div class="tr"><i style="width:' + ((it.score || 0) * 10) + '%;background:' + COLORS[i % 4] + '"></i></div></div>';
    }).join('');
  }
  function newsCard(title, q, must, id) {
    setTimeout(function () { GK.news(q, must).then(function (n) { var el = $(id); if (el) el.innerHTML = GK.newsList(n, 10); }); }, 0);
    return '<section class="gw-card"><h2>📰 ' + esc(title) + ' <span class="sub">Latest first</span></h2><div id="' + id + '"><div class="fx-load" style="padding:16px"><span class="gw-spin dark"></span>Loading headlines…</div></div></section>';
  }
  function words(s) { return String(s || '').toLowerCase().replace(/\(.*?\)/g, ' ').split(/[^a-z0-9&]+/).filter(function (w) { return w.length > 2 && ['the', 'and', 'bank', 'insurance', 'company', 'limited', 'ltd', 'general', 'life', 'india', 'plan', 'card', 'credit', 'loan', 'fund', 'scheme', 'with', 'for'].indexOf(w) < 0; }); }
  function kindChips(D) {
    if (D.kinds.length < 2) return '';
    return '<div class="fx-picks px-kinds"><span class="lbl">Type</span><button type="button" class="fx-pick' + (!S.kind ? ' on' : '') + '" data-kind="">All</button>' +
      D.kinds.map(function (k) { return '<button type="button" class="fx-pick' + (S.kind === k ? ' on' : '') + '" data-kind="' + esc(k) + '">' + esc(k) + '</button>'; }).join('') + '</div>';
  }
  function sources(D) {
    return '<section class="gw-card"><h2>ℹ️ About this data</h2><p class="fx-about">' + esc(D.intro || '') + '</p>' +
      '<p class="fx-note" style="margin-top:8px"><b>Checked:</b> ' + esc(D.asOf || '') + ' · <b>Sources:</b> ' + esc((D.sources || []).join('; ')) + '</p>' +
      '<p class="fx-note">The score ranks each product against its peers on the parameters above (higher weight for what matters most). Blank values are not counted. Always confirm the latest terms with the provider before you decide.</p></section>';
  }

  // ------------------------------------------------------------------ report
  function renderReport(D) {
    var list = sorted(D, visible(D)), top = list[0], h = '', c = catDef();
    var use = D.params.filter(function (p) { return p.use; }).sort(function (a, b) { return b.w - a.w; });
    h += kindChips(D) ? '<section class="gw-card">' + kindChips(D) + '</section>' : '';
    var kp = use.slice(0, 2).map(function (p) { var b = bestOf(D, list, p); return b ? '<div class="kx-kpi"><span>Best ' + esc(p.label) + '</span><b>' + esc(fv(p, b.v[p.k])) + '</b><small>' + esc(b.name) + '</small></div>' : ''; }).join('');
    h += '<div class="kx-kpis"><div class="kx-kpi"><span>' + esc(c.label) + ' options</span><b>' + list.length + '</b><small>' + esc(D.kinds.length > 1 && !S.kind ? D.kinds.length + ' types' : (S.kind || D.title)) + '</small></div>' +
      (top ? '<div class="kx-kpi"><span>Top rated</span><b>' + esc(top.name) + '</b><small>' + sc1(top.score) + ' / 10 · ' + label(top.score) + '</small></div>' : '') + kp + '</div>';
    // summary
    var bl = use.map(function (p) { var b = bestOf(D, list, p); return b ? '<li><b>' + esc(p.label) + ':</b> ' + esc(b.name) + ' (' + esc(fv(p, b.v[p.k])) + ')</li>' : ''; }).join('');
    h += '<section class="gw-card fx-exec"><h2>🏁 ' + esc(S.kind || D.title) + ' report <span class="sub">' + esc(D.asOf || '') + '</span></h2><p class="fx-about" style="margin-bottom:8px">' + esc(D.intro || '') + '</p>' +
      '<h3 style="margin:10px 0 4px;font-size:14px">Best in each area</h3><ul class="fx-sum">' + bl + '</ul></section>';
    h += '<div class="kx-2"><section class="gw-card"><h2>🤖 Top ' + Math.min(10, list.length) + ' by AI score <span class="sub">out of 10</span></h2>' + hbars(list, 10) + '<p class="fx-note">Tap any name for the full analysis.</p></section>';
    h += '<section class="gw-card"><h2>⚖️ What we compare</h2><div class="fx-stats">' + D.params.filter(function (p) { return p.show; }).map(function (p) {
      return '<div class="fx-stat"><span>' + esc(p.label) + '</span><b><small>' + (p.use ? (p.better === 'high' ? 'Higher is better' : 'Lower is better') + ' · weight ' + p.w : 'Shown, not scored') + '</small></b></div>';
    }).join('') + '</div></section></div>';
    // ranking table
    var cols = D.params.filter(function (p) { return p.show; }).slice(0, 7);
    h += '<section class="gw-card"><div class="fx-hrow"><h2>📋 Full ranking</h2><input class="gw-input kx-filter" id="tf" type="search" placeholder="Filter by name" aria-label="Filter"></div>' +
      '<div class="gw-tbl-wrap"><table class="gw-tbl kx-tbl"><thead><tr><th>Name</th><th class="kx-sort" data-sort="_score">Score</th>' + cols.map(function (p) { return '<th class="kx-sort" data-sort="' + esc(p.k) + '" title="' + esc(p.tip || '') + '">' + esc(p.label) + '</th>'; }).join('') + '</tr></thead><tbody id="tb"></tbody></table></div>' +
      '<p class="fx-note">Tap a column to sort, tap a row to analyze. "–" means not published or not found.</p></section>';
    h += newsCard(D.title + ' news', D.newsQuery || D.title, '', 'rnews');
    h += sources(D);
    $('view').innerHTML = h;
    S.rows = list; S.cols = cols; drawTable(D);
  }
  function drawTable(D) {
    var tb = $('tb'); if (!tb) return;
    var f = ($('tf') && $('tf').value || '').toLowerCase(), rows = S.rows.filter(function (it) { return !f || (it.name + ' ' + it.provider).toLowerCase().indexOf(f) >= 0; });
    if (S.sort) {
      var k = S.sort[0], d = S.sort[1], p = D.params.filter(function (x) { return x.k === k; })[0];
      var g = function (it) { return k === '_score' ? it.score : p.fmt === 'text' ? it.v[k] : num(p, it.v[k]); };
      rows = rows.slice().sort(function (a, b) { var x = g(a), y = g(b); if (x == null) return 1; if (y == null) return -1; return (x > y ? 1 : x < y ? -1 : 0) * d; });
    }
    document.querySelectorAll('th[data-sort]').forEach(function (th) { th.classList.toggle('on', !!S.sort && S.sort[0] === th.dataset.sort); });
    tb.innerHTML = rows.map(function (it) {
      return '<tr data-open="' + esc(it.id) + '" tabindex="0"><td><div class="kx-coin"><span style="display:flex;flex-direction:column"><b>' + esc(it.name) + '</b><small>' + esc(it.provider) + '</small></span></div></td><td class="num"><b>' + sc1(it.score) + '</b></td>' +
        S.cols.map(function (p) { var b = it.pr[p.k]; return '<td class="num' + (b != null && b >= 0.8 ? ' up' : b != null && b <= 0.2 ? ' dn' : '') + '">' + esc(fv(p, it.v[p.k])) + '</td>'; }).join('') + '</tr>';
    }).join('') || '<tr><td colspan="9" class="muted">No match.</td></tr>';
  }

  // ------------------------------------------------------------------ analyze
  function verdict(D, it) {
    var s = it.score, g = it.gs.slice().sort(function (a, b) { return b.s - a.s; });
    var t = s == null ? 'Not enough published data to rate this one.' :
      label(s) + ' overall' + (g.length ? ': strongest on ' + g[0].label.toLowerCase() + (g.length > 1 && g[g.length - 1].s < 5 ? ', weaker on ' + g[g.length - 1].label.toLowerCase() : '') : '') + '.';
    if (it.cov < 0.6 && s != null) t += ' Some figures are not published, so treat the score with care.';
    return t;
  }
  function renderAnalyze(D, id) {
    var it = D.byId[id];
    if (!it) { S.id = null; return renderEmpty(D); }
    S.id = id; setHash();
    var h = '', inCmp = S.cmp[S.cat].indexOf(id) >= 0;
    var shown = D.params.filter(function (p) { return p.show; });
    var key = shown.filter(function (p) { return it.v[p.k] != null && it.v[p.k] !== ''; }).slice(0, 8);
    h += '<section class="gw-card fx-head"><div><h1>' + esc(it.name) + '</h1><div class="meta">' + esc(it.provider) + (it.kind ? ' · ' + esc(it.kind) : '') + '</div>' +
      '<div class="chips">' + (it.tags || []).map(function (c) { return '<span class="gw-chip indigo">' + esc(c) + '</span>'; }).join('') + '</div></div>' +
      '<div class="fx-nav"><div class="lab">AI score</div><div class="big num">' + sc1(it.score) + '<small style="font-size:.5em"> / 10</small></div><div style="font-weight:800">' + label(it.score) + '</div>' +
      '<div class="acts"><button class="gw-btn ghost" type="button" data-addcmp="' + esc(id) + '" style="height:38px;font-size:13px">' + (inCmp ? '✓ In compare' : '+ Compare') + '</button>' +
      (it.url ? '<a class="gw-btn ghost" href="' + esc(it.url) + '" target="_blank" rel="noopener" style="height:38px;font-size:13px">Official page ↗</a>' : '') + '</div></div>' +
      '<div class="fx-kv">' + key.map(function (p) { return '<div><span>' + esc(p.label) + '</span><b>' + esc(fv(p, it.v[p.k])) + '</b></div>'; }).join('') + '</div></section>';
    h += '<div class="fx-score"><section class="gw-card fx-sc"><h2>🤖 AI Score <span class="sub">out of 10</span></h2><div class="fx-sc-top"><div class="fx-ring">' + GK.ring(it.score || 0) + '<b>' + sc1(it.score) + '</b></div><div><div class="fx-sc-lbl">' + label(it.score) + '</div><p>' + esc(verdict(D, it)) + '</p></div></div><div class="fx-bars">' +
      it.gs.map(function (g) {
        var d = g.ps.filter(function (p) { return it.rk[p.k]; }).map(function (p) { return p.label + ' #' + it.rk[p.k].r + '/' + it.rk[p.k].n; }).join(' · ');
        return '<div class="fx-bar"><div class="h"><span>' + esc(g.label) + '</span><span>' + g.s.toFixed(1) + '</span></div><div class="tr"><i style="width:' + g.s * 10 + '%"></i></div><p>' + esc(d) + '</p></div>';
      }).join('') + '</div></section>' +
      '<section class="gw-card fx-take"><h3>👍 Strengths</h3>' + ((it.pros || []).length ? '<ul>' + it.pros.map(function (x) { return '<li>' + esc(x) + '</li>'; }).join('') + '</ul>' : '<p class="muted">None listed.</p>') +
      '<h3>⚠️ Watch out</h3><ul class="w">' + (it.cons || []).map(function (x) { return '<li>' + esc(x) + '</li>'; }).join('') + '</ul>' +
      (it.best ? '<h3>🎯 Best for</h3><p style="margin:0;font-size:14px">' + esc(it.best) + '</p>' : '') + '</section></div>';
    // parameters
    var gl = {}; (D.groups || []).forEach(function (g) { gl[g.id] = g.label; });
    var lastG = null;
    h += '<section class="gw-card"><h2>🔬 Parameter by parameter</h2><div class="gw-tbl-wrap"><table class="gw-tbl kx-tbl px-ptbl"><thead><tr><th>Parameter</th><th>Value</th><th>Rank</th><th>Peer median</th></tr></thead><tbody>' +
      shown.slice().sort(function (a, b) { var ga = (D.groups || []).map(function (g) { return g.id; }); return ga.indexOf(a.g) - ga.indexOf(b.g); }).map(function (p) {
        var r = it.rk[p.k], sec = '';
        if (p.g !== lastG) { lastG = p.g; sec = '<tr class="sec"><td colspan="4">' + esc(gl[p.g] || '') + '</td></tr>'; }
        var b = it.pr[p.k];
        return sec + '<tr><td title="' + esc(p.tip || '') + '">' + esc(p.label) + (p.tip ? ' <span class="muted" aria-hidden="true">ⓘ</span>' : '') + '</td><td class="num' + (b != null && b >= 0.8 ? ' up' : b != null && b <= 0.2 ? ' dn' : '') + '" style="white-space:normal">' + esc(fv(p, it.v[p.k])) + '</td>' +
          '<td class="num">' + (r ? '#' + r.r + ' of ' + r.n + (r.peer ? '<br><small class="muted">' + esc(r.peer) + '</small>' : '') : '–') + '</td><td class="num">' + (r && r.med != null && p.fmt !== 'yes' ? esc(fv(p, Math.round(r.med * 100) / 100)) : '–') + '</td></tr>';
      }).join('') + '</tbody></table></div><p class="fx-note">Green = top 20% of peers, red = bottom 20%. Hover or tap ⓘ names for the source.</p></section>';
    h += calcCard(D, it);
    h += '<section class="gw-card fx-verdict ' + vcls(it.score) + '"><h2>🧾 Verdict</h2><div class="fx-v">' + label(it.score) + ' <span class="num">' + sc1(it.score) + ' / 10</span></div><p style="margin-top:6px">' + esc(verdict(D, it)) + (it.best ? ' Best for: ' + esc(it.best) + '.' : '') + '</p></section>';
    var nq = it.news || it.provider, must = words(it.provider).concat(words(it.name)).slice(0, 6).join('|');
    h += newsCard(it.provider + ' news', nq, must, 'inews');
    h += sources(D);
    $('view').innerHTML = h;
    calcRun();
  }
  // calculators: deposit maturity (quarterly compounding) or loan EMI
  function calcCard(D, it) {
    var c = (PX.calc || {})[S.cat]; if (!c) return '';
    var p = D.params.filter(function (x) { return x.k === c.rate; })[0], r = p ? num(p, it.v[c.rate]) : null;
    if (r == null) return '';
    S.calc = c.type;
    var f = function (id, lb, v, st) { return '<label class="gw-field"><span>' + lb + '</span><input class="gw-input" id="' + id + '" type="number" inputmode="decimal" min="0" step="' + st + '" value="' + v + '"></label>'; };
    return '<section class="gw-card"><h2>🧮 ' + (c.type === 'emi' ? 'EMI calculator' : 'Maturity calculator') + '</h2><div class="fx-sip-in">' +
      (c.type === 'emi' ? f('ca', 'Loan amount (₹)', 1000000, 10000) + f('cr', 'Interest rate (% a year)', r, 0.05) + f('cy', 'Tenure (years)', 5, 1)
        : f('ca', 'Amount (₹)', 100000, 1000) + f('cr', 'Rate (% a year)', r, 0.05) + f('cy', 'Years', 5, 1)) +
      '</div><div class="fx-sip-out px3" id="co"></div><p class="fx-note">' + (c.type === 'emi' ? 'Starts at this lender\'s lowest listed rate; your rate depends on your credit score and profile. Fees not included.' : 'Assumes quarterly compounding and no tax. Interest is usually taxable at your slab rate.') + '</p></section>';
  }
  function calcRun() {
    if (!$('co')) return;
    var A = +$('ca').value || 0, r = (+$('cr').value || 0) / 100, y = +$('cy').value || 0, h = '';
    if (S.calc === 'emi') {
      var n = Math.round(y * 12), m = r / 12, e = n ? (m ? A * m * Math.pow(1 + m, n) / (Math.pow(1 + m, n) - 1) : A / n) : 0;
      h = '<div><span>Monthly EMI</span><b>' + inr(e) + '</b></div><div><span>Total interest</span><b>' + inr(e * n - A) + '</b></div><div><span>Total paid</span><b>' + inr(e * n) + '</b></div>';
    } else {
      var M = A * Math.pow(1 + r / 4, 4 * y);
      h = '<div><span>You invest</span><b>' + inr(A) + '</b></div><div><span>Interest earned</span><b>' + inr(M - A) + '</b></div><div><span>Maturity value</span><b>' + inr(M) + '</b></div>';
    }
    $('co').innerHTML = h;
  }
  function renderEmpty(D) {
    setHash();
    $('view').innerHTML = '<section class="gw-card fx-empty"><h2>🔎 Analyze any ' + esc(catDef().label.toLowerCase()) + ' option</h2><p>Search by name or provider above, or tap a top-rated pick. You get an AI score, a parameter-by-parameter check against peers, strengths, risks' + ((PX.calc || {})[S.cat] ? ', a calculator' : '') + ' and the latest news.</p></section>';
  }

  // ------------------------------------------------------------------ compare
  function renderCompare(D) {
    setHash();
    var ids = S.cmp[S.cat].filter(function (x) { return D.byId[x]; }), ms = ids.map(function (x) { return D.byId[x]; });
    if (ms.length < 2) {
      $('view').innerHTML = '<section class="gw-card fx-empty"><h2>⚖️ Compare up to 4</h2><p>' + (ms.length ? 'Add one more to compare with ' + esc(ms[0].name) + '.' : 'Search above or tap the top-rated picks to add options.') + ' You get a ranking, a side-by-side table with the best value in each row marked, and news.</p></section>';
      return;
    }
    var rank = ms.slice().sort(function (a, b) { return (b.score || 0) - (a.score || 0); }), h = '';
    var col = function (m) { return COLORS[ids.indexOf(m.id)]; };
    var wins = ms.map(function (m) { return { m: m, n: D.params.filter(function (p) { return p.use && bestOf(D, ms, p) === m; }).length }; });
    h += '<section class="gw-card fx-exec"><h2>🏁 Ranking</h2><ol class="fx-sum">' + rank.map(function (m, i) { var w = wins.filter(function (x) { return x.m === m; })[0].n; return '<li><b>' + esc(m.name) + '</b> · ' + sc1(m.score) + '/10 (' + label(m.score) + ')' + (w ? ' · best on ' + w + ' parameter' + (w > 1 ? 's' : '') : '') + (i === 0 ? ' · <b>best overall</b>' : '') + '</li>'; }).join('') + '</ol></section>';
    h += '<section class="gw-card"><h2>🤖 Scores by area</h2><div class="gw-tbl-wrap"><table class="gw-tbl fx-cmp-tbl"><thead><tr><th></th>' + ms.map(function (m) { return '<th><span class="d" style="background:' + col(m) + '"></span>' + esc(m.name) + '</th>'; }).join('') + '</tr></thead><tbody>' +
      [{ id: '_', label: 'Overall' }].concat(D.groups || []).map(function (g) {
        var vals = ms.map(function (m) { if (g.id === '_') return m.score; var x = m.gs.filter(function (y) { return y.id === g.id; })[0]; return x ? x.s : null; });
        if (vals.every(function (v) { return v == null; })) return '';
        var mx = Math.max.apply(null, vals.filter(function (v) { return v != null; }));
        return '<tr><td>' + esc(g.label) + '</td>' + vals.map(function (v) { return '<td class="num' + (v != null && v === mx ? ' best' : '') + '">' + sc1(v) + '</td>'; }).join('') + '</tr>';
      }).join('') + '</tbody></table></div></section>';
    var gl = {}; (D.groups || []).forEach(function (g) { gl[g.id] = g.label; });
    var lastG = null, ps = D.params.filter(function (p) { return p.show && ms.some(function (m) { return m.v[p.k] != null && m.v[p.k] !== ''; }); });
    ps.sort(function (a, b) { var ga = (D.groups || []).map(function (g) { return g.id; }); return ga.indexOf(a.g) - ga.indexOf(b.g); });
    h += '<section class="gw-card"><h2>Side by side</h2><div class="gw-tbl-wrap"><table class="gw-tbl fx-cmp-tbl"><thead><tr><th></th>' + ms.map(function (m) { return '<th><span class="d" style="background:' + col(m) + '"></span>' + esc(m.name) + '</th>'; }).join('') + '</tr></thead><tbody>' +
      '<tr><td>Provider</td>' + ms.map(function (m) { return '<td style="white-space:normal">' + esc(m.provider) + '</td>'; }).join('') + '</tr>' +
      ps.map(function (p) {
        var sec = ''; if (p.g !== lastG) { lastG = p.g; sec = '<tr class="sec"><td colspan="' + (ms.length + 1) + '">' + esc(gl[p.g] || '') + '</td></tr>'; }
        var b = scored(p) && p.fmt !== 'text' ? bestOf(D, ms, p) : null;
        var allEq = b && ms.every(function (m) { return num(p, m.v[p.k]) === num(p, b.v[p.k]); });
        return sec + '<tr><td title="' + esc(p.tip || '') + '">' + esc(p.label) + '</td>' + ms.map(function (m) { return '<td class="num' + (b === m && !allEq ? ' best' : '') + '" style="white-space:normal">' + esc(fv(p, m.v[p.k])) + '</td>'; }).join('') + '</tr>';
      }).join('') +
      '<tr class="sec"><td colspan="' + (ms.length + 1) + '">Summary</td></tr><tr><td>Best for</td>' + ms.map(function (m) { return '<td style="white-space:normal">' + esc(m.best || '–') + '</td>'; }).join('') + '</tr>' +
      '</tbody></table></div><p class="fx-note">Green marks the best value in each row.</p></section>';
    h += '<div class="kx-2">' + ms.map(function (m) { return '<section class="gw-card fx-take"><h3 style="color:' + col(m) + '">' + esc(m.name) + '</h3><ul>' + (m.pros || []).slice(0, 3).map(function (x) { return '<li>' + esc(x) + '</li>'; }).join('') + '</ul><ul class="w">' + (m.cons || []).slice(0, 3).map(function (x) { return '<li>' + esc(x) + '</li>'; }).join('') + '</ul></section>'; }).join('') + '</div>';
    var provs = []; ms.forEach(function (m) { var w = words(m.provider)[0]; if (w && provs.indexOf(w) < 0) provs.push(w); });
    h += newsCard('News on these providers', ms.map(function (m) { return m.provider.replace(/\(.*?\)/g, ''); }).slice(0, 3).join(' OR '), provs.join('|'), 'cnews');
    $('view').innerHTML = h;
  }
  function toggleCmp(id) {
    var a = S.cmp[S.cat], i = a.indexOf(id);
    if (i >= 0) a.splice(i, 1);
    else { if (a.length >= 4) { if (GW.toast) GW.toast('You can compare up to 4. Remove one first.'); return false; } a.push(id); }
    GK.saveLS(LS + 'cmp_' + S.cat, a); drawTray(); return true;
  }
  function drawTray() {
    var t = $('tray'), D = S.D, a = S.cmp[S.cat];
    $('cmpCnt').hidden = !a.length; $('cmpCnt').textContent = a.length;
    if (!D || S.tab !== 'compare' || !a.length) { t.hidden = true; return; }
    t.hidden = false;
    t.innerHTML = a.map(function (id, i) { var m = D.byId[id]; return m ? '<span class="fx-tchip" style="--c:' + COLORS[i] + '"><span class="d"></span><span class="t">' + esc(m.name) + '</span><button type="button" data-rm="' + esc(id) + '" aria-label="Remove">×</button></span>' : ''; }).join('');
  }

  // ------------------------------------------------------------------ search & picks
  var ddItems = [], ddOn = -1;
  function closeDD() { $('dd').hidden = true; $('q').setAttribute('aria-expanded', 'false'); ddOn = -1; }
  function search(q) {
    q = q.trim().toLowerCase(); if (!q || !S.D) return closeDD();
    var ts = q.split(/\s+/);
    var a = S.D.items.filter(function (it) { var s = (it.name + ' ' + it.provider + ' ' + (it.kind || '') + ' ' + (it.tags || []).join(' ')).toLowerCase(); return ts.every(function (t) { return s.indexOf(t) >= 0; }); });
    a = sorted(S.D, a).slice(0, 10); ddItems = a; ddOn = a.length ? 0 : -1;
    $('dd').innerHTML = a.length ? a.map(function (it, i) { return '<li role="option" data-i="' + i + '"' + (i === 0 ? ' class="on"' : '') + '><span class="nm">' + esc(it.name) + ' <small class="muted">' + esc(it.provider) + '</small></span><span class="gw-chip">' + sc1(it.score) + '</span></li>'; }).join('') : '<li class="empty">Nothing found. Try a provider name.</li>';
    $('dd').hidden = false; $('q').setAttribute('aria-expanded', 'true');
  }
  function choose(it) {
    if (!it) return; $('q').value = ''; closeDD();
    if (S.tab === 'compare') { if (S.cmp[S.cat].indexOf(it.id) < 0 && toggleCmp(it.id)) renderCompare(S.D); }
    else { S.tab = 'analyze'; syncTabs(); renderAnalyze(S.D, it.id); window.scrollTo({ top: 0, behavior: 'smooth' }); }
  }
  function renderPicks() {
    if (!S.D) { $('picks').innerHTML = ''; return; }
    var top = sorted(S.D, visible(S.D)).slice(0, 6);
    $('picks').innerHTML = '<span class="lbl">Top rated</span>' + top.map(function (it, i) { return '<button type="button" class="fx-pick c' + (i % 6 + 1) + '" data-pick="' + esc(it.id) + '">' + esc(it.name) + '</button>'; }).join('');
  }

  // ------------------------------------------------------------------ navigation
  function setHash() { var h = S.cat + (S.tab !== 'report' ? '/' + S.tab : '') + (S.tab === 'analyze' && S.id ? '/' + S.id : ''); try { history.replaceState(null, '', '#' + h); } catch (e) {} }
  function syncTabs() {
    document.querySelectorAll('#cats button').forEach(function (b) { b.setAttribute('aria-selected', String(b.dataset.cat === S.cat)); });
    document.querySelectorAll('#tabs button').forEach(function (b) { b.setAttribute('aria-selected', String(b.dataset.tab === S.tab)); });
    $('searchBox').hidden = S.tab === 'report';
    var c = catDef();
    $('q').placeholder = S.tab === 'compare' ? 'Add a ' + c.label.toLowerCase() + ' option to compare' : 'Search ' + c.label.toLowerCase() + ' by name or provider';
    drawTray();
  }
  var tok = 0;
  function show() {
    syncTabs(); var my = ++tok;
    if (!S.D || S.D.id !== S.cat) $('view').innerHTML = '<div class="fx-load"><span class="gw-spin dark"></span>Loading ' + esc(catDef().label) + '…</div>';
    load(S.cat).then(function (D) {
      if (my !== tok) return;
      S.D = D; renderPicks(); drawTray();
      if (S.tab === 'report') { setHash(); renderReport(D); }
      else if (S.tab === 'compare') renderCompare(D);
      else if (S.id && D.byId[S.id]) renderAnalyze(D, S.id);
      else renderEmpty(D);
    }).catch(function () {
      if (my !== tok) return;
      $('view').innerHTML = '<section class="gw-card fx-errc"><p>' + esc(catDef().label) + ' data could not load right now.</p><button class="gw-btn" type="button" data-retry>Try again</button></section>';
    });
  }
  function setCat(c) { if (c === S.cat) return; S.cat = c; S.id = null; S.kind = ''; S.sort = null; S.D = null; show(); }

  // build the controls
  $('cats').innerHTML = PX.cats.map(function (c) { return '<button type="button" role="tab" data-cat="' + c.id + '" aria-selected="false"><span aria-hidden="true">' + c.icon + '</span> ' + esc(c.label) + '</button>'; }).join('');
  $('cats').addEventListener('click', function (e) { var b = e.target.closest('button'); if (b) setCat(b.dataset.cat); });
  $('tabs').addEventListener('click', function (e) { var b = e.target.closest('button'); if (!b || b.dataset.tab === S.tab) return; S.tab = b.dataset.tab; show(); });
  $('q').addEventListener('input', function () { search(this.value); });
  $('q').addEventListener('focus', function () { if (this.value) search(this.value); });
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
    var pk = t.closest('[data-pick]'); if (pk && S.D) return choose(S.D.byId[pk.dataset.pick]);
    var op = t.closest('[data-open]'); if (op && S.D) { S.tab = 'analyze'; syncTabs(); renderAnalyze(S.D, op.dataset.open); window.scrollTo({ top: 0, behavior: 'smooth' }); return; }
    var rm = t.closest('[data-rm]'); if (rm) { toggleCmp(rm.dataset.rm); return renderCompare(S.D); }
    var ad = t.closest('[data-addcmp]'); if (ad) { if (toggleCmp(ad.dataset.addcmp)) ad.textContent = S.cmp[S.cat].indexOf(ad.dataset.addcmp) >= 0 ? '✓ In compare' : '+ Compare'; return; }
    var kd = t.closest('[data-kind]'); if (kd) { S.kind = kd.dataset.kind; renderPicks(); return renderReport(S.D); }
    var so = t.closest('th[data-sort]'); if (so) { var k = so.dataset.sort; S.sort = S.sort && S.sort[0] === k ? (S.sort[1] < 0 ? [k, 1] : null) : [k, -1]; return drawTable(S.D); }
    if (t.closest('[data-retry]')) return show();
  });
  document.addEventListener('keydown', function (e) { if (e.key === 'Enter' && e.target.matches && e.target.matches('tr[data-open]')) e.target.click(); });
  document.addEventListener('input', function (e) { if (e.target.id === 'tf') drawTable(S.D); if (/^c[ary]$/.test(e.target.id)) calcRun(); });

  function fromHash() {
    var p = decodeURIComponent(location.hash.slice(1)).split('/');
    if (PX.cats.some(function (c) { return c.id === p[0]; })) {
      if (p[0] !== S.cat) { S.cat = p[0]; S.kind = ''; S.D = null; }
      S.tab = p[1] === 'analyze' || p[1] === 'compare' ? p[1] : 'report'; S.id = p[2] || null; return true;
    }
    return false;
  }
  window.addEventListener('hashchange', function () { var cur = S.cat + '/' + S.tab + '/' + S.id; if (fromHash() && cur !== S.cat + '/' + S.tab + '/' + S.id) show(); });
  fromHash();
  show();
})();
