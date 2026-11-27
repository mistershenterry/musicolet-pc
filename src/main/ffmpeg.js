// "Use ffmpeg" for Play speed & pitch: if ffmpeg is installed, songs played at another speed/pitch are processed
// by ffmpeg (rubberband filter when available, else atempo/asetrate) instead of the built-in time stretching, which
// sounds much smoother for very slowed songs. The result is a WAV kept in a cache folder in userData, encrypted with
// the vault key like downloaded songs (so a downloaded song never ends up on disk as a plain file), and played
// through mco://fx/<key>. ffmpeg is never bundled: we only use the user's own install.
const { execFile, spawn } = require('child_process');
const crypto = require('crypto');
const path = require('path');
const fs = require('fs');

const RENDER_VERSION = 1; // bump when the filters change, so old renders aren't reused
const CACHE_LIMIT = 2 * 1024 * 1024 * 1024; // keep the cache under 2 GB (oldest renders go first)
const DETECT_TTL = 30 * 1000;

function run(file, args, timeout = 8000) {
  return new Promise((resolve) => {
    execFile(file, args, { timeout, windowsHide: true, maxBuffer: 4 * 1024 * 1024 }, (err, stdout) => resolve(err ? null : String(stdout)));
  });
}

// Places ffmpeg usually ends up on Windows besides PATH (winget, scoop, chocolatey, manual installs).
function candidates() {
  const env = process.env;
  const list = ['ffmpeg'];
  if (process.platform === 'win32') {
    list.push(
      env.LOCALAPPDATA && path.join(env.LOCALAPPDATA, 'Microsoft', 'WinGet', 'Links', 'ffmpeg.exe'),
      env.USERPROFILE && path.join(env.USERPROFILE, 'scoop', 'shims', 'ffmpeg.exe'),
      env.ProgramData && path.join(env.ProgramData, 'chocolatey', 'bin', 'ffmpeg.exe'),
      env.ProgramFiles && path.join(env.ProgramFiles, 'ffmpeg', 'bin', 'ffmpeg.exe'),
      'C:\\ffmpeg\\bin\\ffmpeg.exe',
    );
  } else {
    list.push('/opt/homebrew/bin/ffmpeg', '/usr/local/bin/ffmpeg', '/usr/bin/ffmpeg');
  }
  return list.filter(Boolean);
}

// The RIFF and data sizes of a WAV written to a pipe are placeholders; fix them now that the whole file is here.
function fixWavHeader(buf) {
  if (buf.length < 12 || buf.toString('ascii', 0, 4) !== 'RIFF') return buf;
  buf.writeUInt32LE(Math.min(0xffffffff, buf.length - 8), 4);
  let off = 12;
  while (off + 8 <= buf.length) {
    const id = buf.toString('ascii', off, off + 4);
    if (id === 'data') {
      buf.writeUInt32LE(Math.min(0xffffffff, buf.length - off - 8), off + 4);
      break;
    }
    off += 8 + buf.readUInt32LE(off + 4) + (buf.readUInt32LE(off + 4) & 1);
  }
  return buf;
}

class FfmpegFx {
  constructor(userDir, library, send) {
    this.dir = path.join(userDir, 'fx-cache');
    this.indexFile = path.join(this.dir, 'index.json');
    this.library = library;
    this.send = send;
    this.status = null;
    this.checkedAt = 0;
    this.jobs = new Map(); // key -> promise
    this.slots = new Map(); // slot -> { key, child }
    try {
      this.index = JSON.parse(fs.readFileSync(this.indexFile, 'utf8'));
    } catch {
      this.index = {};
    }
  }

  // { available, path, version, rubberband }
  async detect(force = false) {
    if (!force && this.status && Date.now() - this.checkedAt < DETECT_TTL) return this.status;
    let found = { available: false };
    for (const file of candidates()) {
      const out = await run(file, ['-hide_banner', '-version']);
      if (!out || !/ffmpeg version/i.test(out)) continue;
      const filters = (await run(file, ['-hide_banner', '-filters'])) || '';
      found = {
        available: true,
        path: file,
        version: (/ffmpeg version (\S+)/i.exec(out) || [])[1] || '',
        rubberband: /\brubberband\b/.test(filters),
      };
      break;
    }
    this.status = found;
    this.checkedAt = Date.now();
    return found;
  }

  saveIndex() {
    fs.mkdirSync(this.dir, { recursive: true });
    fs.writeFileSync(this.indexFile, JSON.stringify(this.index));
  }

  keyFor(file, speed, pitch, engine) {
    const st = fs.statSync(file);
    return crypto
      .createHash('sha1')
      .update(JSON.stringify([RENDER_VERSION, engine, path.resolve(file).toLowerCase(), st.size, st.mtimeMs, speed, pitch]))
      .digest('hex')
      .slice(0, 24);
  }

  filters(speed, pitch, rubberband) {
    if (rubberband) {
      // Long windows + smooth transients = the soft, smeared sound wanted for slowed songs.
      const slow = speed < 0.8 ? ':transients=smooth:window=long' : '';
      return `rubberband=tempo=${speed}:pitch=${pitch}:pitchq=quality:channels=together${slow}`;
    }
    // No rubberband: pitch by resampling, then fix the tempo with atempo (each atempo step works between 0.5 and 2).
    const SR = 48000;
    const parts = [`aresample=${SR}`];
    if (pitch !== 1) parts.push(`asetrate=${Math.round(SR * pitch)}`, `aresample=${SR}`);
    let tempo = speed / pitch;
    while (tempo < 0.5) {
      parts.push('atempo=0.5');
      tempo /= 0.5;
    }
    while (tempo > 2) {
      parts.push('atempo=2');
      tempo /= 2;
    }
    if (Math.abs(tempo - 1) > 1e-6) parts.push(`atempo=${tempo.toFixed(6)}`);
    return parts.join(',');
  }

  // Render a song at speed/pitch. Returns { key }. slot ('current' / 'next'): a newer request for the same slot
  // stops the older one if it's for something else.
  async render({ file, speed, pitch, slot = 'current' }) {
    const st = await this.detect();
    if (!st.available) throw new Error('ffmpeg was not found');
    if (!this.library.isAllowedMedia(file)) throw new Error('Not a library song');
    const engine = st.rubberband ? 'rubberband' : 'atempo';
    const key = this.keyFor(file, speed, pitch, engine);
    if (this.index[key] && fs.existsSync(path.join(this.dir, key))) {
      this.index[key].at = Date.now();
      this.saveIndex();
      return { key };
    }
    const prev = this.slots.get(slot);
    if (prev && prev.key !== key && prev.child && !this.isWanted(prev.key, slot)) prev.child.kill();
    if (this.jobs.has(key)) {
      this.slots.set(slot, { key, child: null });
      return this.jobs.get(key);
    }
    const job = this.runFfmpeg(st, file, speed, pitch, key, slot).finally(() => this.jobs.delete(key));
    this.jobs.set(key, job);
    return job;
  }

  isWanted(key, exceptSlot) {
    for (const [slot, s] of this.slots) if (slot !== exceptSlot && s.key === key) return true;
    return false;
  }

  runFfmpeg(st, file, speed, pitch, key, slot) {
    return new Promise((resolve, reject) => {
      const vaultInfo = this.library.vaultInfo(file);
      // Downloaded songs go to ffmpeg through a pipe (never decrypted to disk). MP4/M4A files usually keep their
      // index at the end, which ffmpeg can't reach in a pipe, so those use the built-in way.
      if (vaultInfo && /^(m4a|m4b|mp4|alac)$/i.test(vaultInfo.ext || '')) {
        return reject(new Error("this kind of downloaded file can't be sent to ffmpeg"));
      }
      const args = ['-hide_banner', '-nostdin', '-loglevel', 'error', '-stats', '-i', vaultInfo ? 'pipe:0' : file];
      if (vaultInfo) args.splice(args.indexOf('-nostdin'), 1);
      args.push('-vn', '-map_metadata', '-1', '-af', this.filters(speed, pitch, st.rubberband), '-c:a', 'pcm_s16le', '-f', 'wav', 'pipe:1');
      const child = spawn(st.path, args, { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
      this.slots.set(slot, { key, child });
      const chunks = [];
      let err = '';
      child.stdout.on('data', (c) => chunks.push(c));
      child.stderr.on('data', (c) => {
        const text = String(c);
        err = (err + text).slice(-2000);
        let m;
        let last = null;
        const re = /time=(\d+):(\d+):([\d.]+)/g;
        while ((m = re.exec(text))) last = m;
        if (last) this.send('fx:progress', { key, slot, seconds: +last[1] * 3600 + +last[2] * 60 + +last[3] });
      });
      child.stdin.on('error', () => {});
      child.on('error', (e) => reject(e));
      child.on('close', (code, signal) => {
        if (this.slots.get(slot)?.child === child) this.slots.set(slot, { key, child: null });
        if (signal || code !== 0) {
          const e = new Error(signal ? 'Stopped' : (err.split(/\r?\n/).filter((l) => l && !/^size=/.test(l)).pop() || `ffmpeg exited with ${code}`));
          e.stopped = !!signal;
          return reject(e);
        }
        try {
          const wav = fixWavHeader(Buffer.concat(chunks));
          if (wav.length < 8192) throw new Error((err.split(/\r?\n/).find((l) => l && !/^size=/.test(l)) || 'ffmpeg made no audio').trim());
          fs.mkdirSync(this.dir, { recursive: true });
          const iv = this.library.vault.encryptTo(path.join(this.dir, key), wav);
          this.index[key] = { iv, size: wav.length, at: Date.now() };
          this.trim();
          this.saveIndex();
          resolve({ key });
        } catch (e) {
          reject(e);
        }
      });
      if (vaultInfo) {
        try {
          child.stdin.end(this.library.vault.readAll(file, vaultInfo.iv));
        } catch (e) {
          child.kill();
          reject(e);
        }
      } else child.stdin.end();
    });
  }

  // Drop the oldest renders while the cache is over its limit.
  trim() {
    const keys = Object.keys(this.index).sort((a, b) => this.index[a].at - this.index[b].at);
    let total = keys.reduce((n, k) => n + (this.index[k].size || 0), 0);
    for (const k of keys) {
      if (total <= CACHE_LIMIT) break;
      total -= this.index[k].size || 0;
      delete this.index[k];
      fs.rmSync(path.join(this.dir, k), { force: true });
    }
  }

  // For mco://fx/<key>.
  info(key) {
    if (!/^[0-9a-f]{24}$/.test(key) || !this.index[key]) return null;
    return { file: path.join(this.dir, key), iv: this.index[key].iv, ext: 'wav' };
  }
}

module.exports = { FfmpegFx, fixWavHeader };
