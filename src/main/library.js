// Music library: folder scanning, metadata parsing, album-art cache, lyrics and tag writing.
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const NodeID3 = require('node-id3');

const AUDIO_EXT = new Set(['.mp3', '.flac', '.ogg', '.oga', '.opus', '.m4a', '.m4b', '.aac', '.wav', '.webm', '.weba']);
const FOLDER_ART = ['cover', 'folder', 'front', 'albumart', 'album'];
const IMAGE_EXT = ['.jpg', '.jpeg', '.png', '.webp'];
const IS_WIN = process.platform === 'win32';
// 2: embedded covers are cached under a hash of the image (before: one file per album + folder).
const COVER_SCHEME = 2;

let mmPromise;
const mm = () => (mmPromise ||= import('music-metadata'));

const norm = (p) => (IS_WIN ? path.resolve(p).toLowerCase() : path.resolve(p));
const hash = (s, n = 16) => crypto.createHash('sha1').update(s).digest('hex').slice(0, n);
const trackId = (file) => hash(norm(file));

function writeJsonAtomic(file, data) {
  const tmp = file + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(data));
  fs.renameSync(tmp, file);
}

function readJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return fallback;
  }
}

async function pool(items, size, fn) {
  let i = 0;
  const workers = Array.from({ length: Math.min(size, items.length) }, async () => {
    while (i < items.length) {
      const item = items[i++];
      await fn(item);
    }
  });
  await Promise.all(workers);
}

function fmtLrcTime(ms) {
  const t = Math.max(0, ms) / 1000;
  const m = Math.floor(t / 60);
  const s = (t - m * 60).toFixed(2).padStart(5, '0');
  return `${String(m).padStart(2, '0')}:${s}`;
}

function embeddedLyrics(common) {
  const list = common.lyrics || [];
  return list
    .map((l) => {
      if (typeof l === 'string') return l;
      if (l.text) return l.text;
      if (Array.isArray(l.syncText) && l.syncText.length) {
        return l.syncText.map((s) => (s.timestamp != null ? `[${fmtLrcTime(s.timestamp)}]` : '') + s.text).join('\n');
      }
      return '';
    })
    .filter(Boolean)
    .join('\n\n');
}

const sidecarLrc = (file) => path.join(path.dirname(file), path.basename(file, path.extname(file)) + '.lrc');

class Library {
  constructor(userDir) {
    this.file = path.join(userDir, 'library.json');
    this.coverDir = path.join(userDir, 'covers');
    fs.mkdirSync(this.coverDir, { recursive: true });
    this.data = readJson(this.file, null) || { roots: [], tracks: {} };
    this.scanning = null;
  }

  get() {
    return this.data;
  }

  save() {
    writeJsonAtomic(this.file, this.data);
  }

  isAllowedMedia(file) {
    const n = norm(file);
    return this.data.roots.some((r) => {
      const root = norm(r);
      const prefix = root.endsWith(path.sep) ? root : root + path.sep;
      return n.startsWith(prefix);
    });
  }

  addRoots(dirs) {
    for (const d of dirs) {
      const n = norm(d);
      // Skip folders already covered by an existing root; drop roots covered by the new one.
      if (this.data.roots.some((r) => n === norm(r) || n.startsWith(norm(r) + path.sep))) continue;
      this.data.roots = this.data.roots.filter((r) => !norm(r).startsWith(n + path.sep));
      this.data.roots.push(path.resolve(d));
    }
    this.save();
    return this.data.roots;
  }

  removeRoot(dir) {
    this.data.roots = this.data.roots.filter((r) => norm(r) !== norm(dir));
    for (const [id, t] of Object.entries(this.data.tracks)) {
      if (!this.isAllowedMedia(t.path)) delete this.data.tracks[id];
    }
    this.save();
    return this.data;
  }

  async walk(dir, out) {
    let entries;
    try {
      entries = await fs.promises.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    // Like Musicolet on Android, a ".nomedia" file hides a folder from the library.
    if (entries.some((e) => e.isFile() && e.name.toLowerCase() === '.nomedia')) return;
    for (const e of entries) {
      if (e.name.startsWith('.') || e.name.startsWith('$')) continue;
      const full = path.join(dir, e.name);
      if (e.isDirectory()) await this.walk(full, out);
      else if (e.isFile() && AUDIO_EXT.has(path.extname(e.name).toLowerCase())) out.push(full);
    }
  }

  scan(onProgress) {
    if (this.scanning) return this.scanning;
    this.scanning = (async () => {
      const files = [];
      for (const root of this.data.roots) await this.walk(root, files);
      const old = this.data.tracks;
      const next = {};
      this.knownCovers = new Set(fs.readdirSync(this.coverDir));
      // Libraries from an older cover scheme re-read every song once so each gets its own correct cover.
      const rebuildCovers = this.data.coverScheme !== COVER_SCHEME;
      let done = 0;
      onProgress({ done, total: files.length });
      await pool(files, 6, async (file) => {
        const id = trackId(file);
        try {
          const st = await fs.promises.stat(file);
          const prev = old[id];
          const unchanged = !rebuildCovers && prev && prev.mtime === st.mtimeMs && prev.size === st.size;
          next[id] = unchanged ? prev : await this.parse(file, st, prev);
        } catch {
          // unreadable file: skip it
        }
        done++;
        if (done % 20 === 0 || done === files.length) onProgress({ done, total: files.length });
      });
      this.data.tracks = next;
      this.data.coverScheme = COVER_SCHEME;
      this.save();
      this.removeUnusedCovers();
      return this.data;
    })();
    return this.scanning.finally(() => {
      this.scanning = null;
    });
  }

  async parse(file, st, prev, forceCover = false) {
    const { parseFile } = await mm();
    let meta = null;
    try {
      // Full-duration scanning is slow for MP3 (it reads the whole file); other formats are cheap.
      meta = await parseFile(file, { duration: path.extname(file).toLowerCase() !== '.mp3' });
    } catch {
      meta = null;
    }
    const c = meta?.common || {};
    const f = meta?.format || {};
    const dir = path.dirname(file);
    const album = c.album || '';
    const artists = c.artists?.length ? c.artists : c.artist ? [c.artist] : [];
    const t = {
      id: trackId(file),
      path: file,
      dir,
      ext: path.extname(file).slice(1).toLowerCase(),
      title: c.title || path.basename(file, path.extname(file)),
      artist: c.artist || artists.join(', '),
      artists,
      album,
      albumArtist: c.albumartist || '',
      genre: (c.genre || []).join(', '),
      year: c.year || null,
      track: c.track?.no || null,
      disc: c.disk?.no || null,
      duration: f.duration || prev?.duration || 0,
      bitrate: f.bitrate ? Math.round(f.bitrate / 1000) : null,
      sampleRate: f.sampleRate || null,
      codec: f.codec || f.container || '',
      mtime: st.mtimeMs,
      size: st.size,
      addedAt: prev?.addedAt || Math.round(st.birthtimeMs || st.mtimeMs),
      cover: null,
    };
    t.cover = await this.coverFor(t, c.picture?.[0], forceCover);
    return t;
  }

  // Delete cached cover files that no song points to anymore (old scheme, deleted songs, replaced art).
  removeUnusedCovers() {
    const used = new Set(Object.values(this.data.tracks).map((t) => t.cover).filter(Boolean));
    let files = [];
    try {
      files = fs.readdirSync(this.coverDir);
    } catch {
      return;
    }
    for (const f of files) {
      if (used.has(f)) continue;
      try {
        fs.unlinkSync(path.join(this.coverDir, f));
      } catch {
        // in use or already gone: try again after the next scan
      }
    }
  }

  async coverFor(t, picture, force) {
    if (picture) {
      // Named after the image itself: songs with identical art share one file, and songs with different art
      // never do, even when they have the same album tag in the same folder.
      const ext = /png/i.test(picture.format) ? '.png' : '.jpg';
      const name = 'i' + crypto.createHash('sha1').update(picture.data).digest('hex').slice(0, 20) + ext;
      if (!this.knownCovers?.has(name) && !fs.existsSync(path.join(this.coverDir, name))) {
        await fs.promises.writeFile(path.join(this.coverDir, name), picture.data);
        this.knownCovers?.add(name);
      }
      return name;
    }
    // No embedded art: fall back to cover.jpg / folder.jpg etc. in the song's folder.
    const folderKey = 'f' + hash(norm(t.dir), 19);
    for (const ext of IMAGE_EXT) {
      if (this.knownCovers?.has(folderKey + ext) && !force) return folderKey + ext;
    }
    let entries = [];
    try {
      entries = await fs.promises.readdir(t.dir);
    } catch {
      return null;
    }
    for (const base of FOLDER_ART) {
      const hit = entries.find((e) => {
        const ext = path.extname(e).toLowerCase();
        return IMAGE_EXT.includes(ext) && path.basename(e, path.extname(e)).toLowerCase() === base;
      });
      if (hit) {
        const name = folderKey + path.extname(hit).toLowerCase();
        await fs.promises.copyFile(path.join(t.dir, hit), path.join(this.coverDir, name));
        this.knownCovers?.add(name);
        return name;
      }
    }
    return null;
  }

  async lyrics(id) {
    const t = this.data.tracks[id];
    if (!t) return { text: '', source: 'none' };
    try {
      const text = await fs.promises.readFile(sidecarLrc(t.path), 'utf8');
      return { text: text.replace(/^﻿/, ''), source: 'lrc' };
    } catch {
      // no .lrc next to the song
    }
    const { parseFile } = await mm();
    try {
      const meta = await parseFile(t.path, { duration: false, skipCovers: true });
      const text = embeddedLyrics(meta.common);
      return { text, source: text ? 'embedded' : 'none' };
    } catch {
      return { text: '', source: 'none' };
    }
  }

  async details(id) {
    const t = this.data.tracks[id];
    if (!t) return null;
    const { parseFile } = await mm();
    let pic = null;
    try {
      const meta = await parseFile(t.path, { duration: false });
      const p = meta.common.picture?.[0];
      if (p) pic = `data:${p.format};base64,${Buffer.from(p.data).toString('base64')}`;
    } catch {
      // ignore
    }
    const lyr = await this.lyrics(id);
    return { ...t, picture: pic, lyrics: lyr.text, lyricsSource: lyr.source, writable: t.ext === 'mp3' };
  }

  // changes: { title, artist, album, albumArtist, genre, year, track, disc, lyrics, cover: {action:'set', path} | {action:'remove'} }
  async writeTags(ids, changes) {
    const warnings = new Set();
    const updated = [];
    this.knownCovers = new Set(fs.readdirSync(this.coverDir));
    for (const id of ids) {
      const t = this.data.tracks[id];
      if (!t) continue;
      const isMp3 = t.ext === 'mp3';
      const lrcPath = sidecarLrc(t.path);
      const hasLrc = fs.existsSync(lrcPath);

      if ('lyrics' in changes && (!isMp3 || hasLrc)) {
        if (changes.lyrics.trim()) fs.writeFileSync(lrcPath, changes.lyrics, 'utf8');
        else if (hasLrc) fs.unlinkSync(lrcPath);
      }

      if (isMp3) {
        const tags = {};
        if ('title' in changes) tags.title = changes.title;
        if ('artist' in changes) tags.artist = changes.artist;
        if ('album' in changes) tags.album = changes.album;
        if ('albumArtist' in changes) tags.performerInfo = changes.albumArtist;
        if ('genre' in changes) tags.genre = changes.genre;
        if ('year' in changes) tags.year = String(changes.year || '');
        if ('track' in changes) tags.trackNumber = String(changes.track || '');
        if ('disc' in changes) tags.partOfSet = String(changes.disc || '');
        if ('lyrics' in changes && !hasLrc) tags.unsynchronisedLyrics = { language: 'eng', text: changes.lyrics };
        if (changes.cover?.action === 'set') {
          const buf = fs.readFileSync(changes.cover.path);
          tags.image = {
            mime: /\.png$/i.test(changes.cover.path) ? 'image/png' : 'image/jpeg',
            type: { id: 3, name: 'front cover' },
            description: '',
            imageBuffer: buf,
          };
        }
        if (Object.keys(tags).length) {
          const res = NodeID3.update(tags, t.path);
          if (res instanceof Error) throw res;
        }
        if (changes.cover?.action === 'remove') {
          const current = NodeID3.read(t.path, { noRaw: true });
          delete current.image;
          const res = NodeID3.write(current, t.path);
          if (res instanceof Error) throw res;
        }
      } else {
        const other = Object.keys(changes).filter((k) => k !== 'lyrics');
        if (other.length) warnings.add(`Tag editing is only supported for MP3 files. Lyrics for .${t.ext} files are saved as .lrc files next to the song.`);
      }

      const st = fs.statSync(t.path);
      const fresh = await this.parse(t.path, st, t, !!changes.cover);
      this.data.tracks[id] = fresh;
      updated.push(fresh);
    }
    this.save();
    return { updated, warnings: [...warnings] };
  }

  removeTracks(ids) {
    for (const id of ids) delete this.data.tracks[id];
    this.save();
  }
}

module.exports = { Library, trackId };
