// Discord Rich Presence: shows "Listening to <song>" on the user's Discord profile.
// Talks to the local Discord desktop app over IPC. Covers come from CoverUploader (the song's own cover,
// via an image host) or CoverLookup (iTunes/Deezer search).
const { Client } = require('@xhayper/discord-rpc');

const PLAYING = 0;
const LISTENING = 2;
const STATUS_DETAILS = 2; // member list shows "Listening to <song title>"
const RETRY_MS = 15000;
// Small "paused" badge shown on the cover (Twemoji U+23F8, CC-BY 4.0).
const PAUSE_ICON = 'https://cdn.jsdelivr.net/gh/twitter/twemoji@14.0.2/assets/72x72/23f8.png';

// The "Musicolet PC" Discord application: its name and icon are what Discord shows.
const CLIENT_ID = '1553799991640981567';

// Discord requires 2–128 characters for text fields.
function text(s) {
  s = String(s || '').trim();
  if (s.length > 128) s = s.slice(0, 127) + '…';
  return s.length < 2 ? s + '⠀⠀'.slice(s.length) : s;
}

class DiscordPresence {
  constructor(covers) {
    this.covers = covers;
    this.np = null;
    this.appIcons = new Map(); // clientId -> icon URL (or null)
    this.client = null;
    this.clientId = CLIENT_ID;
    this.enabled = false;
    this.ready = false;
    this.activity = null;
    this.retryTimer = null;
  }

  status() {
    if (!this.enabled) return 'off';
    return this.ready ? 'connected' : 'waiting';
  }

  async configure({ enabled }) {
    this.enabled = !!enabled;
    if (!this.enabled) await this.disconnect();
    else this.connect();
    return this.status();
  }

  connect() {
    if (this.client || !this.enabled) return;
    const c = new Client({ clientId: this.clientId, transport: { type: 'ipc' } });
    this.client = c;
    c.on('ready', () => {
      if (this.client !== c) return;
      this.ready = true;
      this.flush();
    });
    c.on('disconnected', () => {
      if (this.client !== c) return;
      this.ready = false;
      this.client = null;
      this.scheduleRetry();
    });
    c.login().catch(() => {
      // Discord isn't running (or not ready yet): try again later.
      if (this.client !== c) return;
      this.ready = false;
      this.client = null;
      Promise.resolve()
        .then(() => c.destroy())
        .catch(() => {});
      this.scheduleRetry();
    });
  }

  scheduleRetry() {
    if (!this.enabled || this.retryTimer) return;
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null;
      this.connect();
    }, RETRY_MS);
  }

  async disconnect() {
    clearTimeout(this.retryTimer);
    this.retryTimer = null;
    this.ready = false;
    const c = this.client;
    this.client = null;
    if (!c) return;
    try {
      await c.user?.clearActivity();
    } catch {
      // ignore
    }
    try {
      await c.destroy();
    } catch {
      // ignore
    }
  }

  // The Discord app's own icon (set in the Discord developer portal), used when no album cover is found.
  cachedAppIcon() {
    const hit = this.appIcons.get(this.clientId);
    if (!hit) return undefined;
    // An app without an icon is checked again every 10 minutes, in case one gets uploaded.
    if (!hit.url && Date.now() - hit.at > 10 * 60 * 1000) return undefined;
    return hit.url;
  }

  async appIcon() {
    const id = this.clientId;
    if (!id) return null;
    const cached = this.cachedAppIcon();
    if (cached !== undefined) return cached;
    this.appIcons.set(id, { url: null, at: Date.now() }); // one request at a time
    try {
      const res = await fetch(`https://discord.com/api/v10/applications/${id}/rpc`, { signal: AbortSignal.timeout(6000) });
      const info = await res.json();
      const url = info.icon ? `https://cdn.discordapp.com/app-icons/${id}/${info.icon}.png?size=512` : null;
      this.appIcons.set(id, { url, at: Date.now() });
      return url;
    } catch {
      this.appIcons.delete(id); // offline: try again next time
      return null;
    }
  }

  // np: { title, artist, album, duration, position, speed, playing, showPaused, lookupCovers } or null
  update(np) {
    // Remember when this position was measured: the status may be rebuilt seconds later
    // (when a cover finishes uploading), and the progress bar must still line up with the song.
    if (np) np.at = Date.now();
    this.np = np;
    this.refresh();
  }

  // Cover priority: the song's own cover (uploaded to Litterbox) > online search by artist/album > app icon.
  // The status is shown right away; the picture is added once an upload/lookup finishes.
  refresh() {
    const np = this.np;
    const stillCurrent = () => this.np && np && this.np.id === np.id;
    let cover = null;
    let waiting = false;
    if (np && !np.idle && np.uploadCovers && np.coverFile && this.uploader) {
      const cached = this.uploader.peek(np.coverFile);
      if (cached === undefined) {
        waiting = true;
        this.uploader.get(np.coverFile, np.uploadHost).then(() => stillCurrent() && this.refresh());
      } else {
        cover = cached; // null = upload failed recently: fall through to the online search
      }
    }
    if (!cover && !waiting && np && !np.idle && np.lookupCovers && this.covers) {
      const song = { artist: np.artist, album: np.album, title: np.title };
      const cached = this.covers.peek(song);
      if (cached === undefined) {
        this.covers.find(song).then((url) => url && stillCurrent() && this.refresh());
      } else {
        cover = cached;
      }
    }
    const fallback = this.cachedAppIcon();
    if (fallback === undefined && this.enabled) this.appIcon().then((url) => url && this.np && this.refresh());
    this.activity = this.build(np, cover, fallback || null);
    this.flush();
  }

  build(np, cover = null, fallbackImage = null) {
    if (!np) return null;
    if (np.idle) {
      // App open but nothing played yet (or nothing loaded): "Playing Musicolet PC · Idling..."
      const idle = { type: PLAYING, details: 'Idling...', instance: false };
      if (fallbackImage) {
        idle.largeImageKey = fallbackImage;
        idle.largeImageText = 'Musicolet PC';
      }
      return idle;
    }
    if (!np.playing && !np.showPaused) return null;
    const artist = np.artist || 'Unknown artist';
    const activity = {
      type: LISTENING,
      statusDisplayType: STATUS_DETAILS,
      details: text(np.title),
      state: text(np.playing ? artist : `Paused · ${artist}`),
      instance: false,
    };
    const image = cover || fallbackImage;
    if (image) {
      activity.largeImageKey = image;
      if (np.album) activity.largeImageText = text(np.album);
    }
    if (np.playing && np.duration > 0) {
      const speed = np.speed || 1;
      const measuredAt = np.at || Date.now();
      activity.startTimestamp = Math.round(measuredAt - (np.position / speed) * 1000);
      activity.endTimestamp = Math.round(measuredAt + ((np.duration - np.position) / speed) * 1000);
    } else if (!np.playing && image) {
      // No progress bar while paused; a pause badge on the cover makes that obvious at a glance.
      activity.smallImageKey = PAUSE_ICON;
      activity.smallImageText = 'Paused';
    }
    return activity;
  }

  async flush() {
    if (!this.ready || !this.client?.user) return;
    if (process.env.MUSICOLET_PC_DEBUG) console.log('[discord]', JSON.stringify(this.activity));
    try {
      if (this.activity) await this.client.user.setActivity(this.activity);
      else await this.client.user.clearActivity();
    } catch {
      // connection dropped; the 'disconnected' handler will reconnect
    }
  }
}

module.exports = { DiscordPresence };
