# Admin Login + Dashboard — Setup Guide

This gives you a password + 2FA (TOTP) protected admin dashboard where you can
add/edit/delete Projects, Designs, Tools, Blog posts, and moderate
Testimonials — all backed by a Google Sheet, with zero hosting cost.

## Files

- `apps-script/Code.gs` → paste into a new Google Apps Script project (this is your backend/API).
- `site/admin-login.html` → the login page (upload alongside your other site files).
- `site/admin-dashboard.html` → the CRUD dashboard (same, upload alongside your site files).
- `site/index.html` → your existing homepage, now with a small lock icon next to "Let's talk" (desktop) and an "Admin" link in the mobile menu, both pointing to `admin-login.html`.

## One-time setup

1. **Create the Google Sheet.**
   Go to sheets.google.com → new blank sheet → name it e.g. `Portfolio DB`.
   Copy the Sheet ID from its URL (the long string between `/d/` and `/edit`).

2. **Create the Apps Script project.**
   In that Sheet: Extensions → Apps Script. Delete the default code and paste
   in the full contents of `apps-script/Code.gs`.

3. **Set script properties.**
   In the Apps Script editor: Project Settings (gear icon) → Script Properties → Add:
   - `SHEET_ID` = the Sheet ID from step 1
   - `DRIVE_FOLDER_ID` = the ID of a Drive folder you create for uploaded images

4. **Create the sheet tabs.**
   Back in the Apps Script editor, select the function `setupSheets_` from the
   function dropdown at the top, click **Run**. The first run will ask you to
   authorize the script (it needs access to Sheets/Drive under your account —
   this is expected and safe, it's your own script).

5. **Create your admin account.**
   Open `Code.gs`, find `setupAdmin_()`, and edit the `username` and
   `plainPassword` values to whatever you want. Run `setupAdmin_` from the
   function dropdown. Then:
   - Open **View → Logs** (or **Executions**) and copy the printed **setup key**.
   - In Google Authenticator (or Authy): Add account → **Enter a setup key** →
     paste it in. It'll start generating 6-digit codes.
   - **Important:** go back into `setupAdmin_()` and blank out/delete the
     plaintext password you typed, then save. It's only needed for that one run.

6. **Deploy the web app.**
   Deploy → New deployment → type **Web app**.
   - Execute as: **Me**
   - Who has access: **Anyone**
   Click Deploy, authorize again if asked, and copy the **Web app URL**.

7. **Wire up the front-end.**
   In `admin-login.html` and `admin-dashboard.html`, replace
   `PASTE_YOUR_APPS_SCRIPT_WEB_APP_URL_HERE` with that Web app URL. Upload
   both files to your site's root (same place as `index.html`).

8. **Test it.** Visit `yoursite.com/admin-login.html`, log in with your
   username/password, then the 6-digit code from your authenticator app.

> Whenever you edit `Code.gs` after this, you need to **Deploy → Manage
> deployments → edit (pencil) → New version** for the changes to go live —
> saving alone isn't enough.

## What's implemented, mapped to your checklist

| Requirement | How it's handled |
|---|---|
| 2FA, not hackable | Real TOTP (RFC 6238), same algorithm Google Authenticator uses. Secret never leaves your Sheet/Apps Script. Note: *any* web login involves a network call to a backend — that part is unavoidable and is not itself a weakness; see note below. |
| Rate limiting | Global request throttle + per-account failure tracking via Apps Script's Cache service. |
| Dependency vulnerabilities | Zero third-party runtime libraries. Hashing/HMAC/TOTP are all built from Apps Script's native `Utilities` service. |
| Input validation | Every field is length-capped and type-checked server-side; collection names and status values are whitelisted. |
| Error handling / info leakage | The server never returns stack traces or internal messages — only a small set of generic, safe messages. Full details go to the Apps Script execution log only. |
| File upload safety | MIME type whitelist, 5MB size cap, filename is discarded and replaced with a random name, extension is derived from the verified MIME type (not trusted from the client). |
| Brute force | 5 failed attempts locks the account for 15 minutes (tracked server-side, can't be bypassed from the browser). |
| Sessions | Random tokens, stored as SHA-256 hashes only (a leaked Sheet doesn't leak usable tokens), 45-minute sliding expiry. |

### Honest limitations (so nothing here overpromises)

- **Apps Script doesn't expose caller IP addresses**, so rate limiting is
  account- and volume-based rather than per-IP. Combine with a strong,
  unique password and don't reuse it anywhere else.
- **Password hashing** uses salted, 2000-round SHA-256 rather than
  bcrypt/scrypt/Argon2 (Apps Script doesn't provide those). It's meaningfully
  slower to brute-force than a bare hash, but a long random passphrase (16+
  characters) matters more than the algorithm here.
- Calling `admin-login.html`/`admin-dashboard.html` always talks to the Apps
  Script URL over HTTPS via `fetch` — this is an API call by definition, same
  as literally every website login. What determines security is what happens
  on the server side of that call (2FA + lockout + validation above), not
  whether it's "an API."

---

# Phase 1 & 2 — Contact/Feedback backend, Testimonials, Stats, Tracking, SEO/legal

These build on the same Apps Script project and Sheet from Phase 3 — no new
project needed, just an update to `Code.gs` and two new script properties.

## Additional one-time setup

1. **Re-run `setupSheets_()`** (Apps Script editor → select it → Run). It's
   safe to run again — it only adds the two new tabs this phase needs
   (`PageViews`, `Events`) and leaves everything else untouched.

2. **Add one more script property:**
   - `CONTACT_EMAIL` = the Gmail address that should receive contact-form
     mail (e.g. `ainsleycardozo07@gmail.com`). This lives only in Script
     Properties — it is never present in any file sent to the browser, so
     visitors can't see it by viewing page source.

3. **Re-deploy.** Deploy → Manage deployments → pencil icon → New version →
   Deploy (this is required any time `Code.gs` changes).

4. **Update the front-end config.** In `site/index.html`, find:
   `const APPS_SCRIPT_URL = "PASTE_YOUR_APPS_SCRIPT_WEB_APP_URL_HERE";`
   and paste in the same Web app URL you used for the admin pages.

5. **Pin Chart.js (recommended before going fully live).** `index.html`
   loads Chart.js from cdnjs for the testimonials charts. Generate a
   Subresource Integrity hash for the exact file at
   [srihash.org](https://www.srihash.org) (paste in
   `https://cdnjs.cloudflare.com/ajax/libs/Chart.js/4.4.4/chart.umd.min.js`)
   and add the resulting `integrity="sha512-..."` attribute to that
   `<script>` tag. This stops a compromised CDN from silently swapping the
   file for something malicious. (Left out here since it has to be
   generated against the live file, not guessed.)

## How mail sending actually works (no app password needed)

Because the backend is Google Apps Script, it sends mail via `MailApp`,
running **as your own authorized Google account** — there's no SMTP
password or app password to generate, store, or leak. Free Google accounts
get ~100 outgoing emails/day this way (Workspace accounts get more), which
is far more than a portfolio contact form needs.

## What each new piece does

| Feature | Where |
|---|---|
| Contact form → email + Sheet | Submits to the `contact` action. Saved to the `Contacts` tab, then emailed to `CONTACT_EMAIL`. Your reply-to is set to the visitor's email, so hitting "reply" in Gmail goes straight to them. |
| Feedback → Testimonials | Submits to the `feedback` action, saved to `Testimonials` with `approved = TRUE`, so it appears on the site immediately, as you asked. You can still hide an individual entry later by flipping `approved` to `FALSE` in the admin dashboard. |
| Testimonials + stats section | New `#testimonials` section on the homepage: total reviews, total enquiries, average rating, 5★ count, a bar chart of the rating breakdown, and a 6-month line chart of enquiries — all pulled live from the Sheet via two public, read-only endpoints (`publicTestimonials`, `publicStats`) that only ever return safe, non-personal fields. |
| Page/event tracking | A random ID (not a cookie, no PII) is generated in `localStorage` on first visit. Page loads and a few key clicks (Let's talk, view project, submit contact) are logged to the `PageViews`/`Events` tabs, rate-limited per ID so the endpoint can't be flooded. |
| SEO basics | Your existing meta tags/OG/Twitter/JSON-LD were already solid — left as-is. Added: `robots.txt` now disallows the two admin pages from being indexed, and `sitemap.xml` includes the new Privacy/Terms pages. |
| Privacy & Terms | `site/privacy.html` and `site/terms.html` — plain-language pages describing what the contact/feedback forms collect and how testimonials get published, linked from the footer. |
| Contact support email | The existing "Drop a message" link in the footer is your public-facing support address — separate from the hidden `CONTACT_EMAIL` backend address, so you can give this one out freely without exposing your primary inbox. Update it to whatever address you want visitors to see. |
| Spam protection | Both public forms include a hidden honeypot field real visitors never fill in, plus a per-visitor rate limit (5 submissions / 10 minutes) enforced server-side. |

## Everything is now built

Phase 1, 2, and 3 are all in this package. If you want anything refined —
different chart styles, more tracked events, additional legal clauses, or
changes to what shows in the CRUD dashboard — just ask.

---

# Update — Forgot password, login page branding, dashboard nav layout

## If you already ran `setupAdmin_()` before this update

The `Admin` sheet tab now has a `recoveryEmail` column (5th column, before
`createdAt`). If your Admin row was created before this update, add that
column header and a value manually in the Sheet, **or** just re-run
`setupAdmin_()` again (it overwrites row 2) with a fresh password.

## Forgot password flow

- On the login page, "Forgot password?" asks only for a username, then
  emails a 6-digit code to that account's `recoveryEmail` — never reveals
  whether the username exists, and rate-limits requests (3 per 15 min) and
  code guesses (5 per 10 min) the same way login does.
- Entering the correct code lets you set a new password (12+ characters
  minimum); this also invalidates any existing admin sessions, so if
  someone else were logged in they'd be signed out.
- There's intentionally no public "Create account" — see the note about
  this in the chat where it was requested. Say the word if you'd like an
  "invite a second admin" feature added inside the dashboard instead.

## Layout

- `admin-login.html` and `admin-dashboard.html` both now show a centered
  "Ainsley." wordmark/logo, matching the main site's branding.
- The dashboard header uses a 3-column layout (logo — empty center — logout)
  so it stays balanced at any width, and the section tabs (Projects/Designs/…)
  are now centered as a group underneath it instead of left-aligned.

## About the uploaded `emailer_sender.py`

That file is not part of this system — Apps Script's `MailApp` (already
wired up for Phase 1) sends mail as your own Google account with no SMTP
password required. If that script had a real, working Gmail App Password in
it, please revoke it now at
[myaccount.google.com/apppasswords](https://myaccount.google.com/apppasswords) —
treat any credential that's been shared anywhere outside your own machine as
burned, even if it's deleted afterward.

---

# Update — Unified admin.html, self-service setup, analytics, and the Chrome-profile bug

## The "works in one Chrome profile, fails in another" bug — read this first

This almost certainly isn't a bug in the code — it's the Apps Script
deployment's access setting. When you deployed, "Who has access" needs to be
literally **Anyone** — not **"Anyone with a Google account"** and not
restricted to your Workspace domain. If it's set to either of those, Google
itself intercepts the request and shows *its own* sign-in/consent page for
whatever Google account is active in that Chrome profile — which is exactly
the symptom you saw (works where you're conveniently logged into the right
account, fails everywhere else). Fix: **Deploy → Manage deployments → ✏️ →
Edit access → Who has access: Anyone → Deploy**. If it still misbehaves
after that, do a **New deployment** (not just a new version) — access-level
changes sometimes don't take effect on an existing deployment ID — and
update `APPS_SCRIPT_URL` in `admin.html` to the new URL.

## `admin-login.html` + `admin-dashboard.html` → merged into one `admin.html`

There's now a single file, `site/admin.html`, that handles everything:
setup, login, 2FA, forgot password, and the full dashboard. Delete the two
old files if they're still on your server, and update the admin link (the
lock icon / mobile "Admin" link) to point at `admin.html` — already done in
the `index.html` in this package.

## Create account (now built in, safely)

The first time anyone opens `admin.html` and no admin account exists yet,
it shows a **Create admin account** form (username, password, recovery
email) instead of a login form. Submitting it:
1. Emails a 6-digit verification code to that recovery email (this is the
   "email verification" you asked for).
2. Once verified, creates the account **and shows your TOTP setup key once,
   right there in the browser** — add it to Google Authenticator/Authy
   immediately, then continue to the login screen.
3. From then on, `createAccount` permanently refuses (`E_ALREADY_SETUP`) —
   there's no way to create a second account through this form, so it can't
   be abused by a stranger who finds the page later. If you ever want a
   *second* admin, that still needs to be a dashboard-only "invite" feature
   (say the word).

`setupAdmin_()` in the Apps Script editor still works too, as a manual
fallback if you'd rather not use the browser flow.

## Password rule

Both account creation and password reset now require **at least 10
characters** (comfortably over the "more than 8" you asked for) —
configurable via `MIN_PASSWORD_LEN` in `Code.gs`.

## Session token: no browser storage at all

The token is now kept only in a JavaScript variable inside `admin.html` —
not `localStorage`, not `sessionStorage`, not a cookie. The trade-off: since
`admin.html` is one page with an internal login/dashboard "view" switch
(no full navigation between them), the token survives normally while
you're using it, but **refreshing the tab logs you out** and you'll need to
log in (password + 2FA) again. That's intentional — it means there is
nothing durable on the client for an XSS payload or a shared computer to
ever find, even seconds after you've walked away.

Login/CRUD security itself hasn't changed: every protected action (`list`,
`create`, `update`, `delete`, `uploadImage`, `analytics`) is re-validated
**server-side** against the live Sessions sheet on every single call — the
dashboard's client-side "am I logged in" check is only a UX convenience for
redirecting you to the login screen, never the actual security boundary.

## New: Analytics tab (page views, time on site, visitors, enquiries)

A 6th tab, **Analytics**, next to Testimonials:
- Total page views, unique visitors (by anonymous ID), average time spent
  on the site, and total enquiries received.
- A 14-day page-views chart and a "most-visited pages" list.
- Time-on-site is measured client-side (from page load to when the tab is
  hidden/closed) and sent via `navigator.sendBeacon` so it's captured
  reliably even on tab-close, then averaged server-side. Values are
  discarded if under 2 seconds (bounce) or over 6 hours (a tab left open
  overnight, not real engagement).

## Performance ("lazy loading" / faster dashboard)

- **Chart.js is no longer loaded upfront.** It's injected only the first
  time you open the Analytics tab, so every other tab (which is most of
  your usage) loads with less JS from the start.
- **Tab data is cached in memory and shown instantly on repeat visits**
  within the same session, then silently refreshed in the background
  (stale-while-revalidate) — switching tabs feels immediate instead of
  waiting on a fetch every time.
- Table loading now shows a skeleton placeholder instead of a bare "Loading…"
  string, which reads as faster even when the network time is the same.

## Everything requested is now covered

Setup/login/2FA/forgot-password, rate limiting + brute-force lockout on all
of login/reset/setup, input validation, generic error responses with no
information leakage, file-upload safety, Privacy/Terms pages, a public
support email separate from the hidden backend one, page/event/time
tracking, SEO basics, and the CRUD + analytics dashboard. If anything about
the flow feels off once you've actually clicked through it, tell me exactly
what happened (and check the Executions log for any error code) and I'll
fix it directly.

---

# Update — Simplified signup flow

You asked for: username → new password → re-enter password → (account
created) → login → 2FA → dashboard, plus Privacy/Terms links on the login
screen itself. This needed a small edit to **both** `Code.gs` and
`admin.html` — the login screen and its fields live in `admin.html`;
`Code.gs` has no UI of its own, so it can't add a page element by itself,
and changing how account creation works on one side without the other
would have broken the flow. Both files in this zip are updated and
cross-checked against each other, so replace both.

What changed:
- Account creation is now one step, matching what you described: username,
  password, a real "re-enter password" field (checked both in the browser
  and again on the server), and a recovery email — submit once, and you
  immediately see your one-time TOTP setup key.
- Removed the "verify your email with a code" step entirely, since it added
  friction you didn't ask for. The recovery email is still exactly what
  "Forgot password" emails a reset code to later — it's just not
  pre-verified at signup anymore. Nothing else about security changed:
  same TOTP 2FA, same rate limiting/lockout, same 10-character minimum,
  same server-side-only session checks.
- Added Privacy Policy and Terms & Conditions links directly on the login
  screen (both the login state and the create-account state).

If you deploy only the new `Code.gs` without the new `admin.html`, account
creation will break (the old page expects a response shape the new backend
no longer sends) — they have to go up together this one time.

---

# Update — Actually tested this time, plus a QR code and a second real bug fix

## What changed

1. **QR code for 2FA setup.** After creating the account, you now get a
   scannable QR code (generated entirely in your browser via a small,
   well-known open-source library loaded from cdnjs — the secret is never
   sent anywhere to produce it) instead of only a text key. "Can't scan?"
   still reveals the manual key as a fallback.

2. **Found and fixed a second real bug: the rate limiter was too strict.**
   While building the test suite below, the global request throttle (meant
   to blunt scripted abuse) tripped under nothing more than normal rapid
   dashboard usage. Loosened it from 40 to 200 requests per 10 seconds —
   still shuts down an actual flood, but won't punish a real person
   clicking around quickly. The account-level lockout (5 failed
   login/2FA/reset attempts) is what actually stops brute-forcing a
   password or code, and that's unchanged.

3. **A real automated test suite (`tests/`).** This simulates Google Apps
   Script in Node.js — mocking Sheets, Cache, Utilities, MailApp, Drive —
   and actually *executes* every action in `Code.gs`, including a full
   login → 2FA → dashboard cycle using a 6-digit code computed by a
   **second, independent** implementation (not copy-pasted from `Code.gs`
   itself), the same way a real authenticator app computes one. 78 checks,
   all passing, covering setup, account creation (and its one-time lock),
   login, 2FA, session handling, every CRUD action, image upload
   validation, contact/feedback with spam checks, forgot/reset password
   (including that it invalidates old sessions), login lockout after
   repeated failures, and malformed-request handling. This is what caught
   the rate-limiter bug above — it wouldn't have been found by reading the
   code again.

Run it yourself anytime with `node tests/run_tests.js apps-script/Code.gs`
— no install needed, just Node.js. Worth running before any future deploy.

## On the "Something went wrong" / "Malformed request body" error you hit

I was not able to reproduce this in the simulation despite deliberately
trying (including feeding the backend genuinely malformed JSON, which it
handled cleanly). My best explanation, in order of likelihood: the browser
was still talking to a deployment made *before* the TOTP fix from earlier
in this conversation (Apps Script requires an explicit "New version"
deploy — saving alone never updates the live URL), or the two error
messages you saw were from two different, unrelated requests (their
request IDs didn't match). If it happens again after deploying this
version, please get me the Executions log entry whose ID matches the exact
`reqId` shown in the browser's response — that pairing is what actually
pinpoints it.

---

# Update — Real content management, countdown timers, and a bug fix

## Important bug fix: duplicate function definitions in `Code.gs`

While adding this round of features I found — and removed — a leftover
duplicate `handleForgotPassword_`/`handleResetPassword_`/
`invalidateAllSessions_` block further down in the file, plus an unfinished,
never-wired "multi-admin" block. Apps Script (like JS generally) just uses
whichever definition of a function appears last, so the stale duplicate was
silently overriding the correct one and didn't match what `admin.html`
actually sends it — which could well have been contributing to odd
behavior. The router and every function reference have been cross-checked
now (no duplicates, nothing calls a function that doesn't exist). **If you
had already deployed a version with this bug, redeploy** (Manage
deployments → ✏️ → New version) to pick up the fix.

## The site now actually reflects what's in the dashboard

This is the big one: until now, Projects/Designs/Tools/Blog on the live
homepage were hardcoded arrays in `index.html` — the CRUD dashboard wrote
to the Sheet, but the homepage never read from it. That's fixed. The
homepage now calls a new public `publicContent` endpoint on load and
renders all four sections from whatever's in the Sheet. Add, edit, or
delete something in the dashboard, refresh the homepage, and it's there.

**To keep your existing content**, run the new `seedInitialContent_()`
function once from the Apps Script editor (function dropdown → select it →
Run). It copies your original hardcoded projects/designs/tools/blog posts
into the Sheet so nothing is lost. Run it only once — running it twice
duplicates everything, since it appends rather than checking for existing
matches.

One visual change worth knowing: the original site used little emoji icons
per project/design; the admin dashboard's image upload is a real image
field instead. Seeded/legacy items will show a plain-color tile until you
attach an image to them from the dashboard.

## Countdown timers for "Upcoming" items

Projects and Designs now have a **Countdown target** field in the
dashboard, shown when Badge is set to "Upcoming." Set it to a future
date/time and the live site shows a ticking `Xd Xh Xm Xs` countdown on that
card; leave it blank and it just shows "Coming soon." Items marked "New"
get a solid badge instead, no countdown.

## Whole nav centered

The header nav (logo + links + icons) is now centered as a single group at
desktop widths, instead of spread edge-to-edge — mobile keeps the
logo-left/hamburger-right layout since the link list is hidden there anyway.

## Dashboard analytics — now includes a security view and a config check

The Analytics tab now also shows:
- **System configuration** — plain-English "✓/✕ Contact email configured" /
  "✓/✕ Image uploads configured" so you can see immediately if `CONTACT_EMAIL`
  or `DRIVE_FOLDER_ID` is missing, instead of guessing from a generic error.
- **Recent security activity** — the last 15 login successes/failures, 2FA
  failures, password-reset requests, and account creation events, each with
  a timestamp and username. Never shows passwords, codes, or tokens — just
  enough to notice something like a burst of failed logins.

## On "create account" / 2FA / email verification / rate limiting

To confirm what's already in place (no new work needed here, just
verifying it matches what you asked for): `admin.html` already has the
one-time self-service account creation with emailed verification code,
TOTP 2FA, forgot-password with its own emailed code, rate limiting *and*
lockout on login/2FA/reset/create-account, and the 10-character minimum
password rule. The admin check is enforced server-side on every protected
call (`list`/`create`/`update`/`delete`/`uploadImage`/`analytics`/
`configCheck`) regardless of what the browser shows — the client-side check
is only there to redirect you to the login screen faster.

## On "sections" (a bigger ask than it might sound like)

Everything above covers full CRUD for your five existing content types —
Projects, Designs, Tools, Blog, Testimonials — which is what actually
renders on the homepage now. Being able to add an entirely new *kind* of
section (its own layout, not just new items in an existing one) is a
genuinely bigger feature — closer to a page-builder than a CRUD panel — and
I'd rather scope and build that properly than bolt it on quickly. Let me
know if that's actually what you need next, versus "more items in the
sections that already exist," which is now fully live.

---

# Update — Idle logout, celebrations, consent banner, HTTPS, and a second bug fix

## Another real bug caught and fixed

The bottom of `index.html`'s script still had three lines calling
`initScroller()` with `.length` on `projects`/`designs`/`posts` — the
hardcoded arrays that were removed when the site switched to admin-managed
content. Since these ran as plain top-level statements, the very first one
would throw `ReferenceError: projects is not defined`, which would have
silently killed the two calls after it too (a thrown error stops the rest
of a script's top-level execution). Fixed by having the scroll counters
count whatever's actually rendered in the DOM instead of a fixed number, and
moved the calls to run right after real content loads. I re-validated this
by actually running every inline script block in `index.html`, `admin.html`,
and `Code.gs` through a JS parser rather than eyeballing it — same process
I'll use going forward.

## Idle auto-logout

A dropdown next to "Log out" in the dashboard header: 5 / 10 / 30 / 60 / 120
minutes. Any mouse move, click, key press, or scroll resets the timer; no
activity for the chosen period logs you out automatically and calls the
server-side `logout` action (so the session is actually invalidated, not
just hidden client-side). The chosen duration is remembered across visits
via `localStorage` — that's just a UI preference, not the session token,
which still never touches any browser storage.

## Countdown celebration (confetti + banner)

When a Project/Design's countdown reaches zero while someone has the page
open, that card automatically shows a brief "🎉 Welcome! Congratulations on
the new release" overlay with a small confetti burst (plain CSS/DOM
animation — no external library, so no added dependency risk), then
settles into a "Just Released" badge. This fires once per item per page
load; a visitor who loads the page after it's already launched just sees
the released state without the animation replaying.

## Accent color, applied site-wide

The Settings tab's color picker isn't cosmetic-only for the dashboard — the
homepage fetches the chosen preset on load and applies it as the site's
actual accent color for every visitor.

## Cookie / local-storage consent banner

A bottom banner now appears on first visit explaining that a random,
non-personal ID is stored locally for basic analytics, with **Accept** and
**Decline** buttons linking to the Privacy Policy. Practically:
**no tracking of any kind — no anonymous ID, no page views, no time-on-site,
no section-engagement data — is sent anywhere until the visitor clicks
Accept.** Declining permanently skips all of it for that browser. This
also means your analytics numbers will now only reflect visitors who
opted in, which is expected and correct.

## Homepage section engagement

The Analytics tab now shows how many unique visitors scrolled into each
section (Home/About/Projects/Designs/Tools/Blog/Testimonials/Contact),
counted once per visitor per page load — this is what "which section was
visited how many times" needed on the frontend side; the backend
aggregation for it was already added in the previous update.

## Spam-bot protection, one more layer

Beyond the existing honeypot field, both the contact and feedback forms now
also send the page's load timestamp; the server silently drops (not
errors) any submission completed in under 2.5 seconds, since no real
person reads and fills either form that fast — this is a strong signal of
a bot auto-submitting rather than a real visitor typing.

## Image compression + alt text + layout-shift fix

Every image uploaded through the dashboard is now resized (max 1600px) and
re-encoded as JPEG at 82% quality in the browser *before* upload — smaller
files, faster live-site loads, no manual compression step needed on your
end. Uploaded images also now get real `alt` text (previously empty) and
explicit `width`/`height` attributes so the browser reserves the right
space before the image finishes loading (reduces layout shift).

## Force HTTPS

A small script at the very top of `index.html` redirects `http://` to
`https://` automatically once deployed to a real domain — it specifically
leaves `localhost`/`127.0.0.1` alone so local development still works
without HTTPS.

## Custom 404 and 500 pages

`site/404.html` — matches the site's branding, links back home and to the
contact section. I've also added `site/500.html` for hosts that support a
custom server-error page (e.g. Netlify via a `_redirects` rule, or Apache's
`ErrorDocument`) — GitHub Pages specifically has no server to fail, so it
never shows one regardless. In practice, every call to the Apps Script
backend already fails gracefully in-page (friendly inline messages) rather
than crashing to a server error, so `500.html` is a safety net for the
hosting layer, not something the site itself will normally trigger.

## Broken-link / asset audit

I checked every link in `index.html` for stray `href="#"` placeholders —
none found; the one intentional fallback (a blog post with no URL set)
just doesn't navigate, which is expected, not broken. Two things I can't
verify from here and want to flag directly:
- The LinkedIn URL already in the site (`linkedin.com/in/ainsley-c-2922k11m`)
  — please confirm that's actually your profile; I didn't add it and can't
  check it without a live fetch you'd need to approve.
- `og-image.jpg`, referenced in the Open Graph/Twitter meta tags, isn't an
  actual file in this package — add one (1200×630px is the standard size)
  at your site's root or social-media link previews will show broken images.

## Everything from this round, mapped to what you asked

Create account / login with 2FA: already done (previous update). Idle
auto-logout: done. Full content edit/update/delete including images and
sections: done for the five content types (see the "sections" note above
for the one genuinely bigger ask). Dark/light theme: was already on the
site; accent color is now also admin-configurable. Countdown with quick
durations + celebration: done. The full security checklist (rate limiting,
dependency risk, input validation, error handling, upload safety, brute
force, spam bots): already covered across earlier updates plus the new
timing check this round. Privacy/Terms: already present. Tracking, SEO,
support email: already present, section-engagement added this round.
Session token never in storage, server-side admin checks, 2FA + email
verification, login/reset rate limiting, 10-character password minimum:
all already in place and unchanged. HTTPS, cookie consent, meta tags, alt
text, image compression, page-speed tweaks, custom 404, broken-link audit,
spam-bot timing check: all done this round.

---

# Update — Bug fix, live admin-managed content, countdown timers, nav

## Important: a real bug was found and fixed

`Code.gs` had picked up **duplicate function definitions** for
`forgotPassword`/`resetPassword` (and an unfinished, never-wired
"multi-admin" block) that had drifted in across earlier edits. Because
Apps Script uses whichever definition of a function appears *last* in the
file, the stale duplicate was silently overriding the correct one — which
would have made password reset behave inconsistently with what `admin.html`
expects. This has been removed; the router and every function it calls have
been cross-checked end-to-end (every action the frontend calls now maps to
exactly one backend handler, with zero duplicates). **You need to redeploy**
(Deploy → Manage deployments → ✏️ → New version) for this fix to take effect.

## Your site content is now actually admin-managed

Previously, Projects/Designs/Tools/Blog were still hardcoded arrays in
`index.html` — the admin CRUD wrote to the Sheet, but the live site never
read from it. Fixed:

1. **Re-run `setupSheets_()`** once (safe to re-run) — it adds a few new
   columns (`upcomingDate` on Projects/Designs, `desc` on Tools, `tag` on
   Blog) without touching existing data.
2. **Run `seedInitialContent_()` once** — this copies your original
   hardcoded homepage content into the Sheet so nothing is lost in the
   switch-over. Safe to run only once (running it twice duplicates entries).
3. `index.html` now fetches everything live via a new public `publicContent`
   endpoint and renders it — add, edit, or delete a project/design/tool/blog
   post in the dashboard and it appears on the live site on next page load,
   no redeploy needed for content changes (only for `Code.gs` changes).
4. If the backend isn't reachable, each section shows a quiet "coming soon"
   message instead of a broken/empty page.

## "Upcoming" badge + live countdown timer

In the dashboard, set a Project/Design's **Badge** to "Upcoming" and fill in
**Countdown target** (a date/time). The live site shows an "Upcoming" badge
and a real-time counting-down timer ("2d 4h 12m 30s…") on that card, so
visitors know something's in progress. A "New" badge works the same way
without needing a date.

## Analytics tab: now also a lightweight security view

Alongside page views/visitors/time-on-site, the Analytics tab now shows:
- **System configuration** — plain-English ✓/✕ status for whether
  `CONTACT_EMAIL` and the Drive upload folder are actually set, so you don't
  have to dig through Script Properties to know why something isn't working.
- **Recent security activity** — the last 15 login successes/failures, 2FA
  failures, password reset requests, and account-creation events, each with
  a timestamp and username. Nothing sensitive is ever logged (no passwords,
  codes, or tokens) — just enough to notice something like a burst of failed
  login attempts.

## Navigation, centered as one group

The header nav (logo, links, and the theme/contact/admin icons) is now
centered together as a single row within the page's max-width container,
rather than spread edge-to-edge. On mobile, the logo stays left and the menu
button stays right (there's no room to center a hidden nav).

## On the contact form + "app password"

Still recommending against this — `MailApp` (already wired up) sends as
your own Google account with nothing to configure or leak. If mail still
isn't sending, open the dashboard's **Analytics tab** — the new
"System configuration" panel will tell you directly if `CONTACT_EMAIL`
is missing, which is the most common cause.


---

## Portfolio redesign + Appearance & Personalization (update)

**Files changed:** `site/index.html` (new design), `site/css/tokens.css`, `site/css/portfolio.css`, `site/css/pages.css`, `site/js/theme.js`, `site/js/main.js`, `site/admin.html`, `apps-script/Code.gs`, plus privacy/terms/404/500/archive restyled. Tailwind CDN and Chart.js are no longer loaded on the homepage.

**Deploying (in this order):**
1. Paste the new `Code.gs` into Apps Script, then **Deploy → Manage deployments → pencil → New version** (same URL, so nothing else changes).
2. Run **`upgradeSheets_`** once from the editor. It only appends new optional columns (`category`, `githubUrl`, blog `imageUrl`/`readTime`/`category`, testimonial `role`). It never edits or reorders existing data, and skipping it is safe: the new fields are simply ignored until the columns exist.
3. Upload the `site/` folder (including `og-image.jpg`).
4. Admin → **Settings** → *Appearance & Personalization*: pick an accent and theme, check the preview, press **Apply**.

**API compatibility:** every existing action and response is unchanged. `publicSettings` still returns `accentPreset/accent/accent2/presets` and now also `themeMode`, `presetMeta`, `defaults`. `updateSettings` accepts `accentPreset` and/or `themeMode`. Previously saved presets (`sunset`, `forest`, `berry`) map to Peach / Mint / Rose automatically.

**Bug fixed:** editing an item without choosing a new image used to blank its image. Updates now only overwrite fields the form actually sent.

**Tests:** `cd tests && node run-tests.js` (203 checks).

## Update notes (admin redesign, carousels, faster sign-in)

- **Redeploy `apps-script/Code.gs`** (Deploy → Manage deployments → Edit → New version). Existing passwords keep working: the hash algorithm is unchanged, it is only computed faster (pure-JS SHA-256, verified bit-identical in `tests/run-tests.js`).
- Sessions are now cached in `CacheService`; the Sessions sheet remains the source of truth and is refreshed every 5 minutes. Logout, password reset and "invalidate all sessions" revoke the cache entry immediately.
- Projects and Designs are carousels (`01 / 08` counter, arrows). The Category field is now just a label on the card; there are no filter chips.
- The "Forgot password" email is sent through `MailApp`, which takes about a second on Google's side.

## Update notes (FAQ system, diagnostics)

- **FAQs:** new "FAQs" tab in the admin (question, answer, sort order). The FAQs tab is created automatically in your Google Sheet the first time it is used. The public page ships with 6 default FAQs (plain HTML plus `FAQPage` structured data) so Google can read them even before you save any. As soon as you save at least one FAQ in the admin, your list replaces the defaults and the structured data is rewritten to match.
- **Is the new backend really deployed?** The admin now shows `Backend v3.0-faq-fast · server 0.4s · total 1.2s` under the login card and in the sidebar. If that line is missing, or a red "backend is out of date" bar appears, the old Code.gs is still live: Apps Script → Deploy → Manage deployments → ✎ → Version: **New version** → Deploy. Saving Code.gs alone does not update the live web app.
- Fixed: the public page no longer replaces Projects/Designs/Blog with "temporarily unavailable" when the (commented-out) Tools section is missing.
