// Song Library downloads in the UI: the download queue, the "Downloads" item above Settings (only shown while
// something is downloading) and what happens when a song finishes.
const SongDownloads = {
  queue: [],
  listeners: new Set(),

  init() {
    this.btn = $('#btn-downloads');
    this.btn.addEventListener('click', () => Views.go('downloads'));
    api.onDownloads((q) => this.onQueue(q));
    api.downloadQueue().then((q) => this.onQueue(q));
    api.onDownloadDone(({ title, artist, library, updated }) => {
      Store.setLibrary(library);
      // Updates to the Song Library's newer version are announced once for all of them (onDownloadSync).
      if (!updated) toast(`Downloaded "${title}"${artist ? ` by ${artist}` : ''}`);
      this.changed();
    });
    // Downloaded songs that changed in the Song Library (e.g. lyrics added, a different album) are downloaded again.
    api.onDownloadSync(({ state, count, done, failed }) => {
      const songs = (n) => (n === 1 ? '1 downloaded song' : `${n} downloaded songs`);
      if (state === 'start') toast(`The Song Library has newer versions of ${songs(count)}. Updating…`, 5000);
      else if (done) toast(`Updated ${songs(done)} to the Song Library's newest version${failed ? ` (${failed} will be tried again later)` : ''}.`, 6000);
    });
    api.onDownloadFailed(({ title, error, code }) => {
      toast(`Couldn't download "${title}": ${errorText(error, code)}`, 6000);
      this.changed();
    });
  },

  onQueue(q) {
    this.queue = q || [];
    this.btn.hidden = this.queue.length === 0;
    this.btn.innerHTML = icon('cloudDownload') + `<span>Downloads</span><span class="nav-badge">${this.queue.length}</span>`;
    this.changed();
  },

  changed() {
    for (const fn of this.listeners) fn(this.queue);
  },

  // Views subscribe while they're open; returns an unsubscribe function.
  subscribe(fn) {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  },

  async download(song) {
    const res = await api.downloadSong(song.id);
    if (!res.ok && res.reason === 'downloaded') toast(`"${song.title}" is already downloaded`);
    else if (!res.ok && res.reason === 'queued') toast(`"${song.title}" is already in the download queue`);
    else if (!res.ok && res.error) toast(`Couldn't start the download of "${song.title}": ${errorText(res.error, res.code)}`, 6000);
    else if (!res.ok) toast(`Couldn't start the download of "${song.title}"`);
    // Everyone's downloads share one queue on the Song Library server; when it's full, songs wait their turn.
    else if (res.waiting) toast(`The download queue is full right now. "${song.title}" was added to the queue: you're number ${res.position}. It starts by itself when it's its turn.`, 7000);
    return res;
  },
};

