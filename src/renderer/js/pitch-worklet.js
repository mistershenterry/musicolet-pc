// Pitch shifter for "Play speed & pitch" (runs on the audio thread as an AudioWorklet).
//
// Changes the pitch without changing the speed: the sound goes into a short ring buffer and is read back by two
// overlapping "grains" whose read position moves `ratio` times as fast as the write position. Each grain's delay
// sweeps across a ~60 ms window and is faded in and out with a Hann window; the two grains are half a window apart,
// so their gains always add up to 1 and the jump when a grain wraps around happens while it is silent.
// The speed itself is changed by the <audio> element (playbackRate), see Player.applyRate.
const SIZE = 1 << 16;
const MASK = SIZE - 1;
const MARGIN = 3; // samples kept between the write position and the newest sample a grain may read

class PitchShifter extends AudioWorkletProcessor {
  static get parameterDescriptors() {
    return [{ name: 'ratio', defaultValue: 1, minValue: 0.25, maxValue: 4, automationRate: 'k-rate' }];
  }

  constructor() {
    super();
    this.win = Math.round(sampleRate * 0.06);
    this.buf = [new Float32Array(SIZE), new Float32Array(SIZE)];
    this.w = 0;
    this.phase = 0;
  }

  // Cubic (Hermite) interpolation at a fractional buffer position.
  read(b, pos) {
    const i = Math.floor(pos);
    const f = pos - i;
    const y0 = b[(i - 1) & MASK];
    const y1 = b[i & MASK];
    const y2 = b[(i + 1) & MASK];
    const y3 = b[(i + 2) & MASK];
    const c1 = 0.5 * (y2 - y0);
    const c2 = y0 - 2.5 * y1 + 2 * y2 - 0.5 * y3;
    const c3 = 0.5 * (y3 - y0) + 1.5 * (y1 - y2);
    return ((c3 * f + c2) * f + c1) * f + y1;
  }

  process(inputs, outputs, params) {
    const input = inputs[0] || [];
    const output = outputs[0];
    const n = output[0].length;
    const ratio = params.ratio[0];
    const W = this.win;
    const step = Math.abs(1 - ratio) / W;
    const up = ratio > 1; // higher pitch: the delay shrinks; lower pitch: it grows
    const [bl, br] = this.buf;
    const inL = input[0];
    const inR = input[1] || inL;
    const outL = output[0];
    const outR = output[1] || null;
    let w = this.w;
    let phase = this.phase;
    for (let s = 0; s < n; s++) {
      bl[w] = inL ? inL[s] : 0;
      br[w] = inR ? inR[s] : 0;
      const p2 = phase + 0.5 < 1 ? phase + 0.5 : phase - 0.5;
      const d1 = (up ? 1 - phase : phase) * W;
      const d2 = (up ? 1 - p2 : p2) * W;
      const g1 = Math.sin(Math.PI * phase) ** 2;
      const g2 = 1 - g1; // = sin²(π·p2)
      const r1 = w - MARGIN - d1;
      const r2 = w - MARGIN - d2;
      outL[s] = g1 * this.read(bl, r1) + g2 * this.read(bl, r2);
      if (outR) outR[s] = g1 * this.read(br, r1) + g2 * this.read(br, r2);
      w = (w + 1) & MASK;
      phase += step;
      if (phase >= 1) phase -= 1;
    }
    this.w = w;
    this.phase = phase;
    return true;
  }
}

registerProcessor('pitch-shifter', PitchShifter);
