/* Portfolio front-end. Vanilla JS, no dependencies.
   Talks to the existing Google Apps Script backend with the same actions
   as before: publicSettings, publicContent, publicTestimonials, publicStats,
   contact, feedback, track. */
(function () {
'use strict';

/* ---------- Backend config (unchanged contract) ---------- */
const APPS_SCRIPT_URL = "https://script.google.com/macros/s/AKfycbwJbNdIc8w5P1skSUZcNVHD_pKTWEKsAodd1KFjsSLpjByS_dSw96_OIhgkc_8upRixDg/exec";

function apiCall(action, payload = {}) {
  return fetch(APPS_SCRIPT_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'text/plain;charset=utf-8' }, // avoids CORS preflight on Apps Script
    body: JSON.stringify({ action, payload })
  }).then(r => r.json());
}

const $ = (id) => document.getElementById(id);
const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));
const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
const finePointer = window.matchMedia('(hover: hover) and (pointer: fine)').matches;
const store = {
  get(k) { try { return localStorage.getItem(k); } catch (e) { return null; } },
  set(k, v) { try { localStorage.setItem(k, v); } catch (e) {} }
};

/* ---------- Anonymous ID + consent-gated tracking (unchanged behaviour) ---------- */
function hasConsent() { return store.get('cookie_consent') === 'accepted'; }
function getAnonId() {
  if (!hasConsent()) return 'anon';
  let id = store.get('anon_id');
  if (!id) { id = 'a_' + Math.random().toString(36).slice(2) + Date.now().toString(36); store.set('anon_id', id); }
  return id;
}
function trackPageview() {
  if (!hasConsent()) return;
  apiCall('track', { type: 'pageview', anonId: getAnonId(), page: location.pathname, referrer: document.referrer.slice(0, 200) }).catch(() => {});
}
function trackEvent(eventType, label) {
  if (!hasConsent()) return;
  apiCall('track', { type: 'event', anonId: getAnonId(), eventType, label, page: location.pathname }).catch(() => {});
}
trackPageview();

(function initConsentBanner() {
  const banner = $('cookie-banner');
  if (!store.get('cookie_consent')) banner.hidden = false;
  $('cookie-accept').addEventListener('click', () => { store.set('cookie_consent', 'accepted'); banner.hidden = true; trackPageview(); });
  $('cookie-decline').addEventListener('click', () => { store.set('cookie_consent', 'declined'); banner.hidden = true; });
})();

const _pageEnteredAt = Date.now();
let _durationSent = false;
function sendDurationBeacon() {
  if (_durationSent || !hasConsent()) return;
  const seconds = Math.round((Date.now() - _pageEnteredAt) / 1000);
  if (seconds < 2) return;
  _durationSent = true;
  const payload = JSON.stringify({ action: 'track', payload: { type: 'event', eventType: 'duration', anonId: getAnonId(), label: String(seconds), page: location.pathname } });
  if (navigator.sendBeacon) navigator.sendBeacon(APPS_SCRIPT_URL, new Blob([payload], { type: 'text/plain;charset=utf-8' }));
}
document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'hidden') sendDurationBeacon(); });
window.addEventListener('pagehide', sendDurationBeacon);

/* ---------- Helpers ---------- */
function esc(s) { return String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }
// Only http(s)/mailto links are ever rendered — a stored "javascript:" URL can't become a clickable payload.
function safeUrl(u) { u = String(u ?? '').trim(); return /^(https?:\/\/|mailto:)/i.test(u) ? u : ''; }
function splitTags(tags) { return String(tags || '').split(',').map(t => t.trim()).filter(Boolean); }
function initials(name) { const p = String(name || '').trim().split(/\s+/).filter(Boolean); return ((p[0] || '?')[0] + (p.length > 1 ? p[p.length - 1][0] : '')).toUpperCase(); }
function formatDate(raw) {
  if (!raw) return '';
  const d = new Date(raw);
  if (isNaN(d.getTime())) return String(raw);
  return d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' });
}
const ICON = {
  arrow: '<svg class="arrow" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M7 17 17 7M8 7h9v9"/></svg>',
  right: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M5 12h14M13 6l6 6-6 6"/></svg>',
  github: '<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M12 .5a11.5 11.5 0 0 0-3.64 22.41c.58.1.79-.25.79-.56v-2c-3.2.7-3.88-1.37-3.88-1.37-.52-1.33-1.28-1.69-1.28-1.69-1.05-.72.08-.7.08-.7 1.16.08 1.77 1.19 1.77 1.19 1.03 1.77 2.7 1.26 3.36.96.1-.75.4-1.26.73-1.55-2.55-.29-5.24-1.28-5.24-5.69 0-1.26.45-2.29 1.19-3.1-.12-.29-.52-1.46.11-3.05 0 0 .97-.31 3.18 1.18a11 11 0 0 1 5.78 0c2.2-1.49 3.17-1.18 3.17-1.18.63 1.59.23 2.76.11 3.05.74.81 1.19 1.84 1.19 3.1 0 4.42-2.7 5.4-5.26 5.68.41.36.78 1.06.78 2.14v3.17c0 .31.21.67.8.56A11.5 11.5 0 0 0 12 .5Z"/></svg>',
  expand: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M14 4h6v6M10 20H4v-6M20 4l-7 7M4 20l7-7"/></svg>',
  doc: '<svg width="46" height="46" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M6 3h8l4 4v14H6z"/><path d="M14 3v4h4M9 12h6M9 16h6"/></svg>',
  play: '<svg width="46" height="46" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="9"/><path d="m10 8.5 5.5 3.5-5.5 3.5z" fill="currentColor"/></svg>',
  star: '<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M12 17.3 6.2 21l1.6-6.6L2.5 9.8l6.7-.6L12 3l2.8 6.2 6.7.6-5.3 4.6 1.6 6.6z"/></svg>',
  ok: '<svg viewBox="0 0 24 24" fill="none" stroke="#2BB67C" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="9"/><path d="m8 12 3 3 5-6"/></svg>',
  bad: '<svg viewBox="0 0 24 24" fill="none" stroke="#E5566D" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="9"/><path d="M12 7v6M12 16.5v.5"/></svg>'
};

/* Drive thumbnails take ?sz=w1600 — request right-sized variants instead of always the biggest one. */
function imgAttrs(url, sizes) {
  url = safeUrl(url);
  if (!url) return '';
  const m = /^(https:\/\/drive\.google\.com\/thumbnail\?[^#]*?)sz=w\d+/.exec(url);
  if (m) {
    const set = [480, 800, 1200, 1600].map(w => `${url.replace(/sz=w\d+/, 'sz=w' + w)} ${w}w`).join(', ');
    return `src="${esc(url.replace(/sz=w\d+/, 'sz=w800'))}" srcset="${esc(set)}" sizes="${sizes}"`;
  }
  return `src="${esc(url)}"`;
}
function coverHtml(i, label, glyph) {
  return `<div class="cover v${i % 4}" aria-hidden="true">${glyph || `<b>${esc(initials(label))}</b>`}</div>`;
}
function mediaHtml(item, i, sizes, extraClass, glyph) {
  const label = item.title || item.name || '';
  const a = imgAttrs(item.imageUrl, sizes);
  const inner = a
    ? `<img ${a} alt="${esc(label)} preview" loading="lazy" decoding="async" width="800" height="500" onerror="this.replaceWith(Object.assign(document.createElement('div'),{className:'cover v${i % 4}'}))" />`
    : coverHtml(i, label, glyph);
  return `<div class="media ${extraClass || ''}">${inner}</div>`;
}
function statusBadge(status) {
  if (status === 'new') return '<span class="badge new">New</span>';
  if (status === 'upcoming') return '<span data-badge class="badge upcoming">Upcoming</span>';
  return '';
}
function countdownBlock(status, upcomingDate, id) {
  if (status !== 'upcoming') return '';
  return `<p class="countdown" data-countdown="${esc(upcomingDate || '')}" data-item-id="${esc(id || '')}">Coming soon</p>`;
}
function toast(msg) {
  const t = $('toast');
  t.textContent = msg; t.classList.add('show');
  clearTimeout(toast._t); toast._t = setTimeout(() => t.classList.remove('show'), 3200);
}
function skeletons() {
  $$('[data-skeleton]').forEach(el => {
    const n = Number(el.dataset.skeleton) || 3;
    el.innerHTML = Array.from({ length: n }, () => '<div class="card skel" aria-hidden="true"></div>').join('');
  });
}
skeletons();

/* ---------- Appearance (admin accent + theme) ---------- */
apiCall('publicSettings').then(r => { if (r && r.ok && window.PortfolioTheme) window.PortfolioTheme.applySettings(r); }).catch(() => {});
$('theme-toggle').addEventListener('click', () => window.PortfolioTheme && window.PortfolioTheme.toggle());
if (window.PortfolioTheme) window.PortfolioTheme.refresh();

/* ---------- Scroll reveal + counters ---------- */
const revealIO = new IntersectionObserver((entries) => {
  entries.forEach(e => { if (e.isIntersecting) { e.target.classList.add('in'); revealIO.unobserve(e.target); } });
}, { threshold: .12, rootMargin: '0px 0px -6% 0px' });
function observeReveals(root = document) { $$('.reveal:not(.in)', root).forEach(el => revealIO.observe(el)); }
observeReveals();

function animateCount(el, target, opts = {}) {
  const suffix = opts.suffix ?? el.dataset.suffix ?? '';
  const decimals = opts.decimals ?? Number(el.dataset.decimals || 0);
  const fmt = (v) => v.toFixed(decimals) + suffix;
  if (reduceMotion || !isFinite(target)) { el.textContent = fmt(target); return; }
  const dur = 1300, t0 = performance.now();
  (function step(now) {
    const p = Math.min(1, (now - t0) / dur), eased = 1 - Math.pow(1 - p, 3);
    el.textContent = fmt(target * eased);
    if (p < 1) requestAnimationFrame(step);
  })(t0);
}
const countIO = new IntersectionObserver((entries) => {
  entries.forEach(e => {
    if (!e.isIntersecting) return;
    countIO.unobserve(e.target);
    const el = e.target;
    animateCount(el, Number(el.dataset.count));
  });
}, { threshold: .6 });
function observeCounters(root = document) { $$('[data-count]', root).forEach(el => countIO.observe(el)); }
observeCounters();

/* ---------- Navigation ---------- */
const nav = $('site-nav');
const menuBtn = $('menu-toggle');
function setMenu(open) {
  nav.classList.toggle('menu-open', open);
  menuBtn.setAttribute('aria-expanded', String(open));
  menuBtn.setAttribute('aria-label', open ? 'Close menu' : 'Open menu');
}
menuBtn.addEventListener('click', () => setMenu(!nav.classList.contains('menu-open')));
$$('#mobile-panel a').forEach(a => a.addEventListener('click', () => setMenu(false)));
document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && nav.classList.contains('menu-open')) { setMenu(false); menuBtn.focus(); } });
document.addEventListener('click', (e) => { if (nav.classList.contains('menu-open') && !e.target.closest('#site-nav')) setMenu(false); });
window.matchMedia('(min-width: 900px)').addEventListener('change', (e) => { if (e.matches) setMenu(false); });

let scrollTick = false;
window.addEventListener('scroll', () => {
  if (scrollTick) return; scrollTick = true;
  requestAnimationFrame(() => { nav.classList.toggle('scrolled', window.scrollY > 16); scrollTick = false; });
}, { passive: true });

const sectionIds = ['home', 'about', 'projects', 'designs', 'tools', 'blog', 'testimonials', 'contact'];
const sections = sectionIds.map($).filter(Boolean);
const navLinks = $$('[data-nav]');
function setActive(id) {
  // The testimonials block sits between Blog and Contact in the page, but has no nav entry — keep Blog lit.
  const key = id === 'testimonials' ? 'blog' : id;
  navLinks.forEach(l => {
    const on = l.getAttribute('href') === '#' + key;
    l.classList.toggle('active', on);
    if (on) l.setAttribute('aria-current', 'true'); else l.removeAttribute('aria-current');
  });
}
const activeIO = new IntersectionObserver((entries) => {
  entries.forEach(e => { if (e.isIntersecting) setActive(e.target.id); });
}, { rootMargin: '-45% 0px -50% 0px' });
sections.forEach(s => activeIO.observe(s));

/* Section-view analytics: once per section per page load (used by the admin dashboard). */
const _sectionsSeen = new Set();
const sectionViewIO = new IntersectionObserver((entries) => {
  entries.forEach(e => {
    if (e.isIntersecting && !_sectionsSeen.has(e.target.id)) {
      _sectionsSeen.add(e.target.id);
      trackEvent('section_view', e.target.id);
      sectionViewIO.unobserve(e.target);
    }
  });
}, { threshold: .4 });
sections.forEach(s => sectionViewIO.observe(s));

/* ---------- Hero word rotator ---------- */
(function () {
  const words = $$('#word-rotate span');
  if (!words.length || reduceMotion) return;
  let wi = 0;
  setInterval(() => {
    if (document.hidden) return;
    words[wi].classList.remove('show'); words[wi].classList.add('hide-up');
    wi = (wi + 1) % words.length;
    words[wi].classList.remove('hide-up'); words[wi].classList.add('show');
  }, 2800);
})();

/* ---------- Card spotlight (pointer devices only) ---------- */
if (finePointer && !reduceMotion) {
  let raf = 0;
  document.addEventListener('pointermove', (e) => {
    const card = e.target.closest && e.target.closest('.card');
    if (!card || raf) return;
    raf = requestAnimationFrame(() => {
      const r = card.getBoundingClientRect();
      card.style.setProperty('--mx', (e.clientX - r.left) + 'px');
      card.style.setProperty('--my', (e.clientY - r.top) + 'px');
      raf = 0;
    });
  }, { passive: true });
}

/* ---------- Live countdowns for "Upcoming" items ---------- */
function formatCountdown(ms) {
  if (ms <= 0) return 'Launching any moment';
  const s = Math.floor(ms / 1000);
  const d = Math.floor(s / 86400), h = Math.floor((s % 86400) / 3600), m = Math.floor((s % 3600) / 60), sec = s % 60;
  return (d > 0 ? d + 'd ' : '') + h + 'h ' + m + 'm ' + sec + 's';
}
let _countdownTimer = null;
const _celebrated = new Set();
function startCountdowns() {
  clearInterval(_countdownTimer);
  const els = $$('[data-countdown]');
  if (!els.length) return;
  const tick = () => {
    els.forEach(el => {
      if (!el.isConnected) return;
      const raw = el.dataset.countdown;
      const target = raw ? new Date(raw).getTime() : NaN;
      const diff = isNaN(target) ? NaN : target - Date.now();
      if (!isNaN(diff) && diff <= 0) {
        const id = el.dataset.itemId || raw;
        if (!_celebrated.has(id)) { _celebrated.add(id); celebrateCard(el); }
      } else {
        el.textContent = isNaN(target) ? 'Coming soon' : formatCountdown(diff);
      }
    });
  };
  tick();
  _countdownTimer = setInterval(tick, 1000);
}
function celebrateCard(el) {
  el.innerHTML = '🎉 <strong>Live now!</strong>';
  const card = el.closest('.card');
  if (!card) return;
  const badge = card.querySelector('[data-badge]');
  if (badge) { badge.textContent = 'Just released'; badge.className = 'badge new'; }
  const banner = document.createElement('div');
  banner.className = 'celebrate';
  banner.innerHTML = '<div><p style="font-size:1.6rem;margin:0">🎉🎈</p><p class="display" style="font-weight:600;margin:.4rem 0 0">Welcome!</p><p style="margin:.2rem 0 0;font-size:.9rem;color:var(--text-soft)">Congratulations on the new release</p></div>';
  card.appendChild(banner);
  setTimeout(() => banner.remove(), 4500);
  if (reduceMotion) return;
  for (let i = 0; i < 22; i++) {
    const piece = document.createElement('span');
    piece.textContent = ['🎊', '🎉', '✨'][i % 3];
    piece.setAttribute('aria-hidden', 'true');
    piece.style.cssText = `position:absolute;left:${50 + (Math.random() * 70 - 35)}%;top:15%;font-size:${11 + Math.random() * 10}px;z-index:21;pointer-events:none;transition:transform 1.1s ease-out,opacity 1.1s ease-out;opacity:1`;
    card.appendChild(piece);
    requestAnimationFrame(() => { piece.style.transform = `translate(${Math.random() * 180 - 90}px,${110 + Math.random() * 90}px) rotate(${Math.random() * 360}deg)`; piece.style.opacity = '0'; });
    setTimeout(() => piece.remove(), 1300);
  }
}

/* ---------- Content sections ---------- */
const PAGE = 6;

/* Carousel: native scroll-snap track + "01 / 08" counter and arrows (right-aligned). */
function makeCarousel(track, key) {
  const prev = $(key + '-prev'), next = $(key + '-next'), count = $(key + '-count'), ctl = $(key + '-ctl');
  const pad = (n) => String(n).padStart(2, '0');
  const cards = () => Array.from(track.children).filter(c => !c.classList.contains('empty') && !c.classList.contains('skel'));
  const step = () => { const c = cards(); if (!c.length) return 320; const gap = parseFloat(getComputedStyle(track).columnGap) || 20; return c[0].getBoundingClientRect().width + gap; };
  function update() {
    const c = cards(), total = c.length;
    ctl.hidden = total < 2;
    if (!total) return;
    const max = track.scrollWidth - track.clientWidth;
    const atEnd = track.scrollLeft >= max - 2;
    const idx = atEnd && max > 2 ? total : Math.min(total, Math.round(track.scrollLeft / step()) + 1);
    count.textContent = pad(Math.max(1, idx)) + ' / ' + pad(total);
    prev.disabled = track.scrollLeft <= 2; next.disabled = atEnd;
  }
  const go = (dir) => track.scrollBy({ left: dir * step(), behavior: reduceMotion ? 'auto' : 'smooth' });
  prev.addEventListener('click', () => go(-1));
  next.addEventListener('click', () => go(1));
  track.addEventListener('scroll', () => requestAnimationFrame(update), { passive: true });
  track.addEventListener('keydown', (e) => { if (e.key === 'ArrowRight') { e.preventDefault(); go(1); } else if (e.key === 'ArrowLeft') { e.preventDefault(); go(-1); } });
  window.addEventListener('resize', update);
  // mouse drag (touch uses native scrolling)
  let down = false, sx = 0, sl = 0, moved = false;
  track.addEventListener('pointerdown', (e) => { if (e.pointerType !== 'mouse' || e.button !== 0) return; down = true; moved = false; sx = e.clientX; sl = track.scrollLeft; });
  window.addEventListener('pointermove', (e) => { if (!down) return; const dx = e.clientX - sx; if (!moved && Math.abs(dx) > 6) { moved = true; track.classList.add('dragging'); } if (moved) track.scrollLeft = sl - dx; });
  window.addEventListener('pointerup', () => { if (!down) return; down = false; if (moved) { track.classList.remove('dragging'); setTimeout(() => { moved = false; }, 0); } });
  track.addEventListener('click', (e) => { if (moved) { e.preventDefault(); e.stopPropagation(); } }, true);
  return { update, reset() { track.scrollLeft = 0; update(); } };
}
let projCar, designCar;

/* ----- Projects ----- */
let projects = [];
function projectCard(p, i, featured) {
  const live = safeUrl(p.url), gh = safeUrl(p.githubUrl);
  const tags = splitTags(p.tags);
  const title = esc(p.title);
  const liveBtn = live
    ? `<a href="${esc(live)}" target="_blank" rel="noopener" class="btn btn-primary btn-sm" aria-label="View project: ${title}">View project ${ICON.arrow}</a>`
    : (gh ? '' : `<button type="button" class="view-project btn btn-ghost btn-sm" aria-label="Ask about project: ${title}">View project</button>`);
  const ghBtn = gh ? `<a href="${esc(gh)}" target="_blank" rel="noopener" class="btn btn-ghost btn-sm" aria-label="${title} on GitHub">${ICON.github} GitHub</a>` : '';
  return `<article class="card pcard reveal${featured ? ' featured' : ''}" style="--i:${i % 3}">
    ${statusBadge(p.status)}
    ${mediaHtml(p, i, featured ? '(min-width:1000px) 40vw, 100vw' : '(min-width:1000px) 30vw, (min-width:640px) 45vw, 100vw')}
    <div class="body">
      ${p.category ? `<span class="cat">${esc(p.category)}</span>` : ''}
      <h3>${title}</h3>
      <p class="desc">${esc(p.desc)}</p>
      ${tags.length ? `<div class="tags">${tags.map(t => `<span class="tag">${esc(t)}</span>`).join('')}</div>` : ''}
      ${countdownBlock(p.status, p.upcomingDate, p.id)}
      <div class="actions">${liveBtn}${ghBtn}</div>
    </div>
  </article>`;
}
function renderProjects() {
  const grid = $('project-grid');
  if (!projects.length) { grid.innerHTML = '<p class="empty">Projects are being updated. Check back soon.</p>'; $('p-ctl').hidden = true; return; }
  grid.innerHTML = projects.map((p, i) => projectCard(p, i, false)).join('');
  observeReveals(grid); startCountdowns();
  if (projCar) projCar.reset();
}

/* ----- Designs + preview modal ----- */
let designs = [], lbList = [], lbIndex = -1, lbOpener = null;
const RATIOS = ['r1', 'r3', 'r2', 'r4', 'r3', 'r1', 'r2', 'r3'];
function designCard(d, i) {
  const cat = d.category || splitTags(d.tags)[0] || '';
  return `<button type="button" class="card dcard reveal" data-d="${i}" style="--i:${i % 3}" aria-label="Preview design: ${esc(d.title)}">
    ${statusBadge(d.status)}
    ${mediaHtml(d, i, '(min-width:1000px) 30vw, (min-width:600px) 48vw, 100vw', RATIOS[i % RATIOS.length])}
    <span class="view">${ICON.expand}</span>
    <div class="meta">${cat ? `<span class="cat">${esc(cat)}</span>` : ''}<h3>${esc(d.title)}</h3>${countdownBlock(d.status, d.upcomingDate, d.id)}</div>
  </button>`;
}
function renderDesigns() {
  const grid = $('design-grid');
  if (!designs.length) { grid.innerHTML = '<p class="empty">Designs are being updated. Check back soon.</p>'; $('d-ctl').hidden = true; return; }
  lbList = designs;
  grid.innerHTML = designs.map(designCard).join('');
  observeReveals(grid); startCountdowns();
  if (designCar) designCar.reset();
}

const lb = $('lightbox');
function lbRender() {
  const d = lbList[lbIndex]; if (!d) return;
  const a = imgAttrs(d.imageUrl, '100vw');
  $('lb-stage').innerHTML = a ? `<img ${a} alt="${esc(d.title)}" decoding="async" onerror="this.replaceWith(Object.assign(document.createElement('div'),{className:'cover v0'}))" />` : coverHtml(lbIndex, d.title);
  if (a) { const big = imgAttrs((d.imageUrl || '').replace(/sz=w\d+/, 'sz=w1600'), '100vw'); const im = $('lb-stage').firstChild; if (big && /srcset/.test(big)) im.setAttribute('sizes', '(min-width:1100px) 1080px, 100vw'); }
  $('lb-title').textContent = d.title || '';
  $('lb-desc').textContent = d.desc || '';
  $('lb-desc').hidden = !d.desc;
  const cat = d.category || ''; const catEl = $('lb-cat'); catEl.textContent = cat; catEl.hidden = !cat;
  $('lb-tags').innerHTML = splitTags(d.tags).map(t => `<span class="tag muted">${esc(t)}</span>`).join('');
  const link = safeUrl(d.url), l = $('lb-link');
  l.hidden = !link; if (link) l.href = link;
  const many = lbList.length > 1;
  $('lb-prev').hidden = $('lb-next').hidden = !many;
}
function lbOpen(i, opener) {
  lbIndex = i; lbOpener = opener || document.activeElement; lbRender();
  lb.classList.add('open'); lb.setAttribute('aria-hidden', 'false');
  document.documentElement.style.overflow = 'hidden';
  $('lb-close').focus({ preventScroll: true });
}
function lbClose() {
  lb.classList.remove('open'); lb.setAttribute('aria-hidden', 'true');
  document.documentElement.style.overflow = '';
  if (lbOpener && lbOpener.focus) lbOpener.focus({ preventScroll: true });
}
function lbStep(dir) { if (!lbList.length) return; lbIndex = (lbIndex + dir + lbList.length) % lbList.length; lbRender(); }
$('design-grid').addEventListener('click', (e) => {
  const c = e.target.closest('.dcard'); if (!c) return;
  trackEvent('click', 'design-preview');
  lbOpen(Number(c.dataset.d), c);
});
$('lb-close').addEventListener('click', lbClose);
$('lb-prev').addEventListener('click', () => lbStep(-1));
$('lb-next').addEventListener('click', () => lbStep(1));
lb.addEventListener('click', (e) => { if (e.target === lb) lbClose(); });
document.addEventListener('keydown', (e) => {
  if (!lb.classList.contains('open')) return;
  if (e.key === 'Escape') { e.preventDefault(); lbClose(); }
  else if (e.key === 'ArrowLeft') lbStep(-1);
  else if (e.key === 'ArrowRight') lbStep(1);
  else if (e.key === 'Tab') { // keep focus inside the dialog
    const f = $$('button:not([hidden]), a[href]:not([hidden])', lb).filter(x => x.offsetParent !== null);
    if (!f.length) return;
    const first = f[0], last = f[f.length - 1];
    if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
    else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
  }
});
let tX = 0;
lb.addEventListener('touchstart', (e) => { tX = e.changedTouches[0].clientX; }, { passive: true });
lb.addEventListener('touchend', (e) => { const dx = e.changedTouches[0].clientX - tX; if (Math.abs(dx) > 60) lbStep(dx < 0 ? 1 : -1); }, { passive: true });

/* ----- Tools ----- */
function toolTile(t, i) {
  const url = safeUrl(t.url);
  const icon = String(t.icon || '').trim();
  const ico = /^https?:\/\//i.test(icon) ? `<img src="${esc(safeUrl(icon))}" alt="" loading="lazy" decoding="async" width="30" height="30" />` : (esc(icon) || '🔧');
  const inner = `<span class="ico" aria-hidden="true">${ico}</span>
    ${t.category ? `<span class="cat">${esc(t.category)}</span>` : ''}
    <h3>${esc(t.name)}</h3>${t.desc ? `<p>${esc(t.desc)}</p>` : ''}
    ${url ? `<span class="go">Open ${ICON.arrow}</span>` : ''}`;
  return url
    ? `<a href="${esc(url)}" target="_blank" rel="noopener" class="card tool reveal" style="--i:${i % 4}" aria-label="${esc(t.name)} (opens in a new tab)">${inner}</a>`
    : `<div class="card tool reveal" style="--i:${i % 4}">${inner}</div>`;
}

/* ----- Blog ----- */
let posts = [], blogShown = 7;
function blogCard(b, i, feature) {
  const tag = b.tag || 'Blog';
  const url = safeUrl(b.url);
  const when = formatDate(b.date || b.updatedAt);
  const glyph = tag === 'Reel' ? ICON.play : ICON.doc;
  const cover = (b.imageUrl && safeUrl(b.imageUrl)) ? mediaHtml(b, i, feature ? '(min-width:1000px) 50vw, 100vw' : '(min-width:1000px) 30vw, 50vw') : `<div class="media">${coverHtml(i + (tag === 'Reel' ? 1 : 0), b.title, `<span style="position:relative;z-index:1;color:var(--accent-ink);opacity:.92">${glyph}</span>`)}</div>`;
  const body = `${cover}<div class="body">
      <div class="bmeta"><span class="tag">${esc(tag)}</span>${b.category ? `<span class="tag muted">${esc(b.category)}</span>` : ''}${when ? `<time>${esc(when)}</time>` : ''}${b.readTime ? `<span>${esc(b.readTime)} read</span>` : ''}</div>
      <h3>${esc(b.title)}</h3>${b.excerpt ? `<p>${esc(b.excerpt)}</p>` : ''}
      ${url ? `<span class="read-more">${tag === 'Reel' ? 'Watch reel' : 'Read more'} ${ICON.right}</span>` : ''}
    </div>`;
  const cls = `card bcard reveal${feature ? ' feature' : ''}`;
  return url
    ? `<a href="${esc(url)}" target="_blank" rel="noopener" class="${cls}" style="--i:${i % 3}">${body}</a>`
    : `<article class="${cls}" style="--i:${i % 3}">${body}</article>`;
}
function renderBlog() {
  const grid = $('blog-grid'), more = $('blog-more');
  if (!posts.length) { grid.innerHTML = '<p class="empty">New posts coming soon.</p>'; more.hidden = true; return; }
  grid.innerHTML = posts.slice(0, blogShown).map((b, i) => blogCard(b, i, i === 0)).join('');
  more.hidden = posts.length <= blogShown;
  observeReveals(grid);
}
$('blog-more').addEventListener('click', () => { blogShown += 6; renderBlog(); });

/* Fetch admin-managed content and render every section. If a fetch fails, each
   section fails gracefully with a quiet empty state instead of breaking the page. */
/* FAQ: the page ships with a crawlable default set (HTML + FAQPage JSON-LD). When the admin has
   saved FAQs they replace it, and the structured data is rewritten to match what is visible. */
function renderFaqs(list) {
  const items = (Array.isArray(list) ? list : []).filter(f => f && f.question && f.answer).slice(0, 24);
  if (!items.length) return;
  $('faq-grid').innerHTML = items.map((f, i) => `
    <details class="faq-item"${i === 0 ? ' open' : ''}>
      <summary><h3>${esc(f.question)}</h3><span class="faq-ico" aria-hidden="true"></span></summary>
      <div class="faq-a"><p>${esc(f.answer)}</p></div>
    </details>`).join('');
  const ld = { '@context': 'https://schema.org', '@type': 'FAQPage', mainEntity: items.map(f => ({ '@type': 'Question', name: String(f.question), acceptedAnswer: { '@type': 'Answer', text: String(f.answer) } })) };
  const tag = document.getElementById('faq-jsonld');
  if (tag) tag.textContent = JSON.stringify(ld).replace(/</g, '\\u003c');
}

async function loadPublicContent() {
  const empty = (m) => `<p class="empty">${m}</p>`;
  try {
    const r = await apiCall('publicContent');
    if (!r.ok) throw new Error(r.error || 'failed');
    projects = r.projects || []; designs = r.designs || []; posts = r.blog || [];
    if (!projCar) projCar = makeCarousel($('project-grid'), 'p');
    if (!designCar) designCar = makeCarousel($('design-grid'), 'd');
    renderProjects(); renderDesigns(false); renderBlog();
    renderFaqs(r.faqs);
    const tools = r.tools || [];
    const dock = $('tool-dock'); // the Tools section may be commented out of the page
    if (dock) { dock.innerHTML = tools.length ? tools.map(toolTile).join('') : empty('Tool list coming soon.'); observeReveals(dock); }
  } catch (err) {
    ['project-grid', 'design-grid', 'blog-grid', 'tool-dock'].forEach(id => { const el = $(id); if (el) el.innerHTML = empty('Content is temporarily unavailable. Please refresh in a moment.'); });
  }
}
loadPublicContent();

/* ---------- Testimonials + live stats ---------- */
function starsHtml(n) { return `<span class="stars" role="img" aria-label="${n} out of 5 stars">${[1, 2, 3, 4, 5].map(i => `<span class="${i <= n ? '' : 'off'}">${ICON.star}</span>`).join('')}</span>`; }
const tTrack = $('testimonial-grid');
function updateArrows() {
  const max = tTrack.scrollWidth - tTrack.clientWidth - 2;
  $('t-prev').disabled = tTrack.scrollLeft <= 2; $('t-next').disabled = tTrack.scrollLeft >= max;
}
function scrollT(dir) { const c = tTrack.querySelector('.tcard'); const step = c ? c.getBoundingClientRect().width + 18 : 320; tTrack.scrollBy({ left: dir * step, behavior: reduceMotion ? 'auto' : 'smooth' }); }
$('t-prev').addEventListener('click', () => scrollT(-1));
$('t-next').addEventListener('click', () => scrollT(1));
tTrack.addEventListener('scroll', () => requestAnimationFrame(updateArrows), { passive: true });
tTrack.addEventListener('keydown', (e) => { if (e.key === 'ArrowRight') { e.preventDefault(); scrollT(1); } if (e.key === 'ArrowLeft') { e.preventDefault(); scrollT(-1); } });
window.addEventListener('resize', updateArrows);

async function loadTestimonialsAndStats() {
  try {
    const [tRes, sRes] = await Promise.all([apiCall('publicTestimonials'), apiCall('publicStats')]);
    if (tRes.ok && tRes.items.length) {
      tTrack.innerHTML = tRes.items.slice(0, 12).map(t => `
        <figure class="card tcard">
          ${starsHtml(Math.max(0, Math.min(5, Number(t.rating) || 0)))}
          <blockquote>${esc(t.feedback)}</blockquote>
          <figcaption class="who"><span class="avatar" aria-hidden="true">${esc(initials(t.name))}</span><span><strong>${esc(t.name)}</strong><span>${esc(t.role || formatMonth(t.createdAt))}</span></span></figcaption>
        </figure>`).join('');
    } else if (tRes.ok) {
      tTrack.innerHTML = '<p class="empty">No testimonials yet. Worked with me? <a href="#contact" data-contact-tab="feedback" style="color:var(--accent-text);font-weight:600;text-decoration:underline">Be the first to leave one</a>.</p>';
    }
    updateArrows();

    if (sRes.ok) {
      const set = (id, v, dec) => { const el = $(id); el.dataset.count = v; el.dataset.decimals = dec || 0; el.textContent = Number(v).toFixed(dec || 0); countIO.observe(el); };
      set('stat-testimonials', sRes.totalTestimonials);
      set('stat-enquiries', sRes.totalEnquiries);
      if (sRes.avgRating) set('stat-avg', sRes.avgRating, 1); else $('stat-avg').textContent = '—';
      set('stat-fivestar', sRes.ratingBreakdown[4] || 0);

      const max = Math.max(1, ...sRes.ratingBreakdown);
      $('rating-bars').innerHTML = [5, 4, 3, 2, 1].map(n => `<div class="bar-row"><span>${n} ★</span><div class="bar-track"><div class="bar-fill" data-w="${Math.round(sRes.ratingBreakdown[n - 1] / max * 100)}"></div></div><b>${sRes.ratingBreakdown[n - 1]}</b></div>`).join('');
      const cm = Math.max(1, ...sRes.enquiriesByMonth.counts);
      $('enquiry-spark').innerHTML = sRes.enquiriesByMonth.labels.map((l, i) => `<div><b>${sRes.enquiriesByMonth.counts[i]}</b><i data-h="${Math.round(sRes.enquiriesByMonth.counts[i] / cm * 100)}"></i><span>${esc(l)}</span></div>`).join('');
      $('t-panels').hidden = false;
      const grow = () => {
        $$('.bar-fill').forEach(b => b.style.width = b.dataset.w + '%');
        $$('#enquiry-spark i').forEach(b => b.style.height = Math.max(4, b.dataset.h * .72) + 'px');
      };
      if (reduceMotion) grow(); else { const io = new IntersectionObserver((en) => { if (en[0].isIntersecting) { grow(); io.disconnect(); } }, { threshold: .3 }); io.observe($('t-panels')); }
    }
  } catch (err) {
    tTrack.innerHTML = '<p class="empty">Testimonials are temporarily unavailable.</p>';
  }
}
function formatMonth(raw) { const d = new Date(raw); return isNaN(d) ? 'Client feedback' : d.toLocaleDateString('en-GB', { month: 'short', year: 'numeric' }); }
loadTestimonialsAndStats();

/* ---------- Contact / feedback ---------- */
const tabs = $$('#contact-tabs [role="tab"]');
function setContactTab(tab, focus) {
  tabs.forEach(b => { const on = b.dataset.tab === tab; b.setAttribute('aria-selected', String(on)); b.tabIndex = on ? 0 : -1; if (on && focus) b.focus(); });
  $('pane-contact').hidden = tab !== 'contact'; $('pane-feedback').hidden = tab !== 'feedback';
}
tabs.forEach(b => {
  b.addEventListener('click', () => setContactTab(b.dataset.tab));
  b.addEventListener('keydown', (e) => { if (e.key === 'ArrowRight' || e.key === 'ArrowLeft') { setContactTab(b.dataset.tab === 'contact' ? 'feedback' : 'contact', true); } });
});
document.addEventListener('click', (e) => {
  if (e.target.closest('.view-project')) { setContactTab('contact'); $('contact').scrollIntoView({ behavior: reduceMotion ? 'auto' : 'smooth' }); }
  const trig = e.target.closest('[data-contact-tab]');
  if (trig) { setContactTab(trig.dataset.contactTab); }   // the link's own #contact href handles smooth scroll
  const el = e.target.closest('[data-contact-tab], .view-project, #contact-form button[type="submit"]');
  if (el) trackEvent('click', el.dataset && el.dataset.contactTab ? 'contact-tab:' + el.dataset.contactTab : (el.matches('.view-project') ? 'view-project' : 'submit-contact'));
});

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
function fieldError(inputId, msg) {
  const input = $(inputId), wrap = input.closest('.field'), err = $(inputId + '-err');
  wrap.classList.toggle('invalid', !!msg);
  if (msg) input.setAttribute('aria-invalid', 'true'); else input.removeAttribute('aria-invalid');
  if (err) { err.textContent = msg || ''; input.setAttribute('aria-describedby', err.id); }
  return !msg;
}
function setStatus(el, kind, msg) {
  el.className = 'form-status' + (kind ? ' show ' + kind : '');
  el.innerHTML = kind ? ICON[kind === 'ok' ? 'ok' : 'bad'] + '<span></span>' : '';
  if (kind) el.lastChild.textContent = msg;
}
function setLoading(btn, loading, label) {
  btn.disabled = loading;
  btn.setAttribute('aria-busy', String(loading));
  btn.querySelector('.label').textContent = loading ? 'Sending…' : label;
  const sp = btn.querySelector('.spinner');
  if (loading && !sp) btn.insertAdjacentHTML('afterbegin', '<span class="spinner" aria-hidden="true"></span>');
  if (!loading && sp) sp.remove();
}
['c-name', 'c-email', 'c-message', 'f-name', 'f-feedback'].forEach(id => $(id).addEventListener('input', () => { if ($(id).closest('.field').classList.contains('invalid')) fieldError(id, ''); }));

$('contact-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const form = e.target, btn = form.querySelector('button[type="submit"]'), status = $('contact-status');
  const f = new FormData(form);
  setStatus(status, '');
  const name = String(f.get('name') || '').trim(), email = String(f.get('email') || '').trim(), message = String(f.get('message') || '').trim();
  const okName = fieldError('c-name', name ? '' : 'Enter your name.');
  const okEmail = fieldError('c-email', EMAIL_RE.test(email) ? '' : 'Enter a valid email address, like you@example.com.');
  const okMsg = fieldError('c-message', message.length >= 10 ? '' : 'Add a few more details (at least 10 characters).');
  if (!(okName && okEmail && okMsg)) { const bad = form.querySelector('.invalid input, .invalid textarea'); if (bad) bad.focus(); return; }
  if (f.get('website')) return; // honeypot tripped
  setLoading(btn, true, 'Send message');
  try {
    const r = await apiCall('contact', { name, email, subject: f.get('subject'), message, website: f.get('website'), anonId: getAnonId(), loadedAt: _pageEnteredAt });
    if (r.ok) { setStatus(status, 'ok', "Message sent. Thanks! I'll get back to you soon."); toast('Message sent'); form.reset(); }
    else setStatus(status, 'bad', (r.error || 'Something went wrong.') + ' Please try again');
  } catch (err) {
    setStatus(status, 'bad', "Couldn't reach the server. Check your connection and try again.");
  } finally { setLoading(btn, false, 'Send message'); }
});

let rating = 0;
(function buildStars() {
  const host = $('star-rating').querySelector('.stars-input');
  host.innerHTML = [1, 2, 3, 4, 5].map(n => `<button type="button" role="radio" aria-checked="false" aria-label="${n} star${n > 1 ? 's' : ''}" data-star="${n}">${ICON.star}</button>`).join('');
  const btns = $$('button', host);
  const paint = () => btns.forEach(b => { const n = Number(b.dataset.star); b.classList.toggle('on', n <= rating); b.setAttribute('aria-checked', String(n === rating)); b.tabIndex = (rating ? n === rating : n === 1) ? 0 : -1; });
  btns.forEach(b => {
    b.addEventListener('click', () => { rating = Number(b.dataset.star); $('f-rating-err').textContent = ''; $('star-rating').closest('.field').classList.remove('invalid'); paint(); });
    b.addEventListener('keydown', (e) => {
      if (e.key === 'ArrowRight' || e.key === 'ArrowUp') { e.preventDefault(); rating = Math.min(5, (rating || 0) + 1); paint(); btns[rating - 1].focus(); }
      if (e.key === 'ArrowLeft' || e.key === 'ArrowDown') { e.preventDefault(); rating = Math.max(1, (rating || 2) - 1); paint(); btns[rating - 1].focus(); }
    });
  });
  paint();
  window.__resetStars = () => { rating = 0; paint(); };
})();

$('feedback-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const form = e.target, btn = form.querySelector('button[type="submit"]'), status = $('feedback-status');
  const f = new FormData(form);
  setStatus(status, '');
  const name = String(f.get('name') || '').trim(), feedback = String(f.get('feedback') || '').trim();
  const okR = !!rating; $('star-rating').closest('.field').classList.toggle('invalid', !okR); $('f-rating-err').textContent = okR ? '' : 'Choose a star rating.';
  const okN = fieldError('f-name', name ? '' : 'Enter your name.');
  const okF = fieldError('f-feedback', feedback ? '' : 'Write a few words of feedback.');
  if (!(okR && okN && okF)) return;
  if (f.get('website')) return; // honeypot tripped
  setLoading(btn, true, 'Submit feedback');
  try {
    const r = await apiCall('feedback', { name, feedback, rating, website: f.get('website'), anonId: getAnonId(), loadedAt: _pageEnteredAt });
    if (r.ok) {
      setStatus(status, 'ok', `Thanks for the ${rating}-star feedback! It now appears in Kind words.`); toast('Feedback sent');
      form.reset(); window.__resetStars();
      loadTestimonialsAndStats(); // reflect the new review immediately
    } else setStatus(status, 'bad', (r.error || 'Something went wrong.') + ' Please try again.');
  } catch (err) {
    setStatus(status, 'bad', "Couldn't reach the server. Check your connection and try again.");
  } finally { setLoading(btn, false, 'Submit feedback'); }
});

$('year').textContent = new Date().getFullYear();
})();
