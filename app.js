/* Growebtek AI MoneyTrade — shared app logic (device ID, session, backend calls, app bar). */
(function () {
  'use strict';
  var CFG = window.GW_CONFIG || {};
  var KEY_DEV = 'gw_device', KEY_SES = 'gw_session', KEY_CHK = 'gw_checked';
  var ALPHA = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

  // ---------- device id: 16 characters, made once per browser ----------
  function readCookie(n) { var m = document.cookie.match(new RegExp('(?:^|; )' + n + '=([^;]*)')); return m ? decodeURIComponent(m[1]) : null; }
  function writeCookie(n, v) { document.cookie = n + '=' + encodeURIComponent(v) + ';path=/;max-age=' + 60 * 60 * 24 * 3650 + ';SameSite=Lax'; }
  function valid(id) { return /^[A-Z0-9]{16}$/.test(id || ''); }
  function deviceId() {
    var id = null;
    try { id = localStorage.getItem(KEY_DEV); } catch (e) {}
    if (!valid(id)) id = readCookie(KEY_DEV);
    if (!valid(id)) { var u = (location.search.match(/[?&]did=([A-Z0-9]{16})(?:&|$)/) || [])[1]; if (valid(u)) id = u; } // from a Safari / iPhone shortcut
    if (!valid(id)) {
      var b = new Uint8Array(16); crypto.getRandomValues(b); id = '';
      for (var i = 0; i < 16; i++) id += ALPHA[b[i] % ALPHA.length];
    }
    try { localStorage.setItem(KEY_DEV, id); } catch (e) {}
    writeCookie(KEY_DEV, id);
    return id;
  }
  function prettyId(id) { return id.replace(/(.{4})(?=.)/g, '$1-'); }

  // ---------- session ----------
  function session() {
    try {
      var s = JSON.parse(localStorage.getItem(KEY_SES) || 'null');
      if (s && s.token && s.exp > Date.now()) return s;
    } catch (e) {}
    return null;
  }
  function setSession(s) { localStorage.setItem(KEY_SES, JSON.stringify(s)); localStorage.setItem(KEY_CHK, String(Date.now())); }
  function clearSession() { localStorage.removeItem(KEY_SES); localStorage.removeItem(KEY_CHK); }

  // ---------- backend ----------
  function api(action, data, opts) {
    opts = opts || {};
    if (!CFG.API_URL) return Promise.reject(new Error('The app is not connected to its backend yet.'));
    var s = session();
    var body = Object.assign({ action: action, deviceId: deviceId(), token: s ? s.token : '' }, data || {});
    var ctl = 'AbortController' in window ? new AbortController() : null;
    var to = ctl ? setTimeout(function () { ctl.abort(); }, opts.timeout || 45000) : null;
    // text/plain keeps this a "simple" request (no CORS preflight), which Apps Script needs.
    return fetch(CFG.API_URL, { method: 'POST', body: JSON.stringify(body), headers: { 'Content-Type': 'text/plain;charset=utf-8' }, signal: ctl ? ctl.signal : undefined, redirect: 'follow' })
      .then(function (r) { if (!r.ok) throw new Error('Server is busy (' + r.status + '). Please try again.'); return r.json(); })
      .then(function (j) {
        if (to) clearTimeout(to);
        if (j && j.error === 'auth' && !opts.noRedirect) { clearSession(); goHome('expired'); throw new Error(j.message || 'Session expired'); }
        if (j && j.error) throw new Error(j.message || j.error);
        return j;
      }, function (e) {
        if (to) clearTimeout(to);
        if (e && e.name === 'AbortError') throw new Error('This is taking too long. Please try again.');
        if (e instanceof TypeError) throw new Error('Could not reach the server. Check your internet and try again.');
        throw e;
      });
  }

  // ---------- paths ----------
  function root() { return CFG.ROOT || (document.querySelector('script[src$="app.js"]').getAttribute('src').replace(/app\.js$/, '') || './'); }
  function goHome(reason) { location.href = root() + 'index.html' + (reason ? '#' + reason : ''); }

  // ---------- UI helpers ----------
  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); }
  var toastEl, toastT;
  function toast(msg) {
    if (!toastEl) { toastEl = document.createElement('div'); toastEl.className = 'gw-toast'; toastEl.setAttribute('role', 'status'); document.body.appendChild(toastEl); }
    toastEl.textContent = msg; toastEl.classList.add('show'); clearTimeout(toastT);
    toastT = setTimeout(function () { toastEl.classList.remove('show'); }, 2200);
  }
  function copy(text, label) {
    var done = function () { toast((label || 'Copied') + ' ✓'); };
    if (navigator.clipboard && window.isSecureContext) return navigator.clipboard.writeText(text).then(done, fallback);
    fallback();
    function fallback() {
      var t = document.createElement('textarea'); t.value = text; t.style.position = 'fixed'; t.style.opacity = '0';
      document.body.appendChild(t); t.select(); try { document.execCommand('copy'); done(); } catch (e) { toast('Copy failed — please copy by hand'); } t.remove();
    }
  }
  function copyDevice() { copy(deviceId(), 'Device ID copied'); }

  function logoHtml(sub) {
    return '<a class="gw-logo" href="' + root() + 'index.html"><span class="gw-logo-mark"><img src="' + root() + 'assets/logo-mark.png" alt="Growebtek"></span><span style="min-width:0"><span class="gw-logo-t">Growebtek <span>AI MoneyTrade</span></span><br><span class="gw-logo-s">' + esc(sub || 'Smart market insights') + '</span></span></a>';
  }
  function deviceChip() {
    var id = deviceId();
    return '<span class="gw-dev" title="Your unique Device ID">Device ID <b>' + prettyId(id) + '</b><button class="gw-btn-ic" type="button" data-gw-copy>Copy</button></span>';
  }
  // Top bar for signed-in pages. opts: {sub, home:boolean}
  function appBar(opts) {
    opts = opts || {};
    var bar = document.createElement('div');
    bar.className = 'gw-bar'; bar.id = 'gw-bar';
    bar.innerHTML = '<div class="gw-bar-in">' + logoHtml(opts.sub) + deviceChip() +
      (opts.home === false ? '' : '<a class="gw-nav-btn" href="' + root() + 'index.html" title="Dashboard"><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" aria-hidden="true"><path d="M3 11l9-8 9 8"/><path d="M5 10v10h14V10"/></svg><span class="lbl">Dashboard</span></a>') +
      '<button class="gw-nav-btn out" type="button" data-gw-logout title="Log out"><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" aria-hidden="true"><path d="M15 3h4a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2h-4"/><path d="M10 17l-5-5 5-5"/><path d="M5 12h12"/></svg><span class="lbl">Logout</span></button></div>';
    document.body.insertBefore(bar, document.body.firstChild);
    return bar;
  }
  document.addEventListener('click', function (e) {
    if (e.target.closest('[data-gw-copy]')) copyDevice();
    if (e.target.closest('[data-gw-logout]')) logout();
  });
  function logout() {
    var s = session();
    if (s) api('logout', {}, { noRedirect: true, timeout: 4000 }).catch(function () {});
    clearSession(); goHome();
  }

  // Protect a sub page: no valid session -> home. Re-checks with the server every 10 minutes
  // so removed or expired users are signed out.
  function guard(opts) {
    var s = session();
    if (!s) { goHome('login'); return null; }
    var last = +localStorage.getItem(KEY_CHK) || 0;
    if (Date.now() - last > 10 * 60 * 1000) {
      api('me').then(function () { localStorage.setItem(KEY_CHK, String(Date.now())); }).catch(function () {});
    }
    setTimeout(function () { if (!session()) goHome('expired'); }, Math.max(0, s.exp - Date.now()) + 500);
    if (!opts || opts.bar !== false) appBar(opts);
    return s;
  }

  // ---------- desktop / home-screen shortcut (installable app) ----------
  // Chrome, Edge and Android share storage with the shortcut, so the Device ID stays the same.
  // Safari / iPhone / iPad give a shortcut its own storage, so the ID travels in the shortcut's address (?did=).
  var UA = navigator.userAgent || '';
  var IOS = /iPad|iPhone|iPod/.test(UA) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
  var SAFARI = IOS || (/Safari\//.test(UA) && !/Chrome|Chromium|Edg|OPR|Firefox|Android/.test(UA));
  var ANDROID = /Android/.test(UA);
  var installEvt = null;
  function standalone() { return (window.matchMedia && matchMedia('(display-mode: standalone)').matches) || navigator.standalone === true; }
  (function setupInstall() {
    var head = document.head;
    if (!SAFARI) { var m = document.createElement('link'); m.rel = 'manifest'; m.href = root() + 'manifest.webmanifest'; head.appendChild(m); }
    [['apple-mobile-web-app-capable', 'yes'], ['mobile-web-app-capable', 'yes'], ['apple-mobile-web-app-title', 'Growebtek AI MoneyTrade'], ['application-name', 'Growebtek AI MoneyTrade']].forEach(function (x) {
      var t = document.createElement('meta'); t.name = x[0]; t.content = x[1]; head.appendChild(t);
    });
    if ('serviceWorker' in navigator) navigator.serviceWorker.register(root() + 'sw.js').catch(function () {});
    window.addEventListener('beforeinstallprompt', function (e) { e.preventDefault(); installEvt = e; });
    window.addEventListener('appinstalled', function () { installEvt = null; toast('Shortcut added ✓'); var c = document.getElementById('gw-install'); if (c) c.remove(); });
  })();
  function installSteps() {
    if (IOS) return ['Tap the <b>Share</b> button <span aria-hidden="true">⬆️</span> at the bottom (or top) of Safari.', 'Choose <b>Add to Home Screen</b>, then tap <b>Add</b>.', 'Open Growebtek AI MoneyTrade from your home screen.'];
    if (SAFARI) return ['In the Safari menu bar choose <b>File → Add to Dock</b>.', 'Click <b>Add</b>.', 'Open Growebtek AI MoneyTrade from your Dock.'];
    if (ANDROID) return ['Tap the browser menu <b>⋮</b> at the top right.', 'Choose <b>Add to Home screen</b> or <b>Install app</b>.', 'Open Growebtek AI MoneyTrade from your home screen.'];
    if (/Firefox/.test(UA)) return ['Firefox cannot make app shortcuts.', 'Open this page in <b>Chrome</b> or <b>Edge</b> and tap <b>Add shortcut</b> there.'];
    return ['Click the <b>install</b> icon <span aria-hidden="true">⊕</span> at the right end of the address bar,', 'or open the browser menu <b>⋮</b> → <b>Cast, save and share</b> → <b>Install page as app</b> (Edge: <b>Apps → Install this site as an app</b>).', 'Growebtek opens from your desktop, Start menu or taskbar.'];
  }
  function installCard() {
    if (standalone()) return '';
    return '<section class="gw-card gw-install" id="gw-install" aria-labelledby="gw-inst-h">' +
      '<div class="gw-install-ic" aria-hidden="true">📲</div><div class="gw-install-tx"><h2 id="gw-inst-h">Add shortcut to your desktop or mobile</h2>' +
      '<p>Open Growebtek in one tap, like an app. Your Device ID <b>' + prettyId(deviceId()) + '</b> stays linked to the shortcut.</p>' +
      '<div class="gw-install-steps" id="gw-inst-steps" hidden></div></div>' +
      '<button class="gw-btn" type="button" id="gw-inst-btn">Add shortcut</button></section>';
  }
  function bindInstall() {
    var btn = document.getElementById('gw-inst-btn'); if (!btn) return;
    btn.onclick = function () {
      if (installEvt) {
        var ev = installEvt; installEvt = null;
        try {
          Promise.resolve(ev.prompt()).catch(showSteps);
          (ev.userChoice || Promise.resolve({})).then(function (r) { if (r.outcome === 'dismissed') showSteps(); }).catch(function () {});
        } catch (err) { showSteps(); }
        return;
      }
      showSteps();
    };
    function showSteps() {
      if (SAFARI) { // the shortcut keeps this address, so it carries the Device ID
        var u = new URL(location.href); u.searchParams.set('did', deviceId()); u.hash = '';
        history.replaceState(null, '', u.pathname + u.search);
      }
      var box = document.getElementById('gw-inst-steps');
      box.innerHTML = '<ol>' + installSteps().map(function (s) { return '<li>' + s + '</li>'; }).join('') + '</ol>' +
        (IOS || SAFARI ? '<p class="gw-install-note">Log in once inside the shortcut with your mobile number.</p>' : '');
      box.hidden = false;
    }
  }

  window.GW = { cfg: CFG, deviceId: deviceId, prettyId: prettyId, session: session, setSession: setSession, clearSession: clearSession,
    api: api, guard: guard, appBar: appBar, logout: logout, toast: toast, copy: copy, copyDevice: copyDevice, esc: esc,
    logoHtml: logoHtml, deviceChip: deviceChip, root: root, goHome: goHome,
    installCard: installCard, bindInstall: bindInstall, standalone: standalone };
})();
