// Song Library downloads. The songs live in a private repository; the app gets the catalog
// (catalog.json), covers and songs from the Song Library server (SONGS_SERVER, a Cloudflare Worker that reads that
// repository), so users never connect anything. Songs download one at a time and go to the library, which stores them
// encrypted in its vault (vault.js).
const { net } = require('electron');
const path = require('path');
const fs = require('fs');

// Serves Songs/<path> of the songs repository at <SONGS_SERVER><path>.
// MUSICOLET_PC_CATALOG: another folder URL ending in "/", e.g. a local test server.
const SONGS_SERVER = process.env.MUSICOLET_PC_CATALOG || 'https://musicolet-songs.thebaconhelper.workers.dev/';
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
    this.coverDir = path.join(userDir, 'song-library-covers');
    fs.mkdirSync(this.coverDir, { recursive: true });
  }

  // A file from the Song Library server.
  fetchFile(rel) {
    return net.fetch(SONGS_SERVER + encodePath(rel), { cache: 'no-store' });
  }

  // ---------- catalog ----------
  async catalog(force = false) {
    if (!force && this.cache && Date.now() - this.cache.at < CATALOG_TTL) return this.view();
    const res = await this.fetchFile('catalog.json');
    if (res.status === 404) {
      this.cache = { at: Date.now(), songs: [] };
      return this.view();
    }
    // The server is down or can't read the songs right now (fixed on the server, not in the app).
    if (!res.ok) return { songs: [], unavailable: true };
    const data = await res.json();
    this.cache = { at: Date.now(), songs: Array.isArray(data.songs) ? data.songs : [] };
    return this.view();
  }

  // Covers are served to the app by the mco://libcover/ protocol and cached on disk.
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
      if (res.status === 401) throw new Error('the Song Library is unavailable right now');
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
