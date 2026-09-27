// Discord Rich Presence: sends the current song to the main process whenever playback changes.
const Presence = {
  // Until something is played after launch, Discord shows "Idling..." instead of the restored (paused) song.
  hasPlayed: false,

  init() {
    const update = debounce(() => this.update(), 400);
    for (const ev of ['track', 'state', 'meta', 'speed']) Player.on(ev, update);
    Player.audio.addEventListener('play', () => (this.hasPlayed = true));
    Player.audio.addEventListener('seeked', update);
    Player.audio.addEventListener('loadedmetadata', update);
    this.configure();
  },

  get cfg() {
    return Store.state.settings.discord;
  },

  async configure() {
    const status = await api.discordConfigure({ enabled: this.cfg.enabled, clientId: this.cfg.clientId });
    this.update();
    return status;
  },

  update() {
    if (!this.cfg.enabled) return;
    const t = Store.track(Player.currentId);
    if (!t || !this.hasPlayed) return api.discordUpdate({ idle: true });
    const a = Player.audio;
    api.discordUpdate({
      id: t.id,
      coverFile: t.cover,
      uploadCovers: this.cfg.uploadCovers,
      title: t.title,
      artist: t.artist,
      album: t.album,
      duration: isFinite(a.duration) ? a.duration : t.duration || 0,
      position: a.currentTime || 0,
      speed: Store.state.settings.speed,
      playing: Player.playing,
      showPaused: this.cfg.showPaused,
      lookupCovers: this.cfg.covers,
    });
  },
};
