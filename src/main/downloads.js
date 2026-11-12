// Song Library downloads: reads the catalog (Songs/catalog.json in the GitHub repo, built by
// scripts/build-catalog.mjs), downloads songs one at a time and hands them to the library, which stores them
// encrypted in its vault (vault.js). Downloaded songs can only be played or deleted in the app.
const { net } = require('electron');

// MUSICOLET_PC_CATALOG points at another catalog (a folder URL ending in "/"), e.g. for testing.
const CATALOG_BASE = process.env.MUSICOLET_PC_CATALOG || 'https://raw.githubusercontent.com/mistershenterry/musicolet-pc/main/Songs/';
const CATALOG_TTL = 5 * 60 * 1000;
const PROGRESS_EVERY_MS = 250;

const urlFor = (rel) => CATALOG_BASE + String(rel).split('/').map(encodeURIComponent).join('/');

class Downloads {
  constructor(library, send) {
    this.library = library;
    this.send = send; // (channel, payload) -> renderer
    this.queue = [];
    this.active = null;
    this.cache = null;
  }

  async catalog(force = false) {
    if (!force && this.cache && Date.now() - this.cache.at < CATALOG_TTL) return this.view();
    const res = await net.fetch(CATALOG_BASE + 'catalog.json', { cache: 'no-store' });
    if (res.status === 404) {
      // No catalog yet (no songs have been added to the repo).
      this.cache = { at: Date.now(), songs: [] };
      return this.view();
    }
    if (!res.ok) throw new Error(`GitHub answered ${res.status}`);
    const data = await res.json();
    this.cache = { at: Date.now(), songs: Array.isArray(data.songs) ? data.songs : [] };
    return this.view();
  }

  // Catalog as the app shows it: full cover URLs and whether each song is already downloaded or queued.
  view() {
    const have = this.library.downloadedIds();
    return {
      songs: this.cache.songs.map((s) => ({
        ...s,
        coverUrl: s.cover ? urlFor(s.cover) : null,
        downloaded: have.has(s.id),
        queued: this.queue.some((q) => q.id === s.id),
      })),
    };
  }

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
    this.queue.push({ ...song, coverUrl: song.cover ? urlFor(song.cover) : null, received: 0, status: 'queued' });
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
      const res = await net.fetch(urlFor(item.file), { cache: 'no-store' });
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
