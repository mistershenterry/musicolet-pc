// Context menus and modal dialogs.
const Menu = {
  el: null,

  show(x, y, items) {
    this.close();
    const root = this.build(items);
    this.el = root;
    document.body.append(root);
    this.place(root, x, y);
    setTimeout(() => {
      document.addEventListener('mousedown', this._outside, true);
      window.addEventListener('blur', this._close);
      document.addEventListener('keydown', this._key, true);
    });
  },

  build(items, isSub = false) {
    const menu = h('div', { class: 'menu' + (isSub ? ' submenu' : '') });
    for (const it of items) {
      if (!it) continue;
      if (it.sep) {
        menu.append(h('div', { class: 'menu-sep' }));
        continue;
      }
      if (it.header) {
        menu.append(h('div', { class: 'menu-header', text: it.header }));
        continue;
      }
      const row = h('div', {
        class: 'menu-item' + (it.disabled ? ' disabled' : '') + (it.danger ? ' danger' : '') + (it.submenu ? ' has-sub' : ''),
      });
      row.innerHTML =
        `<span class="menu-icon">${it.checked ? icon('check', 18) : it.icon ? icon(it.icon, 18) : ''}</span>` +
        `<span class="menu-label">${escapeHtml(it.label)}</span>` +
        (it.hint ? `<span class="menu-hint">${escapeHtml(it.hint)}</span>` : '') +
        (it.submenu ? '<span class="menu-arrow">›</span>' : '');
      if (it.submenu) {
        let sub = null;
        row.addEventListener('mouseenter', () => {
          menu.querySelectorAll(':scope > .submenu').forEach((s) => s.remove());
          sub = this.build(it.submenu, true);
          menu.append(sub);
          const r = row.getBoundingClientRect();
          this.place(sub, r.right - 4, r.top - 6, r.left);
        });
      } else {
        row.addEventListener('mouseenter', () => menu.querySelectorAll(':scope > .submenu').forEach((s) => s.remove()));
        if (!it.disabled) {
          row.addEventListener('click', () => {
            this.close();
            it.action?.();
          });
        }
      }
      menu.append(row);
    }
    return menu;
  },

  place(el, x, y, flipX) {
    el.style.left = '0px';
    el.style.top = '0px';
    const r = el.getBoundingClientRect();
    const W = window.innerWidth;
    const H = window.innerHeight;
    let left = x;
    let top = y;
    if (left + r.width > W - 8) left = flipX != null ? flipX - r.width + 4 : W - r.width - 8;
    if (top + r.height > H - 8) top = Math.max(8, H - r.height - 8);
    el.style.left = Math.max(8, left) + 'px';
    el.style.top = top + 'px';
  },

  close() {
    if (!Menu.el) return;
    Menu.el.remove();
    Menu.el = null;
    document.removeEventListener('mousedown', Menu._outside, true);
    window.removeEventListener('blur', Menu._close);
    document.removeEventListener('keydown', Menu._key, true);
  },
  _close: () => Menu.close(),
  _outside: (e) => {
    if (Menu.el && !Menu.el.contains(e.target)) Menu.close();
  },
  _key: (e) => {
    if (e.key === 'Escape') {
      e.stopPropagation();
      Menu.close();
    }
  },
};

const Modal = {
  stack: [],

  open({ title, body, buttons = [], wide = false, onClose, className = '' }) {
    const box = h('div', { class: 'modal' + (wide ? ' wide' : '') + ' ' + className });
    const backdrop = h('div', { class: 'modal-backdrop' }, box);
    const head = h('div', { class: 'modal-head' }, h('h2', { text: title }), iconBtn('close', 'Close', () => close()));
    const content = h('div', { class: 'modal-body' });
    if (body) content.append(body);
    const foot = h('div', { class: 'modal-foot' });
    const close = (result) => {
      backdrop.remove();
      this.stack = this.stack.filter((m) => m !== entry);
      document.removeEventListener('keydown', onKey, true);
      onClose?.(result);
    };
    for (const b of buttons) {
      const btn = h('button', { class: 'btn' + (b.primary ? ' primary' : '') + (b.danger ? ' danger' : ''), text: b.label });
      btn.addEventListener('click', async () => {
        const r = b.action ? await b.action() : undefined;
        if (r !== false) close(b.value);
      });
      if (b.left) btn.classList.add('left');
      foot.append(btn);
    }
    box.append(head, content);
    if (buttons.length) box.append(foot);
    backdrop.addEventListener('mousedown', (e) => {
      if (e.target === backdrop) close();
    });
    const onKey = (e) => {
      if (this.stack[this.stack.length - 1] !== entry) return;
      if (e.key === 'Escape') {
        e.stopPropagation();
        close();
      }
    };
    document.addEventListener('keydown', onKey, true);
    $('#overlay-root').append(backdrop);
    const entry = { close, box };
    this.stack.push(entry);
    setTimeout(() => box.querySelector('[autofocus], input, textarea, select')?.focus());
    return entry;
  },

  prompt(title, value = '', { placeholder = '', okLabel = 'OK', label } = {}) {
    return new Promise((resolve) => {
      const input = h('input', { type: 'text', class: 'input', value, placeholder, autofocus: true });
      let result = null;
      const m = this.open({
        title,
        body: h('div', { class: 'form' }, label ? h('label', { text: label }) : null, input),
        buttons: [
          { label: 'Cancel' },
          { label: okLabel, primary: true, action: () => (result = input.value.trim() || null) },
        ],
        onClose: () => resolve(result),
      });
      input.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') {
          result = input.value.trim() || null;
          m.close();
        }
      });
      setTimeout(() => input.select());
    });
  },

  confirm(title, message, { okLabel = 'OK', danger = false } = {}) {
    return new Promise((resolve) => {
      let ok = false;
      this.open({
        title,
        body: h('p', { class: 'confirm-text', text: message }),
        buttons: [{ label: 'Cancel' }, { label: okLabel, primary: !danger, danger, action: () => (ok = true) }],
        onClose: () => resolve(ok),
      });
    });
  },
};
