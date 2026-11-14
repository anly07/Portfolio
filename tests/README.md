# Backend test suite

Runs the real `Code.gs` inside a strict simulation of the Google Apps Script
environment and checks it end-to-end — including a static audit that every
Google API method it calls actually exists (this is exactly what would have
caught the `computeHmacSha1Signature` bug immediately instead of after many
rounds of live troubleshooting).

## Run it

```
cd tests
node run-tests.js
```

No install needed — only built-in Node modules. 171 checks across setup,
account creation, the full login → 2FA → session flow (with real RFC 6238
test vectors, not just internal self-consistency), CRUD, uploads, analytics,
settings, contact/feedback spam protection, brute-force lockouts, session
expiry, and password reset.

Re-run this after any change to `Code.gs`, before deploying.

## Troubleshooting a live "Something went wrong" error

`Code.gs` has a built-in, off-by-default debug switch. If you ever see a
generic server error again: in the Apps Script editor, Project Settings →
Script Properties → add `DEBUG_ERRORS` = `true`. The next error response
will include a `detail` field with the real cause. **Turn it back off**
(delete the property or set it to `false`) once you're done — it's meant
for you to diagnose your own deployment, not to stay on permanently.
