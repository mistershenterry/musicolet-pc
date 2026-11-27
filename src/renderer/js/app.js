// Bootstrap: now-playing panel, player bar, library scanning and keyboard shortcuts.
const App = {
  scanning: false,
  npList: null,
  seeking: false,

  async start() {
    await Store.init();
    this.applyTheme();
    Player.init();
    Lyrics.initView();
    this.initPlayerBar();
    this.initNowPlaying();
    Views.init();
    this.initShortcuts();
    Presence.init();
    Updates.init();
    BulletinBoard.init();
    SongDownloads.init();
    // Clicking a Windows notification: "The Song Library has updated!" opens it, "There is an update available!"
    // shows the update prompt.
    api.onNavigate((where) => {
      if (where === 'library') Views.go('library');
      else if (where === 'update') Updates.onButton();
    });

    const q = Store.activeQueue();
    if (q.items.length) Player.load(false, q.position || 0);
    else this.updateNowPlaying();

    window.addEventListener('beforeunload', () => {
      Player.saveCurrentPosition();
      Store.saveNow();
    });
    // Pick up new, changed and deleted files every time the app starts.
    if (Store.lib.roots.length) this.rescan(true);
  },

  applyTheme() {
    const s = Store.state.settings;
    const theme = THEMES.some((t) => t.id === s.theme) ? s.theme : 'dark';
    document.documentElement.dataset.theme = theme;
    // Starry Night brings its own moonlight accent; the other themes use the accent color from Settings.
    document.documentElement.style.setProperty('--accent', theme === 'starry' ? STARRY_ACCENT : s.accent);
    StarrySky.toggle(theme === 'starry');
  },

  async addFolder() {
    const roots = await api.addFolder();
    if (!roots) return;
    Store.lib.roots = roots;
    Views.render();
    await this.rescan();
  },

  async rescan(quiet = false) {
    if (this.scanning) return;
    this.scanning = true;
    const status = $('#scan-status');
    const bar = $('.scan-bar > div', status);
    const label = $('.scan-label', status);
    status.hidden = false;
    label.textContent = 'Looking for music…';
    bar.style.width = '0%';
    if (!Store.trackCount()) Views.render();
    const off = api.onScanProgress(({ done, total }) => {
      label.textContent = `Scanning ${done.toLocaleString()} / ${total.toLocaleString()}`;
      bar.style.width = total ? (100 * done) / total + '%' : '0%';
    });
    try {
      const before = Store.trackCount();
      const lib = await api.scan();
      const current = Player.currentId;
      Store.setLibrary(lib);
      if (current && !Store.track(current)) Player.load(false);
      const diff = Store.trackCount() - before;
      if (!quiet || diff) toast(`Library: ${plural(Store.trackCount(), 'song')}${diff > 0 ? ` (${diff} new)` : ''}`);
    } catch (err) {
      toast('Scan failed: ' + err.message, 5000);
    } finally {
      off();
      this.scanning = false;
      status.hidden = true;
      if (!Store.trackCount()) Views.render();
    }
  },

  // ---------- player bar ----------
  initPlayerBar() {
    const set = (id, name) => ($(id).innerHTML = icon(name, id === '#btn-play' ? 28 : 22));
    set('#btn-prev', 'prev');
    set('#btn-next', 'next');
    set('#btn-shuffle', 'shuffle');
    set('#btn-eq', 'eq');
    set('#btn-sleep', 'timer');
    $('#btn-settings').innerHTML = icon('settings') + '<span>Settings</span>';

    $('#btn-play').addEventListener('click', () => Player.toggle());
    $('#btn-prev').addEventListener('click', () => Player.prev());
    $('#btn-next').addEventListener('click', () => Player.next());
    $('#btn-shuffle').addEventListener('click', () => Player.shuffleQueue(Store.state.activeQueueId));
    $('#btn-repeat').addEventListener('click', () => Player.cycleRepeat());
    $('#btn-eq').addEventListener('click', () => Dialogs.equalizer());
    $('#btn-sleep').addEventListener('click', () => Dialogs.sleepTimer());
    $('#btn-speed').addEventListener('click', () => Dialogs.playSpeed());
    $('#btn-speed').addEventListener('contextmenu', (e) => {
      e.preventDefault();
      const r = e.currentTarget.getBoundingClientRect();
      Dialogs.speedMenu(r.left, r.top - 380);
    });
    $('#btn-mute').addEventListener('click', () => Player.toggleMute());
    $('#btn-settings').addEventListener('click', () => Dialogs.settings());

    const vol = $('#volume');
    vol.addEventListener('input', () => Player.setVolume(vol.value / 100));
    vol.addEventListener('wheel', (e) => {
      e.preventDefault();
      Player.setVolume(Store.state.settings.volume + (e.deltaY < 0 ? 0.05 : -0.05));
    }, { passive: false });

    const seek = $('#seek');
    seek.addEventListener('input', () => {
      this.seeking = true;
      const d = Player.duration || 0;
      $('#time-cur').textContent = fmtTime((seek.value / 1000) * d);
      this.paintRange(seek);
    });
    seek.addEventListener('change', () => {
      Player.seek((seek.value / 1000) * (Player.duration || 0));
      this.seeking = false;
    });

    Player.on('time', () => this.updateTime());
    Player.on('state', () => this.updatePlayState());
    Player.on('track', () => this.updateNowPlaying());
    Player.on('meta', () => this.updateNowPlaying());
    Player.on('volume', () => this.updateVolume());
    Player.on('repeat', () => this.updateRepeat());
    Player.on('speed', () => this.updateSpeed());
    Player.on('sleep', () => this.updateSleep());
    this.updateVolume();
    this.updateRepeat();
    this.updateSpeed();
    this.updatePlayState();
    this.updateSleep();
    $('#btn-eq').classList.toggle('on', Store.state.settings.eq.enabled);
  },

  paintRange(el) {
    const pct = ((el.value - el.min) / (el.max - el.min)) * 100;
    el.style.setProperty('--fill', pct + '%');
  },

  updateTime() {
    const d = isFinite(Player.duration) ? Player.duration : Store.track(Player.currentId)?.duration || 0;
    const cur = Player.time;
    $('#time-dur').textContent = fmtTime(d);
    if (!this.seeking) {
      $('#time-cur').textContent = fmtTime(cur);
      const seek = $('#seek');
      seek.value = d ? Math.round((cur / d) * 1000) : 0;
      this.paintRange(seek);
    }
    Lyrics.update();
  },

  updatePlayState() {
    $('#btn-play').innerHTML = icon(Player.playing ? 'pause' : 'play', 28);
    // Starry Night spins the cover while a song plays.
    document.documentElement.classList.toggle('is-playing', !!Player.playing);
    if ('mediaSession' in navigator) navigator.mediaSession.playbackState = Player.currentId ? (Player.playing ? 'playing' : 'paused') : 'none';
    this.npList?.refresh();
  },

  updateVolume() {
    const s = Store.state.settings;
    const v = $('#volume');
    v.value = Math.round((s.muted ? 0 : s.volume) * 100);
    this.paintRange(v);
    $('#btn-mute').innerHTML = icon(s.muted || s.volume === 0 ? 'volumeOff' : 'volume', 22);
  },

  updateRepeat() {
    const r = Store.state.settings.repeat;
    const b = $('#btn-repeat');
    b.innerHTML = icon(r === 'one' ? 'repeatOne' : 'repeat', 22);
    b.classList.toggle('on', r !== 'off');
    b.title = { all: 'Repeat: queue', one: 'Repeat: current song', off: 'Repeat: off' }[r];
  },

  updateSpeed() {
    const r = Player.rateOf();
    const b = $('#btn-speed');
    const st = 12 * Math.log2(r.pitch);
    const pitched = Math.abs(st) >= 0.005;
    b.textContent = fmtRate(r.speed) + '×' + (pitched && !r.linkPitch ? ' ♪' : '');
    b.classList.toggle('on', r.speed !== 1 || pitched);
    b.title =
      `Play speed & pitch: ${fmtRate(r.speed)}×` +
      (pitched ? `, pitch ${st > 0 ? '+' : ''}${Math.round(st * 100) / 100} semitones` : '') +
      (r.own ? ' (this song only)' : '') +
      (Player.fx ? ', processed by ffmpeg' : '') +
      '\nRight-click for quick speeds';
  },

  updateSleep() {
    const b = $('#btn-sleep');
    b.classList.toggle('on', !!Player.sleep);
    b.title = Player.sleep ? `Sleep timer: ${Player.sleepRemaining()}` : 'Sleep timer';
  },

  // ---------- now playing panel ----------
  initNowPlaying() {
    $('#np-art').addEventListener('click', () => Player.currentId && Dialogs.artViewer(Player.currentId));
    $('#np-fav').addEventListener('click', () => this.toggleFavCurrent());
    $$('#np-tabs button').forEach((b) => b.addEventListener('click', () => this.showPanel(b.dataset.panel)));
    $('#np-queue-select').addEventListener('change', (e) => Player.activateQueue(e.target.value));
    for (const el of [$('#np-title'), $('#np-sub')]) {
      el.addEventListener('click', () => {
        const t = Store.track(Player.currentId);
        if (!t) return;
        if (el.id === 'np-title') Views.openAlbum(Store.idx.albumOf.get(t.id));
        else Views.openArtist((t.artists?.[0] || t.artist || 'Unknown artist').toLowerCase());
      });
    }

    const list = new TrackList({
      compact: true,
      empty: 'Queue is empty',
      subtitle: (t) => t.artist || 'Unknown artist',
      isCurrent: (i) => i === Store.activeQueue().index,
      onActivate: (i) => Player.activateQueue(Store.state.activeQueueId, i),
      onContext: (e, indices) => Views.trackMenu(e, indices.map((i) => list.ids[i]), { type: 'queue', qid: Store.state.activeQueueId, indices }),
      onDelete: (indices) => Player.removeFromQueue(Store.state.activeQueueId, indices),
      onReorder: (indices, target) => Player.reorderQueue(Store.state.activeQueueId, indices, target),
      onDropIds: (ids, target) => {
        Store.addToQueue(Store.state.activeQueueId, ids, target);
        if (!Player.currentId) Player.load(false);
      },
    });
    this.npList = list;
    $('#np-queue-list').append(list.el);
    Store.on('queues', () => this.updateQueuePanel());
    Store.on('library', () => this.updateQueuePanel());
    Store.on('current', () => this.updateQueuePanel(true));
    Store.on('favorites', () => {
      this.updateFav();
      list.refresh();
    });
    this.updateQueuePanel(true);
    this.showPanel(Store.state.ui.panel || 'queue');
  },

  showPanel(panel) {
    Store.state.ui.panel = panel;
    Store.save();
    $$('#np-tabs button').forEach((b) => b.classList.toggle('active', b.dataset.panel === panel));
    $('#np-queue-panel').hidden = panel !== 'queue';
    $('#np-lyrics-panel').hidden = panel !== 'lyrics';
    if (panel === 'lyrics') Lyrics.update(true);
    else this.npList.renderRows();
  },

  updateQueuePanel(scroll = false) {
    const q = Store.activeQueue();
    const sel = $('#np-queue-select');
    sel.innerHTML = '';
    for (const x of Store.state.queues) sel.append(h('option', { value: x.id, text: `${x.name} (${x.items.length})` }));
    sel.value = q.id;
    const left = q.items.slice(q.index + 1).reduce((s, id) => s + (Store.track(id)?.duration || 0), 0);
    $('#np-queue-count').textContent = q.items.length ? `${q.index + 1} / ${q.items.length} · ${fmtTotal(left)} left` : '';
    const sameList = this.npList.ids === q.items;
    this.npList.setIds(q.items, sameList);
    if (scroll && q.items.length) requestAnimationFrame(() => this.npList.scrollToIndex(q.index));
  },

  updateNowPlaying() {
    const t = Store.track(Player.currentId);
    const img = $('#np-art');
    if (t?.cover) {
      img.src = api.coverUrl(t.cover) + '?v=' + (t.mtime || 0);
      img.hidden = false;
      $('#np-art-empty').hidden = true;
    } else {
      img.hidden = true;
      img.removeAttribute('src');
      $('#np-art-empty').hidden = false;
    }
    $('#np-title').textContent = t ? t.title : 'Nothing playing';
    $('#np-sub').textContent = t ? [t.artist || 'Unknown artist', t.album].filter(Boolean).join(' · ') : 'Pick a song to start listening';
    document.title = t ? `${t.title} — ${t.artist || 'Unknown artist'} · Musicolet PC` : 'Musicolet PC';
    this.updateFav();
    this.updateTime();
    this.updatePlayState();
    Lyrics.load(Player.currentId);
    this.updateQueuePanel(true);
  },

  updateFav() {
    const on = Player.currentId && Store.isFav(Player.currentId);
    const b = $('#np-fav');
    b.innerHTML = icon(on ? 'heart' : 'heartOutline', 22);
    b.classList.toggle('on', !!on);
    b.disabled = !Player.currentId;
  },

  toggleFavCurrent() {
    if (!Player.currentId) return;
    const on = Store.toggleFav([Player.currentId]);
    toast(on ? 'Added to Favorites' : 'Removed from Favorites');
  },

  // ---------- keyboard ----------
  initShortcuts() {
    document.addEventListener('keydown', (e) => {
      if (Modal.stack.length || Menu.el) return;
      if (isTyping(e)) return;
      const k = e.key;
      const ctrl = e.ctrlKey || e.metaKey;
      if (k === ' ' && !ctrl) {
        e.preventDefault();
        Player.toggle();
      } else if (ctrl && k === 'ArrowRight') {
        e.preventDefault();
        Player.next();
      } else if (ctrl && k === 'ArrowLeft') {
        e.preventDefault();
        Player.prev();
      } else if (e.shiftKey && k === 'ArrowRight') {
        Player.seekBy(10);
      } else if (e.shiftKey && k === 'ArrowLeft') {
        Player.seekBy(-10);
      } else if (ctrl && k === 'ArrowUp') {
        e.preventDefault();
        Player.setVolume(Store.state.settings.volume + 0.05);
      } else if (ctrl && k === 'ArrowDown') {
        e.preventDefault();
        Player.setVolume(Store.state.settings.volume - 0.05);
      } else if (ctrl && k.toLowerCase() === 'f') {
        e.preventDefault();
        $('#content .search')?.focus();
      } else if (ctrl && k.toLowerCase() === 'a') {
        if (Views.list) {
          e.preventDefault();
          Views.list.selectAll();
        }
      } else if ((e.altKey && k === 'ArrowLeft') || k === 'Backspace') {
        Views.back();
      } else if (!ctrl && !e.altKey && k.toLowerCase() === 'm') {
        Player.toggleMute();
      } else if (!ctrl && !e.altKey && k.toLowerCase() === 'f') {
        this.toggleFavCurrent();
      } else if (!ctrl && !e.altKey && k.toLowerCase() === 'l') {
        this.showPanel(Store.state.ui.panel === 'lyrics' ? 'queue' : 'lyrics');
      } else if (!ctrl && !e.altKey && /^[1-8]$/.test(k)) {
        Views.go(TABS[parseInt(k, 10) - 1].id);
      }
    });
    // Mouse "back" button.
    window.addEventListener('mouseup', (e) => {
      if (e.button === 3) Views.back();
    });
  },
};

App.start();
