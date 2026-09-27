// Discord Rich Presence: shows "Listening to <song>" on the user's Discord profile.
// Talks to the local Discord desktop app over IPC. Album covers come from CoverLookup (iTunes/Deezer).
const { Client } = require('@xhayper/discord-rpc');

const LISTENING = 2;
const STATUS_DETAILS = 2; // member list shows "Listening to <song title>"
const RETRY_MS = 15000;
// Small "paused" badge shown on the cover (Twemoji U+23F8, CC-BY 4.0).
const PAUSE_ICON = 'https://cdn.jsdelivr.net/gh/twitter/twemoji@14.0.2/assets/72x72/23f8.png';

// Built-in Discord application ("Musicolet PC"). Users can override it in Settings.
const DEFAULT_CLIENT_ID = '1553799991640981567';

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
    this.clientId = null;
    this.enabled = false;
    this.ready = false;
    this.activity = null;
    this.retryTimer = null;
  }

  status() {
    if (!this.enabled) return this.wanted ? 'noid' : 'off';
    if (this.ready) return 'connected';
    return this.rejected ? 'rejected' : 'waiting';
  }

  async configure({ enabled, clientId }) {
    const id = String(clientId || '').trim() || DEFAULT_CLIENT_ID;
    const valid = /^\d{15,25}$/.test(id);
    this.wanted = !!enabled;
    this.enabled = !!enabled && valid;
    if (!this.enabled || id !== this.clientId) {
      await this.disconnect();
      this.rejected = false;
    }
    this.clientId = valid ? id : null;
    if (this.enabled) this.connect();
    return this.status();
  }

  connect() {
    if (this.client || !this.enabled) return;
    const c = new Client({ clientId: this.clientId, transport: { type: 'ipc' } });
    this.client = c;
    c.on('ready', () => {
      if (this.client !== c) return;
      this.ready = true;
      this.rejected = false;
      this.flush();
    });
    c.on('disconnected', () => {
      if (this.client !== c) return;
      this.ready = false;
      this.client = null;
      this.scheduleRetry();
    });
    c.login().catch((err) => {
      // Discord isn't running, or it refused this Application ID: try again later.
      if (this.client !== c) return;
      // Discord closes the connection right away when it doesn't recognize the Application ID.
      this.rejected = /Connection ended/i.test(err?.message || '');
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

  // The Discord app's own icon, used as the picture when no album cover is found.
  async appIcon() {
    const id = this.clientId;
    if (!id) return null;
    if (this.appIcons.has(id)) return this.appIcons.get(id);
    this.appIcons.set(id, null);
    try {
      const res = await fetch(`https://discord.com/api/v10/applications/${id}/rpc`, { signal: AbortSignal.timeout(6000) });
      const info = await res.json();
      const url = info.icon ? `https://cdn.discordapp.com/app-icons/${id}/${info.icon}.png?size=512` : null;
      this.appIcons.set(id, url);
      return url;
    } catch {
      this.appIcons.delete(id); // try again next time
      return null;
    }
  }

  // np: { title, artist, album, duration, position, speed, playing, showPaused, lookupCovers } or null
  update(np) {
    this.np = np;
    this.refresh();
  }

  refresh() {
    const np = this.np;
    let cover = null;
    if (np?.lookupCovers && this.covers) {
      const song = { artist: np.artist, album: np.album, title: np.title };
      const cached = this.covers.peek(song);
      if (cached === undefined) {
        // Show the status right away and add the cover once the lookup finishes.
        this.covers.find(song).then((url) => {
          if (url && this.np === np) this.refresh();
        });
      } else {
        cover = cached;
      }
    }
    const fallback = this.appIcons.get(this.clientId);
    if (fallback === undefined && this.enabled) this.appIcon().then((url) => url && this.np === np && this.refresh());
    this.activity = this.build(np, cover, fallback || null);
    this.flush();
  }

  build(np, cover = null, fallbackImage = null) {
    if (!np) return null;
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
      const now = Date.now();
      activity.startTimestamp = Math.round(now - (np.position / speed) * 1000);
      activity.endTimestamp = Math.round(now + ((np.duration - np.position) / speed) * 1000);
    } else if (!np.playing && image) {
      // No progress bar while paused; a pause badge on the cover makes that obvious at a glance.
      activity.smallImageKey = PAUSE_ICON;
      activity.smallImageText = 'Paused';
    }
    return activity;
  }

  async flush() {
    if (!this.ready || !this.client?.user) return;
    try {
      if (this.activity) await this.client.user.setActivity(this.activity);
      else await this.client.user.clearActivity();
    } catch {
      // connection dropped; the 'disconnected' handler will reconnect
    }
  }
}

module.exports = { DiscordPresence };
