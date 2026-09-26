// Virtualized song list with multi-select (click / Ctrl / Shift / Ctrl+A / invert), keyboard navigation,
// context menus and drag & drop (reorder within a queue or playlist, drop songs into a queue).
class TrackList {
  static ROW = 52;
  static dragging = null;

  constructor(opts = {}) {
    this.o = opts;
    this.ids = [];
    this.sel = new Set();
    this.anchor = -1;
    this.focusIdx = -1;
    this.rows = new Map();

    this.el = h('div', { class: 'tracklist' + (opts.compact ? ' compact' : ''), tabindex: '0' });
    this.spacer = h('div', { class: 'tl-spacer' });
    this.dropLine = h('div', { class: 'tl-drop', hidden: true });
    this.emptyEl = h('div', { class: 'tl-empty', hidden: true, text: opts.empty || 'No songs' });
    this.el.append(this.spacer, this.dropLine, this.emptyEl);

    this.el.addEventListener('scroll', () => this.renderRows());
    this.ro = new ResizeObserver(() => this.renderRows());
    this.ro.observe(this.el);
    this.bindEvents();
    this.setIds(opts.ids || []);
  }

  get row() {
    return this.o.compact ? 44 : TrackList.ROW;
  }

  setIds(ids, keepSelection = false) {
    this.ids = ids;
    if (!keepSelection) {
      this.sel.clear();
      this.anchor = -1;
    } else {
      for (const i of [...this.sel]) if (i >= ids.length) this.sel.delete(i);
    }
    this.spacer.style.height = ids.length * this.row + 'px';
    this.emptyEl.hidden = ids.length > 0;
    this.refresh();
    this.selectionChanged();
  }

  refresh() {
    for (const r of this.rows.values()) r.remove();
    this.rows.clear();
    this.renderRows();
  }

  renderRows() {
    const n = this.ids.length;
    const R = this.row;
    const top = this.el.scrollTop;
    const height = this.el.clientHeight || 800;
    const first = Math.max(0, Math.floor(top / R) - 6);
    const last = Math.min(n - 1, Math.ceil((top + height) / R) + 6);
    for (const [i, r] of this.rows) {
      if (i < first || i > last) {
        r.remove();
        this.rows.delete(i);
      }
    }
    for (let i = first; i <= last; i++) {
      if (!this.rows.has(i)) {
        const r = this.buildRow(i);
        this.rows.set(i, r);
        this.el.append(r);
      }
    }
  }

  buildRow(i) {
    const id = this.ids[i];
    const t = Store.track(id);
    const current = this.o.isCurrent ? this.o.isCurrent(i, id) : false;
    const row = h('div', {
      class: 'tl-row' + (this.sel.has(i) ? ' selected' : '') + (current ? ' current' : '') + (i === this.focusIdx ? ' focused' : ''),
      draggable: 'true',
      dataset: { i },
      style: { top: i * this.row + 'px', height: this.row + 'px' },
    });
    if (!t) {
      row.innerHTML = `<div class="tl-num">${i + 1}</div><div class="tl-main"><div class="tl-title muted">Missing file</div></div>`;
      return row;
    }
    const num = current ? `<span class="eq-anim ${Player.playing ? 'on' : ''}"><i></i><i></i><i></i></span>` : this.o.numberFn ? this.o.numberFn(i, t) : i + 1;
    const sub = this.o.subtitle ? this.o.subtitle(t) : [t.artist || 'Unknown artist', t.album].filter(Boolean).join(' · ');
    const cover = this.o.showCover
      ? t.cover
        ? `<img class="tl-cover" loading="lazy" src="${api.coverUrl(t.cover)}" alt="">`
        : `<div class="tl-cover art-placeholder"></div>`
      : '';
    row.innerHTML = `
      <div class="tl-num">${num}</div>
      ${cover}
      <div class="tl-main">
        <div class="tl-title">${escapeHtml(t.title)}</div>
        <div class="tl-sub">${escapeHtml(sub)}</div>
      </div>
      ${Store.isFav(id) ? `<div class="tl-fav">${icon('heart', 16)}</div>` : ''}
      <div class="tl-dur">${t.duration ? fmtTime(t.duration) : ''}</div>
      <button class="tl-more icon-btn" tabindex="-1" title="More">${icon('more', 18)}</button>`;
    return row;
  }

  // ---------- selection ----------
  selected() {
    return [...this.sel].sort((a, b) => a - b);
  }
  selectedIds() {
    return this.selected().map((i) => this.ids[i]);
  }
  selectOnly(i) {
    this.sel = new Set([i]);
    this.anchor = i;
    this.syncSelection();
  }
  selectAll() {
    this.sel = new Set(this.ids.map((_, i) => i));
    this.syncSelection();
  }
  invertSelection() {
    const next = new Set();
    this.ids.forEach((_, i) => !this.sel.has(i) && next.add(i));
    this.sel = next;
    this.syncSelection();
  }
  clearSelection() {
    this.sel.clear();
    this.syncSelection();
  }
  syncSelection() {
    for (const [i, r] of this.rows) {
      r.classList.toggle('selected', this.sel.has(i));
      r.classList.toggle('focused', i === this.focusIdx);
    }
    this.selectionChanged();
  }
  selectionChanged() {
    this.o.onSelection?.(this.sel.size);
  }

  scrollToIndex(i, center = true) {
    const R = this.row;
    const top = i * R;
    if (center) this.el.scrollTop = top - this.el.clientHeight / 2 + R / 2;
    else if (top < this.el.scrollTop) this.el.scrollTop = top;
    else if (top + R > this.el.scrollTop + this.el.clientHeight) this.el.scrollTop = top + R - this.el.clientHeight;
  }

  rowIndex(e) {
    const r = e.target.closest('.tl-row');
    return r ? parseInt(r.dataset.i, 10) : -1;
  }

  // ---------- events ----------
  bindEvents() {
    const el = this.el;
    el.addEventListener('click', (e) => {
      const i = this.rowIndex(e);
      if (i < 0) {
        if (e.target === el || e.target === this.spacer) this.clearSelection();
        return;
      }
      if (e.target.closest('.tl-more')) {
        if (!this.sel.has(i)) this.selectOnly(i);
        const r = e.target.closest('.tl-more').getBoundingClientRect();
        this.o.onContext?.({ clientX: r.left, clientY: r.bottom }, this.selected());
        return;
      }
      this.focusIdx = i;
      if (e.shiftKey && this.anchor >= 0) {
        if (!e.ctrlKey) this.sel.clear();
        const [a, b] = [Math.min(this.anchor, i), Math.max(this.anchor, i)];
        for (let k = a; k <= b; k++) this.sel.add(k);
      } else if (e.ctrlKey || e.metaKey) {
        this.sel.has(i) ? this.sel.delete(i) : this.sel.add(i);
        this.anchor = i;
      } else {
        this.sel = new Set([i]);
        this.anchor = i;
      }
      this.syncSelection();
    });
    el.addEventListener('dblclick', (e) => {
      const i = this.rowIndex(e);
      if (i >= 0 && !e.target.closest('.tl-more')) this.o.onActivate?.(i, this.ids[i]);
    });
    el.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      const i = this.rowIndex(e);
      if (i < 0) return;
      if (!this.sel.has(i)) this.selectOnly(i);
      this.o.onContext?.(e, this.selected());
    });
    el.addEventListener('keydown', (e) => this.onKey(e));

    // drag & drop
    el.addEventListener('dragstart', (e) => {
      const i = this.rowIndex(e);
      if (i < 0) return;
      if (!this.sel.has(i)) this.selectOnly(i);
      const indices = this.selected();
      TrackList.dragging = { list: this, indices, ids: indices.map((k) => this.ids[k]) };
      e.dataTransfer.effectAllowed = 'copyMove';
      e.dataTransfer.setData('text/plain', `${indices.length} songs`);
      const ghost = h('div', { class: 'drag-ghost', text: plural(indices.length, 'song') });
      document.body.append(ghost);
      e.dataTransfer.setDragImage(ghost, 10, 10);
      setTimeout(() => ghost.remove());
    });
    el.addEventListener('dragover', (e) => {
      const d = TrackList.dragging;
      if (!d) return;
      const canReorder = d.list === this && this.o.onReorder;
      const canDrop = d.list !== this && this.o.onDropIds;
      if (!canReorder && !canDrop) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = canReorder ? 'move' : 'copy';
      const rect = el.getBoundingClientRect();
      const y = e.clientY - rect.top;
      const target = Math.max(0, Math.min(this.ids.length, Math.round((y + el.scrollTop) / this.row)));
      this.dropTarget = target;
      this.dropLine.hidden = false;
      this.dropLine.style.top = target * this.row - 1 + 'px';
      if (y < 40) el.scrollTop -= 12;
      else if (y > rect.height - 40) el.scrollTop += 12;
    });
    el.addEventListener('dragleave', (e) => {
      if (!el.contains(e.relatedTarget)) this.dropLine.hidden = true;
    });
    el.addEventListener('drop', (e) => {
      e.preventDefault();
      this.dropLine.hidden = true;
      const d = TrackList.dragging;
      if (!d) return;
      if (d.list === this) this.o.onReorder?.(d.indices, this.dropTarget);
      else this.o.onDropIds?.(d.ids, this.dropTarget);
    });
    el.addEventListener('dragend', () => {
      this.dropLine.hidden = true;
      TrackList.dragging = null;
    });
  }

  onKey(e) {
    const n = this.ids.length;
    if (!n) return;
    const move = (to) => {
      to = Math.max(0, Math.min(n - 1, to));
      if (e.shiftKey) {
        if (this.anchor < 0) this.anchor = this.focusIdx < 0 ? to : this.focusIdx;
        this.sel.clear();
        const [a, b] = [Math.min(this.anchor, to), Math.max(this.anchor, to)];
        for (let k = a; k <= b; k++) this.sel.add(k);
      } else {
        this.sel = new Set([to]);
        this.anchor = to;
      }
      this.focusIdx = to;
      this.syncSelection();
      this.scrollToIndex(to, false);
      e.preventDefault();
    };
    const page = Math.max(1, Math.floor(this.el.clientHeight / this.row) - 1);
    switch (e.key) {
      case 'ArrowDown':
        return move(this.focusIdx + 1);
      case 'ArrowUp':
        return move(this.focusIdx < 0 ? 0 : this.focusIdx - 1);
      case 'PageDown':
        return move(this.focusIdx + page);
      case 'PageUp':
        return move(this.focusIdx - page);
      case 'Home':
        return move(0);
      case 'End':
        return move(n - 1);
      case 'Enter':
        if (this.focusIdx >= 0) this.o.onActivate?.(this.focusIdx, this.ids[this.focusIdx]);
        e.preventDefault();
        return;
      case 'Delete':
        if (this.sel.size) this.o.onDelete?.(this.selected());
        return;
      case 'Escape':
        this.clearSelection();
        return;
      case 'ContextMenu': {
        if (!this.sel.size) return;
        const r = (this.rows.get(this.focusIdx) || this.el).getBoundingClientRect();
        this.o.onContext?.({ clientX: r.left + 40, clientY: r.bottom }, this.selected());
        e.preventDefault();
        return;
      }
    }
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'a') {
      this.selectAll();
      e.preventDefault();
      e.stopPropagation();
    }
  }

  destroy() {
    this.ro.disconnect();
    this.el.remove();
  }
}
