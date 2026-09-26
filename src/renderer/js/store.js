// App state: the scanned library, derived indexes (albums/artists/genres/folders),
// queues, playlists, favorites, play statistics and settings. Persisted to state.json.
const MAX_QUEUES = 20;
const EQ_BANDS = [31, 62, 125, 250, 500, 1000, 2000, 4000, 8000, 16000];
const IS_WIN = navigator.userAgent.includes('Windows');
const pathKey = (p) => (IS_WIN ? p.toLowerCase() : p);
const parentDir = (p) => {
  const i = Math.max(p.lastIndexOf('\\'), p.lastIndexOf('/'));
  return i > 0 ? p.slice(0, i) : p;
};

function defaultState() {
  const q = { id: uid(), name: 'Queue 1', items: [], index: 0, position: 0 };
  return {
    version: 1,
    queues: [q],
    activeQueueId: q.id,
    playlists: [],
    favorites: [],
    stats: {},
    settings: {
      theme: 'dark',
      accent: '#ff8a3d',
      volume: 0.8,
      muted: false,
      speed: 1,
      repeat: 'all', // off | all | one
      clickAction: 'replace', // replace | newqueue | next | append
      prevThreshold: 3,
      folderMode: 'tree', // tree | flat
      lyricsSize: 18,
      eq: { enabled: false, preset: 'Flat', gains: EQ_BANDS.map(() => 0), preamp: 0 },
      sorts: {},
    },
    ui: { tab: 'songs', panel: 'queue' },
  };
}

const TRACK_SORTS = {
  title: { label: 'Title', get: (t) => t.title },
  artist: { label: 'Artist', get: (t) => t.artist },
  album: { label: 'Album', get: (t) => `${t.album}\u0000${String((t.disc || 1) * 10000 + (t.track || 0)).padStart(8, '0')}` },
  year: { label: 'Year', get: (t) => t.year || 0, num: true },
  duration: { label: 'Duration', get: (t) => t.duration || 0, num: true },
  added: { label: 'Date added', get: (t) => t.addedAt || 0, num: true },
  modified: { label: 'Date modified', get: (t) => t.mtime || 0, num: true },
  filename: { label: 'File name', get: (t) => basename(t.path) },
  plays: { label: 'Play count', get: (t) => Store.state.stats[t.id]?.plays || 0, num: true },
  track: { label: 'Track number', get: (t) => (t.disc || 1) * 10000 + (t.track || 0), num: true },
};

const Store = {
  lib: { roots: [], tracks: {} },
  state: null,
  idx: null,
  favSet: new Set(),
  _listeners: {},

  on(event, fn) {
    (this._listeners[event] ||= []).push(fn);
  },
  emit(event, data) {
    for (const fn of this._listeners[event] || []) fn(data);
  },

  async init() {
    this.lib = await api.getLibrary();
    const saved = await api.loadState();
    const def = defaultState();
    this.state = saved ? { ...def, ...saved, settings: { ...def.settings, ...saved.settings }, ui: { ...def.ui, ...saved.ui } } : def;
    this.state.settings.eq = { ...def.settings.eq, ...this.state.settings.eq };
    if (!this.state.queues.length) this.state.queues = def.queues;
    if (!this.getQueue(this.state.activeQueueId)) this.state.activeQueueId = this.state.queues[0].id;
    this.rebuild();
  },

  setLibrary(lib) {
    this.lib = lib;
    this.rebuild();
    this.pruneMissing();
    this.emit('library');
    this.emit('queues');
  },

  rebuild() {
    const albums = new Map();
    const artists = new Map();
    const genres = new Map();
    const folders = new Map();
    const albumOf = new Map();
    const byPath = new Map();
    const roots = this.lib.roots.map((r) => {
      const p = r.replace(/[\\/]+$/, '');
      return { path: p, key: pathKey(p) };
    });

    const folderNode = (p) => {
      const key = pathKey(p);
      let f = folders.get(key);
      if (!f) {
        f = { path: p, key, name: basename(p), subdirs: new Set(), tracks: [], total: 0, parent: null };
        folders.set(key, f);
      }
      return f;
    };

    for (const t of Object.values(this.lib.tracks)) {
      byPath.set(pathKey(t.path), t.id);

      const aKey = t.albumArtist
        ? `${t.album.toLowerCase()}|${t.albumArtist.toLowerCase()}`
        : `${t.album.toLowerCase()}|@${pathKey(t.dir)}`;
      let a = albums.get(aKey);
      if (!a) {
        a = { key: aKey, name: t.album || 'Unknown album', albumArtist: t.albumArtist, artistCounts: new Map(), year: null, cover: null, tracks: [], duration: 0 };
        albums.set(aKey, a);
      }
      a.tracks.push(t.id);
      a.duration += t.duration || 0;
      if (!a.cover && t.cover) a.cover = t.cover;
      if (t.year && (!a.year || t.year < a.year)) a.year = t.year;
      a.artistCounts.set(t.artist, (a.artistCounts.get(t.artist) || 0) + 1);
      albumOf.set(t.id, aKey);

      const names = t.artists?.length ? t.artists : [t.artist || ''];
      for (const n of names) {
        const name = n || 'Unknown artist';
        const key = name.toLowerCase();
        let ar = artists.get(key);
        if (!ar) artists.set(key, (ar = { key, name, tracks: [], albums: new Set() }));
        ar.tracks.push(t.id);
        ar.albums.add(aKey);
      }

      const gs = (t.genre || '').split(/[,;/]/).map((g) => g.trim()).filter(Boolean);
      for (const g of gs.length ? gs : ['Unknown genre']) {
        const key = g.toLowerCase();
        let ge = genres.get(key);
        if (!ge) genres.set(key, (ge = { key, name: g, tracks: [] }));
        ge.tracks.push(t.id);
      }

      // Folder tree: attach the track to its folder and bubble counts up to the library root.
      const node = folderNode(t.dir);
      node.tracks.push(t.id);
      const root = roots.find((r) => node.key === r.key || node.key.startsWith(r.key + (IS_WIN ? '\\' : '/')));
      let cur = node;
      cur.total++;
      while (root && cur.key !== root.key) {
        const up = parentDir(cur.path);
        if (up === cur.path) break;
        const parent = folderNode(up);
        parent.subdirs.add(cur.key);
        cur.parent = parent.key;
        parent.total++;
        cur = parent;
      }
    }

    for (const a of albums.values()) {
      if (a.albumArtist) a.artist = a.albumArtist;
      else if (a.artistCounts.size === 1) a.artist = [...a.artistCounts.keys()][0] || 'Unknown artist';
      else a.artist = 'Various artists';
    }

    this.idx = { albums, artists, genres, folders, albumOf, byPath, roots };
    this.favSet = new Set(this.state.favorites);
  },

  track(id) {
    return this.lib.tracks[id];
  },
  trackCount() {
    return Object.keys(this.lib.tracks).length;
  },
  allIds() {
    return Object.keys(this.lib.tracks);
  },

  sortIds(ids, key, desc = false) {
    const s = TRACK_SORTS[key] || TRACK_SORTS.title;
    const tracks = this.lib.tracks;
    const out = ids.slice().sort((a, b) => {
      const ta = tracks[a];
      const tb = tracks[b];
      const r = s.num ? s.get(ta) - s.get(tb) : cmp(s.get(ta), s.get(tb));
      return r || cmp(ta.title, tb.title);
    });
    return desc ? out.reverse() : out;
  },

  sortFor(view, fallback = 'title') {
    return this.state.settings.sorts[view] || { key: fallback, desc: false };
  },
  setSort(view, key, desc) {
    this.state.settings.sorts[view] = { key, desc };
    this.save();
  },

  filterIds(ids, query) {
    const q = query.trim().toLowerCase();
    if (!q) return ids;
    const words = q.split(/\s+/);
    return ids.filter((id) => {
      const t = this.lib.tracks[id];
      const hay = `${t.title} ${t.artist} ${t.album} ${t.albumArtist} ${t.genre} ${basename(t.path)}`.toLowerCase();
      return words.every((w) => hay.includes(w));
    });
  },

  // ---------- queues ----------
  activeQueue() {
    return this.getQueue(this.state.activeQueueId) || this.state.queues[0];
  },
  getQueue(id) {
    return this.state.queues.find((q) => q.id === id);
  },
  currentId() {
    const q = this.activeQueue();
    return q.items[q.index];
  },
  nextQueueName() {
    const used = new Set(this.state.queues.map((q) => q.name));
    let n = 1;
    while (used.has(`Queue ${n}`)) n++;
    return `Queue ${n}`;
  },
  createQueue(items = [], name) {
    if (this.state.queues.length >= MAX_QUEUES) {
      toast(`You can have at most ${MAX_QUEUES} queues. Delete one first.`);
      return null;
    }
    const q = { id: uid(), name: name || this.nextQueueName(), items: items.slice(), index: 0, position: 0 };
    this.state.queues.push(q);
    this.changed('queues');
    return q;
  },
  addToQueue(qid, ids, at) {
    const q = this.getQueue(qid);
    if (!q) return;
    const pos = at == null ? q.items.length : Math.max(0, Math.min(at, q.items.length));
    q.items.splice(pos, 0, ...ids);
    if (q.items.length > ids.length && pos <= q.index) q.index += ids.length;
    this.changed('queues');
  },
  removeFromQueue(qid, indices) {
    const q = this.getQueue(qid);
    if (!q) return false;
    const set = new Set(indices);
    const removedCurrent = set.has(q.index);
    const before = indices.filter((i) => i < q.index).length;
    q.items = q.items.filter((_, i) => !set.has(i));
    q.index = Math.max(0, Math.min(q.index - before, q.items.length - 1));
    if (removedCurrent) q.position = 0;
    this.changed('queues');
    return removedCurrent;
  },
  // Move the items at `indices` so they land before the item currently at `target`.
  moveInQueue(items, indices, target, currentIndex) {
    const set = new Set(indices);
    const moving = indices.map((i) => items[i]);
    const currentMoving = set.has(currentIndex);
    const currentOffset = currentMoving ? indices.indexOf(currentIndex) : -1;
    const kept = [];
    let newCurrent = -1;
    let insertAt = 0;
    items.forEach((it, i) => {
      if (i === target) insertAt = kept.length;
      if (set.has(i)) return;
      if (i === currentIndex) newCurrent = kept.length;
      kept.push(it);
    });
    if (target >= items.length) insertAt = kept.length;
    kept.splice(insertAt, 0, ...moving);
    if (currentMoving) newCurrent = insertAt + currentOffset;
    else if (newCurrent >= insertAt) newCurrent += moving.length;
    return { items: kept, current: newCurrent };
  },
  reorderQueue(qid, indices, target) {
    const q = this.getQueue(qid);
    const r = this.moveInQueue(q.items, indices, target, q.index);
    q.items = r.items;
    q.index = Math.max(0, r.current);
    this.changed('queues');
  },
  renameQueue(qid, name) {
    const q = this.getQueue(qid);
    if (q && name) {
      q.name = name;
      this.changed('queues');
    }
  },

  // ---------- playlists ----------
  getPlaylist(id) {
    return this.state.playlists.find((p) => p.id === id);
  },
  createPlaylist(name, items = []) {
    const p = { id: uid(), name, items: items.slice(), createdAt: Date.now() };
    this.state.playlists.push(p);
    this.changed('playlists');
    return p;
  },
  addToPlaylist(pid, ids) {
    if (pid === 'favorites') return this.setFav(ids, true);
    const p = this.getPlaylist(pid);
    if (!p) return;
    p.items.push(...ids);
    this.changed('playlists');
  },

  // ---------- favorites & stats ----------
  isFav(id) {
    return this.favSet.has(id);
  },
  setFav(ids, on) {
    for (const id of ids) {
      if (on && !this.favSet.has(id)) {
        this.favSet.add(id);
        this.state.favorites.push(id);
      } else if (!on && this.favSet.has(id)) {
        this.favSet.delete(id);
      }
    }
    if (!on) this.state.favorites = this.state.favorites.filter((id) => this.favSet.has(id));
    this.changed('favorites');
  },
  toggleFav(ids) {
    const allFav = ids.every((id) => this.favSet.has(id));
    this.setFav(ids, !allFav);
    return !allFav;
  },
  recordPlay(id) {
    const s = (this.state.stats[id] ||= { plays: 0, lastPlayed: 0 });
    s.plays++;
    s.lastPlayed = Date.now();
    this.changed('stats');
  },

  // Drop references to songs that no longer exist after a rescan.
  pruneMissing() {
    const has = (id) => !!this.lib.tracks[id];
    for (const q of this.state.queues) {
      const cur = q.items[q.index];
      const curCountBefore = q.items.slice(0, q.index).filter((id) => id === cur).length;
      q.items = q.items.filter(has);
      if (cur && has(cur)) {
        let seen = -1;
        q.index = q.items.findIndex((id) => id === cur && ++seen === curCountBefore);
        if (q.index < 0) q.index = q.items.indexOf(cur);
      } else {
        q.index = Math.min(q.index, Math.max(0, q.items.length - 1));
        q.position = 0;
      }
    }
    for (const p of this.state.playlists) p.items = p.items.filter(has);
    this.state.favorites = this.state.favorites.filter(has);
    for (const id of Object.keys(this.state.stats)) if (!has(id)) delete this.state.stats[id];
    this.favSet = new Set(this.state.favorites);
    this.save();
  },

  changed(what) {
    this.save();
    this.emit(what);
  },
  save: null,
  saveNow() {
    api.saveStateSync(this.state);
  },
};
Store.save = debounce(() => api.saveState(Store.state), 700);
