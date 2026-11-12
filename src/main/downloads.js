// Song Library downloads. The catalog is the private repository mistershenterry/musicolet-pc-songs
// (Songs/catalog.json, built there by its own workflow). The app reads it through the GitHub API with a personal
// access token the user pastes in Settings → Song Library (stored encrypted with Electron safeStorage).
// Songs download one at a time and go to the library, which stores them encrypted in its vault (vault.js).
const { net, safeStorage } = require('electron');
const path = require('path');
const fs = require('fs');

const REPO = process.env.MUSICOLET_PC_SONGS_REPO || 'mistershenterry/musicolet-pc-songs';
// MUSICOLET_PC_CATALOG: a plain folder URL ending in "/" (no token needed), e.g. a local test server.
const TEST_BASE = process.env.MUSICOLET_PC_CATALOG || null;
const CATALOG_TTL = 5 * 60 * 1000;
const PROGRESS_EVERY_MS = 250;

const encodePath = (rel) => String(rel).split('/').map(encodeURIComponent).join('/');

class Downloads {
  constructor(library, userDir, send) {
    this.library = library;
    this.send = send; // (channel, payload) -> renderer
    this.queue = [];
    this.active = null;
    this.cache = null;
    this.settingsFile = path.join(userDir, 'song-library.json');
    this.coverDir = path.join(userDir, 'song-library-covers');
    fs.mkdirSync(this.coverDir, { recursive: true });
    try {
      this.settings = JSON.parse(fs.readFileSync(this.settingsFile, 'utf8'));
    } catch {
      this.settings = {};
    }
  }

  // ---------- access token ----------
  get token() {
    if (TEST_BASE || !this.settings.token) return null;
    try {
      const stored = Buffer.from(this.settings.token, 'base64');
      return this.settings.protected ? safeStorage.decryptString(stored) : stored.toString('utf8');
    } catch {
      return null;
    }
  }

  saveSettings() {
    fs.writeFileSync(this.settingsFile, JSON.stringify(this.settings));
  }

  // Check a token against the songs repository, and keep it if it works.
  async setToken(token) {
    token = String(token || '').trim();
    if (!token) return { ok: false, error: 'Paste a token first.' };
    const res = await net.fetch(`https://api.github.com/repos/${REPO}`, { headers: this.headers(token) });
    if (res.status === 401) return { ok: false, error: "GitHub doesn't accept this token. Check that it was copied completely and hasn't expired." };
    if (res.status === 404 || res.status === 403) return { ok: false, error: `This token doesn't have access to ${REPO}. Give it read access to that repository's contents.` };
    if (!res.ok) return { ok: false, error: `GitHub answered ${res.status}. Try again in a moment.` };
    const canProtect = safeStorage.isEncryptionAvailable();
    this.settings.token = (canProtect ? safeStorage.encryptString(token) : Buffer.from(token, 'utf8')).toString('base64');
    this.settings.protected = canProtect;
    this.saveSettings();
    this.cache = null;
    return { ok: true, ...(await this.status()) };
  }

  clearToken() {
    delete this.settings.token;
    delete this.settings.protected;
    this.saveSettings();
    this.cache = null;
    return { connected: false };
  }

  async status() {
    if (TEST_BASE) return { connected: true, repo: 'test catalog' };
    return { connected: !!this.token, repo: REPO };
  }

  headers(token = this.token, raw = false) {
    const h = { Accept: raw ? 'application/vnd.github.raw' : 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28' };
    if (token) h.Authorization = `Bearer ${token}`;
    return h;
  }

  // A file from the songs repository (or the test folder).
  fetchFile(rel) {
    if (TEST_BASE) return net.fetch(TEST_BASE + encodePath(rel), { cache: 'no-store' });
    return net.fetch(`https://api.github.com/repos/${REPO}/contents/Songs/${encodePath(rel)}`, { headers: this.headers(this.token, true), cache: 'no-store' });
  }

  // ---------- catalog ----------
  async catalog(force = false) {
    if (!TEST_BASE && !this.token) return { songs: [], needsToken: true };
    if (!force && this.cache && Date.now() - this.cache.at < CATALOG_TTL) return this.view();
    const res = await this.fetchFile('catalog.json');
    if (res.status === 401) return { songs: [], needsToken: true, error: 'The saved token stopped working (expired or revoked). Add a new one in Settings → Song Library.' };
    if (res.status === 404) {
      // No catalog yet, or the token lost access to the repository.
      this.cache = { at: Date.now(), songs: [] };
      return this.view();
    }
    if (!res.ok) throw new Error(`GitHub answered ${res.status}`);
    const data = await res.json();
    this.cache = { at: Date.now(), songs: Array.isArray(data.songs) ? data.songs : [] };
    return this.view();
  }

  // Covers are served to the app by the mco://libcover/ protocol (the private repository needs the token).
  coverUrl(song) {
    return song.cover ? 'mco://libcover/' + encodeURIComponent(song.cover) : null;
  }

  // A cover image from the songs repository, cached on disk. Returns the local file or null.
  async cover(rel) {
    if (!/^\.covers\/[\w.-]+$/.test(rel)) return null;
    const file = path.join(this.coverDir, path.basename(rel));
    if (fs.existsSync(file)) return file;
    const res = await this.fetchFile(rel);
    if (!res.ok) return null;
    fs.writeFileSync(file, Buffer.from(await res.arrayBuffer()));
    return file;
  }

  // Catalog as the app shows it: cover URLs and whether each song is already downloaded or queued.
  view() {
    const have = this.library.downloadedIds();
    return {
      songs: this.cache.songs.map((s) => ({
        ...s,
        coverUrl: this.coverUrl(s),
        downloaded: have.has(s.id),
        queued: this.queue.some((q) => q.id === s.id),
      })),
    };
  }

  // ---------- download queue ----------
  state() {
    return this.queue.map(({ id, title, artist, album, coverUrl, received, size, status }) => ({ id, title, artist, album, coverUrl, received, size, status }));
  }

  emit() {
    this.send('downloads:update', this.state());
  }

  enqueue(id) {
    const song = this.cache?.songs.find((s) => s.id === id);
    if (!song) return { ok: false, reason: 'not-found' };
    if (this.queue.some((q) => q.id === id)) return { ok: false, reason: 'queued' };
    if (this.library.downloadedIds().has(id)) return { ok: false, reason: 'downloaded' };
    this.queue.push({ ...song, coverUrl: this.coverUrl(song), received: 0, status: 'queued' });
    this.emit();
    this.pump();
    return { ok: true };
  }

  async pump() {
    if (this.active) return;
    const item = this.queue.find((q) => q.status === 'queued');
    if (!item) return;
    this.active = item;
    item.status = 'downloading';
    this.emit();
    try {
      const res = await this.fetchFile(item.file);
      if (res.status === 401) throw new Error('the Song Library token stopped working');
      if (!res.ok) throw new Error(`GitHub answered ${res.status}`);
      item.size = Number(res.headers.get('content-length')) || item.size || 0;
      // Kept in memory and never written to disk unencrypted.
      const chunks = [];
      const reader = res.body.getReader();
      let last = 0;
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        chunks.push(Buffer.from(value));
        item.received += value.length;
        if (Date.now() - last > PROGRESS_EVERY_MS) {
          last = Date.now();
          this.emit();
        }
      }
      if (item.size && item.received !== item.size) throw new Error('the download was cut off');
      const lib = await this.library.addDownloaded(item, Buffer.concat(chunks));
      this.send('downloads:done', { title: item.title, artist: item.artist, library: lib });
    } catch (err) {
      this.send('downloads:failed', { title: item.title, error: String(err?.message || err) });
    } finally {
      // Finished (or failed) songs leave the download queue right away.
      this.queue = this.queue.filter((q) => q !== item);
      this.active = null;
      this.emit();
      this.pump();
    }
  }
}

module.exports = { Downloads };
