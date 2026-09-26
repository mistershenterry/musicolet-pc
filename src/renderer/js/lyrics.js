// Lyrics: LRC parsing, the synced lyrics view in the now-playing panel, and timestamp helpers for the editor.
const Lyrics = {
  cache: new Map(),
  current: null, // { id, synced, lines }
  activeLine: -1,
  userScrollUntil: 0,

  parse(text) {
    const lines = [];
    let offset = 0;
    let synced = false;
    const stampRe = /\[(\d{1,3}):(\d{1,2}(?:[.:]\d{1,3})?)\]/g;
    for (const raw of (text || '').replace(/\r/g, '').split('\n')) {
      const off = /^\[offset:\s*([+-]?\d+)\]/i.exec(raw);
      if (off) {
        offset = parseInt(off[1], 10) / 1000;
        continue;
      }
      if (/^\[[a-z]+:.*\]$/i.test(raw.trim()) && !/^\[\d/.test(raw.trim())) continue; // [ar:], [ti:] tags
      const stamps = [];
      let m;
      stampRe.lastIndex = 0;
      let lastEnd = 0;
      while ((m = stampRe.exec(raw)) && m.index === lastEnd) {
        stamps.push(parseInt(m[1], 10) * 60 + parseFloat(m[2].replace(':', '.')));
        lastEnd = stampRe.lastIndex;
      }
      const body = raw.slice(lastEnd).replace(/<\d{1,2}:\d{1,2}(?:\.\d{1,3})?>/g, '').trim();
      if (stamps.length) {
        synced = true;
        for (const s of stamps) lines.push({ time: s, text: body });
      } else {
        lines.push({ time: null, text: raw.trim() });
      }
    }
    if (synced) {
      const timed = lines.filter((l) => l.time != null).map((l) => ({ time: Math.max(0, l.time - offset), text: l.text }));
      timed.sort((a, b) => a.time - b.time);
      return { synced: true, lines: timed };
    }
    while (lines.length && !lines[lines.length - 1].text) lines.pop();
    return { synced: false, lines };
  },

  async get(id) {
    if (this.cache.has(id)) return this.cache.get(id);
    const res = await api.lyrics(id);
    const parsed = { ...this.parse(res.text), source: res.source, raw: res.text };
    this.cache.set(id, parsed);
    return parsed;
  },

  invalidate(ids) {
    for (const id of ids) this.cache.delete(id);
    if (this.current && ids.includes(this.current.id)) this.load(this.current.id);
  },

  async load(id) {
    const el = $('#lyrics');
    this.activeLine = -1;
    if (!id) {
      this.current = null;
      el.innerHTML = '<div class="lyrics-empty">Nothing playing</div>';
      return;
    }
    const data = await this.get(id);
    if (Player.currentId !== id) return;
    this.current = { id, ...data };
    el.innerHTML = '';
    el.classList.toggle('synced', data.synced);
    el.style.setProperty('--lyrics-size', Store.state.settings.lyricsSize + 'px');
    if (!data.lines.some((l) => l.text)) {
      el.append(
        h('div', { class: 'lyrics-empty' },
          h('div', { text: 'No lyrics for this song' }),
          h('div', { class: 'muted small', text: 'Add them in the tag editor, or put a .lrc file with the same name next to the song.' }),
          textBtn('Add lyrics', () => Dialogs.tagEditor([id], { focusLyrics: true }), { iconName: 'edit' }),
        ),
      );
      return;
    }
    data.lines.forEach((l, i) => {
      const line = h('div', { class: 'lyric-line', text: l.text || '♪', dataset: { i } });
      if (data.synced) line.addEventListener('click', () => Player.seek(l.time));
      el.append(line);
    });
    if (data.synced) this.update(true);
  },

  update(force = false) {
    const c = this.current;
    if (!c || !c.synced || c.id !== Player.currentId) return;
    const t = Player.audio.currentTime + 0.15;
    let lo = 0;
    let hi = c.lines.length - 1;
    let found = -1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (c.lines[mid].time <= t) {
        found = mid;
        lo = mid + 1;
      } else hi = mid - 1;
    }
    if (found === this.activeLine && !force) return;
    const el = $('#lyrics');
    el.querySelector('.lyric-line.active')?.classList.remove('active');
    this.activeLine = found;
    if (found < 0) return;
    const line = el.children[found];
    line?.classList.add('active');
    if (line && Date.now() > this.userScrollUntil && !el.closest('[hidden]')) {
      el.scrollTo({ top: line.offsetTop - el.clientHeight / 2 + line.clientHeight / 2, behavior: force ? 'auto' : 'smooth' });
    }
  },

  initView() {
    const el = $('#lyrics');
    // Pause auto-scrolling for a few seconds after the user scrolls manually.
    el.addEventListener('wheel', () => (this.userScrollUntil = Date.now() + 4000), { passive: true });
  },

  // "[mm:ss.xx]" for the editor's timestamp button.
  stamp(sec) {
    const m = Math.floor(sec / 60);
    const s = (sec - m * 60).toFixed(2).padStart(5, '0');
    return `[${String(m).padStart(2, '0')}:${s}]`;
  },
};
