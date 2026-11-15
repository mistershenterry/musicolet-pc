// Song Library downloads. The songs live in a private repository; the app gets the catalog
// (catalog.json), covers and songs from the Song Library server (SONGS_SERVER, a Cloudflare Worker that reads that
// repository), so users never connect anything. Songs go to the library, which stores them encrypted in its vault
// (vault.js).
// The Song Library server also keeps a download queue shared by everyone: each song asks it for a slot first, and
// waits its turn when the queue is full. It also takes song suggestions.
const { net } = require('electron');
const { isNetworkError, songLibraryFailure, songLibraryOffline } = require('./errors');
const path = require('path');
const fs = require('fs');

// Serves Songs/<path> of the songs repository at <SONGS_SERVER><path>.
// MUSICOLET_PC_CATALOG: another folder URL ending in "/", e.g. a local test server.
const SONGS_SERVER = process.env.MUSICOLET_PC_CATALOG || 'https://musicolet-songs.thebaconhelper.workers.dev/';
// Suggestions and the shared download queue (the Hub of the Song Library server). MUSICOLET_PC_HUB: a test server.
const HUB_SERVER = process.env.MUSICOLET_PC_HUB || 'https://musicolet-songs.thebaconhelper.workers.dev/';
// How often songs waiting for (or holding) a slot check in with the server.
const HUB_POLL_MS = 10000;
// Songs downloading at the same time on this PC, among those that have a slot.
const MAX_PARALLEL = 3;
const CATALOG_TTL = 5 * 60 * 1000;
const PROGRESS_EVERY_MS = 250;

const encodePath = (rel) => String(rel).split('/').map(encodeURIComponent).join('/');

class Downloads {
  constructor(library, userDir, send) {
    this.library = library;
    this.send = send; // (channel, payload) -> renderer
    this.queue = [];
    this.running = 0;
    this.pollTimer = null;
    this.cache = null;
    this.coverDir = path.join(userDir, 'song-library-covers');
    fs.mkdirSync(this.coverDir, { recursive: true });
    this.settingsFile = path.join(userDir, 'song-library.json');
    try {
      this.settings = JSON.parse(fs.readFileSync(this.settingsFile, 'utf8'));
    } catch {
      this.settings = {};
    }
    // A random id for this app, so the server can tell one app's songs and suggestions from another's.
    if (!this.settings.appId) {
      this.settings.appId = require('crypto').randomUUID();
      this.saveSettings();
    }
  }

  saveSettings() {
    fs.writeFileSync(this.settingsFile, JSON.stringify(this.settings));
  }

  // ---------- the Song Library server's Hub (suggestions, shared download queue) ----------
  // body undefined = GET.
  async hub(route, body) {
    try {
      const res = await net.fetch(HUB_SERVER + route, {
        method: body === undefined ? 'GET' : 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: body === undefined ? undefined : JSON.stringify(body),
        cache: 'no-store',
      });
      let data = null;
      try {
        data = await res.json();
      } catch {}
      if (!res.ok) {
        // The Hub's own answers (e.g. "suggestions are closed") come as JSON with an error.
        const f = res.status >= 500 || res.status === 429 || res.status === 404 || !data?.error ? songLibraryFailure(res) || songLibraryFailure({ status: 500, headers: res.headers }) : null;
        return { ...(data || {}), error: f ? f.message : data.error, code: f?.code, status: res.status };
      }
      return data || {};
    } catch {
      const f = songLibraryOffline();
      return { error: f.message, code: f.code, offline: true };
    }
  }

  suggestionStatus() {
    return this.hub('suggestions/status');
  }

  suggest({ link, artist, title } = {}) {
    return this.hub('suggestions', { link, artist, title, app: this.settings.appId });
  }

  // A file from the Song Library server.
  fetchFile(rel) {
    return net.fetch(SONGS_SERVER + encodePath(rel), { cache: 'no-store' });
  }

  // ---------- catalog ----------
  async catalog(force = false) {
    if (!force && this.cache && Date.now() - this.cache.at < CATALOG_TTL) return this.view();
    let res;
    try {
      res = await this.fetchFile('catalog.json');
    } catch {
      // No answer at all: no internet. (277)
      return { songs: [], failure: songLibraryOffline() };
    }
    // The server answered with an error: it's down, e.g. out of free requests for the day (-1), or this connection
    // sent too much (429).
    const failed = songLibraryFailure(res);
    if (failed) return { songs: [], failure: failed };
    if (res.status === 404) {
      this.cache = { at: Date.now(), songs: [] };
      return this.view();
    }
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
  // status: joining (asking the server) → waiting (queue full, position = place in line) → queued (has a slot)
  // → downloading.
  state() {
    return this.queue.map(({ id, title, artist, album, coverUrl, received, size, status, position }) => ({ id, title, artist, album, coverUrl, received, size, status, position }));
  }

  emit() {
    this.send('downloads:update', this.state());
  }

  async enqueue(id) {
    const song = this.cache?.songs.find((s) => s.id === id);
    if (!song) return { ok: false, reason: 'not-found' };
    if (this.queue.some((q) => q.id === id)) return { ok: false, reason: 'queued' };
    if (this.library.downloadedIds().has(id)) return { ok: false, reason: 'downloaded' };
    const item = { ...song, coverUrl: this.coverUrl(song), received: 0, status: 'joining', ticket: null, position: 0 };
    this.queue.push(item);
    this.emit();
    const res = await this.join(item);
    if (res.error) {
      this.queue = this.queue.filter((q) => q !== item);
      this.emit();
      return { ok: false, reason: 'busy', error: res.error };
    }
    this.pump();
    return { ok: true, waiting: item.status === 'waiting', position: item.position };
  }

  // Ask the server for a download slot. If the server can't be reached (or is an older one), download anyway.
  async join(item) {
    const res = await this.hub('queue/join', { app: this.settings.appId, song: item.id });
    if (res.ticket) {
      item.ticket = res.ticket;
      this.applyTicket(item, res);
    } else if (res.error && !res.offline && !res.status && res.code === undefined) {
      // The server says no (its queue is too long right now).
      return { error: res.error };
    } else {
      item.ticket = null;
      item.status = 'queued';
    }
    this.emit();
    this.schedulePoll();
    return {};
  }

  applyTicket(item, t) {
    if (t.state === 'active' && (item.status === 'waiting' || item.status === 'joining')) {
      item.status = 'queued';
      item.position = 0;
    } else if (t.state === 'waiting') {
      item.status = 'waiting';
      item.position = t.position;
    }
  }

  // Songs with a ticket check in with the server: waiting ones learn their place, and start when it's their turn.
  schedulePoll() {
    if (this.pollTimer || !this.queue.some((q) => q.ticket)) return;
    this.pollTimer = setTimeout(async () => {
      const items = this.queue.filter((q) => q.ticket);
      if (items.length) {
        const res = await this.hub('queue/poll', { tickets: items.map((q) => q.ticket) });
        for (const t of res.tickets || []) {
          const item = items.find((q) => q.ticket === t.ticket);
          if (!item || !this.queue.includes(item)) continue;
          // Lost its place (e.g. the PC slept): line up again.
          if (t.state === 'gone' && item.status === 'waiting') await this.join(item);
          else this.applyTicket(item, t);
        }
        this.emit();
        this.pump();
      }
      this.pollTimer = null;
      this.schedulePoll();
    }, HUB_POLL_MS);
  }

  pump() {
    while (this.running < MAX_PARALLEL) {
      const item = this.queue.find((q) => q.status === 'queued');
      if (!item) return;
      this.download(item);
    }
  }

  async download(item) {
    this.running++;
    item.status = 'downloading';
    this.emit();
    try {
      const res = await this.fetchFile(item.file);
      const failed = songLibraryFailure(res) || (res.ok ? null : songLibraryFailure({ status: 500, headers: res.headers }));
      if (failed) throw Object.assign(new Error(failed.message), { failure: failed });
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
      const failed = err?.failure || (isNetworkError(err) ? songLibraryOffline() : null);
      this.send('downloads:failed', { title: item.title, error: failed ? failed.message : String(err?.message || err), code: failed?.code });
    } finally {
      // Finished (or failed) songs leave the download queue right away.
      this.queue = this.queue.filter((q) => q !== item);
      this.running--;
      // Free the slot for the next song in everyone's queue.
      if (item.ticket) this.hub('queue/done', { tickets: [item.ticket] });
      this.emit();
      this.pump();
    }
  }
}

module.exports = { Downloads };
