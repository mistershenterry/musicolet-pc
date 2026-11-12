// Update checks against the GitHub Releases of this repo.
// Installed copy (NSIS): downloads the new installer and runs it silently on "Update now", then relaunches.
// Portable .exe: can't replace itself, so it only reports the new version and links to its download.
const { app, shell, net } = require('electron');

const REPO = 'mistershenterry/musicolet-pc';
const RELEASES_URL = `https://github.com/${REPO}/releases/latest`;
const FIRST_CHECK_DELAY = 8 * 1000;
const CHECK_INTERVAL = 4 * 60 * 60 * 1000;

const isPortable = () => !!process.env.PORTABLE_EXECUTABLE_FILE;

// "1.2.10" > "1.2.9", and a release is newer than a preview of it: "1.0.8" > "1.0.8-next.2" > "1.0.8-next.1"
function newer(a, b) {
  const parse = (v) => {
    const [main, pre = ''] = String(v).replace(/^v/, '').split('-');
    return { nums: main.split('.').map((n) => parseInt(n, 10) || 0), pre };
  };
  const pa = parse(a);
  const pb = parse(b);
  for (let i = 0; i < 3; i++) if ((pa.nums[i] || 0) !== (pb.nums[i] || 0)) return (pa.nums[i] || 0) > (pb.nums[i] || 0);
  if (!pa.pre || !pb.pre) return !pa.pre && !!pb.pre;
  const na = parseInt(pa.pre.split('.').pop(), 10) || 0;
  const nb = parseInt(pb.pre.split('.').pop(), 10) || 0;
  return na > nb;
}

// GitHub gives release notes as HTML; the renderer shows plain text.
// Everything after the first horizontal rule is the download guide for the GitHub page, not for the app.
const toText = (notes) =>
  (Array.isArray(notes) ? notes.map((n) => n.note).join('\n') : notes || '')
    .split(/<hr\s*\/?>/i)[0]
    // Newlines in the HTML are only formatting, and GitHub turns wrapped lines of the release text
    // into <br>, so both just join words. Only paragraph and list-item ends start a new line.
    .replace(/\s*\n\s*/g, ' ')
    .replace(/\s*<br\s*\/?>\s*/gi, ' ')
    .replace(/<\/(p|h\d)>/gi, '\n\n')
    .replace(/<\/li>/gi, '\n')
    .replace(/<li>/gi, '• ')
    .replace(/<[^>]+>/g, '')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/[ \t]*\n[ \t]*/g, '\n')
    .replace(/ {2,}/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();

class Updater {
  constructor() {
    this.send = () => {};
    this.state = { state: 'idle', current: app.getVersion() };
    this.auto = null;
    this.timer = null;
  }

  // Updates only make sense for the built Windows app, not `npm start`.
  get supported() {
    return app.isPackaged && process.platform === 'win32';
  }

  set(patch) {
    this.state = { current: app.getVersion(), ...patch };
    this.send(this.state);
  }

  start(send) {
    this.send = send;
    if (!this.supported) {
      this.state = { state: 'unsupported', current: app.getVersion() };
      return;
    }
    if (!isPortable()) this.initAuto();
    setTimeout(() => this.check(), FIRST_CHECK_DELAY);
    this.timer = setInterval(() => this.check(), CHECK_INTERVAL);
  }

  initAuto() {
    const { autoUpdater } = require('electron-updater');
    // Preview builds from the `next` branch (e.g. 1.0.8-next.1) would otherwise switch electron-updater to a
    // "next" pre-release channel that skips normal releases, so they'd never be offered the real 1.0.8.
    autoUpdater.allowPrerelease = false;
    autoUpdater.autoDownload = false;
    autoUpdater.autoInstallOnAppQuit = false;
    autoUpdater.logger = null;
    autoUpdater.on('update-available', (info) =>
      this.set({ state: 'available', version: info.version, notes: toText(info.releaseNotes) }),
    );
    autoUpdater.on('update-not-available', () => this.set({ state: 'latest' }));
    autoUpdater.on('download-progress', (p) =>
      this.set({ ...this.state, state: 'downloading', percent: Math.round(p.percent || 0) }),
    );
    autoUpdater.on('update-downloaded', () => {
      this.set({ ...this.state, state: 'installing' });
      // Silent install over the current copy (same folder, no wizard), then start the new version.
      setTimeout(() => autoUpdater.quitAndInstall(true, true), 800);
    });
    autoUpdater.on('error', (err) => {
      // A failed background check shouldn't bother anyone; a failed download should.
      const prev = this.state.state;
      this.set({ ...this.state, state: prev === 'downloading' ? 'error' : 'check-failed', error: String(err?.message || err).split('\n')[0] });
    });
    this.auto = autoUpdater;
  }

  async check() {
    if (!this.supported || ['downloading', 'installing'].includes(this.state.state)) return this.state;
    this.set({ state: 'checking' });
    try {
      if (this.auto) await this.auto.checkForUpdates();
      else await this.checkPortable();
    } catch (err) {
      if (this.state.state === 'checking') this.set({ state: 'check-failed', error: String(err?.message || err).split('\n')[0] });
    }
    return this.state;
  }

  async checkPortable() {
    const res = await net.fetch(`https://api.github.com/repos/${REPO}/releases/latest`, {
      headers: { Accept: 'application/vnd.github+json' },
    });
    if (!res.ok) throw new Error(`GitHub answered ${res.status}`);
    const rel = await res.json();
    const version = String(rel.tag_name || '').replace(/^v/, '');
    if (!newer(version, app.getVersion())) return this.set({ state: 'latest' });
    const asset = (rel.assets || []).find((a) => /portable.*\.exe$/i.test(a.name));
    this.set({ state: 'available', version, notes: (rel.body || '').split(/^---\s*$/m)[0].trim(), portable: true, url: asset?.browser_download_url || RELEASES_URL });
  }

  install() {
    if (this.state.state !== 'available' && this.state.state !== 'error') return this.state;
    if (this.state.portable) {
      shell.openExternal(this.state.url || RELEASES_URL);
      return this.state;
    }
    this.set({ ...this.state, state: 'downloading', percent: 0 });
    this.auto.downloadUpdate().catch(() => {}); // failures arrive through the 'error' event
    return this.state;
  }
}

module.exports = { Updater, RELEASES_URL };
