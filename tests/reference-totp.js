const crypto = require('crypto');

const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

function base32Decode(str) {
  str = str.toUpperCase().replace(/=+$/, '');
  let bits = '';
  for (const ch of str) { const i = ALPHABET.indexOf(ch); if (i !== -1) bits += i.toString(2).padStart(5, '0'); }
  const bytes = [];
  for (let i = 0; i + 8 <= bits.length; i += 8) bytes.push(parseInt(bits.substr(i, 8), 2));
  return Buffer.from(bytes);
}

// Independent RFC 6238 implementation on Node's crypto (NOT derived from Code.gs).
// `nowMs` is injectable so tests can pin the clock and never flake at a 30s boundary.
function computeTotp(secretBase32, stepOffset = 0, nowMs = Date.now()) {
  const counter = Math.floor(nowMs / 1000 / 30) + stepOffset;
  const msg = Buffer.alloc(8);
  msg.writeUInt32BE(Math.floor(counter / 0x100000000), 0);
  msg.writeUInt32BE(counter >>> 0, 4);
  const h = crypto.createHmac('sha1', base32Decode(secretBase32)).update(msg).digest();
  const o = h[h.length - 1] & 0x0f;
  const code = ((h[o] & 0x7f) << 24) | ((h[o + 1] & 0xff) << 16) | ((h[o + 2] & 0xff) << 8) | (h[o + 3] & 0xff);
  return String(code % 1000000).padStart(6, '0');
}

module.exports = { computeTotp, base32Decode };
