'use strict';

// AES-256-GCM encrypt/decrypt for secrets at rest (e.g. BYOK AI provider keys,
// #41). The key is derived from the instance's JWT secret so there's no extra
// env to manage; rotating JWT_SECRET invalidates stored secrets (they're
// re-enterable). Format: base64(iv[12] | tag[16] | ciphertext).
const crypto = require('crypto');
const config = require('../config');

const KEY = crypto.createHash('sha256').update(String(config.jwtSecret) + ':secretbox-v1').digest();

function encrypt(plain) {
  if (plain == null || plain === '') return null;
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', KEY, iv);
  const enc = Buffer.concat([cipher.update(String(plain), 'utf8'), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), enc]).toString('base64');
}

function decrypt(b64) {
  if (!b64) return null;
  try {
    const buf = Buffer.from(b64, 'base64');
    const iv = buf.subarray(0, 12), tag = buf.subarray(12, 28), enc = buf.subarray(28);
    const decipher = crypto.createDecipheriv('aes-256-gcm', KEY, iv);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(enc), decipher.final()]).toString('utf8');
  } catch { return null; }
}

module.exports = { encrypt, decrypt };
