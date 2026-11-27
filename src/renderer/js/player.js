// Playback engine (HTML audio + Web Audio equalizer), queue-driven playback actions and the sleep timer.
const EQ_PRESETS = {
  Flat: [0, 0, 0, 0, 0, 0, 0, 0, 0, 0],
  'Bass boost': [6, 5, 4, 2, 0, 0, 0, 0, 0, 0],
  'Bass reducer': [-6, -5, -4, -2, 0, 0, 0, 0, 0, 0],
  'Treble boost': [0, 0, 0, 0, 0, 1, 2, 4, 5, 6],
  'Treble reducer': [0, 0, 0, 0, 0, -1, -2, -4, -5, -6],
  Vocal: [-2, -3, -2, 1, 3, 4, 3, 1, 0, -1],
  Rock: [5, 4, 2, -1, -2, -1, 2, 3, 4, 5],
  Pop: [-1, 1, 3, 4, 3, 1, -1, -1, -1, -1],
  Jazz: [3, 2, 1, 2, -1, -1, 0, 1, 2, 3],
  Classical: [4, 3, 2, 1, -1, -1, 0, 2, 3, 4],
  Electronic: [5, 4, 1, 0, -2, 2, 1, 2, 4, 5],
  'Hip-hop': [5, 4, 1, 3, -1, -1, 1, -1, 2, 3],
  Acoustic: [4, 3, 2, 1, 2, 2, 3, 3, 2, 1],
  Loudness: [6, 4, 0, 0, -2, 0, -1, -4, 5, 1],
};

const Player = {
  audio: new Audio(),
  ctx: null,
  master: null,
  preamp: null,
  filters: [],
  currentId: null,
  counted: false,
  pendingSeek: null,
  stopAfterCurrent: false,
  errorStreak: 0,
  sleep: null,
  _lastPosSave: 0,
  _listeners: {},
  // "Use ffmpeg" (Play speed & pitch): fx = { speed, pitch, key } while the ffmpeg version of the song is playing.
  // That file is already at the new speed, so it plays at rate 1 and its timeline is song time / speed.
  ffmpeg: null, // { available, version, rubberband } from main
  fx: null,
  fxState: null, // { state: 'working' | 'on' | 'error', pct, error }
  fxKeys: new Map(), // "path|speed|pitch" -> render key (renders made in this session)
  fxFailed: new Map(), // "path|speed|pitch" -> error
  _swapping: false,
  _fxTimer: null,

  on(event, fn) {
    (this._listeners[event] ||= []).push(fn);
  },
  off(event, fn) {
    this._listeners[event] = (this._listeners[event] || []).filter((f) => f !== fn);
  },
  emit(event, data) {
    for (const fn of this._listeners[event] || []) fn(data);
  },

  get s() {
    return Store.state.settings;
  },
  get playing() {
    return !this.audio.paused;
  },
  // Position and length in the song's own time (the ffmpeg version's timeline is shorter or longer).
  get scale() {
    return this.fx ? this.fx.speed : 1;
  },
  get time() {
    return this.audio.currentTime * this.scale;
  },
  get duration() {
    const d = this.audio.duration;
    return isFinite(d) ? d * this.scale : NaN;
  },

  init() {
    const a = this.audio;
    a.crossOrigin = 'anonymous';
    a.preload = 'auto';
    this.applyVolume();

    a.addEventListener('timeupdate', () => {
      this.checkPlayCount();
      const now = Date.now();
      if (!this._swapping && now - this._lastPosSave > 2000) {
        this._lastPosSave = now;
        Store.activeQueue().position = this.time;
        Store.save();
      }
      this.emit('time');
    });
    a.addEventListener('loadedmetadata', () => {
      if (this.pendingSeek != null) {
        a.currentTime = Math.min(this.pendingSeek / this.scale, Math.max(0, a.duration - 1));
        this.pendingSeek = null;
      }
      this._swapping = false;
      const t = Store.track(this.currentId);
      if (t && !t.duration && isFinite(a.duration)) t.duration = this.duration;
      this.emit('time');
    });
    a.addEventListener('playing', () => (this.errorStreak = 0));
    a.addEventListener('play', () => this.emit('state'));
    a.addEventListener('pause', () => {
      if (this._swapping) return;
      Store.activeQueue().position = this.time;
      Store.save();
      this.emit('state');
    });
    a.addEventListener('ended', () => this.onEnded());
    a.addEventListener('error', () => {
      if (!this.currentId) return;
      if (this.fx) {
        // The ffmpeg version couldn't be played: forget it and go back to the song itself.
        const t = Store.track(this.currentId);
        const k = this.fxKey(t.path, this.fx);
        this.fxKeys.delete(k);
        this.fxFailed.set(k, "the processed file couldn't be played");
        this.swapTo(null);
        this.setFxState({ state: 'error', error: this.fxFailed.get(k) });
        return;
      }
      const t = Store.track(this.currentId);
      toast(`Can't play "${t ? t.title : 'this file'}". Skipping.`);
      if (++this.errorStreak < 5) this.next(true);
      else this.errorStreak = 0;
    });

    this.setupMediaSession();
    api.onFxProgress((p) => {
      const st = this.fxState;
      if (p.slot !== 'current' || st?.state !== 'working') return;
      const d = Store.track(this.currentId)?.duration || this.duration;
      if (d) this.setFxState({ ...st, pct: Math.min(99, Math.round(((p.seconds * st.speed) / d) * 100)) });
    });
    api.ffmpegStatus().then((st) => {
      this.ffmpeg = st;
      this.scheduleFx();
    });
  },

  // ---------- audio graph ----------
  ensureGraph() {
    if (this.ctx) return;
    try {
      const ctx = new AudioContext();
      const src = ctx.createMediaElementSource(this.audio);
      this.src = src;
      this.preamp = ctx.createGain();
      this.filters = EQ_BANDS.map((freq, i) => {
        const f = ctx.createBiquadFilter();
        f.type = i === 0 ? 'lowshelf' : i === EQ_BANDS.length - 1 ? 'highshelf' : 'peaking';
        f.frequency.value = freq;
        f.Q.value = 1.1;
        return f;
      });
      this.master = ctx.createGain();
      src.connect(this.preamp);
      let node = this.preamp;
      for (const f of this.filters) node = node.connect(f);
      node.connect(this.master).connect(ctx.destination);
      this.ctx = ctx;
      // Pitch shifter (js/pitch-worklet.js), put between the song and the equalizer only while it's needed.
      ctx.audioWorklet
        .addModule('js/pitch-worklet.js')
        .then(() => {
          this.shifter = new AudioWorkletNode(ctx, 'pitch-shifter', {
            outputChannelCount: [2],
            channelCount: 2,
            channelCountMode: 'explicit',
            channelInterpretation: 'speakers',
          });
          this.setShift(this._shift ?? 1);
        })
        .catch((err) => console.warn('Pitch shifter unavailable:', err));
      this.audio.volume = 1;
      this.applyEq();
      this.applyVolume();
    } catch (err) {
      console.warn('Equalizer unavailable:', err);
    }
  },

  applyEq() {
    if (!this.ctx) return;
    const eq = this.s.eq;
    this.filters.forEach((f, i) => (f.gain.value = eq.enabled ? eq.gains[i] : 0));
    this.preamp.gain.value = eq.enabled ? Math.pow(10, eq.preamp / 20) : 1;
  },

  applyVolume(scale = 1) {
    const v = this.s.muted ? 0 : Math.pow(this.s.volume, 2) * scale;
    if (this.master) this.master.gain.value = v;
    else this.audio.volume = Math.min(1, v);
  },
  setVolume(v) {
    this.s.volume = Math.max(0, Math.min(1, v));
    if (this.s.volume > 0) this.s.muted = false;
    this.applyVolume();
    Store.save();
    this.emit('volume');
  },
  toggleMute() {
    this.s.muted = !this.s.muted;
    this.applyVolume();
    Store.save();
    this.emit('volume');
  },
  // ---------- play speed & pitch ----------
  // Saved as settings.speed / settings.pitch / settings.linkPitch, or per song in settings.songRates[trackId]
  // (same fields; a song with its own entry ignores the general one). linkPitch = the pitch follows the speed.
  rateOf(id = this.currentId) {
    const own = id ? this.s.songRates?.[id] : null;
    const r = own || this.s;
    const speed = r.speed || 1;
    return { speed, pitch: r.linkPitch ? speed : r.pitch || 1, rawPitch: r.pitch || 1, linkPitch: !!r.linkPitch, own: !!own };
  },
  // Speed comes from the <audio> element: with preservesPitch it stretches time and keeps the pitch, without it
  // the pitch moves with the speed (like a record played faster). Whatever pitch change is left over is done by
  // the pitch shifter; pick the way that leaves it the least to do (none at all when pitch = 1 or pitch = speed).
  applyRate() {
    const r = this.rateOf();
    const want = this.fxWant();
    // Settings changed while the ffmpeg version plays: back to the song itself until a new version is ready.
    if (this.fx && !(want && want.speed === this.fx.speed && want.pitch === this.fx.pitch)) this.swapTo(null);
    else this.setAudioRate(r);
    this.emit('speed');
    this.scheduleFx();
  },
  setAudioRate({ speed, pitch } = this.rateOf()) {
    const a = this.audio;
    if (this.fx) {
      a.preservesPitch = true;
      a.defaultPlaybackRate = 1;
      a.playbackRate = 1;
      this.setShift(1);
      return;
    }
    const viaRate = Math.abs(Math.log(pitch / speed)) < Math.abs(Math.log(pitch));
    a.preservesPitch = !viaRate;
    a.defaultPlaybackRate = speed;
    a.playbackRate = speed;
    const shift = viaRate ? pitch / speed : pitch;
    this.setShift(Math.abs(shift - 1) < 1e-4 ? 1 : shift);
  },

  // ---------- "Use ffmpeg" ----------
  // What the song should be rendered at, or null when ffmpeg isn't needed (or is off / not installed).
  // Speed 1 + pitch 1 needs nothing, and pitch = speed is plain resampling, which the built-in way does perfectly.
  fxWant(id = this.currentId) {
    if (!this.s.useFfmpeg || !this.ffmpeg?.available || !id || !Store.track(id)) return null;
    const { speed, pitch } = this.rateOf(id);
    if (Math.abs(pitch - speed) < 1e-4) return null;
    return { speed, pitch };
  },
  fxKey(path, w) {
    return `${path}|${w.speed}|${w.pitch}`;
  },
  setFxState(st) {
    this.fxState = st;
    this.emit('fx');
  },
  // Switch the current song between its own file (key = null) and its ffmpeg version, at the same place in the song.
  swapTo(key, want) {
    const t = Store.track(this.currentId);
    if (!t) return;
    const a = this.audio;
    const pos = this.time;
    const wasPlaying = this.playing;
    this._swapping = true;
    this.fx = key ? { ...want, key } : null;
    this.pendingSeek = pos;
    a.src = key ? api.fxUrl(key) : api.mediaUrl(t.path);
    this.setAudioRate();
    if (wasPlaying) a.play().catch(() => {});
    this.emit('speed');
  },
  scheduleFx() {
    clearTimeout(this._fxTimer);
    this._fxTimer = setTimeout(() => this.requestFx(), 400);
  },
  async requestFx() {
    const id = this.currentId;
    const t = Store.track(id);
    const want = this.fxWant(id);
    if (!t || !want) return this.setFxState(null);
    const k = this.fxKey(t.path, want);
    if (this.fx) {
      this.setFxState({ state: 'on' });
      return this.prefetchNext();
    }
    if (this.fxKeys.has(k)) {
      this.swapTo(this.fxKeys.get(k), want);
      this.setFxState({ state: 'on' });
      return this.prefetchNext();
    }
    if (this.fxFailed.has(k)) return this.setFxState({ state: 'error', error: this.fxFailed.get(k) });
    this.setFxState({ state: 'working', pct: 0, speed: want.speed });
    const res = await api.fxRender({ file: t.path, speed: want.speed, pitch: want.pitch, slot: 'current' });
    const still = this.currentId === id && this.fxWant(id) && this.fxKey(t.path, this.fxWant(id)) === k;
    if (res.error) {
      if (res.stopped) return;
      this.fxFailed.set(k, res.error);
      if (still) {
        this.setFxState({ state: 'error', error: res.error });
        toast(`ffmpeg couldn't process "${t.title}", using the built-in speed & pitch`);
      }
      return;
    }
    this.fxKeys.set(k, res.key);
    if (still && !this.fx) {
      this.swapTo(res.key, want);
      this.setFxState({ state: 'on' });
      this.prefetchNext();
    }
  },
  // Render the next song in the queue ahead of time, so it starts with the ffmpeg version straight away.
  prefetchNext() {
    const q = Store.activeQueue();
    const nid = q.items[q.index + 1];
    const nt = Store.track(nid);
    const w = this.fxWant(nid);
    if (!nt || !w) return;
    const k = this.fxKey(nt.path, w);
    if (this.fxKeys.has(k) || this.fxFailed.has(k)) return;
    api.fxRender({ file: nt.path, speed: w.speed, pitch: w.pitch, slot: 'next' }).then((res) => {
      if (res.key) this.fxKeys.set(k, res.key);
    });
  },
  setShift(ratio) {
    this._shift = ratio;
    if (ratio !== 1) this.ensureGraph();
    if (!this.ctx || !this.src) return;
    const on = ratio !== 1 && !!this.shifter;
    if (on) this.shifter.parameters.get('ratio').value = ratio;
    if (on === !!this._shifterOn) return;
    this.src.disconnect();
    if (this.shifter) this.shifter.disconnect();
    if (on) this.src.connect(this.shifter).connect(this.preamp);
    else this.src.connect(this.preamp);
    this._shifterOn = on;
  },
  // Change speed/pitch/linkPitch of whatever the current song uses (its own setting or the general one).
  setRate(patch) {
    const id = this.currentId;
    Object.assign((id && this.s.songRates?.[id]) || this.s, patch);
    this.applyRate();
    Store.save();
  },
  setSpeed(r) {
    this.setRate({ speed: r });
  },
  // Give the current song its own speed & pitch (starting from the general one), or drop it again.
  setOwnRate(on) {
    const id = this.currentId;
    if (!id) return;
    const songRates = (this.s.songRates ||= {});
    if (on) {
      const { speed, rawPitch, linkPitch } = this.rateOf();
      songRates[id] = { speed, pitch: rawPitch, linkPitch };
    } else delete songRates[id];
    this.applyRate();
    Store.save();
  },
  cycleRepeat() {
    const order = ['all', 'one', 'off'];
    this.s.repeat = order[(order.indexOf(this.s.repeat) + 1) % order.length];
    Store.save();
    this.emit('repeat');
    toast({ all: 'Repeat queue', one: 'Repeat current song', off: 'Repeat off' }[this.s.repeat]);
  },

  // ---------- loading & transport ----------
  load(autoplay = true, position = 0) {
    const a = this.audio;
    const q = Store.activeQueue();
    const id = q.items[q.index];
    if (!id || !Store.track(id)) {
      this.currentId = null;
      a.removeAttribute('src');
      a.load();
      this.emit('track');
      this.emit('state');
      return;
    }
    const t = Store.track(id);
    this.currentId = id;
    this.counted = false;
    this.pendingSeek = position > 0 ? position : null;
    q.position = position;
    // Use the ffmpeg version right away if it's ready (e.g. rendered while the previous song played).
    const want = this.fxWant(id);
    const fxKey = want && this.fxKeys.get(this.fxKey(t.path, want));
    this.fx = fxKey ? { ...want, key: fxKey } : null;
    this._swapping = false;
    this.setFxState(null);
    a.src = fxKey ? api.fxUrl(fxKey) : api.mediaUrl(t.path);
    this.applyRate();
    this.emit('track');
    this.updateMediaSession();
    if (autoplay) this.play();
    else this.emit('state');
  },

  play() {
    if (!this.currentId) {
      if (Store.activeQueue().items.length) this.load(true, Store.activeQueue().position);
      return;
    }
    this.ensureGraph();
    this.ctx?.resume();
    this.audio.play().catch(() => {});
  },
  pause() {
    this.audio.pause();
  },
  toggle() {
    this.playing ? this.pause() : this.play();
  },
  seek(sec) {
    if (!this.currentId) return;
    this.audio.currentTime = Math.max(0, Math.min(sec, this.duration || sec)) / this.scale;
  },
  seekBy(delta) {
    this.seek(this.time + delta);
  },

  moved() {
    Store.save();
    Store.emit('current');
  },

  next(auto = false) {
    const q = Store.activeQueue();
    if (!q.items.length) return;
    const wasPlaying = auto || this.playing;
    if (q.index < q.items.length - 1) {
      q.index++;
    } else {
      q.index = 0;
      if (auto && this.s.repeat === 'off') {
        this.load(false);
        this.moved();
        return;
      }
    }
    this.load(wasPlaying);
    this.moved();
  },

  prev() {
    const q = Store.activeQueue();
    if (!q.items.length) return;
    const threshold = this.s.prevThreshold;
    if (threshold > 0 && this.time > threshold) {
      this.seek(0);
      return;
    }
    const wasPlaying = this.playing;
    if (q.index > 0) q.index--;
    else if (this.s.repeat === 'all') q.index = q.items.length - 1;
    else {
      this.seek(0);
      return;
    }
    this.load(wasPlaying);
    this.moved();
  },

  onEnded() {
    if (this.sleep?.mode === 'songs') {
      this.sleep.songsLeft--;
      this.emit('sleep');
      if (this.sleep.songsLeft <= 0) {
        this.cancelSleep();
        this.advanceStopped();
        toast('Sleep timer: playback stopped');
        return;
      }
    }
    if (this.stopAfterCurrent) {
      this.stopAfterCurrent = false;
      this.cancelSleep();
      this.advanceStopped();
      toast('Sleep timer: playback stopped');
      return;
    }
    if (this.s.repeat === 'one') {
      this.counted = false;
      this.audio.currentTime = 0;
      this.play();
      return;
    }
    this.next(true);
  },

  advanceStopped() {
    const q = Store.activeQueue();
    if (q.index < q.items.length - 1) q.index++;
    this.load(false);
    this.moved();
  },

  checkPlayCount() {
    if (this.counted || !this.currentId) return;
    const d = this.duration;
    if (this.time >= Math.min(30, (isFinite(d) ? d : 60) * 0.5)) {
      this.counted = true;
      Store.recordPlay(this.currentId);
    }
  },

  // ---------- queue actions ----------
  playIds(ids, start = 0) {
    if (!ids.length) return;
    switch (this.s.clickAction) {
      case 'newqueue': {
        const q = Store.createQueue(ids);
        if (!q) return;
        this.saveCurrentPosition();
        Store.state.activeQueueId = q.id;
        q.index = start;
        this.load(true);
        Store.changed('queues');
        return;
      }
      case 'next':
        return this.playNext([ids[start]]);
      case 'append':
        return this.addToQueue(Store.state.activeQueueId, [ids[start]]);
      default:
        this.replaceQueue(ids, start);
    }
  },

  replaceQueue(ids, start = 0) {
    const q = Store.activeQueue();
    q.items = ids.slice();
    q.index = start;
    this.load(true);
    Store.changed('queues');
  },

  playNext(ids) {
    const q = Store.activeQueue();
    if (!q.items.length || !this.currentId) {
      Store.addToQueue(q.id, ids, q.items.length ? q.index : 0);
      if (!this.currentId) {
        q.index = q.items.indexOf(ids[0]);
        this.load(true);
      }
    } else {
      Store.addToQueue(q.id, ids, q.index + 1);
    }
    toast(ids.length === 1 ? 'Will play next' : `${ids.length} songs will play next`);
  },

  addToQueue(qid, ids) {
    const q = Store.getQueue(qid);
    Store.addToQueue(qid, ids);
    if (qid === Store.state.activeQueueId && !this.currentId) this.load(false);
    toast(`Added ${plural(ids.length, 'song')} to ${q.name}`);
  },

  addToNewQueue(ids) {
    const q = Store.createQueue(ids);
    if (q) toast(`Created ${q.name} with ${plural(ids.length, 'song')}`);
    return q;
  },

  saveCurrentPosition() {
    if (this.currentId) Store.activeQueue().position = this.time;
  },

  activateQueue(qid, index = null) {
    const q = Store.getQueue(qid);
    if (!q) return;
    if (qid === Store.state.activeQueueId && index == null) {
      if (!this.playing) this.play();
      return;
    }
    this.saveCurrentPosition();
    const sameTrack = index == null || index === q.index;
    Store.state.activeQueueId = qid;
    if (index != null) q.index = index;
    this.load(true, sameTrack ? q.position : 0);
    Store.changed('queues');
  },

  shuffleQueue(qid) {
    const q = Store.getQueue(qid);
    if (!q || q.items.length < 2) return;
    const cur = q.items[q.index];
    const rest = q.items.filter((_, i) => i !== q.index);
    q.items = [cur, ...shuffleArray(rest)];
    q.index = 0;
    Store.changed('queues');
    toast(`${q.name} shuffled`);
  },

  removeFromQueue(qid, indices) {
    const removedCurrent = Store.removeFromQueue(qid, indices);
    if (qid === Store.state.activeQueueId && removedCurrent) this.load(this.playing);
  },

  reorderQueue(qid, indices, target) {
    Store.reorderQueue(qid, indices, target);
  },

  clearQueue(qid) {
    const q = Store.getQueue(qid);
    q.items = [];
    q.index = 0;
    q.position = 0;
    if (qid === Store.state.activeQueueId) this.load(false);
    Store.changed('queues');
  },

  deleteQueue(qid) {
    const qs = Store.state.queues;
    if (qs.length === 1) return this.clearQueue(qid);
    const i = qs.findIndex((q) => q.id === qid);
    qs.splice(i, 1);
    if (qid === Store.state.activeQueueId) {
      Store.state.activeQueueId = qs[Math.max(0, i - 1)].id;
      this.load(false, Store.activeQueue().position);
    }
    Store.changed('queues');
  },

  // ---------- sleep timer ----------
  startSleep({ mode, minutes, songs, finish }) {
    this.cancelSleep(true);
    if (mode === 'time') {
      this.sleep = { mode, endsAt: Date.now() + minutes * 60000, finish };
      this.sleep.timer = setInterval(() => this.sleepTick(), 1000);
      toast(`Playback will stop in ${minutes} min`);
    } else {
      this.sleep = { mode, songsLeft: songs };
      toast(`Playback will stop after ${plural(songs, 'song')}`);
    }
    this.emit('sleep');
  },
  sleepRemaining() {
    if (!this.sleep) return null;
    if (this.sleep.mode === 'songs') return plural(this.sleep.songsLeft, 'song');
    if (this.sleep.waiting) return 'after this song';
    return fmtTime((this.sleep.endsAt - Date.now()) / 1000);
  },
  sleepTick() {
    const s = this.sleep;
    if (!s) return;
    const left = s.endsAt - Date.now();
    this.emit('sleep');
    if (left > 0) return;
    clearInterval(s.timer);
    if (s.finish && this.playing) {
      s.waiting = true;
      this.stopAfterCurrent = true;
      this.emit('sleep');
      return;
    }
    this.fadeOutAndPause();
  },
  fadeOutAndPause() {
    let step = 0;
    const steps = 20;
    const t = setInterval(() => {
      step++;
      this.applyVolume(1 - step / steps);
      if (step >= steps) {
        clearInterval(t);
        this.pause();
        this.applyVolume();
        this.cancelSleep();
        toast('Sleep timer: playback stopped');
      }
    }, 200);
  },
  cancelSleep(silent) {
    if (this.sleep?.timer) clearInterval(this.sleep.timer);
    const had = !!this.sleep;
    this.sleep = null;
    this.stopAfterCurrent = false;
    if (had && !silent) this.emit('sleep');
  },

  // ---------- OS media controls (media keys, Windows media overlay) ----------
  setupMediaSession() {
    if (!('mediaSession' in navigator)) return;
    const ms = navigator.mediaSession;
    ms.setActionHandler('play', () => this.play());
    ms.setActionHandler('pause', () => this.pause());
    ms.setActionHandler('previoustrack', () => this.prev());
    ms.setActionHandler('nexttrack', () => this.next());
    ms.setActionHandler('seekto', (d) => this.seek(d.seekTime));
    ms.setActionHandler('seekbackward', () => this.seekBy(-10));
    ms.setActionHandler('seekforward', () => this.seekBy(10));
  },
  updateMediaSession() {
    if (!('mediaSession' in navigator)) return;
    const t = Store.track(this.currentId);
    if (!t) return;
    navigator.mediaSession.metadata = new MediaMetadata({
      title: t.title,
      artist: t.artist || 'Unknown artist',
      album: t.album || '',
    });
  },
};
