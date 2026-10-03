// Bulletin board: BULLETIN.md from the GitHub repo, shown in Settings (plans for the next update).
// Edit the file on GitHub and every copy of the app picks it up; no new release needed.
// Checked on launch and every 15 minutes; the last copy is cached so it also shows offline.
const { net } = require('electron');
const crypto = require('crypto');
const fs = require('fs');

const REPO = 'mistershenterry/musicolet-pc';
const FILE = 'BULLETIN.md';
const RAW_URL = `https://raw.githubusercontent.com/${REPO}/main/${FILE}`;
const COMMITS_URL = `https://api.github.com/repos/${REPO}/commits?path=${FILE}&per_page=1`;
const FIRST_CHECK_DELAY = 5 * 1000;
const CHECK_INTERVAL = 15 * 60 * 1000;

class Bulletin {
  constructor(cacheFile) {
    this.file = cacheFile;
    this.send = () => {};
    this.checking = null;
    try {
      this.state = JSON.parse(fs.readFileSync(cacheFile, 'utf8'));
    } catch {
      this.state = { text: '', hash: '', etag: '', updatedAt: null, checkedAt: null };
    }
    this.state.status = this.state.checkedAt ? 'ok' : 'never';
  }

  start(send) {
    this.send = send;
    setTimeout(() => this.check(), FIRST_CHECK_DELAY);
    setInterval(() => this.check(), CHECK_INTERVAL);
  }

  check() {
    if (this.checking) return this.checking;
    this.checking = this.fetchBoard()
      .catch((err) => {
        // Offline or GitHub unreachable: keep showing the cached board.
        this.state.status = 'failed';
        this.state.error = String(err?.message || err);
      })
      .then(() => {
        this.save();
        this.send(this.state);
        return this.state;
      })
      .finally(() => (this.checking = null));
    return this.checking;
  }

  async fetchBoard() {
    // The ETag makes an unchanged board a tiny "304 Not Modified" answer.
    const headers = this.state.etag && this.state.text ? { 'If-None-Match': this.state.etag } : {};
    const res = await net.fetch(RAW_URL, { headers, cache: 'no-store' });
    if (res.status === 304) {
      Object.assign(this.state, { status: 'ok', checkedAt: Date.now(), error: null });
      return;
    }
    if (res.status === 404) {
      // No board in the repo (yet): show nothing.
      Object.assign(this.state, { text: '', hash: '', etag: '', updatedAt: null, status: 'ok', checkedAt: Date.now(), error: null });
      return;
    }
    if (!res.ok) throw new Error(`GitHub answered ${res.status}`);
    const text = (await res.text()).replace(/^﻿/, '');
    const hash = crypto.createHash('sha1').update(text).digest('hex').slice(0, 16);
    if (hash !== this.state.hash) {
      this.state.updatedAt = (await this.lastEdited()) || Date.now();
    }
    Object.assign(this.state, { text, hash, etag: res.headers.get('etag') || '', status: 'ok', checkedAt: Date.now(), error: null });
  }

  // When the board was last edited, from the repo's history (best effort; GitHub limits anonymous requests).
  async lastEdited() {
    try {
      const res = await net.fetch(COMMITS_URL, { headers: { Accept: 'application/vnd.github+json' } });
      if (!res.ok) return null;
      const [commit] = await res.json();
      const date = commit?.commit?.committer?.date || commit?.commit?.author?.date;
      return date ? Date.parse(date) : null;
    } catch {
      return null;
    }
  }

  save() {
    try {
      const { status, error, ...keep } = this.state;
      fs.writeFileSync(this.file, JSON.stringify(keep));
    } catch {
      // cache is only a convenience
    }
  }
}

module.exports = { Bulletin };
