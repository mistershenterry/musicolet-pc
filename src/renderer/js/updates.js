// Update prompt: asks once per new version, then keeps a sidebar button until it's installed.
const Updates = {
  s: { state: 'idle' },
  prompted: null,
  listeners: new Set(),

  init() {
    this.btn = $('#btn-update');
    this.btn.addEventListener('click', () => this.onButton());
    api.onUpdateState((s) => this.onState(s));
    api.updateState().then((s) => this.onState(s));
  },

  onState(s) {
    this.s = s;
    this.renderButton();
    for (const fn of this.listeners) fn(s);
    if (s.state === 'available' && this.prompted !== s.version) {
      this.prompted = s.version;
      this.prompt();
    }
    if (s.state === 'error') toast('Update failed: ' + (s.error || 'unknown error'), 6000);
  },

  // Settings dialog subscribes while it's open.
  subscribe(fn) {
    this.listeners.add(fn);
    fn(this.s);
    return () => this.listeners.delete(fn);
  },

  label(s = this.s) {
    switch (s.state) {
      case 'available':
      case 'error':
        return s.portable ? `Download v${s.version}` : `Update to v${s.version}`;
      case 'downloading':
        return `Updating… ${s.percent || 0}%`;
      case 'installing':
        return 'Installing…';
      default:
        return '';
    }
  },

  renderButton() {
    const text = this.label();
    this.btn.hidden = !text;
    this.btn.disabled = ['downloading', 'installing'].includes(this.s.state);
    this.btn.innerHTML = icon('download') + `<span>${escapeHtml(text)}</span>`;
  },

  onButton() {
    if (['available', 'error'].includes(this.s.state)) this.prompt();
  },

  prompt() {
    const s = this.s;
    const body = h('div', { class: 'update-prompt' },
      h('p', { text: `Musicolet PC ${s.version} is available. You have ${s.current}.` }),
      s.notes ? h('div', { class: 'update-notes', text: s.notes }) : null,
      h('p', {
        class: 'muted small',
        text: s.portable
          ? 'This is the portable version, which can\'t update itself. "Download" gets the new portable .exe; use it in place of this one.'
          : 'Musicolet PC will close, update itself and open again in a few seconds. Your library, queues and settings are kept.',
      }),
    );
    Modal.open({
      title: 'Update available',
      body,
      buttons: [
        { label: 'Later' },
        { label: s.portable ? 'Download' : 'Update now', primary: true, action: () => this.install() },
      ],
    });
  },

  install() {
    return api.installUpdate().then((s) => this.onState(s));
  },

  check() {
    return api.checkForUpdate().then((s) => this.onState(s));
  },
};
