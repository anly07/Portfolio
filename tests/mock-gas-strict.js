/**
 * Strict simulation of the Google Apps Script services Code.gs uses.
 *
 * WHY "STRICT": an earlier mock defined `Utilities.computeHmacSha1Signature`
 * — a method that does NOT exist in the real Apps Script API — so tests passed
 * while the live site crashed. Every service here is wrapped in a Proxy that
 * THROWS if code touches a member that isn't in the real reference, so an
 * invented API can never silently pass again.
 *
 * Only members listed in Google's reference (developers.google.com/apps-script/
 * reference) are implemented.
 */
const crypto = require('crypto');

function strict(name, target) {
  return new Proxy(target, {
    get(t, prop, recv) {
      if (typeof prop === 'symbol' || prop === 'then' || prop === 'toJSON' || prop === 'inspect') return Reflect.get(t, prop, recv);
      if (!(prop in t)) throw new TypeError(`${name}.${String(prop)} is not a real Apps Script API member (not implemented in strict mock)`);
      return t[prop];
    }
  });
}

// ---------------------------------------------------------------------------
// Sheets (in-memory, 1-indexed like the real Range API)
// ---------------------------------------------------------------------------
class FakeRange {
  constructor(sheet, row, col, numRows, numCols) { Object.assign(this, { sheet, row, col, numRows, numCols }); }
  setValues(values) {
    values.forEach((rowVals, r) => rowVals.forEach((v, c) => this.sheet._set(this.row + r, this.col + c, v)));
    return this;
  }
  getValues() {
    const out = [];
    for (let r = 0; r < this.numRows; r++) {
      const row = [];
      for (let c = 0; c < this.numCols; c++) row.push(this.sheet._get(this.row + r, this.col + c));
      out.push(row);
    }
    return out;
  }
  setValue(v) { this.sheet._set(this.row, this.col, v); return this; }
  getValue() { return this.sheet._get(this.row, this.col); }
}
class FakeSheet {
  constructor(name) { this.name = name; this.data = []; }
  _set(r1, c1, v) {
    while (this.data.length < r1) this.data.push([]);
    while (this.data[r1 - 1].length < c1) this.data[r1 - 1].push('');
    this.data[r1 - 1][c1 - 1] = v;
  }
  _get(r1, c1) { const row = this.data[r1 - 1]; return row && row[c1 - 1] !== undefined ? row[c1 - 1] : ''; }
  getRange(row, col, numRows, numCols) { return new FakeRange(this, row, col, numRows || 1, numCols || 1); }
  getLastColumn() { return this.data.reduce((m, r) => Math.max(m, r.length), 0); }
  getLastRow() { return this.data.length; }
  getDataRange() { return this.getRange(1, 1, this.data.length, this.getLastColumn()); }
  appendRow(arr) { this.getRange(this.data.length + 1, 1, 1, arr.length).setValues([arr]); }
  deleteRow(r1) { this.data.splice(r1 - 1, 1); }
}
const fakeSS = { sheets: {},
  getSheetByName(n) { return this.sheets[n] || null; },
  insertSheet(n) { return (this.sheets[n] = new FakeSheet(n)); } };

// ---------------------------------------------------------------------------
// Stores
// ---------------------------------------------------------------------------
const scriptProps = {};
const cacheStore = {};
const sentEmails = [];
const logLines = [];

const signed = (buf) => Array.from(buf).map((b) => (b > 127 ? b - 256 : b));

// ---------------------------------------------------------------------------
// Services — ONLY real members
// ---------------------------------------------------------------------------
const Utilities = strict('Utilities', {
  getUuid: () => crypto.randomUUID(),
  computeDigest: (algo, value /*, charset */) => {
    if (algo !== 'SHA_256') throw new Error('mock only supports SHA_256');
    return signed(crypto.createHash('sha256').update(Buffer.from(String(value), 'utf8')).digest());
  },
  base64Decode: (b64) => signed(Buffer.from(b64, 'base64')),
  newBlob: (bytes, mimeType, name) => ({ bytes, mimeType, name }),
  formatDate: (date, _tz, fmt) => {
    const M = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
    if (fmt === 'MMM') return M[date.getMonth()];
    if (fmt === 'd MMM') return date.getDate() + ' ' + M[date.getMonth()];
    if (fmt === 'yyyy-MM-dd') return date.toISOString().slice(0, 10);
    throw new Error('mock formatDate: unsupported pattern ' + fmt);
  },
  DigestAlgorithm: strict('Utilities.DigestAlgorithm', { SHA_256: 'SHA_256' }),
  Charset: strict('Utilities.Charset', { UTF_8: 'UTF_8' })
});

const SpreadsheetApp = strict('SpreadsheetApp', { openById: () => fakeSS });

const PropertiesService = strict('PropertiesService', {
  getScriptProperties: () => strict('ScriptProperties', {
    getProperty: (k) => (k in scriptProps ? scriptProps[k] : null),
    setProperty: (k, v) => { scriptProps[k] = String(v); },
    deleteProperty: (k) => { delete scriptProps[k]; }
  })
});

const CacheService = strict('CacheService', {
  getScriptCache: () => strict('Cache', {
    get: (k) => (k in cacheStore ? cacheStore[k] : null),
    put: (k, v, ttl) => {
      if (String(k).length > 250) throw new Error('Cache key too long (real limit: 250 chars)');
      if (ttl !== undefined && (ttl < 0 || ttl > 21600)) throw new Error('Cache TTL out of range (real limit: 21600s)');
      cacheStore[k] = String(v);
    },
    remove: (k) => { delete cacheStore[k]; }
  })
});

const ContentService = strict('ContentService', {
  createTextOutput: (text) => ({ _text: text, setMimeType(mt) { this._mime = mt; return this; } }),
  MimeType: strict('ContentService.MimeType', { JSON: 'JSON' })
});

const Session = strict('Session', { getScriptTimeZone: () => 'Etc/UTC' });
const Logger = strict('Logger', { log: (...a) => { logLines.push(a.join(' ')); if (process.env.DEBUG) console.log('[gs]', ...a); } });

const MailApp = strict('MailApp', {
  sendEmail: (opts) => {
    if (typeof opts !== 'object' || !opts.to || !opts.subject) throw new Error('MailApp.sendEmail needs {to, subject, body}');
    sentEmails.push(opts);
  }
});

const DriveApp = strict('DriveApp', {
  getFolderById: () => strict('Folder', {
    createFile: () => strict('File', { getId: () => 'fake-file-id-123', setSharing: () => {} })
  }),
  Access: strict('DriveApp.Access', { ANYONE_WITH_LINK: 'ANYONE_WITH_LINK' }),
  Permission: strict('DriveApp.Permission', { VIEW: 'VIEW' })
});

module.exports = {
  globals: { SpreadsheetApp, PropertiesService, CacheService, Utilities, ContentService, Session, Logger, MailApp, DriveApp },
  state: { scriptProps, cacheStore, sentEmails, logLines, fakeSS },
  // The exact members of each service that are real. Used by the static API scan.
  REAL_API: {
    Utilities: ['getUuid','computeDigest','base64Decode','newBlob','formatDate','DigestAlgorithm','Charset','base64Encode','computeHmacSignature','computeHmacSha256Signature'],
    SpreadsheetApp: ['openById'],
    PropertiesService: ['getScriptProperties'],
    CacheService: ['getScriptCache'],
    ContentService: ['createTextOutput','MimeType'],
    Session: ['getScriptTimeZone'],
    Logger: ['log'],
    MailApp: ['sendEmail'],
    DriveApp: ['getFolderById','Access','Permission']
  }
};
