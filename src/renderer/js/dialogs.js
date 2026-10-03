// Dialogs: tag editor (with synced-lyrics maker), equalizer, sleep timer, settings, album art viewer.
const TAG_FIELDS = [
  ['title', 'Title'],
  ['artist', 'Artist'],
  ['album', 'Album'],
  ['albumArtist', 'Album artist'],
  ['genre', 'Genre'],
  ['year', 'Year'],
  ['track', 'Track #'],
  ['disc', 'Disc #'],
];

const Dialogs = {
  // ---------- tag editor ----------
  async tagEditor(ids, { focusLyrics = false } = {}) {
    if (!ids.length) return;
    const single = ids.length === 1;
    const tracks = ids.map((id) => Store.track(id)).filter(Boolean);
    const d = single ? await api.details(ids[0]) : null;
    if (single && !d) return toast('Song not found');
    const anyMp3 = tracks.some((t) => t.ext === 'mp3');
    const dirty = new Set();
    let coverChange = null;

    const form = h('div', { class: 'tag-form' });
    const inputs = {};
    for (const [key, label] of TAG_FIELDS) {
      if (!single && key === 'title') continue;
      const values = new Set(tracks.map((t) => (t[key] ?? '') + ''));
      const same = values.size === 1;
      const input = h('input', {
        class: 'input',
        type: key === 'year' || key === 'track' || key === 'disc' ? 'number' : 'text',
        value: same ? [...values][0] : '',
        placeholder: same ? '' : 'Multiple values (unchanged)',
        disabled: !anyMp3,
      });
      input.addEventListener('input', () => dirty.add(key));
      inputs[key] = input;
      form.append(h('label', { class: 'field' + (['year', 'track', 'disc'].includes(key) ? ' short' : '') }, h('span', { text: label }), input));
    }

    // album art
    const firstCover = single ? d.picture || (d.cover ? api.coverUrl(d.cover) : '') : tracks[0].cover ? api.coverUrl(tracks[0].cover) : '';
    const artImg = h('img', { class: 'tag-art', src: firstCover || null, alt: '' });
    const artEmpty = h('div', { class: 'tag-art art-placeholder', hidden: !!firstCover });
    artImg.hidden = !firstCover;
    const art = h('div', { class: 'tag-art-col' },
      artImg,
      artEmpty,
      h('div', { class: 'row gap' },
        textBtn('Change…', async () => {
          const pick = await api.pickImage();
          if (!pick) return;
          coverChange = { action: 'set', path: pick.path };
          artImg.src = pick.dataUrl;
          artImg.hidden = false;
          artEmpty.hidden = true;
        }),
        textBtn('Remove', () => {
          coverChange = { action: 'remove' };
          artImg.hidden = true;
          artEmpty.hidden = false;
        }),
      ),
    );
    if (!anyMp3) art.querySelectorAll('button').forEach((b) => (b.disabled = true));

    const top = h('div', { class: 'tag-top' }, art, form);
    const body = h('div', { class: 'tag-editor' }, top);

    if (!anyMp3) {
      body.prepend(h('div', { class: 'note', text: 'Only MP3 tags can be edited. For other formats you can still edit lyrics — they are saved as an .lrc file next to the song.' }));
    } else if (tracks.some((t) => t.ext !== 'mp3')) {
      body.prepend(h('div', { class: 'note', text: 'Some selected songs are not MP3 files; their tags will not be changed.' }));
    }
    if (!single) body.prepend(h('div', { class: 'note', text: `Editing ${tracks.length} songs. Only the fields you change will be written.` }));

    let lyricsArea = null;
    if (single) {
      lyricsArea = h('textarea', { class: 'input lyrics-input', spellcheck: 'false', placeholder: 'Paste or type lyrics here.\nTo make synced lyrics: play the song, put the cursor on a line and press "Stamp line" (Ctrl+Enter) when that line is sung.' });
      lyricsArea.value = d.lyrics || '';
      lyricsArea.addEventListener('input', () => dirty.add('lyrics'));
      const isPlayingThis = () => Player.currentId === ids[0];
      const stampLine = () => {
        if (!isPlayingThis()) return toast('Play this song first to stamp lines with the current time.');
        const ta = lyricsArea;
        const v = ta.value;
        const pos = ta.selectionStart;
        const start = v.lastIndexOf('\n', pos - 1) + 1;
        let end = v.indexOf('\n', pos);
        if (end < 0) end = v.length;
        const line = v.slice(start, end).replace(/^(\[\d{1,3}:\d{1,2}(?:[.:]\d{1,3})?\])+/, '');
        const stamped = Lyrics.stamp(Math.max(0, Player.audio.currentTime - 0.2)) + line;
        ta.value = v.slice(0, start) + stamped + v.slice(end);
        const nextLine = start + stamped.length + 1;
        ta.selectionStart = ta.selectionEnd = Math.min(nextLine, ta.value.length);
        dirty.add('lyrics');
        ta.focus();
      };
      lyricsArea.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' && e.ctrlKey) {
          e.preventDefault();
          stampLine();
        }
      });
      const where = d.ext !== 'mp3' || d.lyricsSource === 'lrc' ? 'Saved to an .lrc file next to the song.' : 'Saved inside the MP3 file.';
      body.append(
        h('div', { class: 'lyrics-tools' },
          h('h3', { text: 'Lyrics' }),
          h('span', { class: 'muted small', text: where }),
          h('div', { class: 'spacer' }),
          textBtn('Play / pause', () => {
            if (isPlayingThis()) return Player.toggle();
            Player.playNext([ids[0]]);
            if (Player.currentId !== ids[0]) Player.next();
          }),
          textBtn('−3 s', () => isPlayingThis() && Player.seekBy(-3)),
          textBtn('Stamp line', stampLine, { title: 'Ctrl+Enter', primary: true }),
          textBtn('Clear stamps', () => {
            lyricsArea.value = lyricsArea.value.replace(/^(\[\d{1,3}:\d{1,2}(?:[.:]\d{1,3})?\])+/gm, '');
            dirty.add('lyrics');
          }),
        ),
        lyricsArea,
      );
    }

    const save = async () => {
      const changes = {};
      for (const key of dirty) {
        if (key === 'lyrics') changes.lyrics = lyricsArea.value;
        else changes[key] = inputs[key].value.trim();
      }
      if (coverChange) changes.cover = coverChange;
      if (!Object.keys(changes).length) return true;
      const res = await api.writeTags(ids, changes);
      if (res.error) {
        await Modal.confirm('Could not save tags', res.error, { okLabel: 'OK' });
        return false;
      }
      for (const w of res.warnings) toast(w, 5000);
      for (const t of res.updated) Store.lib.tracks[t.id] = t;
      Store.rebuild();
      Store.emit('library');
      Lyrics.invalidate(ids);
      Player.emit('meta');
      toast(single ? 'Tags saved' : `Saved tags for ${plural(res.updated.length, 'song')}`);
      return true;
    };

    Modal.open({
      title: single ? 'Edit tags' : `Edit tags — ${plural(tracks.length, 'song')}`,
      body,
      wide: true,
      buttons: [
        single ? { label: 'Show file', left: true, action: () => (api.showInFolder(d.path), false) } : null,
        { label: 'Cancel' },
        { label: 'Save', primary: true, action: save },
      ].filter(Boolean),
    });
    if (focusLyrics && lyricsArea) setTimeout(() => lyricsArea.focus(), 50);
  },

  // ---------- equalizer ----------
  equalizer() {
    Player.ensureGraph();
    const eq = Store.state.settings.eq;
    const apply = () => {
      Player.applyEq();
      Store.save();
      $('#btn-eq').classList.toggle('on', eq.enabled);
    };
    const enabled = h('input', { type: 'checkbox', checked: eq.enabled });
    const preset = h('select', { class: 'input' }, ...Object.keys(EQ_PRESETS).map((p) => h('option', { value: p, text: p })), h('option', { value: 'Custom', text: 'Custom' }));
    preset.value = EQ_PRESETS[eq.preset] ? eq.preset : 'Custom';

    const bands = h('div', { class: 'eq-bands' });
    const sliders = [];
    const makeBand = (label, get, set) => {
      const val = h('div', { class: 'eq-val' });
      const s = h('input', { type: 'range', min: '-12', max: '12', step: '0.5', class: 'vslider' });
      const show = () => (val.textContent = (s.value > 0 ? '+' : '') + s.value);
      s.value = get();
      show();
      s.addEventListener('input', () => {
        set(parseFloat(s.value));
        show();
        apply();
      });
      bands.append(h('div', { class: 'eq-band' }, val, s, h('div', { class: 'eq-freq', text: label })));
      return { s, show };
    };
    const pre = makeBand('Preamp', () => eq.preamp, (v) => (eq.preamp = v));
    bands.append(h('div', { class: 'eq-divider' }));
    EQ_BANDS.forEach((f, i) => {
      sliders.push(
        makeBand(f >= 1000 ? f / 1000 + 'k' : String(f), () => eq.gains[i], (v) => {
          eq.gains[i] = v;
          eq.preset = 'Custom';
          preset.value = 'Custom';
          if (!eq.enabled) {
            eq.enabled = true;
            enabled.checked = true;
          }
        }),
      );
    });
    const syncSliders = () => {
      sliders.forEach((b, i) => {
        b.s.value = eq.gains[i];
        b.show();
      });
      pre.s.value = eq.preamp;
      pre.show();
    };
    enabled.addEventListener('change', () => {
      eq.enabled = enabled.checked;
      apply();
    });
    preset.addEventListener('change', () => {
      if (preset.value === 'Custom') return;
      eq.preset = preset.value;
      eq.gains = EQ_PRESETS[preset.value].slice();
      eq.enabled = true;
      enabled.checked = true;
      syncSliders();
      apply();
    });
    const body = h('div', { class: 'eq' },
      h('div', { class: 'row gap center' },
        h('label', { class: 'switch' }, enabled, h('span', { class: 'slider' })),
        h('span', { text: 'Enable equalizer' }),
        h('div', { class: 'spacer' }),
        h('span', { class: 'muted', text: 'Preset' }),
        preset,
      ),
      bands,
    );
    Modal.open({
      title: 'Equalizer',
      body,
      wide: true,
      buttons: [
        {
          label: 'Reset',
          left: true,
          action: () => {
            eq.gains = EQ_BANDS.map(() => 0);
            eq.preamp = 0;
            eq.preset = 'Flat';
            preset.value = 'Flat';
            syncSliders();
            apply();
            return false;
          },
        },
        { label: 'Done', primary: true },
      ],
    });
  },

  // ---------- sleep timer ----------
  sleepTimer() {
    if (Player.sleep) {
      const status = h('p', { class: 'confirm-text' });
      const upd = () => (status.textContent = `Playback will stop ${Player.sleep ? (Player.sleep.mode === 'songs' || Player.sleep.waiting ? Player.sleepRemaining() : 'in ' + Player.sleepRemaining()) : '—'}.`);
      upd();
      const t = setInterval(upd, 1000);
      Modal.open({
        title: 'Sleep timer',
        body: status,
        buttons: [{ label: 'Cancel timer', danger: true, action: () => Player.cancelSleep() }, { label: 'Close', primary: true }],
        onClose: () => clearInterval(t),
      });
      return;
    }
    const mode = { value: 'time' };
    const minutes = h('input', { class: 'input', type: 'number', min: '1', max: '600', value: '30' });
    const songs = h('input', { class: 'input', type: 'number', min: '1', max: '500', value: '3' });
    const finish = h('input', { type: 'checkbox', checked: true });
    const radio = (val, label, input, suffix) => {
      const r = h('input', { type: 'radio', name: 'sleepmode', value: val, checked: val === 'time' });
      r.addEventListener('change', () => (mode.value = val));
      input.addEventListener('focus', () => {
        r.checked = true;
        mode.value = val;
      });
      return h('label', { class: 'row gap center radio-row' }, r, h('span', { text: label }), input, h('span', { class: 'muted', text: suffix }));
    };
    const quick = h('div', { class: 'row gap wrap' },
      ...[15, 30, 45, 60, 90].map((m) =>
        textBtn(`${m} min`, () => {
          minutes.value = m;
          mode.value = 'time';
          body.querySelector('input[value=time]').checked = true;
        }),
      ),
    );
    const body = h('div', { class: 'form' },
      radio('time', 'Stop after', minutes, 'minutes'),
      quick,
      radio('songs', 'Stop after', songs, 'songs'),
      h('label', { class: 'row gap center' }, finish, h('span', { text: 'When the time runs out, let the current song finish' })),
    );
    Modal.open({
      title: 'Sleep timer',
      body,
      buttons: [
        { label: 'Cancel' },
        {
          label: 'Start',
          primary: true,
          action: () =>
            Player.startSleep({
              mode: mode.value,
              minutes: Math.max(1, parseInt(minutes.value, 10) || 30),
              songs: Math.max(1, parseInt(songs.value, 10) || 1),
              finish: finish.checked,
            }),
        },
      ],
    });
  },

  speedMenu(x, y) {
    const rates = [0.5, 0.75, 0.85, 0.9, 1, 1.1, 1.15, 1.25, 1.5, 1.75, 2];
    Menu.show(
      x,
      y,
      rates.map((r) => ({ label: r.toFixed(2).replace(/0$/, '') + '×', checked: Store.state.settings.speed === r, action: () => Player.setSpeed(r) })),
    );
  },

  // ---------- settings ----------
  settings() {
    const s = Store.state.settings;
    const section = (title, ...children) => h('section', { class: 'settings-section' }, h('h3', { text: title }), ...children);
    const selectRow = (label, value, options, onChange, hint) => {
      const sel = h('select', { class: 'input' }, ...options.map(([v, l]) => h('option', { value: v, text: l })));
      sel.value = value;
      sel.addEventListener('change', () => onChange(sel.value));
      return h('label', { class: 'settings-row' }, h('div', {}, h('div', { text: label }), hint ? h('div', { class: 'muted small', text: hint }) : null), sel);
    };

    const rootsList = h('div', { class: 'roots' });
    const renderRoots = () => {
      rootsList.innerHTML = '';
      if (!Store.lib.roots.length) rootsList.append(h('div', { class: 'muted', text: 'No folders yet.' }));
      for (const r of Store.lib.roots) {
        rootsList.append(
          h('div', { class: 'root-row' },
            h('span', { class: 'ic-wrap', html: icon('folder', 18) }),
            h('span', { class: 'ellipsis', text: r, title: r }),
            iconBtn('delete', 'Remove from library (files are not deleted)', async () => {
              const lib = await api.removeFolder(r);
              Store.setLibrary(lib);
              renderRoots();
            }),
          ),
        );
      }
    };
    renderRoots();

    const accent = h('input', { type: 'color', value: s.accent, class: 'color-input' });
    accent.addEventListener('input', () => {
      s.accent = accent.value;
      App.applyTheme();
      Store.save();
    });
    const prevSel = h('input', { class: 'input short', type: 'number', min: '0', max: '30', value: s.prevThreshold });
    prevSel.addEventListener('change', () => {
      s.prevThreshold = Math.max(0, parseInt(prevSel.value, 10) || 0);
      Store.save();
    });
    const lyricSize = h('input', { class: 'input short', type: 'number', min: '12', max: '40', value: s.lyricsSize });
    lyricSize.addEventListener('change', () => {
      s.lyricsSize = Math.max(12, Math.min(40, parseInt(lyricSize.value, 10) || 18));
      $('#lyrics').style.setProperty('--lyrics-size', s.lyricsSize + 'px');
      Store.save();
    });

    const shortcuts = [
      ['Space', 'Play / pause'],
      ['Ctrl + → / ←', 'Next / previous song'],
      ['Shift + → / ←', 'Seek 10 s'],
      ['Ctrl + ↑ / ↓', 'Volume'],
      ['M', 'Mute'],
      ['F', 'Favorite current song'],
      ['L', 'Show lyrics / queue'],
      ['Ctrl + F', 'Search'],
      ['Ctrl + A', 'Select all in list'],
      ['Delete', 'Remove selection from queue / playlist'],
      ['Ctrl + Enter', 'Stamp line (lyrics editor)'],
      ['1 – 7', 'Switch tabs'],
    ];

    const body = h('div', { class: 'settings' },
      this.bulletinSection(section),
      section('Library',
        rootsList,
        h('div', { class: 'row gap' },
          textBtn('Add folder…', () => App.addFolder().then(renderRoots), { iconName: 'add', primary: true }),
          textBtn('Rescan library', () => App.rescan(), { iconName: 'refresh' }),
        ),
        h('div', { class: 'muted small', text: 'Tip: put an empty file named ".nomedia" in a folder to hide it from the library.' }),
      ),
      section('Appearance',
        selectRow('Theme', s.theme, [['dark', 'Dark'], ['black', 'Black (AMOLED)'], ['light', 'Light']], (v) => {
          s.theme = v;
          App.applyTheme();
          Store.save();
        }),
        h('label', { class: 'settings-row' }, h('div', { text: 'Accent color' }), accent),
        h('label', { class: 'settings-row' }, h('div', { text: 'Lyrics text size' }), lyricSize),
      ),
      section('Playback',
        selectRow('Double-clicking a song', s.clickAction, [
          ['replace', 'Plays the list in the current queue'],
          ['newqueue', 'Plays the list in a new queue'],
          ['next', 'Plays the song next'],
          ['append', 'Adds the song to the end of the queue'],
        ], (v) => {
          s.clickAction = v;
          Store.save();
        }),
        h('label', { class: 'settings-row' },
          h('div', {}, h('div', { text: 'Previous button restarts the song if played for more than (seconds)' }), h('div', { class: 'muted small', text: '0 = always go to the previous song' })),
          prevSel,
        ),
      ),
      this.discordSection(section),
      section('Keyboard shortcuts', h('div', { class: 'shortcuts' }, ...shortcuts.flatMap(([k, d]) => [h('kbd', { text: k }), h('span', { text: d })]))),
      this.updatesSection(section),
      section('About', h('p', { class: 'muted small', text: 'Musicolet PC — an unofficial desktop music player inspired by Musicolet for Android. No ads, no accounts. It only goes online to check for updates and, if you turn it on, for the Discord status.' })),
    );
    Modal.open({ title: 'Settings', body, wide: true, buttons: [{ label: 'Done', primary: true }] });
  },

  // Plans for the next update, from BULLETIN.md in the GitHub repo (refreshes by itself while open).
  bulletinSection(section) {
    const board = h('div', { class: 'bulletin' });
    const meta = h('span', { class: 'muted small' });
    const refresh = iconBtn('refresh', 'Check for changes', () => {
      refresh.disabled = true;
      BulletinBoard.refresh().finally(() => (refresh.disabled = false));
    });
    const fmtDate = (ms) => new Date(ms).toLocaleDateString(undefined, { day: 'numeric', month: 'long', year: 'numeric' });
    const unsubscribe = BulletinBoard.subscribe((s) => {
      if (board.dataset.shown && !board.isConnected) return unsubscribe();
      board.dataset.shown = '1';
      if (s.text.trim()) {
        board.innerHTML = Markdown.render(s.text);
        board.classList.remove('empty');
      } else {
        board.textContent = s.status === 'failed' ? "Couldn't load the bulletin board. Check your internet connection." : s.status === 'never' ? 'Loading…' : 'Nothing posted yet.';
        board.classList.add('empty');
      }
      meta.textContent = [s.updatedAt ? `Updated ${fmtDate(s.updatedAt)}` : '', s.status === 'failed' && s.text ? 'offline: showing the last copy' : ''].filter(Boolean).join(' · ');
      if (board.isConnected) BulletinBoard.markSeen();
    });
    setTimeout(() => BulletinBoard.markSeen());
    return section('Bulletin board',
      h('div', { class: 'row center gap bulletin-head' }, h('span', { class: 'muted small', text: 'Plans for the next update' }), meta, h('div', { class: 'spacer' }), refresh),
      board,
    );
  },

  updatesSection(section) {
    const status = h('div', { class: 'muted small' });
    const btn = textBtn('Check for updates', () => {
      if (['available', 'error'].includes(Updates.s.state)) Updates.install();
      else Updates.check();
    }, { iconName: 'refresh' });
    const title = h('div');
    const unsubscribe = Updates.subscribe((s) => {
      if (!status.isConnected && title.dataset.shown) return unsubscribe();
      title.dataset.shown = '1';
      title.textContent = `Version ${s.current || '?'}`;
      status.textContent = {
        unsupported: 'Updates are installed automatically in the installed app (not when running with npm start).',
        idle: 'Checks for updates automatically.',
        checking: 'Checking for updates…',
        latest: 'You have the latest version ✓',
        'check-failed': `Couldn't check for updates${s.error ? ` (${s.error})` : ''}.`,
        available: `Version ${s.version} is available.`,
        downloading: `Downloading version ${s.version}… ${s.percent || 0}%`,
        installing: 'Installing… Musicolet PC will reopen in a moment.',
        error: `Update failed${s.error ? `: ${s.error}` : ''}.`,
      }[s.state] || '';
      const label = Updates.label(s);
      btn.querySelector('span').textContent = label || 'Check for updates';
      btn.disabled = ['unsupported', 'checking', 'downloading', 'installing'].includes(s.state);
    });
    return section('Updates', h('div', { class: 'settings-row' }, h('div', {}, title, status), btn));
  },

  discordSection(section) {
    const d = Store.state.settings.discord;
    const status = h('span', { class: 'muted small' });
    const showStatus = (s) =>
      (status.textContent = {
        off: 'Off',
        waiting: 'Not connected. Make sure the Discord desktop app is running (retrying automatically).',
        connected: 'Connected to Discord ✓',
      }[s]);
    const apply = async () => {
      Store.save();
      showStatus(await Presence.configure());
    };
    const enabled = h('input', { type: 'checkbox', checked: d.enabled });
    enabled.addEventListener('change', () => {
      d.enabled = enabled.checked;
      apply();
    });
    const paused = h('select', { class: 'input' }, h('option', { value: 'show', text: 'Show "Paused"' }), h('option', { value: 'hide', text: 'Hide the status' }));
    paused.value = d.showPaused ? 'show' : 'hide';
    paused.addEventListener('change', () => {
      d.showPaused = paused.value === 'show';
      Store.save();
      Presence.update();
    });
    const covers = h('input', { type: 'checkbox', checked: d.covers });
    covers.addEventListener('change', () => {
      d.covers = covers.checked;
      Store.save();
      Presence.update();
    });
    const upload = h('input', { type: 'checkbox', checked: d.uploadCovers });
    const uploadHost = h('select', { class: 'input' },
      h('option', { value: 'uguu', text: 'uguu.se (kept 3 hours)' }),
      h('option', { value: 'litterbox', text: 'Litterbox (kept 3 days)' }),
    );
    uploadHost.value = d.uploadHost || 'uguu';
    uploadHost.disabled = !d.uploadCovers;
    upload.addEventListener('change', () => {
      d.uploadCovers = upload.checked;
      uploadHost.disabled = !upload.checked;
      Store.save();
      Presence.update();
    });
    uploadHost.addEventListener('change', () => {
      d.uploadHost = uploadHost.value;
      Store.save();
      Presence.update();
    });
    api.discordStatus().then(showStatus);
    // Refresh the status line while the dialog is open (it changes when Discord starts/quits).
    const timer = setInterval(() => {
      if (!status.isConnected) return clearInterval(timer);
      api.discordStatus().then(showStatus);
    }, 2000);

    return section('Discord',
      h('label', { class: 'settings-row' },
        h('div', {}, h('div', { text: 'Show what I\'m listening to on Discord' }), status),
        h('label', { class: 'switch' }, enabled, h('span', { class: 'slider' })),
      ),
      h('label', { class: 'settings-row' }, h('div', { text: 'When playback is paused' }), paused),
      h('label', { class: 'settings-row' },
        h('div', {},
          h('div', { text: 'Show the song\'s own cover' }),
          h('div', { class: 'muted small', text: 'Discord can\'t show pictures stored on your PC, so the cover of the playing song is uploaded to an image host that deletes it automatically. Only the picture is uploaded, never the song.' }),
        ),
        h('label', { class: 'switch' }, upload, h('span', { class: 'slider' })),
      ),
      h('label', { class: 'settings-row' },
        h('div', {},
          h('div', { text: 'Primary uploader' }),
          h('div', { class: 'muted small', text: 'Covers go here first. If it fails, the other one is tried.' }),
        ),
        uploadHost,
      ),
      h('label', { class: 'settings-row' },
        h('div', {},
          h('div', { text: 'Search for covers online' }),
          h('div', { class: 'muted small', text: 'For songs without their own cover: find the album cover on iTunes, then Deezer, by artist and album name.' }),
        ),
        h('label', { class: 'switch' }, covers, h('span', { class: 'slider' })),
      ),
    );
  },

  // ---------- album art viewer ----------
  artViewer(id) {
    const t = Store.track(id);
    if (!t?.cover) return;
    const img = h('img', { class: 'art-full', src: api.coverUrl(t.cover), alt: '' });
    Modal.open({
      title: t.album || t.title,
      body: img,
      className: 'art-modal',
      buttons: [
        { label: 'Save image…', left: true, action: () => (api.saveCover(t.cover, t.album || t.title), false) },
        { label: 'Close', primary: true },
      ],
    });
  },
};
