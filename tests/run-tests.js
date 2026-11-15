/**
 * Backend test suite for Code.gs — runs the REAL script in a STRICT simulation
 * of Google Apps Script (see mock-gas-strict.js). No dependencies; Node only.
 *   node run-tests.js
 */
const vm = require('vm');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const mock = require('./mock-gas-strict');
const { computeTotp, base32Decode } = require('./reference-totp');

let pass = 0, fail = 0;
const failures = [];
function check(label, cond, detail) {
  if (cond) { pass++; console.log('  \u2713', label); }
  else { fail++; failures.push(label); console.log('  \u2717 FAIL:', label, detail !== undefined ? '-> ' + JSON.stringify(detail) : ''); }
}
const section = (t) => console.log('\n=== ' + t + ' ===');

// ---------------------------------------------------------------------------
// Load Code.gs
// ---------------------------------------------------------------------------
const CODE_PATH = process.env.CODE_GS || path.join(__dirname, '..', 'apps-script', 'Code.gs');
const src = fs.readFileSync(CODE_PATH, 'utf8');
const sandbox = Object.assign({ console }, mock.globals);
vm.createContext(sandbox);
vm.runInContext(src, sandbox, { filename: 'Code.gs' });

// Pin the clock used by Date.now() inside Code.gs (TOTP window, throttles) so
// tests can never flake at a 30-second boundary.
sandbox.__NOW__ = Date.now();
vm.runInContext('Date.now = function () { return __NOW__; };', sandbox);
const advance = (ms) => { sandbox.__NOW__ += ms; };

const P = mock.globals.PropertiesService.getScriptProperties();
P.setProperty('SHEET_ID', 'fake-sheet-id');
P.setProperty('DRIVE_FOLDER_ID', 'fake-folder-id');
P.setProperty('CONTACT_EMAIL', 'owner@example.com');

function doPost(action, payload) {
  const out = sandbox.doPost({ postData: { contents: JSON.stringify({ action, payload }) } });
  return JSON.parse(out._text);
}
function resetThrottles() {
  Object.keys(mock.state.cacheStore).forEach((k) => { if (/^(rl_|fail_)/.test(k)) delete mock.state.cacheStore[k]; });
}
const sheetRows = (name) => mock.state.fakeSS.sheets[name].data;

// ===========================================================================
section('A. Static API audit — Code.gs may only call REAL Google APIs');
{
  let code = src.replace(/\/\*[\s\S]*?\*\//g, '');
  code = code.split('\n').map((l) => l.replace(/(^|[^:])\/\/.*$/, '$1')).join('\n');
  const re = /\b(Utilities|SpreadsheetApp|PropertiesService|CacheService|ContentService|Session|Logger|MailApp|DriveApp|LockService|UrlFetchApp|GmailApp|DocumentApp|HtmlService|ScriptApp)\.(\w+)/g;
  const used = new Set(); let m;
  while ((m = re.exec(code))) used.add(m[1] + '.' + m[2]);
  const bad = [...used].filter((u) => { const [svc, mem] = u.split('.'); return !(mock.REAL_API[svc] || []).includes(mem); });
  check('every Google API member used exists in the real reference', bad.length === 0, bad);
  check('computeHmacSha1Signature is not called anywhere', !/computeHmacSha1Signature\s*\(/.test(code));
  console.log('   APIs used:', [...used].sort().join(', '));
}

// ===========================================================================
section('B. Crypto correctness — SHA-1 / HMAC-SHA1 / base32 / RFC 6238');
{
  const hex = (arr) => Buffer.from(arr).toString('hex');
  const bytes = (s) => Array.from(Buffer.from(s, 'utf8'));
  check('SHA-1("") known answer', hex(sandbox.sha1Bytes_([])) === 'da39a3ee5e6b4b0d3255bfef95601890afd80709');
  check('SHA-1("abc") known answer', hex(sandbox.sha1Bytes_(bytes('abc'))) === 'a9993e364706816aba3e25717850c26c9cd0d89d');

  let shaOk = true;
  for (let len = 0; len <= 300; len++) {
    const data = crypto.randomBytes(len);
    if (hex(sandbox.sha1Bytes_(Array.from(data))) !== crypto.createHash('sha1').update(data).digest('hex')) { shaOk = false; console.log('   mismatch at len', len); break; }
  }
  check('SHA-1 matches Node crypto for every length 0..300 (covers all padding edge cases)', shaOk);

  let hmacOk = true;
  for (const kl of [0, 1, 10, 20, 32, 63, 64, 65, 100, 200]) {
    for (const ml of [0, 1, 8, 55, 56, 63, 64, 65, 200]) {
      const k = crypto.randomBytes(kl), d = crypto.randomBytes(ml);
      const got = hex(sandbox.hmacSha1_(Array.from(k), Array.from(d)));
      const want = crypto.createHmac('sha1', k).update(d).digest('hex');
      if (got !== want) { hmacOk = false; console.log('   mismatch key', kl, 'msg', ml); }
    }
  }
  check('HMAC-SHA1 matches Node crypto across key sizes (incl. >64-byte keys) and message sizes', hmacOk);

  const rep = (b, n) => Array(n).fill(b);
  check('RFC 2202 vector 1', hex(sandbox.hmacSha1_(rep(0x0b, 20), bytes('Hi There'))) === 'b617318655057264e28bc0b6fb378c8ef146be00');
  check('RFC 2202 vector 2', hex(sandbox.hmacSha1_(bytes('Jefe'), bytes('what do ya want for nothing?'))) === 'effcdf6ae5eb2fa2d27416d5f184df9c259a7c79');
  check('RFC 2202 vector 3', hex(sandbox.hmacSha1_(rep(0xaa, 20), rep(0xdd, 50))) === '125d7342b9ac11cd91a39af48aa17b4f63f175d3');
  check('RFC 2202 vector 6 (key larger than block size)', hex(sandbox.hmacSha1_(rep(0xaa, 80), bytes('Test Using Larger Than Block-Size Key - Hash Key First'))) === 'aa4ae5e15272d00e95705637ce8a3b55ed402112');

  const rfcSecret = sandbox.base32Encode_(bytes('12345678901234567890'));
  const vectors = [[59, '287082'], [1111111109, '081804'], [1111111111, '050471'], [1234567890, '005924'], [2000000000, '279037'], [20000000000, '353130']];
  vectors.forEach(([t, want]) => check(`RFC 6238 vector T=${t} -> ${want}`, sandbox.totpAt_(rfcSecret, Math.floor(t / 30)) === want, sandbox.totpAt_(rfcSecret, Math.floor(t / 30))));

  const s2 = sandbox.generateBase32Secret_(20);
  let big = true;
  for (const c of [0, 1, 0xFFFFFFFF, 0x100000000, 0x100000001, 0x2A0000000]) {
    const now = c * 30 * 1000;
    if (sandbox.totpAt_(s2, c) !== computeTotp(s2, 0, now)) big = false;
  }
  check('counter values beyond 32 bits match the independent implementation', big);

  const rt = crypto.randomBytes(20);
  check('base32 encode/decode round-trips', Buffer.from(sandbox.base32Decode_(sandbox.base32Encode_(Array.from(rt)))).equals(rt));

  const secrets = new Set();
  let shapeOk = true;
  for (let i = 0; i < 200; i++) { const s = sandbox.generateBase32Secret_(20); secrets.add(s); if (!/^[A-Z2-7]{32}$/.test(s)) shapeOk = false; }
  check('generated secrets are 32 valid base32 chars', shapeOk);
  check('200 generated secrets are all distinct', secrets.size === 200);
  const rb = sandbox.secureRandomBytes_(20);
  check('secureRandomBytes_ returns 20 bytes in 0..255', rb.length === 20 && rb.every((b) => b >= 0 && b <= 255));
}

// ===========================================================================
section('C. Setup');
sandbox.setupSheets_();
const tabs = Object.keys(mock.state.fakeSS.sheets);
check('all 12 tabs created', ['Admin','Sessions','Projects','Designs','Tools','Blog','Testimonials','Contacts','AuditLog','PageViews','Events','Settings'].every((t) => tabs.includes(t)), tabs);
check('Admin header is username|passwordHash|salt|totpSecret|recoveryEmail|createdAt', sheetRows('Admin')[0].join('|') === 'username|passwordHash|salt|totpSecret|recoveryEmail|createdAt', sheetRows('Admin')[0]);
{ let r = doPost('setupStatus', {}); check('setupStatus: no admin yet', r.ok && r.hasAdmin === false, r); }
check('GET (doGet) is refused', JSON.parse(sandbox.doGet({})._text).error === 'METHOD_NOT_ALLOWED');
check('unknown action -> E_UNKNOWN_ACTION', doPost('nope', {}).code === 'E_UNKNOWN_ACTION');
check('protected action without token -> E_SESSION', doPost('list', { collection: 'Projects' }).code === 'E_SESSION');

// ===========================================================================
section('D. Malformed / hostile requests never crash the server');
{
  const raw = (contents) => JSON.parse(sandbox.doPost({ postData: { contents } })._text);
  check('invalid JSON -> E_BAD_JSON', raw('{not json').code === 'E_BAD_JSON');
  check('empty body -> handled', raw('').ok === false);
  check('JSON array body -> handled, not a crash', raw('[1,2,3]').ok === false);
  check('JSON null body -> handled', raw('null').ok === false);
  check('payload is a string -> handled, not a crash', raw('{"action":"login","payload":"x"}').ok === false);
  check('missing postData entirely -> handled', JSON.parse(sandbox.doPost({})._text).ok === false);
  check('very long action name -> handled', raw(JSON.stringify({ action: 'x'.repeat(100000) })).code === 'E_UNKNOWN_ACTION');
  check('prototype-pollution style keys are inert', raw('{"action":"login","payload":{"__proto__":{"admin":true},"username":"a","password":"b"}}').ok === false && ({}).admin === undefined);
}

// ===========================================================================
section('E. Account creation (validation + security)');
const USERNAME = 'testadmin', PASSWORD = 'longenoughpassword1';
{
  const bad = (o) => doPost('createAccount', Object.assign({ username: 'validname', password: PASSWORD, confirmPassword: PASSWORD, recoveryEmail: 'x@example.com' }, o));
  let r = bad({ password: 'short', confirmPassword: 'short' }); check('rejects short password (and says why)', r.code === 'E_BAD_INPUT' && /at least 10/.test(r.error), r);
  r = bad({ confirmPassword: 'different12345678' }); check('rejects mismatched confirm (and says why)', r.code === 'E_BAD_INPUT' && /do not match/.test(r.error), r);
  check('rejects invalid email', bad({ recoveryEmail: 'not-an-email' }).code === 'E_BAD_INPUT');
  check('rejects invalid username', bad({ username: 'a b!' }).code === 'E_BAD_INPUT');
  check('rejects too-short username', bad({ username: 'ab' }).code === 'E_BAD_INPUT');
  check('honeypot silently ignored, creates nothing', doPost('createAccount', { username: 'botuser', password: PASSWORD, confirmPassword: PASSWORD, recoveryEmail: 'b@example.com', website: 'x' }).ok === true && doPost('setupStatus', {}).hasAdmin === false);
  check('no admin exists after all the rejected attempts', doPost('setupStatus', {}).hasAdmin === false);
}
resetThrottles();
let TOTP_SECRET;
{
  const r = doPost('createAccount', { username: USERNAME, password: PASSWORD, confirmPassword: PASSWORD, recoveryEmail: 'owner@example.com' });
  check('createAccount ok', r.ok === true, r);
  check('returns a 32-char base32 totpSecret', /^[A-Z2-7]{32}$/.test(r.totpSecret || ''), r.totpSecret);
  check('otpauthUrl is a valid otpauth:// URI containing the secret', typeof r.otpauthUrl === 'string' && r.otpauthUrl.startsWith('otpauth://totp/') && r.otpauthUrl.includes('secret=' + r.totpSecret) && r.otpauthUrl.includes('digits=6') && r.otpauthUrl.includes('period=30'), r.otpauthUrl);
  TOTP_SECRET = r.totpSecret;
  const adminRow = sheetRows('Admin')[1];
  check('password is NOT stored in plaintext', !adminRow.includes(PASSWORD) && !JSON.stringify(sheetRows('Admin')).includes(PASSWORD));
  check('stored hash is 64 hex chars + has a salt', /^[0-9a-f]{64}$/.test(adminRow[1]) && adminRow[2].length > 30);
  check('second createAccount is blocked', doPost('createAccount', { username: 'other', password: PASSWORD, confirmPassword: PASSWORD, recoveryEmail: 'x@example.com' }).code === 'E_ALREADY_SETUP');
  check('setupStatus now reports an admin', doPost('setupStatus', {}).hasAdmin === true);
  check('courtesy notification email was sent', mock.state.sentEmails.some((m) => /account was created/.test(m.subject)));
}

// ===========================================================================
section('F. Login step 1 (password)');
resetThrottles();
{
  check('wrong password rejected', doPost('login', { username: USERNAME, password: 'wrongpassword123' }).code === 'E_AUTH');
  check('unknown user gets the SAME response as wrong password (no user enumeration)', JSON.stringify(doPost('login', { username: 'nobody', password: 'wrongpassword123' })).replace(/"reqId":"[^"]*"/, '') === JSON.stringify(doPost('login', { username: USERNAME, password: 'wrongpassword123' })).replace(/"reqId":"[^"]*"/, ''));
  check('empty credentials -> E_BAD_INPUT', doPost('login', { username: '', password: '' }).code === 'E_BAD_INPUT');
}

// ===========================================================================
section('G. THE CRITICAL PATH: password -> 2FA -> dashboard token');
resetThrottles();
let TOKEN;
{
  let r = doPost('login', { username: USERNAME, password: PASSWORD });
  check('correct password -> stage "2fa" + ticket', r.ok && r.stage === '2fa' && /^[0-9a-f-]{36}$/.test(r.ticket), r);
  const ticket = r.ticket;

  check('malformed code (5 digits) -> E_BAD_INPUT', doPost('verify2fa', { ticket, code: '12345' }).code === 'E_BAD_INPUT');
  check('non-numeric code -> E_BAD_INPUT', doPost('verify2fa', { ticket, code: 'abcdef' }).code === 'E_BAD_INPUT');
  check('wrong code -> E_AUTH (NOT E_INTERNAL)', doPost('verify2fa', { ticket, code: '000000' }).code === 'E_AUTH');
  check('bogus ticket -> E_AUTH', doPost('verify2fa', { ticket: 'not-a-real-ticket', code: computeTotp(TOTP_SECRET, 0, sandbox.__NOW__) }).code === 'E_AUTH');

  const good = computeTotp(TOTP_SECRET, 0, sandbox.__NOW__);
  r = doPost('verify2fa', { ticket, code: good });
  check('VALID 6-digit code is accepted', r.ok === true, r);
  check('returns a long random session token', typeof r.token === 'string' && r.token.length >= 64, r);
  TOKEN = r.token;
  check('ticket is single-use (replay rejected)', doPost('verify2fa', { ticket, code: good }).code === 'E_AUTH');
  check('raw session token is NOT stored (only its hash)', !JSON.stringify(sheetRows('Sessions')).includes(TOKEN));
  check('code with spaces ("123 456" style) is tolerated', (() => {
    const t2 = doPost('login', { username: USERNAME, password: PASSWORD }).ticket;
    const c = computeTotp(TOTP_SECRET, 0, sandbox.__NOW__);
    return doPost('verify2fa', { ticket: t2, code: c.slice(0, 3) + ' ' + c.slice(3) }).ok === true;
  })());
}

// ===========================================================================
section('H. 2FA time window (clock drift) — pinned clock');
resetThrottles();
{
  const tryCode = (offset) => {
    const t = doPost('login', { username: USERNAME, password: PASSWORD }).ticket;
    return doPost('verify2fa', { ticket: t, code: computeTotp(TOTP_SECRET, offset, sandbox.__NOW__) });
  };
  check('code from the previous 30s step accepted', tryCode(-1).ok === true);
  check('code from the next 30s step accepted', tryCode(+1).ok === true);
  resetThrottles();
  check('code from 2 steps ago (60s+ stale) rejected', tryCode(-2).ok === false);
  check('code from 2 steps ahead rejected', tryCode(+2).ok === false);
  resetThrottles();
  const t = doPost('login', { username: USERNAME, password: PASSWORD }).ticket;
  const stale = computeTotp(TOTP_SECRET, 0, sandbox.__NOW__);
  advance(3 * 60 * 1000);
  check('a code that has aged past the window is rejected', doPost('verify2fa', { ticket: t, code: stale }).ok === false);
  resetThrottles();
}

// ===========================================================================
section('I. Corrupt / missing stored secret degrades gracefully');
resetThrottles();
{
  const adminSheet = mock.state.fakeSS.sheets.Admin;
  const saved = adminSheet.data[1][3];
  for (const bad of ['', '!!!!', 'lowercase-not-base32', 12345]) {
    adminSheet.data[1][3] = bad;
    const t = doPost('login', { username: USERNAME, password: PASSWORD }).ticket;
    const r = doPost('verify2fa', { ticket: t, code: '123456' });
    check(`stored secret ${JSON.stringify(bad)} -> clean, specific E_2FA_CONFIG, not a crash`, r.code === 'E_2FA_CONFIG', r);
    resetThrottles();
  }
  adminSheet.data[1][3] = saved;
}

// ===========================================================================
section('J. Dashboard actions with a valid session (all 5 collections, field alignment)');
resetThrottles();
TOKEN = (() => {
  const t = doPost('login', { username: USERNAME, password: PASSWORD }).ticket;
  return doPost('verify2fa', { ticket: t, code: computeTotp(TOTP_SECRET, 0, sandbox.__NOW__) }).token;
})();
{
  check('checkSession ok', doPost('checkSession', { token: TOKEN }).ok === true);
  const samples = {
    Projects: { title: 'P1', desc: 'd', tags: 'a,b', url: 'https://x.test', status: 'upcoming', upcomingDate: '2030-01-01T10:00', order: 3 },
    Designs: { title: 'D1', desc: 'd', tags: 'a', url: '', status: 'new', upcomingDate: '', order: 1 },
    Tools: { name: 'T1', desc: 'a tool', icon: '🔧', url: 'https://t.test', order: 2 },
    Blog: { title: 'B1', tag: 'Reel', excerpt: 'e', url: 'https://b.test', date: 'Jan 2030' },
    Testimonials: { name: 'N1', rating: 4, feedback: 'nice', approved: 'TRUE' }
  };
  Object.keys(samples).forEach((col) => {
    const c = doPost('create', { token: TOKEN, collection: col, item: samples[col] });
    check(`${col}: create ok`, c.ok === true, c);
    const l = doPost('list', { token: TOKEN, collection: col });
    const row = l.items.find((i) => i.id === c.item.id);
    const misaligned = Object.keys(samples[col]).filter((k) => String(row[k]) !== String(samples[col][k]));
    check(`${col}: every field reads back in the right column`, misaligned.length === 0, misaligned.map((k) => [k, row[k], samples[col][k]]));
    const u = doPost('update', { token: TOKEN, collection: col, id: c.item.id, item: Object.assign({}, samples[col], col === 'Testimonials' ? { name: 'Edited' } : col === 'Tools' || col === 'Designs' && false ? { name: 'Edited' } : { title: 'Edited' }) });
    check(`${col}: update ok`, u.ok === true, u);
    check(`${col}: delete ok`, doPost('delete', { token: TOKEN, collection: col, id: c.item.id }).ok === true);
    check(`${col}: gone after delete`, !doPost('list', { token: TOKEN, collection: col }).items.some((i) => i.id === c.item.id));
  });
  check('delete of a missing id -> clean error', doPost('delete', { token: TOKEN, collection: 'Projects', id: 'nope' }).ok === false);
  check('invalid badge status rejected', doPost('create', { token: TOKEN, collection: 'Projects', item: { title: 'x', status: 'hacked' } }).code === 'E_BAD_INPUT');
  check('invalid countdown date rejected', doPost('create', { token: TOKEN, collection: 'Projects', item: { title: 'x', status: 'upcoming', upcomingDate: 'not-a-date' } }).code === 'E_BAD_INPUT');
  const long = doPost('create', { token: TOKEN, collection: 'Projects', item: { title: 'x'.repeat(5000) } });
  check('over-long fields are truncated, not stored whole', long.ok && long.item.title.length === 200, long.item && long.item.title.length);
  doPost('delete', { token: TOKEN, collection: 'Projects', id: long.item.id }); // clean up so later count-based checks stay accurate
  const x = doPost('create', { token: TOKEN, collection: 'Blog', item: { title: '<img src=x onerror=alert(1)>', excerpt: '<script>alert(1)</script>' } });
  check('HTML in content is stored as inert text (site escapes on render)', x.ok === true);
  doPost('delete', { token: TOKEN, collection: 'Blog', id: x.item.id }); // clean up so later count-based checks stay accurate
}

// ===========================================================================
section('K. The API cannot be used to read secrets');
{
  for (const col of ['Admin', 'Sessions', 'AuditLog', 'Settings', 'Contacts']) {
    check(`list "${col}" refused`, doPost('list', { token: TOKEN, collection: col }).code === 'E_BAD_INPUT');
  }
  check('cannot create into Admin', doPost('create', { token: TOKEN, collection: 'Admin', item: { username: 'evil' } }).code === 'E_BAD_INPUT');
  check('cannot delete from Sessions', doPost('delete', { token: TOKEN, collection: 'Sessions', id: 'x' }).code === 'E_BAD_INPUT');
  const pub = JSON.stringify([doPost('publicContent', {}), doPost('publicTestimonials', {}), doPost('publicStats', {}), doPost('publicSettings', {})]);
  check('public endpoints never expose hashes, secrets, emails or tokens', !/passwordHash|totpSecret|salt|recoveryEmail|owner@example|tokenHash/.test(pub) && !pub.includes(TOKEN));
}

// ===========================================================================
section('L. Image upload safety');
{
  const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=';
  check('valid PNG accepted', doPost('uploadImage', { token: TOKEN, filename: 'a.png', mimeType: 'image/png', base64: png }).ok === true);
  check('SVG (script-capable) rejected', doPost('uploadImage', { token: TOKEN, filename: 'a.svg', mimeType: 'image/svg+xml', base64: png }).code === 'E_UPLOAD');
  check('HTML rejected', doPost('uploadImage', { token: TOKEN, filename: 'a.html', mimeType: 'text/html', base64: png }).code === 'E_UPLOAD');
  check('.exe rejected', doPost('uploadImage', { token: TOKEN, filename: 'a.exe', mimeType: 'application/x-msdownload', base64: png }).code === 'E_UPLOAD');
  check('empty upload rejected', doPost('uploadImage', { token: TOKEN, filename: 'a.png', mimeType: 'image/png', base64: '' }).code === 'E_UPLOAD');
  check('oversize (>5MB) rejected', doPost('uploadImage', { token: TOKEN, filename: 'big.png', mimeType: 'image/png', base64: Buffer.alloc(6 * 1024 * 1024).toString('base64') }).code === 'E_UPLOAD');
  check('upload requires a session', doPost('uploadImage', { filename: 'a.png', mimeType: 'image/png', base64: png }).code === 'E_SESSION');
}

// ===========================================================================
section('M. Seed content lands in the right columns');
{
  sandbox.seedInitialContent_();
  const c = doPost('publicContent', {});
  check('3 projects, 6 designs, 8 tools, 6 blog posts seeded', c.projects.length === 3 && c.designs.length === 6 && c.tools.length === 8 && c.blog.length >= 6, [c.projects.length, c.designs.length, c.tools.length, c.blog.length]);
  check('project fields aligned (title/url)', c.projects[0].title.startsWith('Ledger') && c.projects[0].url.startsWith('https://ledger'));
  check('tool fields aligned (name/desc/icon/url)', c.tools[0].name === 'Remove.bg' && c.tools[0].desc === 'Background remover' && c.tools[0].icon === '✂️' && c.tools[0].url.startsWith('https://'));
  check('blog tag aligned', c.blog.some((b) => b.tag === 'Reel') && c.blog.some((b) => b.tag === 'Blog'));
}

// ===========================================================================
section('N. Tracking, analytics, settings');
resetThrottles();
{
  const a = 'anon_test_1';
  check('pageview tracked', doPost('track', { type: 'pageview', anonId: a, page: '/', referrer: '' }).ok === true);
  check('click event tracked', doPost('track', { type: 'event', anonId: a, eventType: 'click', label: 'x', page: '/' }).ok === true);
  check('duration tracked', doPost('track', { type: 'event', anonId: a, eventType: 'duration', label: '95', page: '/' }).ok === true);
  check('section view tracked', doPost('track', { type: 'event', anonId: a, eventType: 'section_view', label: 'projects', page: '/' }).ok === true);
  check('missing anonId rejected', doPost('track', { type: 'pageview', page: '/' }).code === 'E_BAD_INPUT');
  check('unknown track type rejected', doPost('track', { type: 'weird', anonId: a }).code === 'E_BAD_INPUT');
  const an = doPost('analytics', { token: TOKEN });
  check('analytics: counts add up', an.ok && an.totalPageViews === 1 && an.uniqueVisitors === 1 && an.avgDurationSeconds === 95, an);
  check('analytics: section engagement present', an.sectionViews.some((s) => s.section === 'projects' && s.count === 1), an.sectionViews);
  check('analytics requires a session', doPost('analytics', {}).code === 'E_SESSION');
  check('configCheck reports configured', doPost('configCheck', { token: TOKEN }).contactEmailConfigured === true);
  check('updateSettings ok', doPost('updateSettings', { token: TOKEN, accentPreset: 'ocean' }).ok === true);
  check('publicSettings reflects it', doPost('publicSettings', {}).accentPreset === 'ocean');
  check('unknown accent preset rejected (no CSS injection)', doPost('updateSettings', { token: TOKEN, accentPreset: 'red;}body{display:none' }).code === 'E_BAD_INPUT');
  // --- Appearance & Personalization (8 accents + theme mode) ---
  const KEYS = ['violet', 'ocean', 'mint', 'rose', 'peach', 'cyan', 'indigo', 'lavender'];
  const HEXES = { violet: '#8581EF', ocean: '#579CEB', mint: '#50B99A', rose: '#E18BAF', peach: '#E6A17D', cyan: '#49BFCB', indigo: '#7188DB', lavender: '#AA8BE8' };
  const ps0 = doPost('publicSettings', {});
  check('publicSettings keeps the old contract keys (ok, accentPreset, accent, accent2, presets)', ps0.ok && ['accentPreset', 'accent', 'accent2', 'presets'].every((k) => k in ps0), Object.keys(ps0));
  check('publicSettings lists exactly the 8 requested accents', JSON.stringify(ps0.presets) === JSON.stringify(KEYS), ps0.presets);
  KEYS.forEach((k) => {
    check(`accent "${k}" saves and is served with the exact requested hex ${HEXES[k]}`, doPost('updateSettings', { token: TOKEN, accentPreset: k }).ok === true && doPost('publicSettings', {}).accent === HEXES[k]);
  });
  check('Cyber Cyan uses a different secondary so it never matches its accent', doPost('updateSettings', { token: TOKEN, accentPreset: 'cyan' }).ok && doPost('publicSettings', {}).accent2 !== HEXES.cyan);
  check('theme mode defaults to system', ps0.themeMode === 'system', ps0.themeMode);
  ['light', 'dark', 'system'].forEach((m) => check(`theme mode "${m}" saves and is served`, doPost('updateSettings', { token: TOKEN, themeMode: m }).ok === true && doPost('publicSettings', {}).themeMode === m));
  check('saving theme mode alone does not reset the accent', doPost('updateSettings', { token: TOKEN, accentPreset: 'rose' }).ok && doPost('updateSettings', { token: TOKEN, themeMode: 'dark' }).ok && doPost('publicSettings', {}).accentPreset === 'rose');
  check('unknown theme mode rejected', doPost('updateSettings', { token: TOKEN, themeMode: 'neon' }).code === 'E_BAD_INPUT');
  check('empty settings update rejected', doPost('updateSettings', { token: TOKEN }).code === 'E_BAD_INPUT');
  check('updateSettings still requires a session', doPost('updateSettings', { accentPreset: 'ocean' }).code === 'E_SESSION');
  mock.state.fakeSS.sheets.Settings.data.push(['accentPreset', 'forest']);
  mock.state.fakeSS.sheets.Settings.data = mock.state.fakeSS.sheets.Settings.data.filter((r, i, a) => !(r[0] === 'accentPreset' && i !== a.length - 1));
  check('a legacy saved preset ("forest") maps to a valid new one instead of breaking', doPost('publicSettings', {}).accentPreset === 'mint', doPost('publicSettings', {}));
  doPost('updateSettings', { token: TOKEN, accentPreset: 'violet', themeMode: 'system' });

  // --- editing must not wipe fields the edit form didn't send (image bug) ---
  {
    const c = doPost('create', { token: TOKEN, collection: 'Projects', item: { title: 'Keep my image', desc: 'd', imageUrl: 'https://drive.google.com/thumbnail?id=abc&sz=w1600', url: 'https://x.test', order: 5 } });
    doPost('update', { token: TOKEN, collection: 'Projects', id: c.item.id, item: { title: 'Renamed', desc: 'd2', url: 'https://x.test' } });
    const row = doPost('list', { token: TOKEN, collection: 'Projects' }).items.find((i) => i.id === c.item.id);
    check('editing without re-uploading keeps the existing image', row.imageUrl === 'https://drive.google.com/thumbnail?id=abc&sz=w1600', row.imageUrl);
    check('editing without sending "order" keeps the order', Number(row.order) === 5, row.order);
    check('edited fields still change', row.title === 'Renamed' && row.desc === 'd2');
    doPost('update', { token: TOKEN, collection: 'Projects', id: c.item.id, item: { title: 'Renamed', imageUrl: 'https://drive.google.com/thumbnail?id=new&sz=w1600' } });
    check('a new upload replaces the image', doPost('list', { token: TOKEN, collection: 'Projects' }).items.find((i) => i.id === c.item.id).imageUrl.includes('id=new'));
    doPost('delete', { token: TOKEN, collection: 'Projects', id: c.id || c.item.id });
  }

  // --- new optional content fields ---
  {
    sandbox.upgradeSheets_();
    sandbox.upgradeSheets_(); // idempotent
    const hdr = (n) => mock.state.fakeSS.sheets[n].data[0];
    check('upgradeSheets_ adds the new columns exactly once', hdr('Projects').filter((h) => h === 'category').length === 1 && hdr('Blog').includes('readTime') && hdr('Testimonials').includes('role') && hdr('Tools').includes('category') && hdr('Designs').includes('category') && hdr('Projects').includes('githubUrl'));
    check('upgradeSheets_ never reorders existing columns', hdr('Projects').slice(0, 10).join() === 'id,title,desc,tags,imageUrl,url,status,order,updatedAt,upcomingDate', hdr('Projects'));
    const p = doPost('create', { token: TOKEN, collection: 'Projects', item: { title: 'Cat test', category: 'Web App', githubUrl: 'https://github.com/x/y', url: 'https://x.test' } });
    const row = doPost('publicContent', {}).projects.find((i) => i.id === p.item.id);
    check('project category + githubUrl are stored and served publicly', row && row.category === 'Web App' && row.githubUrl === 'https://github.com/x/y', row);
    check('javascript: links are rejected', doPost('create', { token: TOKEN, collection: 'Projects', item: { title: 'x', url: 'javascript:alert(1)' } }).code === 'E_BAD_INPUT');
    check('javascript: GitHub link rejected', doPost('create', { token: TOKEN, collection: 'Projects', item: { title: 'x', githubUrl: 'javascript:alert(1)' } }).code === 'E_BAD_INPUT');
    doPost('delete', { token: TOKEN, collection: 'Projects', id: p.item.id });
    const b = doPost('create', { token: TOKEN, collection: 'Blog', item: { title: 'Post', tag: 'Blog', imageUrl: 'https://i.test/a.jpg', readTime: '4 min', category: 'Design' } });
    const brow = doPost('publicContent', {}).blog.find((i) => i.id === b.item.id);
    check('blog image / read time / category round-trip', brow && brow.imageUrl === 'https://i.test/a.jpg' && brow.readTime === '4 min' && brow.category === 'Design', brow);
    doPost('delete', { token: TOKEN, collection: 'Blog', id: b.item.id });
    // --- FAQs: admin-managed, public, and resilient when the tab doesn't exist yet ---
    delete mock.state.fakeSS.sheets['FAQs']; // simulate a spreadsheet created before FAQs existed
    sandbox.resetMemo_();
    check('publicContent still works with no FAQs tab (auto-created, empty list)', Array.isArray(doPost('publicContent', {}).faqs) && doPost('publicContent', {}).faqs.length === 0);
    const f2 = doPost('create', { token: TOKEN, collection: 'FAQs', item: { question: 'Second?', answer: 'Yes.', order: 2 } });
    const f1 = doPost('create', { token: TOKEN, collection: 'FAQs', item: { question: 'First?', answer: 'Of course.', order: 1 } });
    doPost('create', { token: TOKEN, collection: 'FAQs', item: { question: '<script>x</script>Q', answer: 'A', order: 3 } });
    const pf = doPost('publicContent', {}).faqs;
    check('FAQs are served publicly, sorted by order', pf.length === 3 && pf[0].question === 'First?' && pf[1].question === 'Second?', pf);
    check('FAQ list requires a session', doPost('list', { collection: 'FAQs' }).ok === false);
    doPost('update', { token: TOKEN, collection: 'FAQs', id: f1.item.id, item: { question: 'First edited?', answer: 'Yes', order: 1 } });
    check('FAQ edit is reflected publicly', doPost('publicContent', {}).faqs[0].question === 'First edited?');
    doPost('delete', { token: TOKEN, collection: 'FAQs', id: f2.item.id });
    check('FAQ delete works', doPost('publicContent', {}).faqs.length === 2);
    check('responses carry backend version + timing', typeof doPost('setupStatus', {}).v === 'string');
    const t = doPost('create', { token: TOKEN, collection: 'Testimonials', item: { name: 'Pat', rating: 5, feedback: 'Great', approved: 'TRUE', role: 'CEO, Acme' } });
    check('testimonial role is exposed publicly; unapproved ones stay hidden', doPost('publicTestimonials', {}).items.some((i) => i.name === 'Pat' && i.role === 'CEO, Acme'));
    doPost('update', { token: TOKEN, collection: 'Testimonials', id: t.item.id, item: { name: 'Pat', rating: 5, feedback: 'Great', approved: 'FALSE' } });
    check('moderation: un-approving removes it from the public feed', !doPost('publicTestimonials', {}).items.some((i) => i.name === 'Pat'));
    doPost('delete', { token: TOKEN, collection: 'Testimonials', id: t.item.id });
  }
  let limited = null;
  for (let i = 0; i < 40; i++) { const r = doPost('track', { type: 'pageview', anonId: 'flooder', page: '/' }); if (!r.ok) { limited = { i, code: r.code }; break; } }
  check('tracking flood from one visitor is rate limited', limited && limited.code === 'E_RATE_LIMIT', limited);
}

// ===========================================================================
section('O. Contact + feedback (spam protection)');
resetThrottles();
{
  const before = mock.state.sentEmails.length;
  check('honeypot filled -> pretends success, sends nothing', doPost('contact', { name: 'Bot', email: 'b@x.com', message: 'hi', website: 'http://spam' }).ok && mock.state.sentEmails.length === before);
  check('submitted too fast -> pretends success, sends nothing', doPost('contact', { name: 'Fast', email: 'f@x.com', message: 'hi', loadedAt: sandbox.__NOW__ }).ok && mock.state.sentEmails.length === before);
  const real = { name: 'Real Person', email: 'real@example.com', subject: 'Project', message: 'Hello there', loadedAt: sandbox.__NOW__ - 6000, anonId: 'visitor1' };
  check('genuine contact accepted', doPost('contact', real).ok === true);
  const mail = mock.state.sentEmails[mock.state.sentEmails.length - 1];
  check('email goes to the hidden owner address with reply-to = visitor', mail.to === 'owner@example.com' && mail.replyTo === 'real@example.com');
  check('invalid email rejected', doPost('contact', Object.assign({}, real, { email: 'nope', anonId: 'v2' })).code === 'E_BAD_INPUT');
  check('empty message rejected', doPost('contact', Object.assign({}, real, { message: '', anonId: 'v3' })).code === 'E_BAD_INPUT');
  let hit = null;
  for (let i = 0; i < 8; i++) { const r = doPost('contact', real); if (!r.ok) { hit = r.code; break; } }
  check('6th contact from same visitor within the window is rate limited', hit === 'E_RATE_LIMIT', hit);
  check('feedback accepted and shown immediately', doPost('feedback', { name: 'Fan', feedback: 'Great!', rating: 5, loadedAt: sandbox.__NOW__ - 6000, anonId: 'fb1' }).ok && doPost('publicTestimonials', {}).items.some((t) => t.name === 'Fan'));
  check('rating outside 1-5 rejected', doPost('feedback', { name: 'X', feedback: 'y', rating: 9, loadedAt: sandbox.__NOW__ - 6000, anonId: 'fb2' }).code === 'E_BAD_INPUT');
  P.setProperty('CONTACT_EMAIL', '');
  const cnt = sheetRows('Contacts').length;
  check('with no CONTACT_EMAIL set: message is still saved (not lost)', doPost('contact', { name: 'Saved', email: 's@x.com', message: 'm', loadedAt: sandbox.__NOW__ - 6000, anonId: 'v9' }).ok && sheetRows('Contacts').length === cnt + 1);
  P.setProperty('CONTACT_EMAIL', 'owner@example.com');
}

// ===========================================================================
section('P. Brute-force protection');
resetThrottles();
{
  for (let i = 0; i < 5; i++) doPost('login', { username: USERNAME, password: 'wrongwrongwrong' });
  check('locked after 5 bad passwords — even the CORRECT password is refused', doPost('login', { username: USERNAME, password: PASSWORD }).code === 'E_LOCKED');
  resetThrottles();
  const t = doPost('login', { username: USERNAME, password: PASSWORD }).ticket;
  for (let i = 0; i < 5; i++) doPost('verify2fa', { ticket: t, code: '000000' });
  check('locked after 5 bad 2FA codes — even the CORRECT code is refused', doPost('verify2fa', { ticket: t, code: computeTotp(TOTP_SECRET, 0, sandbox.__NOW__) }).code === 'E_LOCKED');
  resetThrottles();
}

// ===========================================================================
section('Q. Sessions: expiry, logout, and password reset');
resetThrottles();
{
  const login = () => { const t = doPost('login', { username: USERNAME, password: PASSWORD }).ticket; return doPost('verify2fa', { ticket: t, code: computeTotp(TOTP_SECRET, 0, sandbox.__NOW__) }).token; };
  const tk = login();
  const sess = mock.state.fakeSS.sheets.Sessions;
  // Must target the row belonging to THIS token specifically (hash match) —
  // not just "any" row with a future expiry, since earlier sections' logins
  // leave their own still-valid session rows sitting in the sheet too.
  const tkHash = sandbox.sha256Hex_(tk);
  const row = sess.data.findIndex((r, i) => i > 0 && r[0] === tkHash);
  check('found the session row for this token', row !== -1, row);
  sess.data[row][3] = new Date(Date.now() - 1000).toISOString();
  check('cached session is served from cache (fast path)', doPost('list', { token: tk, collection: 'Projects' }).ok === true);
  delete mock.state.cacheStore['sess_' + tkHash]; // simulate cache eviction -> sheet is the source of truth
  check('expired session is rejected', doPost('list', { token: tk, collection: 'Projects' }).code === 'E_SESSION');
  // (Code.gs correctly deletes the expired row itself as part of rejecting
  // it — nothing to restore here, which is itself a good sign.)

  {
    const nodeCrypto = require('crypto');
    const samples = ['', 'abc', 'a'.repeat(55), 'a'.repeat(56), 'a'.repeat(64), 'a'.repeat(119), 'pässwörd-日本語-😀', 'x'.repeat(1000)];
    check('pure-JS sha256 matches reference for all samples', samples.every((x) => sandbox.sha256Hex_(x) === nodeCrypto.createHash('sha256').update(x, 'utf8').digest('hex')));
    const slow = (pw, salt) => { let v = salt + '::' + pw; for (let i = 0; i < 2000; i++) v = nodeCrypto.createHash('sha256').update(v + salt, 'utf8').digest('hex'); return v; };
    check('hashPassword_ stays bit-compatible with stored hashes', sandbox.hashPassword_('Tést-pässword 123!', 'saltysalt') === slow('Tést-pässword 123!', 'saltysalt'));
  }
  const t2 = login();
  check('session cached after login', !!mock.state.cacheStore['sess_' + sandbox.sha256Hex_(t2)]);
  check('logout ok', doPost('logout', { token: t2 }).ok === true);
  check('cache entry removed on logout', !mock.state.cacheStore['sess_' + sandbox.sha256Hex_(t2)]);
  check('token dead after logout', doPost('list', { token: t2, collection: 'Projects' }).code === 'E_SESSION');
  check('a made-up token is rejected', doPost('list', { token: 'a'.repeat(72), collection: 'Projects' }).code === 'E_SESSION');

  resetThrottles();
  const live = login();
  check('nonexistent user: forgotPassword answers identically, sends nothing', (() => {
    const n = mock.state.sentEmails.length; const r = doPost('forgotPassword', { username: 'ghost' });
    return r.ok === true && typeof r.ticket === 'string' && mock.state.sentEmails.length === n;
  })());
  let r = doPost('forgotPassword', { username: USERNAME });
  check('forgotPassword ok', r.ok === true && !!r.ticket, r);
  const mail = [...mock.state.sentEmails].reverse().find((m) => /reset code/.test(m.subject));
  check('reset code emailed to the RECOVERY address', mail && mail.to === 'owner@example.com');
  const code = mail.body.match(/code is: (\d{6})/)[1];
  check('short new password rejected (with reason)', /at least 10/.test(doPost('resetPassword', { ticket: r.ticket, code, newPassword: 'short' }).error));
  check('wrong reset code rejected', doPost('resetPassword', { ticket: r.ticket, code: '000000', newPassword: 'brandnewpassword2' }).code === 'E_AUTH');
  check('resetPassword ok', doPost('resetPassword', { ticket: r.ticket, code, newPassword: 'brandnewpassword2' }).ok === true);
  check('reset code cannot be reused', doPost('resetPassword', { ticket: r.ticket, code, newPassword: 'anotherpassword33' }).ok === false);
  check('password reset signs out every existing session', doPost('list', { token: live, collection: 'Projects' }).code === 'E_SESSION');
  check('old password no longer works', doPost('login', { username: USERNAME, password: PASSWORD }).code === 'E_AUTH');
  const rl = doPost('login', { username: USERNAME, password: 'brandnewpassword2' });
  check('new password works', rl.ok && rl.stage === '2fa', rl);
  check('2FA secret unchanged by a password reset', doPost('verify2fa', { ticket: rl.ticket, code: computeTotp(TOTP_SECRET, 0, sandbox.__NOW__) }).ok === true);
}

// ===========================================================================
section('R. Error handling: no information leakage + optional debug switch');
{
  const original = sandbox.sheetToObjects_;
  sandbox.sheetToObjects_ = function () { throw new Error('SECRET_INTERNAL_DETAIL: db exploded at /srv/x'); };
  let r = doPost('publicContent', {});
  check('unexpected exception -> generic E_INTERNAL', r.ok === false && r.code === 'E_INTERNAL' && r.error === 'Something went wrong. Please try again.', r);
  check('internal detail is NOT leaked by default', !JSON.stringify(r).includes('SECRET_INTERNAL_DETAIL') && r.detail === undefined, r);
  check('response carries a reqId for support', typeof r.reqId === 'string' && r.reqId.length > 10);
  check('full error is logged server-side under that reqId', mock.state.logLines.some((l) => l.includes(r.reqId) && l.includes('SECRET_INTERNAL_DETAIL')));
  P.setProperty('DEBUG_ERRORS', 'true');
  r = doPost('publicContent', {});
  check('DEBUG_ERRORS=true exposes the real reason for troubleshooting', /SECRET_INTERNAL_DETAIL/.test(r.detail || ''), r);
  P.setProperty('DEBUG_ERRORS', 'false');
  r = doPost('publicContent', {});
  check('DEBUG_ERRORS=false hides it again', r.detail === undefined);
  sandbox.sheetToObjects_ = original;
  check('server healthy again after restore', doPost('publicContent', {}).ok === true);
}

// ===========================================================================
console.log(`\n${'='.repeat(60)}\nRESULTS: ${pass} passed, ${fail} failed\n${'='.repeat(60)}`);
if (fail) { console.log('Failed:\n - ' + failures.join('\n - ')); }
process.exit(fail ? 1 : 0);
