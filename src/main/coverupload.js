// Uploads a song's own cover (the one shown in the app) to Litterbox so Discord can display it.
// Discord can only show images that are online. Litterbox deletes uploads after 72 hours;
// each cover is uploaded once and its link reused until shortly before it expires.
const { nativeImage } = require('electron');
const path = require('path');
const fs = require('fs');

const API = 'https://litterbox.catbox.moe/resources/internals/api.php';
const EXPIRY = '72h';
const REUSE_MS = 70 * 3600 * 1000; // re-upload a little before Litterbox deletes the file
const FAIL_RETRY_MS = 60 * 1000; // after all attempts failed, try again a minute later
const ATTEMPT_DELAYS_MS = [0, 3000, 10000]; // Litterbox sometimes refuses or answers very slowly; retry
const UPLOAD_TIMEOUT_MS = 45000; // uploads normally take 1-15 s but can take longer
const MAX_SIZE = 512; // Discord shows covers small; this keeps uploads quick

class CoverUploader {
  constructor(coverDir, cacheFile) {
    this.coverDir = coverDir;
    this.file = cacheFile;
    this.pending = new Map();
    try {
      this.cache = JSON.parse(fs.readFileSync(cacheFile, 'utf8'));
    } catch {
      this.cache = {};
    }
  }

  // Covers are rewritten in place when tags are edited, so the key includes the file's modified time.
  key(name) {
    const file = path.join(this.coverDir, path.basename(name));
    try {
      return { file, key: `${path.basename(name)}@${Math.round(fs.statSync(file).mtimeMs)}` };
    } catch {
      return { file, key: null };
    }
  }

  // Cached result without uploading: a URL, null (recent failure), or undefined (not uploaded yet).
  peek(name) {
    const { key } = this.key(name);
    if (!key) return null;
    const hit = this.cache[key];
    if (!hit) return undefined;
    if (!hit.url) return Date.now() - hit.at < FAIL_RETRY_MS ? null : undefined;
    return Date.now() - hit.at < REUSE_MS ? hit.url : undefined;
  }

  async get(name) {
    const cached = this.peek(name);
    if (cached !== undefined) return cached;
    const { file, key } = this.key(name);
    if (this.pending.has(key)) return this.pending.get(key);
    const job = this.uploadWithRetry(file)
      .then((url) => {
        this.cache[key] = { url, at: Date.now() };
        return url;
      })
      .catch((err) => {
        const error = [err?.message, err?.cause?.message].filter(Boolean).join(': ');
        if (process.env.MUSICOLET_PC_DEBUG) console.log('[cover upload failed]', error);
        // The reason is kept in discord-uploads.json to make failures easy to diagnose.
        this.cache[key] = { url: null, at: Date.now(), error };
        return null;
      })
      .finally(() => {
        this.pending.delete(key);
        this.prune();
        this.save();
      });
    this.pending.set(key, job);
    return job;
  }

  async uploadWithRetry(file) {
    let lastError;
    for (const delay of ATTEMPT_DELAYS_MS) {
      if (delay) await new Promise((r) => setTimeout(r, delay));
      try {
        return await this.upload(file);
      } catch (err) {
        lastError = err;
        if (err.message === 'unreadable image') break; // retrying won't help
      }
    }
    throw lastError;
  }

  async upload(file) {
    let img = nativeImage.createFromPath(file);
    if (img.isEmpty()) throw new Error('unreadable image');
    const { width, height } = img.getSize();
    if (Math.max(width, height) > MAX_SIZE) {
      img = width >= height ? img.resize({ width: MAX_SIZE, quality: 'best' }) : img.resize({ height: MAX_SIZE, quality: 'best' });
    }
    const form = new FormData();
    form.append('reqtype', 'fileupload');
    form.append('time', EXPIRY);
    form.append('fileToUpload', new Blob([img.toJPEG(88)], { type: 'image/jpeg' }), 'cover.jpg');
    const res = await fetch(API, { method: 'POST', body: form, signal: AbortSignal.timeout(UPLOAD_TIMEOUT_MS) });
    const text = (await res.text()).trim();
    if (!res.ok || !/^https:\/\/litter\.catbox\.moe\/[\w.-]+$/.test(text)) {
      throw new Error(`Litterbox answered HTTP ${res.status}: ${text.replace(/\s+/g, ' ').slice(0, 120)}`);
    }
    return text;
  }

  // Forget links that have expired anyway.
  prune() {
    const now = Date.now();
    for (const [k, v] of Object.entries(this.cache)) if (now - v.at > REUSE_MS) delete this.cache[k];
  }

  save() {
    try {
      fs.writeFileSync(this.file, JSON.stringify(this.cache));
    } catch {
      // cache is only an optimization
    }
  }
}

module.exports = { CoverUploader };
