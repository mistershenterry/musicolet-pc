// Main content area: the tabs (Queues, Folders, Albums, Artists, Genres, Songs, Playlists) and their detail pages.
const TABS = [
  { id: 'queues', label: 'Queues', icon: 'queue' },
  { id: 'folders', label: 'Folders', icon: 'folder' },
  { id: 'albums', label: 'Albums', icon: 'album' },
  { id: 'artists', label: 'Artists', icon: 'artist' },
  { id: 'genres', label: 'Genres', icon: 'genre' },
  { id: 'songs', label: 'Songs', icon: 'song' },
  { id: 'playlists', label: 'Playlists', icon: 'playlist' },
];

const AUTO_PLAYLISTS = [
  { id: 'favorites', name: 'Favorites', icon: 'heart' },
  { id: 'recent-added', name: 'Recently added', icon: 'add' },
  { id: 'most-played', name: 'Most played', icon: 'playlist' },
  { id: 'recent-played', name: 'Recently played', icon: 'refresh' },
  { id: 'never-played', name: 'Never played', icon: 'song' },
];

const Views = {
  stack: [],
  list: null,
  query: '',
  indexMap: null,

  init() {
    const nav = $('#nav');
    for (const t of TABS) {
      const b = h('button', { class: 'nav-item', dataset: { tab: t.id } });
      b.innerHTML = icon(t.icon) + `<span>${t.label}</span>`;
      b.addEventListener('click', () => this.go(t.id));
      nav.append(b);
    }
    Store.on('library', () => this.render(true));
    Store.on('queues', () => {
      const t = this.top()?.type;
      if (t === 'queues' || t === 'queue') this.render(true);
      else this.list?.refresh();
    });
    Store.on('current', () => this.list?.refresh());
    Store.on('favorites', () => {
      if (this.top()?.id === 'favorites') this.render(true);
      else this.list?.refresh();
    });
    Store.on('playlists', () => {
      const t = this.top()?.type;
      if (t === 'playlists' || t === 'playlist') this.render(true);
    });
    Player.on('state', () => this.list?.refresh());
    this.go(Store.state.ui.tab || 'songs');
  },

  top() {
    return this.stack[this.stack.length - 1];
  },
  go(tab) {
    this.stack = [{ type: tab }];
    Store.state.ui.tab = tab;
    Store.save();
    this.query = '';
    this.render();
  },
  push(view) {
    this.saveScroll();
    this.stack.push(view);
    this.query = '';
    this.render();
  },
  back() {
    if (this.stack.length < 2) return;
    this.stack.pop();
    this.query = '';
    this.render(true);
  },
  saveScroll() {
    const v = this.top();
    if (!v) return;
    const scroller = this.list?.el || $('#content .scroll');
    if (scroller) v.scroll = scroller.scrollTop;
  },

  render(keepScroll = false) {
    if (keepScroll) this.saveScroll();
    const content = $('#content');
    this.list?.destroy();
    this.list = null;
    this.indexMap = null;
    content.innerHTML = '';
    const v = this.top();
    $$('#nav .nav-item').forEach((b) => b.classList.toggle('active', b.dataset.tab === this.stack[0].type));

    if (!Store.lib.roots.length) return content.append(this.welcome());
    if (!Store.trackCount() && App.scanning) {
      return content.append(h('div', { class: 'empty-state' }, h('div', { class: 'spinner' }), h('h2', { text: 'Scanning your music…' })));
    }
    const fn = this['render_' + v.type];
    if (fn) fn.call(this, v, content);
    if (keepScroll && v.scroll != null) {
      const scroller = this.list?.el || $('#content .scroll');
      if (scroller) {
        scroller.scrollTop = v.scroll;
        this.list?.renderRows();
      }
    }
  },

  welcome() {
    return h('div', { class: 'empty-state welcome' },
      h('div', { class: 'brand-mark big' }),
      h('h1', { text: 'Welcome to Musicolet PC' }),
      h('p', { class: 'muted', text: 'A fast, offline music player with multiple queues, synced lyrics, a tag editor and an equalizer. Add the folder where you keep your music to get started.' }),
      textBtn('Add music folder', () => App.addFolder(), { iconName: 'add', primary: true }),
    );
  },

  // ---------- shared building blocks ----------
  header({ title, subtitle, art, actions = [], search = true, sort, back = this.stack.length > 1, onSearch }) {
    const el = h('div', { class: 'view-header' + (art !== undefined ? ' with-art' : '') });
    if (back) el.append(iconBtn('back', 'Back (Alt+←)', () => this.back(), 'back-btn'));
    if (art !== undefined) {
      el.append(art ? h('img', { class: 'header-art', src: art, alt: '' }) : h('div', { class: 'header-art art-placeholder' }));
    }
    const text = h('div', { class: 'view-title' }, h('h1', { class: 'ellipsis', text: title, title }), subtitle ? h('div', { class: 'muted ellipsis', text: subtitle, title: subtitle }) : null);
    el.append(text);
    const tools = h('div', { class: 'view-tools' });
    if (search) {
      const input = h('input', { class: 'search', type: 'search', placeholder: 'Search', value: this.query });
      const wrap = h('div', { class: 'search-wrap', html: icon('search', 18) }, input);
      input.addEventListener('input', debounce(() => {
        this.query = input.value;
        onSearch?.();
      }, 120));
      input.addEventListener('keydown', (e) => {
        if (e.key === 'Escape' && input.value) {
          e.stopPropagation();
          input.value = '';
          this.query = '';
          onSearch?.();
        } else if (e.key === 'ArrowDown' && this.list) {
          this.list.el.focus();
          this.list.onKey(e);
        }
      });
      tools.append(wrap);
    }
    if (sort) tools.append(this.sortControl(sort));
    tools.append(...actions.filter(Boolean));
    el.append(tools);
    const bar = h('div', { class: 'view-header-wrap' }, el, (this.selBar = this.selectionBar()));
    return bar;
  },

  selectionBar() {
    const bar = h('div', { class: 'selbar', hidden: true });
    const count = h('span', { class: 'selcount' });
    bar.append(
      count,
      textBtn('Select all', () => this.list?.selectAll()),
      textBtn('Invert', () => this.list?.invertSelection()),
      textBtn('Clear', () => this.list?.clearSelection()),
      h('div', { class: 'spacer' }),
      textBtn('Play', () => Player.replaceQueue(this.list.selectedIds()), { iconName: 'play' }),
      textBtn('Play next', () => Player.playNext(this.list.selectedIds()), { iconName: 'playNext' }),
      textBtn('More', (e) => this.list.o.onContext({ clientX: e.clientX, clientY: e.clientY + 10 }, this.list.selected()), { iconName: 'more' }),
    );
    bar.update = (n) => {
      bar.hidden = n < 2;
      count.textContent = `${n.toLocaleString()} selected`;
    };
    return bar;
  },

  sortControl({ view, options, fallback, onChange }) {
    const cur = Store.sortFor(view, fallback);
    const sel = h('select', { class: 'input sort-select', title: 'Sort by' }, ...options.map(([k, l]) => h('option', { value: k, text: l })));
    sel.value = cur.key;
    const dir = iconBtn('sort', cur.desc ? 'Descending' : 'Ascending', () => {
      const s = Store.sortFor(view, fallback);
      Store.setSort(view, s.key, !s.desc);
      dir.classList.toggle('desc', !s.desc);
      dir.title = !s.desc ? 'Descending' : 'Ascending';
      onChange();
    }, 'sort-dir' + (cur.desc ? ' desc' : ''));
    dir.innerHTML = '<span class="sort-arrow">↑</span>';
    sel.addEventListener('change', () => {
      Store.setSort(view, sel.value, Store.sortFor(view, fallback).desc);
      onChange();
    });
    return h('div', { class: 'sort-wrap' }, sel, dir);
  },

  trackSortOptions(extra = []) {
    return [...extra, ...['title', 'artist', 'album', 'year', 'duration', 'added', 'modified', 'filename', 'plays'].map((k) => [k, TRACK_SORTS[k].label])];
  },

  // Generic song-list page.
  trackView(content, cfg) {
    const { title, subtitle, art, actions = [], getIds, sortView, sortFallback = 'title', sortExtra = [], ctx = { type: 'library' }, reorderable, onDropIds, isCurrent, onActivate, numberFn, showCover } = cfg;
    let base = [];
    const compute = () => {
      base = getIds();
      if (sortView) {
        const s = Store.sortFor(sortView, sortFallback);
        base = Store.sortIds(base, s.key, s.desc);
      }
      if (this.query) {
        const shown = [];
        const map = [];
        const allowed = new Set(Store.filterIds([...new Set(base)], this.query));
        base.forEach((id, i) => {
          if (allowed.has(id)) {
            shown.push(id);
            map.push(i);
          }
        });
        this.indexMap = map;
        return shown;
      }
      this.indexMap = null;
      return base;
    };
    const orig = (i) => (this.indexMap ? this.indexMap[i] : i);
    const origAll = (indices) => indices.map(orig);

    const hdr = this.header({
      title,
      subtitle,
      art,
      actions,
      sort: sortView ? { view: sortView, options: this.trackSortOptions(sortExtra), fallback: sortFallback, onChange: () => list.setIds(compute()) } : null,
      onSearch: () => list.setIds(compute()),
    });
    const list = new TrackList({
      showCover,
      numberFn,
      empty: cfg.empty || 'No songs here',
      isCurrent: isCurrent ? (i, id) => isCurrent(orig(i), id) : (i, id) => id === Player.currentId,
      onActivate: (i) => (onActivate ? onActivate(orig(i), list.ids) : Player.playIds(list.ids, i)),
      onContext: (e, indices) => this.trackMenu(e, indices.map((i) => list.ids[i]), { ...ctx, indices: origAll(indices) }),
      onDelete: ctx.type === 'queue' || ctx.type === 'playlist' ? (indices) => this.removeFrom(ctx, origAll(indices)) : null,
      onReorder: reorderable ? (indices, target) => !this.query && reorderable(origAll(indices), target >= list.ids.length ? base.length : orig(target)) : null,
      onDropIds: onDropIds ? (ids, target) => onDropIds(ids, target >= list.ids.length ? base.length : orig(target)) : null,
      onSelection: (n) => this.selBar?.update(n),
    });
    this.list = list;
    content.append(hdr, h('div', { class: 'view-body' }, list.el));
    list.setIds(compute());
    return list;
  },

  removeFrom(ctx, indices) {
    if (ctx.type === 'queue') Player.removeFromQueue(ctx.qid, indices);
    else if (ctx.type === 'playlist') {
      if (ctx.pid === 'favorites') {
        const ids = indices.map((i) => Store.state.favorites[i]);
        Store.setFav(ids, false);
      } else {
        const p = Store.getPlaylist(ctx.pid);
        if (!p) return;
        const set = new Set(indices);
        p.items = p.items.filter((_, i) => !set.has(i));
        Store.changed('playlists');
      }
    }
  },

  queueSubmenu(ids) {
    return [
      ...Store.state.queues.map((q) => ({
        label: q.name + (q.id === Store.state.activeQueueId ? ' (playing)' : ''),
        hint: String(q.items.length),
        action: () => Player.addToQueue(q.id, ids),
      })),
      { sep: true },
      { label: 'New queue', icon: 'add', action: () => Player.addToNewQueue(ids), disabled: Store.state.queues.length >= MAX_QUEUES },
    ];
  },

  playlistSubmenu(ids) {
    return [
      { label: 'Favorites', icon: 'heart', action: () => (Store.setFav(ids, true), toast('Added to Favorites')) },
      ...Store.state.playlists.map((p) => ({
        label: p.name,
        hint: String(p.items.length),
        action: () => (Store.addToPlaylist(p.id, ids), toast(`Added ${plural(ids.length, 'song')} to ${p.name}`)),
      })),
      { sep: true },
      {
        label: 'New playlist…',
        icon: 'add',
        action: async () => {
          const name = await Modal.prompt('New playlist', '', { placeholder: 'Playlist name', okLabel: 'Create' });
          if (name) {
            Store.createPlaylist(name, ids);
            toast(`Created playlist "${name}"`);
          }
        },
      },
    ];
  },

  // Actions for a set of songs; used by song lists, album cards, folders, etc.
  collectionItems(ids) {
    return [
      { label: 'Play', icon: 'play', action: () => Player.replaceQueue(ids) },
      { label: 'Shuffle', icon: 'shuffle', action: () => Player.replaceQueue(shuffleArray(ids.slice())) },
      { label: 'Play next', icon: 'playNext', action: () => Player.playNext(ids) },
      { label: 'Add to queue', icon: 'queue', submenu: this.queueSubmenu(ids) },
      { label: 'Add to playlist', icon: 'playlist', submenu: this.playlistSubmenu(ids) },
    ];
  },

  trackMenu(e, ids, ctx = {}) {
    if (!ids.length) return;
    const single = ids.length === 1;
    const t = single ? Store.track(ids[0]) : null;
    const allFav = ids.every((id) => Store.isFav(id));
    const items = [
      ...this.collectionItems(ids).filter((it) => single ? it.label !== 'Shuffle' : true),
      { sep: true },
      { label: allFav ? 'Remove from favorites' : 'Add to favorites', icon: allFav ? 'heart' : 'heartOutline', hint: single ? 'F' : '', action: () => Store.setFav(ids, !allFav) },
      { label: single ? 'Edit tags…' : `Edit tags of ${ids.length} songs…`, icon: 'edit', action: () => Dialogs.tagEditor(ids) },
    ];
    if (t) {
      items.push(
        { label: 'Go to album', icon: 'album', action: () => this.openAlbum(Store.idx.albumOf.get(t.id)) },
        { label: 'Go to artist', icon: 'artist', action: () => this.openArtist((t.artists?.[0] || t.artist || 'Unknown artist').toLowerCase()) },
        { label: 'Go to folder', icon: 'folder', action: () => this.openFolder(pathKey(t.dir)) },
        { label: 'Show in Explorer', icon: 'folder', action: () => api.showInFolder(t.path) },
      );
    }
    if (ctx.type === 'queue') {
      items.push({ sep: true }, { label: 'Remove from queue', icon: 'close', hint: 'Del', action: () => this.removeFrom(ctx, ctx.indices) });
    } else if (ctx.type === 'playlist' && ctx.editable) {
      items.push({ sep: true }, { label: 'Remove from playlist', icon: 'close', hint: 'Del', action: () => this.removeFrom(ctx, ctx.indices) });
    }
    items.push({ sep: true }, {
      label: 'Delete from disk…',
      icon: 'delete',
      danger: true,
      action: async () => {
        const ok = await Modal.confirm('Delete songs?', `Move ${single ? `"${t.title}"` : plural(ids.length, 'song')} to the Recycle Bin?`, { okLabel: 'Delete', danger: true });
        if (!ok) return;
        if (ids.includes(Player.currentId)) Player.pause();
        const removed = await api.trash(ids);
        for (const id of removed) delete Store.lib.tracks[id];
        Store.setLibrary(Store.lib);
        if (removed.includes(Player.currentId)) Player.load(false);
        toast(`Deleted ${plural(removed.length, 'song')}`);
      },
    });
    Menu.show(e.clientX, e.clientY, items);
  },

  // ---------- navigation helpers ----------
  openAlbum(key) {
    if (!key) return;
    this.stack = [{ type: 'albums' }, { type: 'album', key }];
    this.query = '';
    this.render();
  },
  openArtist(key) {
    this.stack = [{ type: 'artists' }, { type: 'artist', key }];
    this.query = '';
    this.render();
  },
  openFolder(key) {
    this.stack = [{ type: 'folders' }, { type: 'folder', key }];
    this.query = '';
    this.render();
  },

  // ---------- Queues ----------
  render_queues(v, content) {
    const qs = Store.state.queues;
    content.append(
      this.header({
        title: 'Queues',
        subtitle: `${qs.length} of ${MAX_QUEUES} queues · each queue remembers its own position`,
        search: false,
        actions: [textBtn('New queue', () => Store.createQueue(), { iconName: 'add', primary: true })],
      }),
    );
    const grid = h('div', { class: 'queue-grid scroll' });
    for (const q of qs) {
      const active = q.id === Store.state.activeQueueId;
      const cur = Store.track(q.items[q.index]);
      const dur = q.items.reduce((s, id) => s + (Store.track(id)?.duration || 0), 0);
      const card = h('div', { class: 'queue-card' + (active ? ' active' : '') },
        h('div', { class: 'qc-art' }, cur?.cover ? h('img', { src: api.coverUrl(cur.cover), alt: '' }) : h('div', { class: 'art-placeholder' })),
        h('div', { class: 'qc-body' },
          h('div', { class: 'qc-name ellipsis', text: q.name }),
          h('div', { class: 'muted small', text: `${plural(q.items.length, 'song')} · ${fmtTotal(dur)}` }),
          h('div', { class: 'qc-cur ellipsis small', text: cur ? `${active ? (Player.playing ? '▶ ' : '❚❚ ') : ''}${q.index + 1}. ${cur.title}` : 'Empty' }),
        ),
        h('div', { class: 'qc-actions' },
          iconBtn(active && Player.playing ? 'pause' : 'play', active ? 'Play / pause' : 'Switch to this queue', (e) => {
            e.stopPropagation();
            active ? Player.toggle() : Player.activateQueue(q.id);
            this.render(true);
          }),
          iconBtn('more', 'More', (e) => {
            e.stopPropagation();
            this.queueMenu(e, q);
          }),
        ),
      );
      if (active) card.append(h('div', { class: 'qc-badge', text: 'Playing' }));
      card.addEventListener('click', () => this.push({ type: 'queue', id: q.id }));
      card.addEventListener('contextmenu', (e) => {
        e.preventDefault();
        this.queueMenu(e, q);
      });
      card.addEventListener('dragover', (e) => {
        if (!TrackList.dragging) return;
        e.preventDefault();
        card.classList.add('drop');
      });
      card.addEventListener('dragleave', () => card.classList.remove('drop'));
      card.addEventListener('drop', (e) => {
        e.preventDefault();
        card.classList.remove('drop');
        if (TrackList.dragging) Player.addToQueue(q.id, TrackList.dragging.ids);
      });
      grid.append(card);
    }
    if (qs.length < MAX_QUEUES) {
      const add = h('button', { class: 'queue-card add-card', html: icon('add', 32) + '<span>New queue</span>' });
      add.addEventListener('click', () => Store.createQueue());
      grid.append(add);
    }
    content.append(h('div', { class: 'view-body' }, grid));
  },

  queueMenu(e, q) {
    const active = q.id === Store.state.activeQueueId;
    Menu.show(e.clientX, e.clientY, [
      { label: active ? 'Playing now' : 'Play this queue', icon: 'play', disabled: active, action: () => Player.activateQueue(q.id) },
      { label: 'Open', icon: 'queue', action: () => this.push({ type: 'queue', id: q.id }) },
      { label: 'Shuffle', icon: 'shuffle', action: () => Player.shuffleQueue(q.id) },
      { label: 'Rename…', icon: 'edit', action: () => this.renameQueue(q) },
      { label: 'Duplicate', icon: 'add', action: () => Store.createQueue(q.items, q.name + ' copy') },
      { label: 'Save as playlist…', icon: 'playlist', action: () => this.saveAsPlaylist(q.items, q.name) },
      { sep: true },
      { label: 'Clear', icon: 'close', action: () => Player.clearQueue(q.id) },
      { label: 'Delete queue', icon: 'delete', danger: true, action: () => Player.deleteQueue(q.id) },
    ]);
  },

  async renameQueue(q) {
    const name = await Modal.prompt('Rename queue', q.name, { okLabel: 'Rename' });
    if (name) Store.renameQueue(q.id, name);
  },

  async saveAsPlaylist(ids, suggested) {
    const name = await Modal.prompt('Save as playlist', suggested, { okLabel: 'Save' });
    if (!name) return;
    Store.createPlaylist(name, ids);
    toast(`Saved playlist "${name}"`);
  },

  render_queue(v, content) {
    const q = Store.getQueue(v.id);
    if (!q) return this.go('queues');
    const active = q.id === Store.state.activeQueueId;
    const dur = q.items.reduce((s, id) => s + (Store.track(id)?.duration || 0), 0);
    const list = this.trackView(content, {
      title: q.name,
      subtitle: `${plural(q.items.length, 'song')} · ${fmtTotal(dur)}${active ? ' · playing now' : ''}`,
      ctx: { type: 'queue', qid: q.id },
      getIds: () => q.items,
      showCover: true,
      empty: 'This queue is empty. Right-click songs anywhere and choose "Add to queue", or drag them here.',
      isCurrent: (i) => i === q.index,
      onActivate: (i) => Player.activateQueue(q.id, i),
      reorderable: (indices, target) => Player.reorderQueue(q.id, indices, target),
      onDropIds: (ids, target) => {
        Store.addToQueue(q.id, ids, target);
        if (active && !Player.currentId) Player.load(false);
      },
      actions: [
        textBtn(active ? 'Playing' : 'Play', () => Player.activateQueue(q.id), { iconName: 'play', primary: !active }),
        iconBtn('shuffle', 'Shuffle queue', () => Player.shuffleQueue(q.id)),
        iconBtn('more', 'More', (e) => this.queueMenu(e, q)),
      ],
    });
    if (q.items.length && v.scroll == null) setTimeout(() => list.scrollToIndex(q.index));
  },

  // ---------- Folders ----------
  folderMode() {
    return Store.state.settings.folderMode;
  },
  folderModeToggle() {
    const wrap = h('div', { class: 'segmented small' });
    for (const [m, l] of [['tree', 'Tree'], ['flat', 'All folders']]) {
      const b = h('button', { class: this.folderMode() === m ? 'active' : '', text: l, title: m === 'tree' ? 'Browse folders like in File Explorer' : 'Every folder that contains music, in one list' });
      b.addEventListener('click', () => {
        Store.state.settings.folderMode = m;
        Store.save();
        this.go('folders');
      });
      wrap.append(b);
    }
    return wrap;
  },

  folderIds(key) {
    const f = Store.idx.folders.get(key);
    if (!f) return [];
    const out = [...f.tracks];
    for (const s of f.subdirs) out.push(...this.folderIds(s));
    return out;
  },

  folderRow(f, subtitle) {
    const row = h('div', { class: 'folder-row', tabindex: '0' },
      h('span', { class: 'folder-ic', html: icon('folder', 22) }),
      h('div', { class: 'folder-main' }, h('div', { class: 'ellipsis', text: f.name || f.path }), subtitle ? h('div', { class: 'muted small ellipsis', text: subtitle }) : null),
      h('span', { class: 'muted small', text: plural(f.total, 'song') }),
    );
    const open = () => this.push({ type: 'folder', key: f.key });
    row.addEventListener('click', open);
    row.addEventListener('keydown', (e) => e.key === 'Enter' && open());
    row.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      const ids = Store.sortIds(this.folderIds(f.key), 'filename');
      Menu.show(e.clientX, e.clientY, [
        ...this.collectionItems(ids),
        { sep: true },
        { label: 'Show in Explorer', icon: 'folder', action: () => api.showInFolder(f.path) },
      ]);
    });
    return row;
  },

  render_folders(v, content) {
    const folders = Store.idx.folders;
    let rows;
    if (this.folderMode() === 'flat') {
      rows = [...folders.values()].filter((f) => f.tracks.length).sort((a, b) => cmp(a.name, b.name));
    } else {
      rows = Store.idx.roots.map((r) => folders.get(r.key)).filter(Boolean);
    }
    const listEl = h('div', { class: 'folder-list scroll' });
    const draw = () => {
      listEl.innerHTML = '';
      const q = this.query.toLowerCase();
      const shown = rows.filter((f) => !q || f.path.toLowerCase().includes(q));
      for (const f of shown) listEl.append(this.folderRow(f, this.folderMode() === 'flat' ? f.path : f.path));
      if (!shown.length) listEl.append(h('div', { class: 'tl-empty', text: 'No folders' }));
    };
    content.append(
      this.header({
        title: 'Folders',
        subtitle: this.folderMode() === 'flat' ? plural(rows.length, 'folder') : 'Library folders',
        actions: [this.folderModeToggle()],
        onSearch: draw,
      }),
      h('div', { class: 'view-body' }, listEl),
    );
    draw();
  },

  render_folder(v, content) {
    const f = Store.idx.folders.get(v.key);
    if (!f) return this.back();
    const subs = [...f.subdirs].map((k) => Store.idx.folders.get(k)).filter(Boolean).sort((a, b) => cmp(a.name, b.name));
    this.trackView(content, {
      title: f.name,
      subtitle: f.path,
      getIds: () => f.tracks,
      sortView: 'folder',
      sortFallback: 'filename',
      empty: subs.length ? 'No songs directly in this folder' : 'No songs',
      actions: [
        textBtn('Play all', () => Player.replaceQueue(Store.sortIds(this.folderIds(f.key), 'filename')), { iconName: 'play', primary: true, title: 'Play this folder and its subfolders' }),
        iconBtn('more', 'More', (e) =>
          Menu.show(e.clientX, e.clientY, [...this.collectionItems(Store.sortIds(this.folderIds(f.key), 'filename')), { sep: true }, { label: 'Show in Explorer', icon: 'folder', action: () => api.showInFolder(f.path) }]),
        ),
      ],
    });
    if (subs.length) {
      const strip = h('div', { class: 'folder-list sub scroll' }, ...subs.map((s) => this.folderRow(s)));
      $('#content .view-body').prepend(strip);
    }
  },

  // ---------- Albums ----------
  albumMenu(e, a) {
    const ids = Store.sortIds(a.tracks, 'track');
    Menu.show(e.clientX, e.clientY, [
      ...this.collectionItems(ids),
      { sep: true },
      { label: 'Edit tags…', icon: 'edit', action: () => Dialogs.tagEditor(ids) },
      a.cover ? { label: 'View album art', icon: 'album', action: () => Dialogs.artViewer(ids.find((id) => Store.track(id).cover)) } : null,
    ]);
  },

  render_albums(v, content) {
    const all = [...Store.idx.albums.values()];
    const grid = h('div', { class: 'album-grid scroll' });
    const sortView = 'albums';
    const draw = () => {
      const s = Store.sortFor(sortView, 'name');
      const q = this.query.toLowerCase();
      let list = all.filter((a) => !q || `${a.name} ${a.artist}`.toLowerCase().includes(q));
      const key = { name: (a) => a.name, artist: (a) => a.artist, year: (a) => a.year || 0, songs: (a) => a.tracks.length }[s.key] || ((a) => a.name);
      list.sort((a, b) => (typeof key(a) === 'number' ? key(a) - key(b) : cmp(key(a), key(b))) || cmp(a.name, b.name));
      if (s.desc) list.reverse();
      grid.innerHTML = '';
      const frag = document.createDocumentFragment();
      for (const a of list) {
        const card = h('div', { class: 'album-card', tabindex: '0' },
          h('div', { class: 'ac-art' },
            a.cover ? h('img', { loading: 'lazy', src: api.coverUrl(a.cover), alt: '' }) : h('div', { class: 'art-placeholder' }),
            h('button', { class: 'ac-play', title: 'Play', html: icon('play', 22) }),
          ),
          h('div', { class: 'ac-name ellipsis', text: a.name, title: a.name }),
          h('div', { class: 'muted small ellipsis', text: [a.artist, a.year].filter(Boolean).join(' · ') }),
        );
        card.addEventListener('click', (e) => {
          if (e.target.closest('.ac-play')) Player.replaceQueue(Store.sortIds(a.tracks, 'track'));
          else this.push({ type: 'album', key: a.key });
        });
        card.addEventListener('keydown', (e) => e.key === 'Enter' && this.push({ type: 'album', key: a.key }));
        card.addEventListener('contextmenu', (e) => {
          e.preventDefault();
          this.albumMenu(e, a);
        });
        frag.append(card);
      }
      grid.append(frag);
      if (!list.length) grid.append(h('div', { class: 'tl-empty', text: 'No albums' }));
    };
    content.append(
      this.header({
        title: 'Albums',
        subtitle: plural(all.length, 'album'),
        sort: { view: sortView, fallback: 'name', options: [['name', 'Name'], ['artist', 'Artist'], ['year', 'Year'], ['songs', 'Number of songs']], onChange: draw },
        onSearch: draw,
      }),
      h('div', { class: 'view-body' }, grid),
    );
    draw();
  },

  render_album(v, content) {
    const a = Store.idx.albums.get(v.key);
    if (!a) return this.back();
    this.trackView(content, {
      title: a.name,
      subtitle: [a.artist, a.year, plural(a.tracks.length, 'song'), fmtTotal(a.duration)].filter(Boolean).join(' · '),
      art: a.cover ? api.coverUrl(a.cover) : null,
      getIds: () => a.tracks,
      sortView: 'album',
      sortFallback: 'track',
      sortExtra: [['track', 'Track number']],
      numberFn: (i, t) => t.track || i + 1,
      actions: [
        textBtn('Play', () => Player.replaceQueue(this.list.ids), { iconName: 'play', primary: true }),
        iconBtn('shuffle', 'Shuffle', () => Player.replaceQueue(shuffleArray(this.list.ids.slice()))),
        iconBtn('more', 'More', (e) => this.albumMenu(e, a)),
      ],
    });
    const art = $('#content .header-art');
    if (art && a.cover) art.addEventListener('click', () => Dialogs.artViewer(a.tracks.find((id) => Store.track(id).cover)));
  },

  // ---------- Artists & Genres ----------
  groupList(content, { title, noun, map, sortView, onOpen, meta }) {
    const all = [...map.values()];
    const listEl = h('div', { class: 'group-list scroll' });
    const draw = () => {
      const s = Store.sortFor(sortView, 'name');
      const q = this.query.toLowerCase();
      const list = all.filter((g) => !q || g.name.toLowerCase().includes(q));
      list.sort((a, b) => (s.key === 'songs' ? a.tracks.length - b.tracks.length : cmp(a.name, b.name)) || cmp(a.name, b.name));
      if (s.desc) list.reverse();
      listEl.innerHTML = '';
      const frag = document.createDocumentFragment();
      for (const g of list) {
        const row = h('div', { class: 'group-row', tabindex: '0' },
          h('div', { class: 'avatar', text: (g.name.match(/[\p{L}\p{N}]/u) || ['#'])[0].toUpperCase() }),
          h('div', { class: 'folder-main' }, h('div', { class: 'ellipsis', text: g.name }), h('div', { class: 'muted small', text: meta(g) })),
        );
        row.addEventListener('click', () => onOpen(g));
        row.addEventListener('keydown', (e) => e.key === 'Enter' && onOpen(g));
        row.addEventListener('contextmenu', (e) => {
          e.preventDefault();
          Menu.show(e.clientX, e.clientY, this.collectionItems(Store.sortIds(g.tracks, 'album')));
        });
        frag.append(row);
      }
      listEl.append(frag);
      if (!list.length) listEl.append(h('div', { class: 'tl-empty', text: `No ${noun}s` }));
    };
    content.append(
      this.header({
        title,
        subtitle: plural(all.length, noun),
        sort: { view: sortView, fallback: 'name', options: [['name', 'Name'], ['songs', 'Number of songs']], onChange: draw },
        onSearch: draw,
      }),
      h('div', { class: 'view-body' }, listEl),
    );
    draw();
  },

  render_artists(v, content) {
    this.groupList(content, {
      title: 'Artists',
      noun: 'artist',
      map: Store.idx.artists,
      sortView: 'artists',
      meta: (g) => `${plural(g.albums.size, 'album')} · ${plural(g.tracks.length, 'song')}`,
      onOpen: (g) => this.push({ type: 'artist', key: g.key }),
    });
  },

  render_artist(v, content) {
    const g = Store.idx.artists.get(v.key);
    if (!g) return this.back();
    const albums = [...g.albums].map((k) => Store.idx.albums.get(k)).filter(Boolean).sort((a, b) => (a.year || 0) - (b.year || 0) || cmp(a.name, b.name));
    this.trackView(content, {
      title: g.name,
      subtitle: `${plural(albums.length, 'album')} · ${plural(g.tracks.length, 'song')}`,
      getIds: () => g.tracks,
      sortView: 'artist',
      sortFallback: 'album',
      showCover: true,
      actions: [
        textBtn('Play', () => Player.replaceQueue(this.list.ids), { iconName: 'play', primary: true }),
        iconBtn('shuffle', 'Shuffle', () => Player.replaceQueue(shuffleArray(this.list.ids.slice()))),
        iconBtn('more', 'More', (e) => Menu.show(e.clientX, e.clientY, this.collectionItems(this.list.ids))),
      ],
    });
    if (albums.length > 1) {
      const strip = h('div', { class: 'album-strip' });
      for (const a of albums) {
        const c = h('div', { class: 'strip-card', title: a.name },
          a.cover ? h('img', { loading: 'lazy', src: api.coverUrl(a.cover), alt: '' }) : h('div', { class: 'art-placeholder' }),
          h('div', { class: 'ellipsis small', text: a.name }),
        );
        c.addEventListener('click', () => this.push({ type: 'album', key: a.key }));
        c.addEventListener('contextmenu', (e) => {
          e.preventDefault();
          this.albumMenu(e, a);
        });
        strip.append(c);
      }
      $('#content .view-body').prepend(strip);
    }
  },

  render_genres(v, content) {
    this.groupList(content, {
      title: 'Genres',
      noun: 'genre',
      map: Store.idx.genres,
      sortView: 'genres',
      meta: (g) => plural(g.tracks.length, 'song'),
      onOpen: (g) => this.push({ type: 'genre', key: g.key }),
    });
  },

  render_genre(v, content) {
    const g = Store.idx.genres.get(v.key);
    if (!g) return this.back();
    this.trackView(content, {
      title: g.name,
      subtitle: plural(g.tracks.length, 'song'),
      getIds: () => g.tracks,
      sortView: 'genre',
      sortFallback: 'artist',
      showCover: true,
      actions: [
        textBtn('Play', () => Player.replaceQueue(this.list.ids), { iconName: 'play', primary: true }),
        iconBtn('shuffle', 'Shuffle', () => Player.replaceQueue(shuffleArray(this.list.ids.slice()))),
      ],
    });
  },

  // ---------- Songs ----------
  render_songs(v, content) {
    const total = Object.values(Store.lib.tracks).reduce((s, t) => s + (t.duration || 0), 0);
    this.trackView(content, {
      title: 'Songs',
      subtitle: `${plural(Store.trackCount(), 'song')} · ${fmtTotal(total)}`,
      getIds: () => Store.allIds(),
      sortView: 'songs',
      showCover: true,
      actions: [
        iconBtn('shuffle', 'Shuffle all', () => Player.replaceQueue(shuffleArray(Store.allIds()))),
        iconBtn('selectAll', 'Select all (Ctrl+A)', () => this.list?.selectAll()),
      ],
    });
  },

  // ---------- Playlists ----------
  autoPlaylistIds(id) {
    const stats = Store.state.stats;
    const all = Store.allIds();
    switch (id) {
      case 'favorites':
        return Store.state.favorites.slice();
      case 'recent-added':
        return Store.sortIds(all, 'added', true).slice(0, 200);
      case 'most-played':
        return all.filter((i) => stats[i]?.plays).sort((a, b) => stats[b].plays - stats[a].plays).slice(0, 100);
      case 'recent-played':
        return all.filter((i) => stats[i]?.lastPlayed).sort((a, b) => stats[b].lastPlayed - stats[a].lastPlayed).slice(0, 100);
      case 'never-played':
        return all.filter((i) => !stats[i]?.plays);
    }
    return [];
  },

  playlistMenu(e, p) {
    Menu.show(e.clientX, e.clientY, [
      ...this.collectionItems(p.items),
      { sep: true },
      { label: 'Rename…', icon: 'edit', action: () => this.renamePlaylist(p) },
      { label: 'Export as M3U…', icon: 'download', action: () => api.exportPlaylist(p.name, p.items).then((ok) => ok && toast('Playlist exported')) },
      { label: 'Delete playlist', icon: 'delete', danger: true, action: () => this.deletePlaylist(p) },
    ]);
  },

  async renamePlaylist(p) {
    const name = await Modal.prompt('Rename playlist', p.name, { okLabel: 'Rename' });
    if (!name) return;
    p.name = name;
    Store.changed('playlists');
  },

  async deletePlaylist(p) {
    const ok = await Modal.confirm('Delete playlist?', `Delete "${p.name}"? The songs themselves are not deleted.`, { okLabel: 'Delete', danger: true });
    if (!ok) return;
    Store.state.playlists = Store.state.playlists.filter((x) => x !== p);
    if (this.top().type === 'playlist') this.stack.pop();
    Store.changed('playlists');
  },

  async importPlaylists() {
    const res = await api.importPlaylist();
    for (const pl of res) {
      const ids = pl.ids.filter((id) => Store.track(id));
      Store.createPlaylist(pl.name, ids);
      toast(`Imported "${pl.name}" (${plural(ids.length, 'song')}${ids.length < pl.ids.length ? `, ${pl.ids.length - ids.length} not in library` : ''})`, 4000);
    }
  },

  render_playlists(v, content) {
    const listEl = h('div', { class: 'group-list scroll' });
    const row = (name, iconName, count, onOpen, onMenu) => {
      const r = h('div', { class: 'group-row', tabindex: '0' },
        h('div', { class: 'avatar icon', html: icon(iconName, 20) }),
        h('div', { class: 'folder-main' }, h('div', { class: 'ellipsis', text: name }), h('div', { class: 'muted small', text: plural(count, 'song') })),
      );
      r.addEventListener('click', onOpen);
      r.addEventListener('keydown', (e) => e.key === 'Enter' && onOpen());
      r.addEventListener('contextmenu', (e) => {
        e.preventDefault();
        onMenu(e);
      });
      return r;
    };
    const draw = () => {
      listEl.innerHTML = '';
      const q = this.query.toLowerCase();
      listEl.append(h('div', { class: 'list-section', text: 'Automatic playlists' }));
      for (const ap of AUTO_PLAYLISTS) {
        if (q && !ap.name.toLowerCase().includes(q)) continue;
        const ids = this.autoPlaylistIds(ap.id);
        listEl.append(row(ap.name, ap.icon, ids.length, () => this.push({ type: 'playlist', id: ap.id }), (e) => Menu.show(e.clientX, e.clientY, this.collectionItems(ids))));
      }
      listEl.append(h('div', { class: 'list-section', text: 'Your playlists' }));
      const mine = Store.state.playlists.filter((p) => !q || p.name.toLowerCase().includes(q)).sort((a, b) => cmp(a.name, b.name));
      for (const p of mine) listEl.append(row(p.name, 'playlist', p.items.length, () => this.push({ type: 'playlist', id: p.id }), (e) => this.playlistMenu(e, p)));
      if (!Store.state.playlists.length) listEl.append(h('div', { class: 'muted pad', text: 'No playlists yet. Select songs, right-click and choose "Add to playlist".' }));
    };
    content.append(
      this.header({
        title: 'Playlists',
        subtitle: plural(Store.state.playlists.length, 'playlist'),
        onSearch: draw,
        actions: [
          textBtn('Import M3U…', () => this.importPlaylists(), { iconName: 'upload' }),
          textBtn('New playlist', async () => {
            const name = await Modal.prompt('New playlist', '', { placeholder: 'Playlist name', okLabel: 'Create' });
            if (name) Store.createPlaylist(name);
          }, { iconName: 'add', primary: true }),
        ],
      }),
      h('div', { class: 'view-body' }, listEl),
    );
    draw();
  },

  render_playlist(v, content) {
    const auto = AUTO_PLAYLISTS.find((a) => a.id === v.id);
    const p = auto ? null : Store.getPlaylist(v.id);
    if (!auto && !p) return this.back();
    const editable = !auto || v.id === 'favorites';
    const getIds = () => (auto ? this.autoPlaylistIds(v.id) : p.items);
    const ids = getIds();
    const dur = ids.reduce((s, id) => s + (Store.track(id)?.duration || 0), 0);
    const stats = Store.state.stats;
    this.trackView(content, {
      title: auto ? auto.name : p.name,
      subtitle: `${plural(ids.length, 'song')} · ${fmtTotal(dur)}`,
      getIds,
      showCover: true,
      sortView: v.id === 'never-played' ? 'never-played' : null,
      ctx: { type: 'playlist', pid: v.id, editable },
      reorderable: editable
        ? (indices, target) => {
            const list = auto ? Store.state.favorites : p.items;
            const r = Store.moveInQueue(list, indices, target, -1);
            if (auto) Store.state.favorites = r.items;
            else p.items = r.items;
            Store.changed(auto ? 'favorites' : 'playlists');
          }
        : null,
      onDropIds: editable
        ? (dropIds, target) => {
            if (auto) return Store.setFav(dropIds, true);
            p.items.splice(target, 0, ...dropIds);
            Store.changed('playlists');
          }
        : null,
      numberFn: v.id === 'most-played' ? (i, t) => `<span class="plays" title="Plays">${stats[t.id]?.plays || 0}×</span>` : null,
      empty: v.id === 'favorites' ? 'No favorites yet. Press the heart on a song (or F) to add it.' : 'No songs here yet',
      actions: [
        textBtn('Play', () => Player.replaceQueue(this.list.ids), { iconName: 'play', primary: true }),
        iconBtn('shuffle', 'Shuffle', () => Player.replaceQueue(shuffleArray(this.list.ids.slice()))),
        p
          ? iconBtn('more', 'More', (e) => this.playlistMenu(e, p))
          : iconBtn('more', 'More', (e) =>
              Menu.show(e.clientX, e.clientY, [
                ...this.collectionItems(this.list.ids),
                { sep: true },
                { label: 'Save as playlist…', icon: 'playlist', action: () => this.saveAsPlaylist(this.list.ids, auto.name) },
                { label: 'Export as M3U…', icon: 'download', action: () => api.exportPlaylist(auto.name, this.list.ids) },
              ]),
            ),
      ],
    });
  },
};
