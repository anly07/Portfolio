const crypto = require('crypto');

// ---------------------------------------------------------------------------
// Fake Sheets (in-memory, 1-indexed like real Apps Script Range API)
// ---------------------------------------------------------------------------
class FakeRange {
  constructor(sheet, row, col, numRows, numCols) {
    this.sheet = sheet; this.row = row; this.col = col; this.numRows = numRows; this.numCols = numCols;
  }
  setValues(values) {
    for (let r = 0; r < values.length; r++)
      for (let c = 0; c < values[r].length; c++)
        this.sheet._set(this.row + r, this.col + c, values[r][c]);
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
  _set(row1, col1, val) {
    const r = row1 - 1, c = col1 - 1;
    while (this.data.length <= r) this.data.push([]);
    while (this.data[r].length <= c) this.data[r].push('');
    this.data[r][c] = val;
  }
  _get(row1, col1) {
    const r = row1 - 1, c = col1 - 1;
    if (!this.data[r]) return '';
    return this.data[r][c] === undefined ? '' : this.data[r][c];
  }
  getRange(row, col, numRows, numCols) { return new FakeRange(this, row, col, numRows || 1, numCols || 1); }
  getLastColumn() { let m = 0; this.data.forEach(row => { if (row.length > m) m = row.length; }); return m; }
  getLastRow() { return this.data.length; }
  getDataRange() { return this.getRange(1, 1, this.data.length, this.getLastColumn()); }
  appendRow(rowArr) { this.getRange(this.data.length + 1, 1, 1, rowArr.length).setValues([rowArr]); }
  deleteRow(row1) { this.data.splice(row1 - 1, 1); }
}

class FakeSpreadsheet {
  constructor() { this.sheets = {}; }
  getSheetByName(name) { return this.sheets[name] || null; }
  insertSheet(name) { const s = new FakeSheet(name); this.sheets[name] = s; return s; }
}

const fakeSS = new FakeSpreadsheet();
const SpreadsheetApp = { openById: () => fakeSS };

// ---------------------------------------------------------------------------
// PropertiesService / CacheService
// ---------------------------------------------------------------------------
const scriptProps = {};
const PropertiesService = {
  getScriptProperties: () => ({
    getProperty: (k) => (k in scriptProps ? scriptProps[k] : null),
    setProperty: (k, v) => { scriptProps[k] = v; }
  })
};

const cacheStore = {};
const CacheService = {
  getScriptCache: () => ({
    get: (k) => (k in cacheStore ? cacheStore[k] : null),
    put: (k, v) => { cacheStore[k] = v; },
    remove: (k) => { delete cacheStore[k]; }
  })
};

// ---------------------------------------------------------------------------
// Utilities — real crypto, matching Apps Script's signed-byte-array convention
// ---------------------------------------------------------------------------
const toSignedArr = (buf) => Array.from(buf).map(b => (b > 127 ? b - 256 : b));
const toUnsignedBuf = (arr) => Buffer.from(arr.map(b => (b < 0 ? b + 256 : b)));

const Utilities = {
  getUuid: () => crypto.randomUUID(),
  computeDigest: (_algo, str) => toSignedArr(crypto.createHash('sha256').update(Buffer.from(String(str), 'utf8')).digest()),
  DigestAlgorithm: { SHA_256: 'SHA_256' },
  Charset: { UTF_8: 'UTF_8' },
  computeHmacSha1Signature: (value, key) =>
    toSignedArr(crypto.createHmac('sha1', toUnsignedBuf(key)).update(toUnsignedBuf(value)).digest()),
  base64Decode: (b64) => toSignedArr(Buffer.from(b64, 'base64')),
  newBlob: (bytes, mimeType, name) => ({ bytes, mimeType, name }),
  formatDate: (date, _tz, fmt) => {
    // Minimal formatter covering the two patterns Code.gs actually uses.
    const months = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
    if (fmt === 'MMM') return months[date.getMonth()];
    if (fmt === 'd MMM') return date.getDate() + ' ' + months[date.getMonth()];
    if (fmt === 'yyyy-MM-dd') return date.toISOString().slice(0, 10);
    return date.toISOString();
  }
};

// ---------------------------------------------------------------------------
// ContentService / Session / Logger
// ---------------------------------------------------------------------------
const ContentService = {
  createTextOutput: (text) => ({ _text: text, setMimeType(mt) { this._mimeType = mt; return this; } }),
  MimeType: { JSON: 'JSON' }
};
const Session = { getScriptTimeZone: () => 'Etc/UTC' };
const Logger = { log: (...args) => { /* silent unless DEBUG */ if (process.env.DEBUG) console.log('[gs]', ...args); } };

// ---------------------------------------------------------------------------
// MailApp / DriveApp
// ---------------------------------------------------------------------------
const sentEmails = [];
const MailApp = { sendEmail: (opts) => { sentEmails.push(opts); } };

const DriveApp = {
  getFolderById: () => ({
    createFile: () => ({ getId: () => 'fake-file-id-123', setSharing: () => {} })
  }),
  Access: { ANYONE_WITH_LINK: 'ANYONE_WITH_LINK' },
  Permission: { VIEW: 'VIEW' }
};

module.exports = {
  SpreadsheetApp, PropertiesService, CacheService, Utilities,
  ContentService, Session, Logger, MailApp, DriveApp,
  _internals: { scriptProps, cacheStore, sentEmails, fakeSS }
};
