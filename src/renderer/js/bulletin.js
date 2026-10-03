// Bulletin board (BULLETIN.md on GitHub): shown in Settings, with a dot on the Settings button
// whenever it has changed since you last opened Settings.
const BulletinBoard = {
  s: { text: '', hash: '', status: 'never' },
  listeners: new Set(),

  init() {
    api.onBulletin((s) => this.onState(s));
    api.bulletinGet().then((s) => this.onState(s));
  },

  onState(s) {
    this.s = s || this.s;
    this.renderDot();
    for (const fn of this.listeners) fn(this.s);
  },

  hasNews() {
    return !!this.s.hash && this.s.text.trim() !== '' && this.s.hash !== Store.state.ui.bulletinSeen;
  },

  markSeen() {
    if (!this.s.hash || Store.state.ui.bulletinSeen === this.s.hash) return;
    Store.state.ui.bulletinSeen = this.s.hash;
    Store.save();
    this.renderDot();
  },

  renderDot() {
    $('#btn-settings').classList.toggle('has-news', this.hasNews());
    $('#btn-settings').title = this.hasNews() ? 'Settings: the bulletin board has news' : '';
  },

  refresh() {
    return api.bulletinCheck().then((s) => this.onState(s));
  },

  // Settings dialog subscribes while it's open.
  subscribe(fn) {
    this.listeners.add(fn);
    fn(this.s);
    return () => this.listeners.delete(fn);
  },
};
