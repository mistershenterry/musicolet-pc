// Vault for songs downloaded from the Song Library. They're stored encrypted (AES-256-CTR) under random file names in a
// randomly named, hidden folder inside the app's data folder, so they can only be played in Musicolet PC.
//
// The key is random per install and protected by the operating system (Electron safeStorage = Windows DPAPI, tied
// to your Windows account), so it isn't stored anywhere in readable form. A key written into the app's code would
// be pointless: the repository is public.
//
// This stops copying songs out of the app; it can't stop someone determined (the app must decrypt to play),
// which is true for every app with offline downloads.
// CTR mode allows decrypting any byte range on its own, which is what seeking needs.
const { safeStorage } = require('electron');
const crypto = require('crypto');
const path = require('path');
const fs = require('fs');
const { execFile } = require('child_process');
const { Readable } = require('stream');

const ALGO = 'aes-256-ctr';

// The 16-byte IV for the AES block that contains byte `offset`: base IV + block number (128-bit big-endian add).
function ivAt(iv, offset) {
  const out = Buffer.from(iv);
  let carry = BigInt(Math.floor(offset / 16));
  for (let i = 15; i >= 0 && carry > 0n; i--) {
    const sum = BigInt(out[i]) + (carry & 0xffn);
    out[i] = Number(sum & 0xffn);
    carry = (carry >> 8n) + (sum >> 8n);
  }
  return out;
}

class Vault {
  // state: { dir, key, protected } kept in library.json; created on first use.
  constructor(userDir, state, save) {
    this.userDir = userDir;
    this.state = state || {};
    this.save = save;
  }

  get dir() {
    if (!this.state.dir) {
      this.state.dir = crypto.randomBytes(8).toString('hex');
      this.save(this.state);
    }
    const dir = path.join(this.userDir, this.state.dir);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
      if (process.platform === 'win32') execFile('attrib', ['+h', '+s', dir], () => {});
    }
    return dir;
  }

  get key() {
    if (this._key) return this._key;
    if (this.state.key) {
      const stored = Buffer.from(this.state.key, 'base64');
      this._key = this.state.protected ? Buffer.from(safeStorage.decryptString(stored), 'hex') : stored;
    } else {
      this._key = crypto.randomBytes(32);
      const canProtect = safeStorage.isEncryptionAvailable();
      this.state.key = (canProtect ? safeStorage.encryptString(this._key.toString('hex')) : this._key).toString('base64');
      this.state.protected = canProtect;
      this.save(this.state);
    }
    return this._key;
  }

  contains(file) {
    if (!this.state.dir) return false;
    const rel = path.relative(path.join(this.userDir, this.state.dir), file);
    return !!rel && !rel.startsWith('..') && !path.isAbsolute(rel);
  }

  // Encrypt a downloaded song into the vault. Returns where it went and its IV (kept with the library entry).
  store(plain) {
    const iv = crypto.randomBytes(16);
    const cipher = crypto.createCipheriv(ALGO, this.key, iv);
    const file = path.join(this.dir, crypto.randomBytes(12).toString('hex'));
    fs.writeFileSync(file, Buffer.concat([cipher.update(plain), cipher.final()]));
    return { file, iv: iv.toString('hex') };
  }

  // Whole song, decrypted in memory (for reading lyrics).
  readAll(file, ivHex) {
    const decipher = crypto.createDecipheriv(ALGO, this.key, Buffer.from(ivHex, 'hex'));
    return Buffer.concat([decipher.update(fs.readFileSync(file)), decipher.final()]);
  }

  // Decrypted bytes start..end (inclusive) as a web stream, for playback and seeking.
  stream(file, ivHex, start, end) {
    const aligned = start - (start % 16);
    const decipher = crypto.createDecipheriv(ALGO, this.key, ivAt(Buffer.from(ivHex, 'hex'), aligned));
    let skip = start - aligned;
    const source = fs.createReadStream(file, { start: aligned, end });
    const out = source.pipe(decipher).pipe(
      new (require('stream').Transform)({
        transform(chunk, _enc, cb) {
          if (skip > 0) {
            const drop = Math.min(skip, chunk.length);
            chunk = chunk.subarray(drop);
            skip -= drop;
          }
          cb(null, chunk);
        },
      }),
    );
    source.on('error', (err) => out.destroy(err));
    return Readable.toWeb(out);
  }
}

module.exports = { Vault, ivAt };
