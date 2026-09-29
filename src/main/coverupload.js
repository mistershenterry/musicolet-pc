// Uploads a song's own cover (the one shown in the app) to a temporary image host so Discord can display it.
// Discord can only show images that are online. Each cover is uploaded once and its link reused until
// shortly before the host deletes it.
//
// Hosts (the user picks the primary in Settings, default uguu.se; the other one is the backup):
//   - uguu.se - deletes files after 3 hours.
//   - Litterbox (litterbox.catbox.moe) - deletes files after 72 hours.
// A host that fails (or blocks uploads with HTTP 403) is followed by the other one.
const { nativeImage } = require('electron');
const path = require('path');
const fs = require('fs');

const HOSTS = [
  {
    name: 'litterbox',
    reuseMs: 70 * 3600 * 1000, // files live 72 h
    attemptDelaysMs: [0, 3000, 10000], // Litterbox sometimes answers very slowly or with a server error
    async upload(jpeg, signal) {
      const form = new FormData();
      form.append('reqtype', 'fileupload');
      form.append('time', '72h');
      form.append('fileToUpload', new Blob([jpeg], { type: 'image/jpeg' }), 'cover.jpg');
      const res = await fetch('https://litterbox.catbox.moe/resources/internals/api.php', { method: 'POST', body: form, signal });
      const text = (await res.text()).trim();
      if (!res.ok || !/^https:\/\/litter\.catbox\.moe\/[\w.-]+$/.test(text)) throw hostError('Litterbox', res.status, text);
      return text;
    },
  },
  {
    name: 'uguu',
    reuseMs: 2.5 * 3600 * 1000, // files live 3 h
    attemptDelaysMs: [0, 3000],
    async upload(jpeg, signal) {
      const form = new FormData();
      form.append('files[]', new Blob([jpeg], { type: 'image/jpeg' }), 'cover.jpg');
      const res = await fetch('https://uguu.se/upload', { method: 'POST', body: form, signal });
      const text = await res.text();
      let url = null;
      try {
        url = JSON.parse(text)?.files?.[0]?.url;
      } catch {
        // not JSON: an error page
      }
      if (!res.ok || !/^https:\/\/[\w.-]*uguu\.se\/[\w.-]+$/.test(url || '')) throw hostError('uguu.se', res.status, text);
      return url;
    },
  },
];

const UPLOAD_TIMEOUT_MS = 45000; // uploads normally take 1-15 s but can take longer
const FAIL_RETRY_MS = 60 * 1000; // after every host failed, try again a minute later
const BLOCKED_PAUSE_MS = 30 * 60 * 1000; // a host that answered 403 is skipped for 30 minutes
const MAX_SIZE = 512; // Discord shows covers small; this keeps uploads quick

function hostError(host, status, body) {
  const title = /<title>(.*?)<\/title>/i.exec(body)?.[1];
  const err = new Error(`${host} answered HTTP ${status}: ${(title || body).replace(/\s+/g, ' ').trim().slice(0, 120)}`);
  err.status = status;
  return err;
}

class CoverUploader {
  constructor(coverDir, cacheFile) {
    this.coverDir = coverDir;
    this.file = cacheFile;
    this.pending = new Map();
    this.blockedUntil = {}; // host name -> time until which it is skipped
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

  reuseMs(entry) {
    return (HOSTS.find((h) => h.name === entry.host) || HOSTS[0]).reuseMs;
  }

  // Cached result without uploading: a URL, null (recent failure), or undefined (not uploaded yet).
  peek(name) {
    const { key } = this.key(name);
    if (!key) return null;
    const hit = this.cache[key];
    if (!hit) return undefined;
    if (!hit.url) return Date.now() - hit.at < FAIL_RETRY_MS ? null : undefined;
    return Date.now() - hit.at < this.reuseMs(hit) ? hit.url : undefined;
  }

  // primary: name of the host to try first ('uguu' or 'litterbox').
  async get(name, primary) {
    const cached = this.peek(name);
    if (cached !== undefined) return cached;
    const { file, key } = this.key(name);
    if (this.pending.has(key)) return this.pending.get(key);
    const job = this.uploadAnywhere(file, primary)
      .then(({ url, host }) => {
        this.cache[key] = { url, host, at: Date.now() };
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

  async uploadAnywhere(file, primary = 'uguu') {
    const jpeg = this.prepare(file);
    const errors = [];
    const order = [...HOSTS].sort((a, b) => (b.name === primary) - (a.name === primary));
    for (const host of order) {
      if ((this.blockedUntil[host.name] || 0) > Date.now()) {
        errors.push(`${host.name} skipped (it refused uploads recently)`);
        continue;
      }
      for (const delay of host.attemptDelaysMs) {
        if (delay) await new Promise((r) => setTimeout(r, delay));
        try {
          const url = await host.upload(jpeg, AbortSignal.timeout(UPLOAD_TIMEOUT_MS));
          if (process.env.MUSICOLET_PC_DEBUG) console.log(`[cover uploaded to ${host.name}]`, url);
          return { url, host: host.name };
        } catch (err) {
          errors.push([err?.message, err?.cause?.code || err?.cause?.message].filter(Boolean).join(': '));
          if (err.status === 403) {
            // Blocked (usually a rate limit): asking again only prolongs it, so use the next host for a while.
            this.blockedUntil[host.name] = Date.now() + BLOCKED_PAUSE_MS;
            break;
          }
        }
      }
    }
    throw new Error(errors.join(' | '));
  }

  prepare(file) {
    let img = nativeImage.createFromPath(file);
    if (img.isEmpty()) throw new Error('unreadable image');
    const { width, height } = img.getSize();
    if (Math.max(width, height) > MAX_SIZE) {
      img = width >= height ? img.resize({ width: MAX_SIZE, quality: 'best' }) : img.resize({ height: MAX_SIZE, quality: 'best' });
    }
    return img.toJPEG(88);
  }

  // Forget links that have expired anyway.
  prune() {
    const now = Date.now();
    for (const [k, v] of Object.entries(this.cache)) {
      if (now - v.at > (v.url ? this.reuseMs(v) : FAIL_RETRY_MS)) delete this.cache[k];
    }
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
