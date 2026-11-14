/**
 * ============================================================================
 *  Ainsley C. Portfolio — Admin Backend (Google Apps Script)
 * ============================================================================
 *  This single script is the entire backend for the admin dashboard:
 *    - Username + password + TOTP (Google-Authenticator style) 2FA login
 *    - Session tokens (stored hashed, short-lived, sliding expiry)
 *    - Rate limiting + account lockout (brute-force protection)
 *    - Generic CRUD over named "collections" (Sheet tabs)
 *    - Safe image upload to Google Drive
 *
 *  ONE-TIME SETUP (do this in the Apps Script editor, never over the web):
 *    1. Create a Google Sheet. Copy its ID into SHEET_ID below (or set the
 *       script property SHEET_ID — see README).
 *    2. Run `setupSheets_()` once (select it in the toolbar, click Run).
 *       This creates every tab/header row this script needs.
 *    3. Deploy > New deployment > Web app.
 *         Execute as: Me
 *         Who has access: Anyone   <-- NOT "Anyone with Google account" — see
 *         the README section on the "works on one Chrome profile only" bug.
 *       Copy the deployment URL into APPS_SCRIPT_URL in admin.html.
 *    4. Create a Drive folder for uploaded images, put its ID in
 *       DRIVE_FOLDER_ID (or script property DRIVE_FOLDER_ID).
 *    5. Open admin.html in a browser. Since no admin account exists yet,
 *       it shows a one-time "Create admin account" form instead of a login
 *       form (username, password, recovery email) — this submits, emails a
 *       verification code to that recovery email, and once verified shows
 *       your TOTP setup key exactly once. Add it to Google Authenticator /
 *       Authy immediately (Add account > Enter a setup key). After this
 *       account exists, the create-account form disables itself permanently
 *       — `admin.html` always shows the normal login form to everyone else.
 *       (`setupAdmin_()` below still exists as a manual fallback if you'd
 *       rather create the account directly in the editor instead.)
 *
 *  SECURITY NOTES (read the README for the full list):
 *    - This script has ZERO third-party/npm dependencies. Everything
 *      (hashing, HMAC, TOTP) uses Apps Script's built-in Utilities service.
 *      That removes an entire class of supply-chain risk.
 *    - Apps Script web apps do not expose the caller's real IP address,
 *      so rate limiting here is account-based + a global throttle, not
 *      per-IP. Combine this with the account lockout for real protection.
 *    - Session tokens are stored as SHA-256 hashes only — a leaked Sheet
 *      does not hand over usable tokens.
 * ============================================================================
 */

// ---------------------------------------------------------------------------
// CONFIG
// ---------------------------------------------------------------------------
// Per-execution memo (globals persist only within one execution; doPost resets them).
var MEMO_ = { cfg: null, ss: null, sheets: {} };
function resetMemo_() { MEMO_ = { cfg: null, ss: null, sheets: {} }; }

function CFG_() {
  if (MEMO_.cfg) return MEMO_.cfg;
  var p = PropertiesService.getScriptProperties();
  MEMO_.cfg = {
    SHEET_ID: p.getProperty('SHEET_ID') || 'PUT_YOUR_SHEET_ID_HERE',
    DRIVE_FOLDER_ID: p.getProperty('DRIVE_FOLDER_ID') || 'PUT_YOUR_DRIVE_FOLDER_ID_HERE',
    SESSION_TTL_MIN: 45,
    LOGIN_TICKET_TTL_SEC: 300, // 5 min — enough time to switch to an authenticator app and back
    MIN_PASSWORD_LEN: 10, // "more than 8 characters"
    MAX_FAILED_ATTEMPTS: 5,
    LOCKOUT_SECONDS: 15 * 60,
    HASH_ROUNDS: 2000,
    MAX_UPLOAD_BYTES: 5 * 1024 * 1024, // 5 MB
    ALLOWED_IMAGE_TYPES: ['image/png', 'image/jpeg', 'image/webp', 'image/gif'],
    ALLOWED_COLLECTIONS: ['Projects', 'Designs', 'Tools', 'Blog', 'Testimonials'],
    // Where contact-form mail is sent. Set as a script property so it never
    // needs to appear in any file that ships to the browser.
    CONTACT_EMAIL: p.getProperty('CONTACT_EMAIL') || 'PUT_YOUR_EMAIL_IN_SCRIPT_PROPERTIES',
    MAX_MSG_LEN: 3000,
    TRACK_MAX_PER_MIN: 30, // per anonId, blunts abuse of the tracking endpoint
    SESSION_SLIDE_SHEET_SEC: 300 // how often a sliding session is re-written to the sheet
  };
  return MEMO_.cfg;
}

function ss_() { if (!MEMO_.ss) MEMO_.ss = SpreadsheetApp.openById(CFG_().SHEET_ID); return MEMO_.ss; }
function sheet_(name) {
  if (MEMO_.sheets[name]) return MEMO_.sheets[name];
  var sh = ss_().getSheetByName(name);
  if (!sh) throw new AppError_('E_NO_SHEET', 'Missing sheet tab: ' + name);
  MEMO_.sheets[name] = sh;
  return sh;
}

// Generic app-level error that is safe to show to the client.
function AppError_(code, message) {
  var e = new Error(message);
  e.appCode = code;
  return e;
}

// ---------------------------------------------------------------------------
// ONE-TIME SETUP HELPERS (run manually from the editor — never web-exposed)
// ---------------------------------------------------------------------------
function setupSheets_() {
  var ss = ss_();
  var specs = {
    Admin: ['username', 'passwordHash', 'salt', 'totpSecret', 'recoveryEmail', 'createdAt'],
    Sessions: ['tokenHash', 'username', 'createdAt', 'expiresAt'],
    Projects: ['id', 'title', 'desc', 'tags', 'imageUrl', 'url', 'status', 'order', 'updatedAt', 'upcomingDate', 'category', 'githubUrl'],
    Designs: ['id', 'title', 'desc', 'tags', 'imageUrl', 'url', 'status', 'order', 'updatedAt', 'upcomingDate', 'category'],
    Tools: ['id', 'name', 'icon', 'url', 'order', 'updatedAt', 'desc', 'category'],
    Blog: ['id', 'title', 'excerpt', 'url', 'date', 'updatedAt', 'tag', 'imageUrl', 'readTime', 'category'],
    Testimonials: ['id', 'name', 'rating', 'feedback', 'approved', 'createdAt', 'role'],
    Settings: ['key', 'value'],
    Contacts: ['id', 'name', 'email', 'subject', 'message', 'createdAt'],
    AuditLog: ['timestamp', 'actor', 'action', 'detail'],
    PageViews: ['id', 'anonId', 'page', 'referrer', 'createdAt'],
    Events: ['id', 'anonId', 'type', 'label', 'page', 'createdAt']
  };
  Object.keys(specs).forEach(function (name) {
    var sh = ss.getSheetByName(name) || ss.insertSheet(name);
    sh.getRange(1, 1, 1, specs[name].length).setValues([specs[name]]);
  });
  Logger.log('Sheets ready.');
}

// RUN ONCE after updating Code.gs if your Sheet already has data.
// Appends the new OPTIONAL columns (category, githubUrl, blog imageUrl /
// readTime / category, testimonial role) to the right-hand end of each tab's
// header row. It never touches existing rows, never reorders or renames an
// existing column, and is safe to run any number of times. Until a column
// exists the backend simply ignores that field, so nothing breaks if you skip it.
function upgradeSheets_() {
  var wanted = {
    Projects: ['category', 'githubUrl'],
    Designs: ['category'],
    Tools: ['category'],
    Blog: ['imageUrl', 'readTime', 'category'],
    Testimonials: ['role']
  };
  var ss = ss_();
  Object.keys(wanted).forEach(function (name) {
    var sh = ss.getSheetByName(name);
    if (!sh) return;
    var lastCol = Math.max(sh.getLastColumn(), 1);
    var headers = sh.getRange(1, 1, 1, lastCol).getValues()[0].map(String);
    wanted[name].forEach(function (col) {
      if (headers.indexOf(col) === -1) {
        sh.getRange(1, headers.length + 1).setValue(col);
        headers.push(col);
        Logger.log('Added column "' + col + '" to ' + name);
      }
    });
  });
  Logger.log('Sheets upgraded.');
}

// OPTIONAL, run once: copies the portfolio's original hardcoded
// projects/designs/tools/blog posts into the Sheet, so switching the site
// over to admin-managed content doesn't lose anything that was already
// there. Safe to run more than once — it only appends, never overwrites —
// but that means running it twice will duplicate entries, so run it once.
function seedInitialContent_() {
  var now = new Date().toISOString();
  var projects = [
    { title: 'Ledger//Pulse — Manager', desc: 'A focused task manager designed to simplify creating, assigning, prioritizing, and tracking tasks while keeping project progress clear and organized.', tags: 'Next.Js,Tailwind', url: 'https://ledger-pulse-nu.vercel.app' },
    { title: 'MotoLedger — Bike Manager', desc: 'A clean bike management app for tracking fuel, mileage, maintenance, expenses, and your bike’s overall performance.', tags: 'Next.js,Tailwind', url: '' },
    { title: 'Task Management System', desc: 'Centralized task manager to create, assign, prioritize, and track tasks with month-wise, year-wise, and overall progress insights.', tags: 'Management,Tracking', url: '' }
  ];
  var designs = [
    { title: 'Aurora Design System', desc: 'A full component library and token set built for a fintech product.', tags: 'Figma,Design System' },
    { title: 'Fable — Reading App UI', desc: 'Warm, editorial-style interface concept for a reading app.', tags: 'Figma,Mobile' },
    { title: 'Kiln Dashboard Kit', desc: 'Dashboard UI kit with 40+ reusable data components.', tags: 'Figma,Dashboard' },
    { title: 'Wander Travel Wireframes', desc: 'Low to high fidelity wireframes for a travel booking concept.', tags: 'Figma,Wireframe' },
    { title: 'Sprout Onboarding Flow', desc: 'Friendly onboarding sequence with progressive disclosure.', tags: 'Figma,Flow' },
    { title: 'Halo Icon Set', desc: 'A soft, rounded 200+ icon set for product UIs.', tags: 'Figma,Icons' }
  ];
  var tools = [
    { name: 'Remove.bg', desc: 'Background remover', url: 'https://www.remove.bg/', icon: '✂️' },
    { name: 'Pixelcut', desc: 'AI photo editor', url: 'https://www.pixelcut.ai/', icon: '🖼️' },
    { name: 'Grammarly', desc: 'Writing assistant', url: 'https://www.grammarly.com/', icon: '✍️' },
    { name: 'iLovePDF', desc: 'PDF editor & tools', url: 'https://www.ilovepdf.com/', icon: '📄' },
    { name: 'Canva', desc: 'Quick graphic design', url: 'https://www.canva.com/', icon: '🎯' },
    { name: 'Photopea', desc: 'Browser photoshop', url: 'https://www.photopea.com/', icon: '🖌️' },
    { name: 'TinyPNG', desc: 'Image compression', url: 'https://tinypng.com/', icon: '🗜️' },
    { name: 'Figma', desc: 'Interface design', url: 'https://www.figma.com/', icon: '🎛️' }
  ];
  var blog = [
    { title: 'Designing motion that feels invisible', tag: 'Blog', excerpt: 'Notes on using animation to guide attention without ever calling attention to itself.' },
    { title: 'Behind the scenes: Aurora Design System', tag: 'Reel', excerpt: 'A 60-second walkthrough of building a token-based component library.' },
    { title: 'Dark mode, done softly', tag: 'Blog', excerpt: 'Why soft contrast beats pure black for long reading sessions — with examples.' },
    { title: '5 Figma plugins I use every week', tag: 'Blog', excerpt: 'The small plugins that quietly save hours on every design system project.' },
    { title: 'Building a card hover in 60 seconds', tag: 'Reel', excerpt: 'A quick reel breaking down a hover micro-interaction, frame by frame.' },
    { title: 'Why soft shadows beat hard shadows', tag: 'Blog', excerpt: 'A short case for gentler elevation in modern interfaces.' }
  ];

  var pSh = sheet_('Projects'), dSh = sheet_('Designs'), tSh = sheet_('Tools'), bSh = sheet_('Blog');
  projects.forEach(function (p, i) { pSh.appendRow([Utilities.getUuid(), p.title, p.desc, p.tags, '', p.url, '', i, now, '']); });
  designs.forEach(function (d, i) { dSh.appendRow([Utilities.getUuid(), d.title, d.desc, d.tags, '', '', '', i, now, '']); });
  tools.forEach(function (t, i) { tSh.appendRow([Utilities.getUuid(), t.name, t.icon, t.url, i, now, t.desc]); });
  blog.forEach(function (b, i) { bSh.appendRow([Utilities.getUuid(), b.title, b.excerpt, '', '', now, b.tag]); });

  Logger.log('Seeded ' + projects.length + ' projects, ' + designs.length + ' designs, ' + tools.length + ' tools, ' + blog.length + ' blog posts.');
}

// EDIT the username/password/recovery email here, run once, then blank the password.
function setupAdmin_() {
  var username = 'ainsley';          // <-- change me
  var plainPassword = 'CHANGE_ME_TO_A_LONG_PASSPHRASE'; // <-- change me, then re-run, then blank this out
  var recoveryEmail = 'ainsleycardozo07@gmail.com'; // <-- where "forgot password" codes get sent

  var salt = Utilities.getUuid() + Utilities.getUuid();
  var hash = hashPassword_(plainPassword, salt);
  var totpSecret = generateBase32Secret_(20); // 160-bit secret

  var sh = sheet_('Admin');
  sh.getRange(2, 1, 1, 6).setValues([[username, hash, salt, totpSecret, recoveryEmail, new Date().toISOString()]]);

  var otpauth = 'otpauth://totp/AinsleyPortfolio:' + encodeURIComponent(username) +
    '?secret=' + totpSecret + '&issuer=AinsleyPortfolio&digits=6&period=30';

  Logger.log('Admin created. Add this to your authenticator app manually:');
  Logger.log('Setup key (secret): ' + totpSecret);
  Logger.log('Or full otpauth URL: ' + otpauth);
}

// ---------------------------------------------------------------------------
// WEB ENTRY POINTS
// ---------------------------------------------------------------------------
function doGet(e) {
  return jsonOut_({ ok: false, error: 'METHOD_NOT_ALLOWED' });
}

function doPost(e) {
  resetMemo_();
  var reqId = Utilities.getUuid();
  try {
    globalThrottle_(); // blunt scripted floods (see notes on IP limitation)

    var body;
    try {
      body = JSON.parse(e.postData.contents || '{}');
    } catch (parseErr) {
      throw new AppError_('E_BAD_JSON', 'Malformed request body');
    }

    var action = String(body.action || '');
    var payload = body.payload || {};

    switch (action) {
      case 'contact': return jsonOut_(handleContact_(payload));
      case 'feedback': return jsonOut_(handleFeedback_(payload));
      case 'publicTestimonials': return jsonOut_(handlePublicTestimonials_());
      case 'publicStats': return jsonOut_(handlePublicStats_());
      case 'publicContent': return jsonOut_(handlePublicContent_());
      case 'publicSettings': return jsonOut_(handlePublicSettings_());
      case 'track': return jsonOut_(handleTrack_(payload));
      case 'setupStatus': return jsonOut_(handleSetupStatus_());
      case 'createAccount': return jsonOut_(handleCreateAccount_(payload));
      case 'login': return jsonOut_(handleLogin_(payload));
      case 'forgotPassword': return jsonOut_(handleForgotPassword_(payload));
      case 'resetPassword': return jsonOut_(handleResetPassword_(payload));
      case 'verify2fa': return jsonOut_(handleVerify2FA_(payload));
      case 'logout': return jsonOut_(handleLogout_(payload));
      case 'checkSession': return jsonOut_(handleCheckSession_(payload));
      case 'list': return jsonOut_(withSession_(payload, function (u) { return listItems_(payload); }));
      case 'create': return jsonOut_(withSession_(payload, function (u) { return createItem_(payload, u); }));
      case 'update': return jsonOut_(withSession_(payload, function (u) { return updateItem_(payload, u); }));
      case 'delete': return jsonOut_(withSession_(payload, function (u) { return deleteItem_(payload, u); }));
      case 'uploadImage': return jsonOut_(withSession_(payload, function (u) { return uploadImage_(payload, u); }));
      case 'analytics': return jsonOut_(withSession_(payload, function (u) { return handleAnalytics_(payload); }));
      case 'configCheck': return jsonOut_(withSession_(payload, function (u) { return handleConfigCheck_(); }));
      case 'updateSettings': return jsonOut_(withSession_(payload, function (u) { return handleUpdateSettings_(payload, u); }));
      default: throw new AppError_('E_UNKNOWN_ACTION', 'Unknown action');
    }
  } catch (err) {
    return jsonOut_(safeError_(err, reqId));
  }
}

// Never leak stack traces / internal messages to the client.
function safeError_(err, reqId) {
  var code = err && err.appCode ? err.appCode : 'E_INTERNAL';
  Logger.log('[' + reqId + '] ' + (err && err.stack ? err.stack : err));
  var publicMessages = {
    E_BAD_JSON: 'Request could not be read.',
    E_UNKNOWN_ACTION: 'Unsupported action.',
    E_NO_SHEET: 'Server is not configured correctly.',
    E_BAD_INPUT: 'Some fields are invalid.',
    E_AUTH: 'Invalid credentials.',
    E_LOCKED: 'Too many attempts. Try again later.',
    E_2FA_CONFIG: 'Your 2FA setup looks corrupted. Delete your account row in the Admin sheet tab and create it again.',
    E_SESSION: 'Session expired. Please log in again.',
    E_ALREADY_SETUP: 'An admin account already exists.',
    E_RATE_LIMIT: 'Too many requests. Please slow down.',
    E_UPLOAD: 'File could not be uploaded.',
    E_SPAM: 'Submission blocked.',
    E_INTERNAL: 'Something went wrong. Please try again.'
  };
  var resp = { ok: false, code: code, error: publicMessages[code] || publicMessages.E_INTERNAL, reqId: reqId };

  // Validation messages are written by this script (e.g. "Passwords do not
  // match") and never contain secrets or internals, so they're safe — and far
  // more useful than a generic "some fields are invalid".
  if (code === 'E_BAD_INPUT' && err && err.message) resp.error = String(err.message).slice(0, 200);

  // OPTIONAL troubleshooting switch, OFF by default: set the Script Property
  // DEBUG_ERRORS to the text "true" and unexpected server errors will include
  // the real reason in the response ("detail"). Turn it back off afterwards.
  if (code === 'E_INTERNAL' || code === 'E_2FA_CONFIG') {
    try {
      if (PropertiesService.getScriptProperties().getProperty('DEBUG_ERRORS') === 'true') {
        resp.detail = String(err && err.message ? err.message : err).slice(0, 300);
      }
    } catch (ignore) { /* never let diagnostics break error handling */ }
  }
  return resp;
}

function jsonOut_(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}

// ---------------------------------------------------------------------------
// RATE LIMITING
// ---------------------------------------------------------------------------
// Global request throttle (best-effort; Apps Script gives no caller IP).
function globalThrottle_() {
  var cache = CacheService.getScriptCache();
  var key = 'rl_global_' + Math.floor(Date.now() / 10000); // 10-second buckets
  var count = Number(cache.get(key) || 0) + 1;
  cache.put(key, String(count), 30);
  // 200 requests / 10s (~20/sec) still blocks a real scripted flood while
  // giving comfortable headroom for a real person clicking around the
  // dashboard quickly, switching tabs, etc. — the account-level lockout is
  // what actually stops brute-forcing a password/2FA/reset code, not this.
  if (count > 200) throw new AppError_('E_RATE_LIMIT', 'Too many requests');
}

function recordFailedAttempt_(username) {
  var cache = CacheService.getScriptCache();
  var key = 'fail_' + username;
  var attempts = Number(cache.get(key) || 0) + 1;
  cache.put(key, String(attempts), CFG_().LOCKOUT_SECONDS);
  return attempts;
}

function isLockedOut_(username) {
  var cache = CacheService.getScriptCache();
  var attempts = Number(cache.get('fail_' + username) || 0);
  return attempts >= CFG_().MAX_FAILED_ATTEMPTS;
}

function clearFailedAttempts_(username) {
  CacheService.getScriptCache().remove('fail_' + username);
}

// ---------------------------------------------------------------------------
// AUTH: FIRST-RUN SETUP WIZARD (create the one admin account, once)
// ---------------------------------------------------------------------------
// True once any admin row exists. After that, createAccount permanently
// refuses — this is a single-admin panel, so "sign up" only ever works once,
// from a browser that can also read the verification email below.
function hasAdmin_() {
  return sheetToObjects_(sheet_('Admin')).some(function (r) { return r.username; });
}

function handleSetupStatus_() {
  return { ok: true, hasAdmin: hasAdmin_() };
}

function isValidUsername_(u) { return /^[a-zA-Z0-9_.-]{3,60}$/.test(u); }

function handleCreateAccount_(payload) {
  if (payload.website) return { ok: true }; // honeypot
  if (hasAdmin_()) throw new AppError_('E_ALREADY_SETUP', 'Already set up');

  publicThrottle_('rl_create_account', 5, 3600); // 5 attempts/hour, global — this endpoint only matters pre-setup

  var username = sanitizeStr_(payload.username, 60);
  var password = String(payload.password || '');
  var confirmPassword = String(payload.confirmPassword || '');
  var recoveryEmail = sanitizeStr_(payload.recoveryEmail, 200);

  if (!isValidUsername_(username)) throw new AppError_('E_BAD_INPUT', 'Username must be 3-60 characters (letters, numbers, . _ -)');
  if (password.length < CFG_().MIN_PASSWORD_LEN) throw new AppError_('E_BAD_INPUT', 'Password must be at least ' + CFG_().MIN_PASSWORD_LEN + ' characters');
  if (password !== confirmPassword) throw new AppError_('E_BAD_INPUT', 'Passwords do not match');
  if (!isValidEmail_(recoveryEmail)) throw new AppError_('E_BAD_INPUT', 'Invalid recovery email');

  // Re-check right before writing too — closes the (very small) race window
  // if two setup attempts were somehow started at almost the same instant.
  if (hasAdmin_()) throw new AppError_('E_ALREADY_SETUP', 'Already set up');

  var salt = Utilities.getUuid() + Utilities.getUuid();
  var hash = hashPassword_(password, salt);
  var totpSecret = generateBase32Secret_(20);

  sheet_('Admin').getRange(2, 1, 1, 6).setValues([[username, hash, salt, totpSecret, recoveryEmail, new Date().toISOString()]]);
  audit_(username, 'ACCOUNT_CREATED', '');

  // Courtesy notification only — account creation does not wait on this
  // succeeding, and it is never used to gate or verify anything.
  try {
    MailApp.sendEmail({
      to: recoveryEmail,
      subject: 'Your portfolio admin account was created',
      body: 'An admin account ("' + username + '") was just created for your portfolio site.\n\n' +
        'If this was not you, that likely means someone reached the setup page before you did — ' +
        'you can still recover access via "Forgot password" using this same recovery email.'
    });
  } catch (e) { /* never let a notification failure block account creation */ }

  var otpauthUrl = 'otpauth://totp/AinsleyPortfolio:' + encodeURIComponent(username) +
    '?secret=' + totpSecret + '&issuer=AinsleyPortfolio&digits=6&period=30';

  // This is the one and only time the TOTP secret is ever handed to the
  // browser — shown once, immediately after account creation. Add it to an
  // authenticator app right away; it cannot be retrieved again afterward.
  return { ok: true, totpSecret: totpSecret, otpauthUrl: otpauthUrl };
}

// ---------------------------------------------------------------------------
// AUTH: FORGOT PASSWORD (emailed one-time code to the registered recovery address)
// ---------------------------------------------------------------------------
function handleForgotPassword_(payload) {
  var username = sanitizeStr_(payload.username, 100);
  if (!username) throw new AppError_('E_BAD_INPUT', 'Missing username');

  publicThrottle_('rl_forgot_' + username, 3, 900); // 3 requests / 15 min per username

  var ticket = Utilities.getUuid();
  var row = findAdminRow_(username);

  // Always behave the same way whether or not the account/email exists,
  // so the response can't be used to guess valid usernames.
  if (row && row.recoveryEmail) {
    var code = ('000000' + Math.floor(Math.random() * 1000000)).slice(-6);
    CacheService.getScriptCache().put('reset_' + ticket, username + '|' + code, 600); // 10 min
    MailApp.sendEmail({
      to: row.recoveryEmail,
      subject: 'Portfolio admin — password reset code',
      body: 'Your password reset code is: ' + code + '\n\nThis code expires in 10 minutes. ' +
        'If you did not request this, you can safely ignore this email.'
    });
    audit_(username, 'FORGOT_PASSWORD_REQUESTED', '');
  }
  return { ok: true, ticket: ticket };
}

function handleResetPassword_(payload) {
  var ticket = sanitizeStr_(payload.ticket, 100);
  var code = sanitizeStr_(payload.code, 10).replace(/\s+/g, '');
  var newPassword = String(payload.newPassword || '');

  if (!ticket || !/^\d{6}$/.test(code)) throw new AppError_('E_BAD_INPUT', 'Invalid code format');
  if (newPassword.length < CFG_().MIN_PASSWORD_LEN) throw new AppError_('E_BAD_INPUT', 'Password must be at least ' + CFG_().MIN_PASSWORD_LEN + ' characters');

  publicThrottle_('rl_reset_' + ticket, 5, 600); // 5 guesses per ticket / 10 min

  var cache = CacheService.getScriptCache();
  var stored = cache.get('reset_' + ticket);
  if (!stored) throw new AppError_('E_AUTH', 'Code expired or invalid');
  var parts = stored.split('|');
  var username = parts[0], expectedCode = parts[1];
  if (!timingSafeEqual_(code, expectedCode)) throw new AppError_('E_AUTH', 'Invalid code');

  var sh = sheet_('Admin');
  var data = sh.getDataRange().getValues();
  var headers = data[0];
  var userCol = headers.indexOf('username');
  var hashCol = headers.indexOf('passwordHash');
  var saltCol = headers.indexOf('salt');
  for (var i = 1; i < data.length; i++) {
    if (data[i][userCol] === username) {
      var newSalt = Utilities.getUuid() + Utilities.getUuid();
      sh.getRange(i + 1, saltCol + 1).setValue(newSalt);
      sh.getRange(i + 1, hashCol + 1).setValue(hashPassword_(newPassword, newSalt));
      cache.remove('reset_' + ticket);
      clearFailedAttempts_(username);
      invalidateAllSessions_(username);
      audit_(username, 'PASSWORD_RESET', '');
      return { ok: true };
    }
  }
  throw new AppError_('E_AUTH', 'Invalid code');
}

function invalidateAllSessions_(username) {
  var sh = sheet_('Sessions');
  var data = sh.getDataRange().getValues();
  var cache = CacheService.getScriptCache();
  for (var i = data.length - 1; i >= 1; i--) {
    if (data[i][1] === username) { cache.remove('sess_' + data[i][0]); sh.deleteRow(i + 1); }
  }
}


function handleLogin_(payload) {
  var username = sanitizeStr_(payload.username, 100);
  var password = String(payload.password || '');
  if (!username || !password) throw new AppError_('E_BAD_INPUT', 'Missing credentials');

  // Constant-shaped response whether the account exists or not.
  if (isLockedOut_(username)) throw new AppError_('E_LOCKED', 'Locked');

  var row = findAdminRow_(username);
  var validPassword = row && verifyPassword_(password, row.passwordHash, row.salt);

  if (!validPassword) {
    recordFailedAttempt_(username);
    audit_(username, 'LOGIN_FAILED', '');
    throw new AppError_('E_AUTH', 'Invalid credentials');
  }

  // Password OK — issue a short-lived ticket, require TOTP next.
  var ticket = Utilities.getUuid();
  CacheService.getScriptCache().put('ticket_' + ticket, username, CFG_().LOGIN_TICKET_TTL_SEC);
  audit_(username, 'LOGIN_STEP1_OK', '');
  return { ok: true, stage: '2fa', ticket: ticket };
}

// ---------------------------------------------------------------------------
// AUTH: LOGIN STEP 2 (TOTP)
// ---------------------------------------------------------------------------
function handleVerify2FA_(payload) {
  var ticket = sanitizeStr_(payload.ticket, 100);
  var code = sanitizeStr_(payload.code, 10).replace(/\s+/g, '');
  if (!ticket || !/^\d{6}$/.test(code)) throw new AppError_('E_BAD_INPUT', 'Invalid code format');

  var cache = CacheService.getScriptCache();
  var username = cache.get('ticket_' + ticket);
  if (!username) throw new AppError_('E_AUTH', 'Ticket expired');
  if (isLockedOut_(username)) throw new AppError_('E_LOCKED', 'Locked');

  var row = findAdminRow_(username);
  if (!row) { recordFailedAttempt_(username); audit_(username, '2FA_FAILED', 'no admin row'); throw new AppError_('E_AUTH', 'Invalid code'); }

  // Validate the stored secret's shape before touching any crypto with it —
  // if this ever comes back empty/malformed (e.g. a corrupted or manually
  // edited Sheet cell), fail with a clear, specific message instead of
  // letting an obscure internal exception surface as "Something went wrong."
  var secret = String(row.totpSecret || '').trim();
  if (!/^[A-Z2-7]{10,}$/.test(secret)) {
    Logger.log('2FA config error for "' + username + '": totpSecret is missing or not valid base32 (len=' + secret.length + ')');
    throw new AppError_('E_2FA_CONFIG', 'Your 2FA setup looks corrupted');
  }

  var totpMatches;
  try {
    totpMatches = verifyTotp_(secret, code);
  } catch (cryptoErr) {
    // A genuine failure inside the HMAC/TOTP computation itself — log the
    // real cause and surface a specific, actionable error rather than the
    // generic catch-all.
    Logger.log('TOTP computation threw for "' + username + '": ' + (cryptoErr && cryptoErr.stack ? cryptoErr.stack : cryptoErr));
    throw new AppError_('E_2FA_CONFIG', 'Could not verify your 2FA code');
  }

  if (!totpMatches) {
    recordFailedAttempt_(username);
    audit_(username, '2FA_FAILED', '');
    throw new AppError_('E_AUTH', 'Invalid code');
  }

  cache.remove('ticket_' + ticket);
  clearFailedAttempts_(username);

  var token = Utilities.getUuid() + Utilities.getUuid();
  var tokenHash = sha256Hex_(token);
  var now = new Date();
  var expires = new Date(now.getTime() + CFG_().SESSION_TTL_MIN * 60000);
  var sessSheet = sheet_('Sessions');
  // Housekeeping: drop expired sessions so the sheet stays small (and fast to scan).
  var sdata = sessSheet.getDataRange().getValues();
  for (var si = sdata.length - 1; si >= 1; si--) {
    var sx = new Date(sdata[si][3]);
    if (!(sx >= now)) { CacheService.getScriptCache().remove('sess_' + sdata[si][0]); sessSheet.deleteRow(si + 1); }
  }
  sessSheet.appendRow([tokenHash, username, now.toISOString(), expires.toISOString()]);
  cacheSession_(tokenHash, username, expires.getTime(), now.getTime());

  audit_(username, 'LOGIN_SUCCESS', '');
  return { ok: true, token: token, expiresAt: expires.toISOString() };
}

function handleLogout_(payload) {
  var token = String(payload.token || '');
  if (!token) return { ok: true };
  var tokenHash = sha256Hex_(token);
  CacheService.getScriptCache().remove('sess_' + tokenHash);
  var sh = sheet_('Sessions');
  var data = sh.getDataRange().getValues();
  for (var i = 1; i < data.length; i++) {
    if (data[i][0] === tokenHash) { sh.deleteRow(i + 1); break; }
  }
  return { ok: true };
}

function handleCheckSession_(payload) {
  try {
    var username = requireSession_(String(payload.token || ''));
    return { ok: true, username: username };
  } catch (e) {
    return { ok: false };
  }
}

// Session cache entry: {u: username, e: expiry ms, w: last sheet write ms}.
function cacheSession_(tokenHash, username, expMs, writtenMs) {
  try {
    CacheService.getScriptCache().put('sess_' + tokenHash, JSON.stringify({ u: username, e: expMs, w: writtenMs }), CFG_().SESSION_TTL_MIN * 60);
  } catch (err) { /* cache is an optimisation only */ }
}

// Validates a session token, slides its expiry forward, returns the username.
// Fast path: CacheService (no sheet read). The sheet stays the source of truth
// and is only re-written every SESSION_SLIDE_SHEET_SEC.
function requireSession_(token) {
  if (!token) throw new AppError_('E_SESSION', 'No session');
  var tokenHash = sha256Hex_(token);
  var nowMs = Date.now();
  var ttlMs = CFG_().SESSION_TTL_MIN * 60000;
  var cache = CacheService.getScriptCache();
  var hit = cache.get('sess_' + tokenHash);
  if (hit) {
    var c = null;
    try { c = JSON.parse(hit); } catch (e1) { c = null; }
    if (c && c.e > nowMs) {
      var wrote = c.w;
      if (nowMs - c.w > CFG_().SESSION_SLIDE_SHEET_SEC * 1000) {
        var row = findSessionRow_(tokenHash);
        if (row) { sheet_('Sessions').getRange(row, 4).setValue(new Date(nowMs + ttlMs).toISOString()); wrote = nowMs; }
        else { cache.remove('sess_' + tokenHash); throw new AppError_('E_SESSION', 'Invalid session'); }
      }
      cacheSession_(tokenHash, c.u, nowMs + ttlMs, wrote);
      return c.u;
    }
    cache.remove('sess_' + tokenHash);
  }
  var sh = sheet_('Sessions');
  var data = sh.getDataRange().getValues();
  var now = new Date(nowMs);
  for (var i = 1; i < data.length; i++) {
    if (data[i][0] === tokenHash) {
      var expires = new Date(data[i][3]);
      if (expires < now) {
        sh.deleteRow(i + 1);
        throw new AppError_('E_SESSION', 'Expired');
      }
      sh.getRange(i + 1, 4).setValue(new Date(nowMs + ttlMs).toISOString());
      cacheSession_(tokenHash, data[i][1], nowMs + ttlMs, nowMs);
      return data[i][1]; // username
    }
  }
  throw new AppError_('E_SESSION', 'Invalid session');
}
function findSessionRow_(tokenHash) {
  var vals = sheet_('Sessions').getRange(1, 1, Math.max(1, sheet_('Sessions').getLastRow()), 1).getValues();
  for (var i = 1; i < vals.length; i++) if (vals[i][0] === tokenHash) return i + 1;
  return 0;
}

function withSession_(payload, fn) {
  var username = requireSession_(String(payload.token || ''));
  return fn(username);
}

// ---------------------------------------------------------------------------
// CRUD (generic, whitelisted collections)
// ---------------------------------------------------------------------------
function assertCollection_(name) {
  if (CFG_().ALLOWED_COLLECTIONS.indexOf(name) === -1) {
    throw new AppError_('E_BAD_INPUT', 'Unknown collection');
  }
}

function sheetToObjects_(sh) {
  var values = sh.getDataRange().getValues();
  var headers = values[0];
  var out = [];
  for (var i = 1; i < values.length; i++) {
    var obj = {}; var rowEmpty = true;
    for (var c = 0; c < headers.length; c++) {
      obj[headers[c]] = values[i][c];
      if (values[i][c] !== '' && values[i][c] !== null) rowEmpty = false;
    }
    if (!rowEmpty) { obj._row = i + 1; out.push(obj); }
  }
  return out;
}

function listItems_(payload) {
  assertCollection_(payload.collection);
  var items = sheetToObjects_(sheet_(payload.collection));
  items.forEach(function (it) { delete it._row; });
  return { ok: true, items: items };
}

function createItem_(payload, username) {
  assertCollection_(payload.collection);
  var sh = sheet_(payload.collection);
  var headers = sh.getRange(1, 1, 1, sh.getLastColumn()).getValues()[0];
  var item = validateItem_(payload.collection, payload.item || {});
  item.id = Utilities.getUuid();
  item.updatedAt = new Date().toISOString();
  if (headers.indexOf('createdAt') !== -1 && !item.createdAt) item.createdAt = item.updatedAt;
  var row = headers.map(function (h) { return item[h] !== undefined ? item[h] : ''; });
  sh.appendRow(row);
  audit_(username, 'CREATE', payload.collection + ':' + item.id);
  return { ok: true, item: item };
}

function updateItem_(payload, username) {
  assertCollection_(payload.collection);
  var id = sanitizeStr_(payload.id, 100);
  if (!id) throw new AppError_('E_BAD_INPUT', 'Missing id');
  var sh = sheet_(payload.collection);
  var headers = sh.getRange(1, 1, 1, sh.getLastColumn()).getValues()[0];
  var idCol = headers.indexOf('id');
  var data = sh.getDataRange().getValues();
  for (var i = 1; i < data.length; i++) {
    if (data[i][idCol] === id) {
      var sent = payload.item || {};
      var item = validateItem_(payload.collection, sent);
      item.updatedAt = new Date().toISOString();
      headers.forEach(function (h, c) {
        if (h === 'id' || h === 'createdAt') return;
        // Only overwrite fields the client actually sent. Without this, editing
        // an item without re-uploading its image would blank imageUrl (and any
        // other field the edit form doesn't carry).
        if (h !== 'updatedAt' && (sent[h] === undefined || sent[h] === null)) return;
        if (item[h] !== undefined) sh.getRange(i + 1, c + 1).setValue(item[h]);
      });
      audit_(username, 'UPDATE', payload.collection + ':' + id);
      return { ok: true };
    }
  }
  throw new AppError_('E_BAD_INPUT', 'Item not found');
}

function deleteItem_(payload, username) {
  assertCollection_(payload.collection);
  var id = sanitizeStr_(payload.id, 100);
  var sh = sheet_(payload.collection);
  var headers = sh.getRange(1, 1, 1, sh.getLastColumn()).getValues()[0];
  var idCol = headers.indexOf('id');
  var data = sh.getDataRange().getValues();
  for (var i = 1; i < data.length; i++) {
    if (data[i][idCol] === id) {
      sh.deleteRow(i + 1);
      audit_(username, 'DELETE', payload.collection + ':' + id);
      return { ok: true };
    }
  }
  throw new AppError_('E_BAD_INPUT', 'Item not found');
}

// Per-collection field whitelist + length limits (defense in depth vs. junk/XSS payloads).
function validateItem_(collection, item) {
  var rules = {
    Projects: { title: 200, desc: 2000, tags: 300, imageUrl: 500, url: 500, status: 20, order: 0, upcomingDate: 40, category: 60, githubUrl: 500 },
    Designs: { title: 200, desc: 2000, tags: 300, imageUrl: 500, url: 500, status: 20, order: 0, upcomingDate: 40, category: 60 },
    Tools: { name: 100, icon: 500, url: 500, order: 0, desc: 200, category: 60 },
    Blog: { title: 200, excerpt: 2000, url: 500, date: 40, tag: 20, imageUrl: 500, readTime: 20, category: 60 },
    Testimonials: { name: 100, rating: 0, feedback: 2000, approved: 0, role: 100 }
  };
  var spec = rules[collection];
  var clean = {};
  Object.keys(spec).forEach(function (field) {
    var max = spec[field];
    var val = item[field];
    if (val === undefined || val === null) { clean[field] = max ? '' : 0; return; }
    if (max === 0) { clean[field] = val; return; } // numeric/boolean-ish fields, left as-is
    clean[field] = sanitizeStr_(String(val), max);
  });
  if (clean.status && ['new', 'upcoming', ''].indexOf(clean.status) === -1) {
    throw new AppError_('E_BAD_INPUT', 'Invalid status');
  }
  if (clean.upcomingDate && isNaN(new Date(clean.upcomingDate).getTime())) {
    throw new AppError_('E_BAD_INPUT', 'Invalid countdown date');
  }
  // Links are rendered as clickable hrefs on the public site, so only web URLs are stored.
  ['url', 'githubUrl'].forEach(function (f) {
    if (clean[f] && !/^https?:\/\//i.test(clean[f])) throw new AppError_('E_BAD_INPUT', 'Links must start with http:// or https://');
  });
  if (clean.tag && ['Blog', 'Reel', ''].indexOf(clean.tag) === -1) {
    throw new AppError_('E_BAD_INPUT', 'Invalid tag');
  }
  return clean;
}

// ---------------------------------------------------------------------------
// IMAGE UPLOAD (validated, stored in a private-ish Drive folder)
// ---------------------------------------------------------------------------
function uploadImage_(payload, username) {
  var mimeType = String(payload.mimeType || '');
  var filename = sanitizeStr_(payload.filename, 150);
  var base64 = String(payload.base64 || '');

  if (CFG_().ALLOWED_IMAGE_TYPES.indexOf(mimeType) === -1) {
    throw new AppError_('E_UPLOAD', 'Unsupported file type');
  }
  if (!base64) throw new AppError_('E_UPLOAD', 'No file data');

  var bytes;
  try { bytes = Utilities.base64Decode(base64); }
  catch (e) { throw new AppError_('E_UPLOAD', 'Corrupt file data'); }

  if (bytes.length > CFG_().MAX_UPLOAD_BYTES) throw new AppError_('E_UPLOAD', 'File too large');

  // Re-derive extension from the *validated* mimeType rather than trusting
  // the client-supplied filename/extension.
  var extByMime = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp', 'image/gif': 'gif' };
  var safeName = Utilities.getUuid() + '.' + extByMime[mimeType];

  var blob = Utilities.newBlob(bytes, mimeType, safeName);
  var folder = DriveApp.getFolderById(CFG_().DRIVE_FOLDER_ID);
  var file = folder.createFile(blob);
  file.setSharing(DriveApp.Access.ANYONE_WITH_LINK, DriveApp.Permission.VIEW);

  // drive.google.com/uc?export=view is well known to intermittently break
  // when hotlinked directly in an <img> tag (Google sometimes serves an
  // interstitial/warning page instead of the raw image). The /thumbnail
  // endpoint is the documented, reliable way to embed a Drive file as an
  // image — sz=w1600 requests a version up to 1600px wide.
  var url = 'https://drive.google.com/thumbnail?id=' + file.getId() + '&sz=w1600';
  audit_(username, 'UPLOAD', safeName + ' (' + filename + ')');
  return { ok: true, url: url };
}

// ---------------------------------------------------------------------------
// PHASE 1 — CONTACT FORM (email + Sheet), FEEDBACK FORM (Sheet + public display)
// ---------------------------------------------------------------------------

// Simple per-anonId + global throttle for unauthenticated public endpoints
// (contact/feedback/track) — separate from the login lockout above.
function publicThrottle_(bucketKey, limit, windowSeconds) {
  var cache = CacheService.getScriptCache();
  var count = Number(cache.get(bucketKey) || 0) + 1;
  cache.put(bucketKey, String(count), windowSeconds);
  if (count > limit) throw new AppError_('E_RATE_LIMIT', 'Too many requests');
}

function isValidEmail_(email) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) && email.length <= 200;
}

function handleContact_(payload) {
  // Honeypot: a real visitor never fills this hidden field.
  if (payload.website) return { ok: true };
  // Timing check: a real person takes at least a couple seconds to read the
  // form and type something; a form submitted faster than that is almost
  // always a bot filling every field programmatically. Silently accepted
  // (not an error) so a bot gets no signal that it was caught.
  if (payload.loadedAt && (Date.now() - Number(payload.loadedAt)) < 2500) return { ok: true };

  publicThrottle_('rl_contact_' + (payload.anonId || 'anon'), 5, 600); // 5 per 10 min per device

  var name = sanitizeStr_(payload.name, 100);
  var email = sanitizeStr_(payload.email, 200);
  var subject = sanitizeStr_(payload.subject, 150) || 'New project inquiry';
  var message = sanitizeStr_(payload.message, CFG_().MAX_MSG_LEN);

  if (!name || !message) throw new AppError_('E_BAD_INPUT', 'Missing required fields');
  if (!isValidEmail_(email)) throw new AppError_('E_BAD_INPUT', 'Invalid email');

  var id = Utilities.getUuid();
  sheet_('Contacts').appendRow([id, name, email, subject, message, new Date().toISOString()]);

  var to = CFG_().CONTACT_EMAIL;
  if (to && to.indexOf('PUT_YOUR_EMAIL') === -1) {
    // Sent from your own authorized Google account — no password/app-password
    // ever needs to be stored anywhere for this to work.
    MailApp.sendEmail({
      to: to,
      replyTo: email,
      subject: '[Portfolio contact] ' + subject,
      body: 'From: ' + name + ' <' + email + '>\n\n' + message +
        '\n\n— sent automatically from the portfolio contact form —'
    });
  } else {
    audit_('system', 'CONTACT_MAIL_SKIPPED_NO_CONFIG', 'message saved but not emailed — CONTACT_EMAIL not set');
  }
  return { ok: true };
}

function handleFeedback_(payload) {
  if (payload.website) return { ok: true }; // honeypot
  if (payload.loadedAt && (Date.now() - Number(payload.loadedAt)) < 2500) return { ok: true }; // bot timing check

  publicThrottle_('rl_feedback_' + (payload.anonId || 'anon'), 5, 600);

  var name = sanitizeStr_(payload.name, 100);
  var feedback = sanitizeStr_(payload.feedback, CFG_().MAX_MSG_LEN);
  var rating = parseInt(payload.rating, 10);
  if (!name || !feedback) throw new AppError_('E_BAD_INPUT', 'Missing required fields');
  if (isNaN(rating) || rating < 1 || rating > 5) throw new AppError_('E_BAD_INPUT', 'Invalid rating');

  var id = Utilities.getUuid();
  // Shows immediately on the public site (approved = TRUE); you can hide any
  // individual entry later from the admin dashboard by flipping it to FALSE.
  sheet_('Testimonials').appendRow([id, name, rating, feedback, 'TRUE', new Date().toISOString()]);
  return { ok: true };
}

// Public, read-only, no session required — only ever returns approved rows
// and only the fields that are safe to show (never emails/contact details).
function handlePublicTestimonials_() {
  var items = sheetToObjects_(sheet_('Testimonials'))
    .filter(function (t) { return String(t.approved).toUpperCase() === 'TRUE'; })
    .map(function (t) { return { name: t.name, rating: Number(t.rating) || 0, feedback: t.feedback, createdAt: t.createdAt, role: t.role || '' }; })
    .sort(function (a, b) { return new Date(b.createdAt) - new Date(a.createdAt); });
  return { ok: true, items: items };
}

// Public aggregate stats for the homepage charts — counts only, no PII.
function handlePublicStats_() {
  var testimonials = sheetToObjects_(sheet_('Testimonials'))
    .filter(function (t) { return String(t.approved).toUpperCase() === 'TRUE'; });
  var contacts = sheetToObjects_(sheet_('Contacts'));

  var ratingBreakdown = [0, 0, 0, 0, 0]; // index 0 = 1-star ... index 4 = 5-star
  testimonials.forEach(function (t) {
    var r = Number(t.rating);
    if (r >= 1 && r <= 5) ratingBreakdown[r - 1]++;
  });

  // Enquiries per month for the last 6 months (oldest first).
  var months = [];
  var now = new Date();
  for (var i = 5; i >= 0; i--) {
    var d = new Date(now.getFullYear(), now.getMonth() - i, 1);
    months.push({ key: d.getFullYear() + '-' + (d.getMonth() + 1), label: Utilities.formatDate(d, Session.getScriptTimeZone(), 'MMM'), count: 0 });
  }
  contacts.forEach(function (c) {
    var d = new Date(c.createdAt);
    var key = d.getFullYear() + '-' + (d.getMonth() + 1);
    var bucket = months.find(function (m) { return m.key === key; });
    if (bucket) bucket.count++;
  });

  var avgRating = testimonials.length
    ? (testimonials.reduce(function (s, t) { return s + Number(t.rating); }, 0) / testimonials.length)
    : 0;

  return {
    ok: true,
    totalTestimonials: testimonials.length,
    totalEnquiries: contacts.length,
    avgRating: Math.round(avgRating * 10) / 10,
    ratingBreakdown: ratingBreakdown,
    enquiriesByMonth: { labels: months.map(function (m) { return m.label; }), counts: months.map(function (m) { return m.count; }) }
  };
}

// Public, read-only — this is what makes the homepage actually reflect
// whatever's in the admin dashboard, instead of hardcoded arrays in index.html.
function sortByOrder_(items) {
  return items.slice().sort(function (a, b) {
    var oa = a.order === '' || a.order === undefined ? 9999 : Number(a.order);
    var ob = b.order === '' || b.order === undefined ? 9999 : Number(b.order);
    return oa - ob;
  });
}
function handlePublicContent_() {
  return {
    ok: true,
    projects: sortByOrder_(sheetToObjects_(sheet_('Projects'))),
    designs: sortByOrder_(sheetToObjects_(sheet_('Designs'))),
    tools: sortByOrder_(sheetToObjects_(sheet_('Tools'))),
    blog: sheetToObjects_(sheet_('Blog')).sort(function (a, b) { return new Date(b.updatedAt) - new Date(a.updatedAt); })
  };
}

// ---------------------------------------------------------------------------
// SITE SETTINGS (Appearance & Personalization) — whitelisted values only, so
// this can never be used to inject arbitrary CSS/HTML into the page.
// The public site receives { accentPreset, accent, accent2, themeMode } from
// publicSettings and paints it; nothing is ever edited in CSS by hand.
// ---------------------------------------------------------------------------
var DEFAULT_ACCENT_PRESET = 'violet';
var DEFAULT_THEME_MODE = 'system';
var THEME_MODES = ['light', 'dark', 'system'];
var ACCENT_PRESETS = {
  violet:   { name: 'Aurora Violet', accent: '#8581EF', accent2: '#63C8D6' },   // default
  ocean:    { name: 'Ocean Blue',    accent: '#579CEB', accent2: '#63C8D6' },
  mint:     { name: 'Mint Green',    accent: '#50B99A', accent2: '#63C8D6' },
  rose:     { name: 'Rose Pink',     accent: '#E18BAF', accent2: '#63C8D6' },
  peach:    { name: 'Sunset Peach',  accent: '#E6A17D', accent2: '#63C8D6' },
  cyan:     { name: 'Cyber Cyan',    accent: '#49BFCB', accent2: '#8581EF' },   // secondary swapped so it never matches the accent
  indigo:   { name: 'Soft Indigo',   accent: '#7188DB', accent2: '#63C8D6' },
  lavender: { name: 'Lavender',      accent: '#AA8BE8', accent2: '#63C8D6' }
};
// Keys saved by the previous 5-colour version of this panel keep working.
var LEGACY_PRESET_ALIASES = { sunset: 'peach', forest: 'mint', berry: 'rose' };

function getSetting_(key, fallback) {
  var rows = sheetToObjects_(sheet_('Settings'));
  var row = rows.find(function (r) { return r.key === key; });
  return row ? row.value : fallback;
}
function setSetting_(key, value) {
  var sh = sheet_('Settings');
  var data = sh.getDataRange().getValues();
  for (var i = 1; i < data.length; i++) {
    if (data[i][0] === key) { sh.getRange(i + 1, 2).setValue(value); return; }
  }
  sh.appendRow([key, value]);
}

function resolvePreset_(key) {
  key = String(key || '');
  if (LEGACY_PRESET_ALIASES[key]) key = LEGACY_PRESET_ALIASES[key];
  return ACCENT_PRESETS[key] ? key : DEFAULT_ACCENT_PRESET;
}

// Same response shape as before (ok, accentPreset, accent, accent2, presets),
// plus themeMode and presetMeta. Existing callers just ignore the new keys.
function handlePublicSettings_() {
  var presetKey = resolvePreset_(getSetting_('accentPreset', DEFAULT_ACCENT_PRESET));
  var preset = ACCENT_PRESETS[presetKey];
  var mode = String(getSetting_('themeMode', DEFAULT_THEME_MODE));
  if (THEME_MODES.indexOf(mode) === -1) mode = DEFAULT_THEME_MODE;
  return {
    ok: true,
    accentPreset: presetKey,
    accent: preset.accent,
    accent2: preset.accent2,
    themeMode: mode,
    presets: Object.keys(ACCENT_PRESETS),
    presetMeta: ACCENT_PRESETS,
    defaults: { accentPreset: DEFAULT_ACCENT_PRESET, themeMode: DEFAULT_THEME_MODE }
  };
}

// Either field is optional, but at least one must be present.
function handleUpdateSettings_(payload, username) {
  var hasPreset = payload.accentPreset !== undefined && payload.accentPreset !== null && payload.accentPreset !== '';
  var hasMode = payload.themeMode !== undefined && payload.themeMode !== null && payload.themeMode !== '';
  if (!hasPreset && !hasMode) throw new AppError_('E_BAD_INPUT', 'Nothing to update');

  var presetKey, mode;
  if (hasPreset) {
    presetKey = sanitizeStr_(payload.accentPreset, 30);
    if (!ACCENT_PRESETS[presetKey]) throw new AppError_('E_BAD_INPUT', 'Unknown color preset');
  }
  if (hasMode) {
    mode = sanitizeStr_(payload.themeMode, 10);
    if (THEME_MODES.indexOf(mode) === -1) throw new AppError_('E_BAD_INPUT', 'Unknown theme mode');
  }
  if (hasPreset) setSetting_('accentPreset', presetKey);
  if (hasMode) setSetting_('themeMode', mode);
  audit_(username, 'UPDATE_SETTINGS', (hasPreset ? 'accentPreset=' + presetKey : '') + (hasPreset && hasMode ? ' ' : '') + (hasMode ? 'themeMode=' + mode : ''));
  return { ok: true };
}

// ---------------------------------------------------------------------------
// PROTECTED ANALYTICS (admin dashboard only — requires a valid session)
// ---------------------------------------------------------------------------
function handleAnalytics_(payload) {
  var pageviews = sheetToObjects_(sheet_('PageViews'));
  var events = sheetToObjects_(sheet_('Events'));
  var contacts = sheetToObjects_(sheet_('Contacts'));

  var uniqueVisitors = {};
  pageviews.forEach(function (p) { uniqueVisitors[p.anonId] = true; });

  var durations = events
    .filter(function (e) { return e.type === 'duration'; })
    .map(function (e) { return Number(e.label); })
    .filter(function (n) { return !isNaN(n) && n > 0 && n < 6 * 3600; }); // discard junk/outliers (>6h)
  var avgDurationSeconds = durations.length ? Math.round(durations.reduce(function (a, b) { return a + b; }, 0) / durations.length) : 0;

  // Page views per day for the last 14 days (oldest first).
  var days = [];
  var now = new Date();
  for (var i = 13; i >= 0; i--) {
    var d = new Date(now.getFullYear(), now.getMonth(), now.getDate() - i);
    days.push({ key: Utilities.formatDate(d, Session.getScriptTimeZone(), 'yyyy-MM-dd'), label: Utilities.formatDate(d, Session.getScriptTimeZone(), 'd MMM'), count: 0 });
  }
  pageviews.forEach(function (p) {
    var key = Utilities.formatDate(new Date(p.createdAt), Session.getScriptTimeZone(), 'yyyy-MM-dd');
    var bucket = days.find(function (d) { return d.key === key; });
    if (bucket) bucket.count++;
  });

  // Most-visited pages, top 5.
  var byPage = {};
  pageviews.forEach(function (p) { byPage[p.page] = (byPage[p.page] || 0) + 1; });
  var topPages = Object.keys(byPage).map(function (k) { return { page: k, count: byPage[k] }; })
    .sort(function (a, b) { return b.count - a.count; }).slice(0, 5);

  // Which homepage sections get scrolled into, and how often — "section_view"
  // events are fired once per visitor per section (see index.html).
  var bySection = {};
  events.filter(function (e) { return e.type === 'section_view'; })
    .forEach(function (e) { bySection[e.label] = (bySection[e.label] || 0) + 1; });
  var sectionViews = Object.keys(bySection).map(function (k) { return { section: k, count: bySection[k] }; })
    .sort(function (a, b) { return b.count - a.count; });

  // Recent security-relevant activity (logins, failures, lock..out triggers,
  // password resets, account changes) — helps you notice something like a
  // burst of failed attempts. Only ever timestamp + actor + action, never
  // passwords/codes/tokens.
  var securityActions = ['LOGIN_STEP1_OK', 'LOGIN_SUCCESS', 'LOGIN_FAILED', '2FA_FAILED',
    'FORGOT_PASSWORD_REQUESTED', 'PASSWORD_RESET', 'RESET_CODE_FAILED', 'ACCOUNT_CREATED'];
  var recentSecurity = sheetToObjects_(sheet_('AuditLog'))
    .filter(function (e) { return securityActions.indexOf(e.action) !== -1; })
    .sort(function (a, b) { return new Date(b.timestamp) - new Date(a.timestamp); })
    .slice(0, 15)
    .map(function (e) { return { timestamp: e.timestamp, actor: e.actor, action: e.action }; });

  return {
    ok: true,
    totalPageViews: pageviews.length,
    uniqueVisitors: Object.keys(uniqueVisitors).length,
    avgDurationSeconds: avgDurationSeconds,
    totalContacts: contacts.length,
    pageViewsByDay: { labels: days.map(function (d) { return d.label; }), counts: days.map(function (d) { return d.count; }) },
    topPages: topPages,
    sectionViews: sectionViews,
    recentSecurity: recentSecurity
  };
}

// Lets the dashboard show plain-English "is this actually configured?"
// status instead of you having to dig through Script Properties/logs.
function handleConfigCheck_() {
  var cfg = CFG_();
  return {
    ok: true,
    contactEmailConfigured: !!cfg.CONTACT_EMAIL && cfg.CONTACT_EMAIL.indexOf('PUT_YOUR_EMAIL') === -1,
    driveFolderConfigured: !!cfg.DRIVE_FOLDER_ID && cfg.DRIVE_FOLDER_ID.indexOf('PUT_YOUR_DRIVE') === -1,
    sheetIdConfigured: !!cfg.SHEET_ID && cfg.SHEET_ID.indexOf('PUT_YOUR_SHEET') === -1
  };
}

function handleTrack_(payload) {
  var anonId = sanitizeStr_(payload.anonId, 60);
  if (!anonId) throw new AppError_('E_BAD_INPUT', 'Missing anonId');

  publicThrottle_('rl_track_' + anonId, CFG_().TRACK_MAX_PER_MIN, 60);

  var type = sanitizeStr_(payload.type, 20);
  var page = sanitizeStr_(payload.page, 200);
  var id = Utilities.getUuid();
  var now = new Date().toISOString();

  if (type === 'pageview') {
    var referrer = sanitizeStr_(payload.referrer, 200);
    sheet_('PageViews').appendRow([id, anonId, page, referrer, now]);
  } else if (type === 'event') {
    var label = sanitizeStr_(payload.label, 100);
    sheet_('Events').appendRow([id, anonId, sanitizeStr_(payload.eventType, 40), label, page, now]);
  } else {
    throw new AppError_('E_BAD_INPUT', 'Unknown track type');
  }
  return { ok: true };
}

// ---------------------------------------------------------------------------
// CRYPTO HELPERS (no third-party libraries)
// ---------------------------------------------------------------------------
// Pure-JS SHA-256 (bit-identical to Utilities.computeDigest SHA_256 / UTF-8).
// Utilities.computeDigest is a service call (~ms each); hashPassword_ runs it
// 2000 times, so staying in-process makes login several times faster.
var SHA256_K_ = [
  0x428a2f98,0x71374491,0xb5c0fbcf,0xe9b5dba5,0x3956c25b,0x59f111f1,0x923f82a4,0xab1c5ed5,0xd807aa98,0x12835b01,0x243185be,0x550c7dc3,0x72be5d74,0x80deb1fe,0x9bdc06a7,0xc19bf174,
  0xe49b69c1,0xefbe4786,0x0fc19dc6,0x240ca1cc,0x2de92c6f,0x4a7484aa,0x5cb0a9dc,0x76f988da,0x983e5152,0xa831c66d,0xb00327c8,0xbf597fc7,0xc6e00bf3,0xd5a79147,0x06ca6351,0x14292967,
  0x27b70a85,0x2e1b2138,0x4d2c6dfc,0x53380d13,0x650a7354,0x766a0abb,0x81c2c92e,0x92722c85,0xa2bfe8a1,0xa81a664b,0xc24b8b70,0xc76c51a3,0xd192e819,0xd6990624,0xf40e3585,0x106aa070,
  0x19a4c116,0x1e376c08,0x2748774c,0x34b0bcb5,0x391c0cb3,0x4ed8aa4a,0x5b9cca4f,0x682e6ff3,0x748f82ee,0x78a5636f,0x84c87814,0x8cc70208,0x90befffa,0xa4506ceb,0xbef9a3f7,0xc67178f2
];
function utf8Bytes_(str) {
  var out = [];
  for (var i = 0; i < str.length; i++) {
    var c = str.charCodeAt(i);
    if (c >= 0xD800 && c <= 0xDBFF && i + 1 < str.length) {
      var d = str.charCodeAt(i + 1);
      if (d >= 0xDC00 && d <= 0xDFFF) { c = 0x10000 + ((c - 0xD800) << 10) + (d - 0xDC00); i++; }
    }
    if (c < 0x80) out.push(c);
    else if (c < 0x800) out.push(0xC0 | (c >> 6), 0x80 | (c & 63));
    else if (c < 0x10000) out.push(0xE0 | (c >> 12), 0x80 | ((c >> 6) & 63), 0x80 | (c & 63));
    else out.push(0xF0 | (c >> 18), 0x80 | ((c >> 12) & 63), 0x80 | ((c >> 6) & 63), 0x80 | (c & 63));
  }
  return out;
}
function sha256Hex_(str) {
  var bytes = utf8Bytes_(String(str));
  var len = bytes.length;
  bytes.push(0x80);
  while (bytes.length % 64 !== 56) bytes.push(0);
  var hi = Math.floor(len / 0x20000000), lo = (len << 3) >>> 0;
  bytes.push((hi >>> 24) & 255, (hi >>> 16) & 255, (hi >>> 8) & 255, hi & 255, (lo >>> 24) & 255, (lo >>> 16) & 255, (lo >>> 8) & 255, lo & 255);
  var H = [0x6a09e667,0xbb67ae85,0x3c6ef372,0xa54ff53a,0x510e527f,0x9b05688c,0x1f83d9ab,0x5be0cd19];
  var w = new Array(64), K = SHA256_K_;
  for (var o = 0; o < bytes.length; o += 64) {
    for (var t = 0; t < 16; t++) w[t] = (bytes[o + 4*t] << 24) | (bytes[o + 4*t + 1] << 16) | (bytes[o + 4*t + 2] << 8) | bytes[o + 4*t + 3];
    for (t = 16; t < 64; t++) {
      var x = w[t - 15], y = w[t - 2];
      var s0 = ((x >>> 7) | (x << 25)) ^ ((x >>> 18) | (x << 14)) ^ (x >>> 3);
      var s1 = ((y >>> 17) | (y << 15)) ^ ((y >>> 19) | (y << 13)) ^ (y >>> 10);
      w[t] = (w[t - 16] + s0 + w[t - 7] + s1) | 0;
    }
    var a = H[0], b = H[1], c = H[2], d = H[3], e = H[4], f = H[5], g = H[6], h = H[7];
    for (t = 0; t < 64; t++) {
      var S1 = ((e >>> 6) | (e << 26)) ^ ((e >>> 11) | (e << 21)) ^ ((e >>> 25) | (e << 7));
      var ch = (e & f) ^ (~e & g);
      var t1 = (h + S1 + ch + K[t] + w[t]) | 0;
      var S0 = ((a >>> 2) | (a << 30)) ^ ((a >>> 13) | (a << 19)) ^ ((a >>> 22) | (a << 10));
      var mj = (a & b) ^ (a & c) ^ (b & c);
      var t2 = (S0 + mj) | 0;
      h = g; g = f; f = e; e = (d + t1) | 0; d = c; c = b; b = a; a = (t1 + t2) | 0;
    }
    H[0] = (H[0] + a) | 0; H[1] = (H[1] + b) | 0; H[2] = (H[2] + c) | 0; H[3] = (H[3] + d) | 0;
    H[4] = (H[4] + e) | 0; H[5] = (H[5] + f) | 0; H[6] = (H[6] + g) | 0; H[7] = (H[7] + h) | 0;
  }
  var hex = '';
  for (var i = 0; i < 8; i++) hex += ('00000000' + (H[i] >>> 0).toString(16)).slice(-8);
  return hex;
}

// Simple salted, iterated SHA-256 (Apps Script has no native bcrypt/scrypt).
// Iterating thousands of rounds meaningfully slows offline guessing.
function hashPassword_(password, salt) {
  var value = salt + '::' + password;
  var rounds = CFG_().HASH_ROUNDS;
  for (var i = 0; i < rounds; i++) {
    value = sha256Hex_(value + salt);
  }
  return value;
}
function verifyPassword_(password, expectedHash, salt) {
  var computed = hashPassword_(password, salt);
  return timingSafeEqual_(computed, expectedHash);
}
function timingSafeEqual_(a, b) {
  if (a.length !== b.length) return false;
  var diff = 0;
  for (var i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

function findAdminRow_(username) {
  var rows = sheetToObjects_(sheet_('Admin'));
  for (var i = 0; i < rows.length; i++) {
    if (rows[i].username === username) return rows[i];
  }
  return null;
}

// --- TOTP (RFC 6238), implemented in plain JavaScript ---------------------
// IMPORTANT: this deliberately does NOT call any Utilities.computeHmac*
// method. An earlier version called Utilities.computeHmacSha1Signature,
// which does not exist in Apps Script (the real API only has
// computeHmacSha256Signature and computeHmacSignature) — that made every
// 2FA check crash. SHA-1 + HMAC are implemented below instead, so nothing
// here depends on a Google function that may or may not exist. They are
// verified against Node's crypto and the RFC 2202 / RFC 6238 test vectors
// in tests/run-tests.js.

// Cryptographically-strong random bytes. Apps Script has no crypto RNG, but
// Utilities.getUuid() is backed by a secure generator (UUID v4), so bytes are
// taken from its hex digits — skipping the fixed version/variant nibbles.
function secureRandomBytes_(n) {
  var hex = '';
  while (hex.length < n * 2) {
    var u = Utilities.getUuid().replace(/-/g, ''); // 32 hex chars
    hex += u.slice(0, 12) + u.slice(13, 16) + u.slice(17); // drop index 12 (version) + 16 (variant)
  }
  var out = [];
  for (var i = 0; i < n; i++) out.push(parseInt(hex.substr(i * 2, 2), 16));
  return out;
}

function generateBase32Secret_(byteLen) {
  return base32Encode_(secureRandomBytes_(byteLen));
}

var BASE32_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
function base32Encode_(bytes) {
  var bits = '', out = '';
  for (var i = 0; i < bytes.length; i++) bits += ('00000000' + (bytes[i] & 0xFF).toString(2)).slice(-8);
  for (i = 0; i + 5 <= bits.length; i += 5) out += BASE32_ALPHABET[parseInt(bits.substr(i, 5), 2)];
  if (i < bits.length) out += BASE32_ALPHABET[parseInt((bits.substr(i) + '0000').slice(0, 5), 2)];
  return out;
}
function base32Decode_(str) {
  str = str.toUpperCase().replace(/=+$/, '');
  var bits = '';
  for (var i = 0; i < str.length; i++) {
    var idx = BASE32_ALPHABET.indexOf(str[i]);
    if (idx === -1) continue;
    bits += ('00000' + idx.toString(2)).slice(-5);
  }
  var bytes = [];
  for (i = 0; i + 8 <= bits.length; i += 8) bytes.push(parseInt(bits.substr(i, 8), 2));
  return bytes;
}

// SHA-1 over an array of unsigned bytes (0-255) -> array of 20 unsigned bytes.
function sha1Bytes_(input) {
  var h0 = 0x67452301, h1 = 0xEFCDAB89, h2 = 0x98BADCFE, h3 = 0x10325476, h4 = 0xC3D2E1F0;
  var msg = input.slice();
  var bitLen = input.length * 8;
  msg.push(0x80);
  while (msg.length % 64 !== 56) msg.push(0);
  var hi = Math.floor(bitLen / 0x100000000), lo = bitLen >>> 0, i;
  for (i = 3; i >= 0; i--) msg.push((hi >>> (i * 8)) & 0xFF);
  for (i = 3; i >= 0; i--) msg.push((lo >>> (i * 8)) & 0xFF);

  var w = new Array(80);
  for (var off = 0; off < msg.length; off += 64) {
    var t;
    for (t = 0; t < 16; t++) {
      w[t] = ((msg[off + t * 4] << 24) | (msg[off + t * 4 + 1] << 16) | (msg[off + t * 4 + 2] << 8) | msg[off + t * 4 + 3]) >>> 0;
    }
    for (t = 16; t < 80; t++) {
      var x = w[t - 3] ^ w[t - 8] ^ w[t - 14] ^ w[t - 16];
      w[t] = ((x << 1) | (x >>> 31)) >>> 0;
    }
    var a = h0, b = h1, c = h2, d = h3, e = h4;
    for (t = 0; t < 80; t++) {
      var f, k;
      if (t < 20) { f = (b & c) | (~b & d); k = 0x5A827999; }
      else if (t < 40) { f = b ^ c ^ d; k = 0x6ED9EBA1; }
      else if (t < 60) { f = (b & c) | (b & d) | (c & d); k = 0x8F1BBCDC; }
      else { f = b ^ c ^ d; k = 0xCA62C1D6; }
      var temp = ((((a << 5) | (a >>> 27)) >>> 0) + (f >>> 0) + e + k + w[t]) >>> 0;
      e = d; d = c; c = ((b << 30) | (b >>> 2)) >>> 0; b = a; a = temp;
    }
    h0 = (h0 + a) >>> 0; h1 = (h1 + b) >>> 0; h2 = (h2 + c) >>> 0; h3 = (h3 + d) >>> 0; h4 = (h4 + e) >>> 0;
  }
  var out = [], hs = [h0, h1, h2, h3, h4];
  for (i = 0; i < 5; i++) for (var s = 3; s >= 0; s--) out.push((hs[i] >>> (s * 8)) & 0xFF);
  return out;
}

// HMAC-SHA1 (RFC 2104). Both arguments are arrays of unsigned bytes.
function hmacSha1_(keyBytes, msgBytes) {
  var key = keyBytes.slice();
  if (key.length > 64) key = sha1Bytes_(key);
  while (key.length < 64) key.push(0);
  var ipad = [], opad = [];
  for (var i = 0; i < 64; i++) { ipad.push(key[i] ^ 0x36); opad.push(key[i] ^ 0x5c); }
  return sha1Bytes_(opad.concat(sha1Bytes_(ipad.concat(msgBytes))));
}

function totpAt_(secretBase32, timeStepCounter) {
  var key = base32Decode_(String(secretBase32 || ''));

  // 8-byte big-endian counter. The high half is derived with division, not
  // bit-shifts: JavaScript's `>>` only works for shifts under 32 bits
  // (`counter >> 56` silently wraps instead of giving 0).
  var high = Math.floor(timeStepCounter / 0x100000000);
  var low = timeStepCounter >>> 0;
  var msg = [];
  for (var i = 3; i >= 0; i--) msg.push((high >>> (i * 8)) & 0xFF);
  for (var j = 3; j >= 0; j--) msg.push((low >>> (j * 8)) & 0xFF);

  var hmac = hmacSha1_(key, msg);
  var offset = hmac[19] & 0x0f;
  var code = ((hmac[offset] & 0x7f) << 24) |
    ((hmac[offset + 1] & 0xff) << 16) |
    ((hmac[offset + 2] & 0xff) << 8) |
    (hmac[offset + 3] & 0xff);
  return ('000000' + (code % 1000000)).slice(-6);
}

// Accept the current 30s step and one step on either side (clock drift).
// A missing/corrupt stored secret simply fails verification — it never throws.
function verifyTotp_(secretBase32, userCode) {
  if (!secretBase32 || typeof userCode !== 'string') return false;
  var counter = Math.floor(Date.now() / 1000 / 30);
  var ok = false;
  for (var drift = -1; drift <= 1; drift++) {
    if (timingSafeEqual_(totpAt_(secretBase32, counter + drift), userCode)) ok = true; // no early exit: constant work
  }
  return ok;
}

// ---------------------------------------------------------------------------
// MISC HELPERS
// ---------------------------------------------------------------------------
function sanitizeStr_(val, maxLen) {
  if (val === undefined || val === null) return '';
  var s = String(val).replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, ''); // strip control chars
  return s.slice(0, maxLen);
}

function audit_(actor, action, detail) {
  try { sheet_('AuditLog').appendRow([new Date().toISOString(), actor, action, detail]); }
  catch (e) { /* never let audit logging break the request */ }
}
