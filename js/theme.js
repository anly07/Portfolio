/* Shared appearance engine (public site).
   - Accent colour + default theme come from the admin's saved settings
     (publicSettings). The last-known values are cached in localStorage and
     applied synchronously from <head>, so there is no colour flash on reload.
   - A visitor who presses the theme toggle gets a personal light/dark choice
     (stored under its own key) that wins over the admin default for them. */
(function () {
  var root = document.documentElement;
  var CACHE_KEY = 'pf_appearance_v1';
  var OVERRIDE_KEY = 'pf_theme_override';
  var DEFAULTS = { accentPreset: 'violet', accent: '#8581EF', accent2: '#63C8D6', themeMode: 'system' };
  var HEX = /^#[0-9a-fA-F]{6}$/;
  var mq = window.matchMedia ? window.matchMedia('(prefers-color-scheme: dark)') : null;
  var state = { settings: Object.assign({}, DEFAULTS) };

  function read(k) { try { return localStorage.getItem(k); } catch (e) { return null; } }
  function write(k, v) { try { localStorage.setItem(k, v); } catch (e) {} }

  function ink(hex) {
    var n = parseInt(hex.slice(1), 16);
    var c = [n >> 16 & 255, n >> 8 & 255, n & 255].map(function (v) { v /= 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); });
    var L = 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
    return 1.05 / (L + 0.05) >= (L + 0.05) / 0.058 ? '#ffffff' : '#14152a';
  }

  function effectiveTheme() {
    var o = read(OVERRIDE_KEY);
    if (o === 'light' || o === 'dark') return o;
    var m = state.settings.themeMode;
    if (m === 'light' || m === 'dark') return m;
    return mq && mq.matches ? 'dark' : 'light';
  }

  function paintTheme() {
    var t = effectiveTheme();
    root.classList.toggle('dark', t === 'dark');
    root.setAttribute('data-theme', t);
    root.style.colorScheme = t;
    var tc = document.querySelector('meta[name="theme-color"][data-dynamic]');
    if (tc) tc.setAttribute('content', t === 'dark' ? '#10111D' : '#F6F7FC');
    var btn = document.getElementById('theme-toggle');
    if (btn) { btn.setAttribute('aria-pressed', String(t === 'dark')); btn.setAttribute('aria-label', t === 'dark' ? 'Switch to light theme' : 'Switch to dark theme'); }
  }

  function paintAccent() {
    var s = state.settings;
    var a = HEX.test(s.accent) ? s.accent : DEFAULTS.accent;
    root.style.setProperty('--accent', a);
    root.style.setProperty('--accent-ink', ink(a));
    root.setAttribute('data-accent', s.accentPreset || 'violet');
    // Only the Cyber Cyan preset needs a different secondary accent.
    if (HEX.test(s.accent2) && s.accent2.toLowerCase() !== DEFAULTS.accent2.toLowerCase()) root.style.setProperty('--accent-2', s.accent2);
    else root.style.removeProperty('--accent-2');
  }

  function applySettings(r, persist) {
    if (!r) return;
    var s = state.settings;
    if (r.accentPreset) s.accentPreset = String(r.accentPreset).replace(/[^a-z]/g, '');
    if (HEX.test(r.accent || '')) s.accent = r.accent;
    if (HEX.test(r.accent2 || '')) s.accent2 = r.accent2;
    if (r.themeMode === 'light' || r.themeMode === 'dark' || r.themeMode === 'system') s.themeMode = r.themeMode;
    paintAccent(); paintTheme();
    if (persist) write(CACHE_KEY, JSON.stringify(s));
  }

  // 1) synchronous, from cache
  try { var c = JSON.parse(read(CACHE_KEY) || 'null'); if (c) applySettings(c, false); else { paintAccent(); paintTheme(); } } catch (e) { paintAccent(); paintTheme(); }

  if (mq) { var onSys = function () { paintTheme(); }; if (mq.addEventListener) mq.addEventListener('change', onSys); else if (mq.addListener) mq.addListener(onSys); }

  window.PortfolioTheme = {
    applySettings: function (r) { applySettings(r, true); },
    toggle: function () {
      var next = effectiveTheme() === 'dark' ? 'light' : 'dark';
      root.classList.add('theme-anim');
      write(OVERRIDE_KEY, next);
      paintTheme();
      setTimeout(function () { root.classList.remove('theme-anim'); }, 600);
    },
    refresh: paintTheme,
    // For pages that don't load main.js (legal pages, 404...): fetch settings themselves.
    fetchSettings: function (url) {
      return fetch(url, { method: 'POST', headers: { 'Content-Type': 'text/plain;charset=utf-8' }, body: JSON.stringify({ action: 'publicSettings', payload: {} }) })
        .then(function (r) { return r.json(); }).then(function (r) { if (r && r.ok) applySettings(r, true); }).catch(function () {});
    }
  };
})();
