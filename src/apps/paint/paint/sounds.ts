/**
 * Paint's noises, all synthesized on the spot: scribbling that follows the
 * pen's speed, a bloop for the bucket, a boing for stamps, a bang for the
 * dynamite and an "uh-oh" for undo. Nothing plays until the first click,
 * which is also when the AudioContext gets made.
 */

let ctx: AudioContext | null = null;
let master: GainNode | null = null;
let noiseBuffer: AudioBuffer | null = null;
let enabled = true;

export function setSoundEnabled(on: boolean): void {
  enabled = on;
  if (!on) stopScribble();
}

function audio(): { ac: AudioContext; out: GainNode } | null {
  if (!enabled) return null;
  if (!ctx) {
    try {
      ctx = new AudioContext();
    } catch {
      enabled = false;
      return null;
    }
    master = ctx.createGain();
    master.gain.value = 0.35;
    master.connect(ctx.destination);
  }
  if (ctx.state === 'suspended') void ctx.resume();
  return { ac: ctx, out: master! };
}

function noise(ac: AudioContext): AudioBuffer {
  if (!noiseBuffer) {
    noiseBuffer = ac.createBuffer(1, ac.sampleRate * 2, ac.sampleRate);
    const data = noiseBuffer.getChannelData(0);
    for (let i = 0; i < data.length; i++) data[i] = Math.random() * 2 - 1;
  }
  return noiseBuffer;
}

/** One oscillator note with a quick envelope. */
function tone(
  type: OscillatorType,
  from: number,
  to: number,
  start: number,
  duration: number,
  volume = 0.5,
): void {
  const a = audio();
  if (!a) return;
  const { ac, out } = a;
  const t = ac.currentTime + start;
  const osc = ac.createOscillator();
  const gain = ac.createGain();
  osc.type = type;
  osc.frequency.setValueAtTime(from, t);
  osc.frequency.exponentialRampToValueAtTime(Math.max(1, to), t + duration);
  gain.gain.setValueAtTime(0.0001, t);
  gain.gain.exponentialRampToValueAtTime(volume, t + 0.01);
  gain.gain.exponentialRampToValueAtTime(0.0001, t + duration);
  osc.connect(gain).connect(out);
  osc.start(t);
  osc.stop(t + duration + 0.02);
}

function burst(start: number, duration: number, filterFrom: number, filterTo: number, volume: number, type: BiquadFilterType = 'lowpass') {
  const a = audio();
  if (!a) return;
  const { ac, out } = a;
  const t = ac.currentTime + start;
  const src = ac.createBufferSource();
  src.buffer = noise(ac);
  const filter = ac.createBiquadFilter();
  filter.type = type;
  filter.frequency.setValueAtTime(filterFrom, t);
  filter.frequency.exponentialRampToValueAtTime(filterTo, t + duration);
  const gain = ac.createGain();
  gain.gain.setValueAtTime(volume, t);
  gain.gain.exponentialRampToValueAtTime(0.0001, t + duration);
  src.connect(filter).connect(gain).connect(out);
  src.start(t, Math.random());
  src.stop(t + duration + 0.02);
}

export type ScribbleKind = 'pencil' | 'brush' | 'spray' | 'eraser' | 'wacky';

let scribble: { src: AudioBufferSourceNode; gain: GainNode; filter: BiquadFilterNode; kind: ScribbleKind } | null = null;

/** Start the scratchy drawing sound; `scribbleSpeed` drives it. */
export function startScribble(kind: ScribbleKind): void {
  stopScribble();
  const a = audio();
  if (!a) return;
  const { ac, out } = a;
  const src = ac.createBufferSource();
  src.buffer = noise(ac);
  src.loop = true;
  const filter = ac.createBiquadFilter();
  const settings: Record<ScribbleKind, [BiquadFilterType, number, number]> = {
    pencil: ['bandpass', 3800, 4],
    brush: ['bandpass', 900, 1.2],
    spray: ['highpass', 4500, 0.7],
    eraser: ['bandpass', 450, 2],
    wacky: ['bandpass', 1800, 8],
  };
  const [type, freq, q] = settings[kind];
  filter.type = type;
  filter.frequency.value = freq;
  filter.Q.value = q;
  const gain = ac.createGain();
  gain.gain.value = kind === 'spray' ? 0.25 : 0;
  src.connect(filter).connect(gain).connect(out);
  src.start();
  scribble = { src, gain, filter, kind };
}

/** How fast the pen is moving, in pixels per event. */
export function scribbleSpeed(speed: number): void {
  if (!scribble || !ctx) return;
  if (scribble.kind === 'spray') return;
  const level = Math.min(0.6, speed / 25);
  const t = ctx.currentTime;
  scribble.gain.gain.cancelScheduledValues(t);
  scribble.gain.gain.setTargetAtTime(level, t, 0.02);
  scribble.gain.gain.setTargetAtTime(0, t + 0.06, 0.05);
  if (scribble.kind === 'wacky') {
    scribble.filter.frequency.setTargetAtTime(800 + Math.random() * 3000, t, 0.03);
  }
}

export function stopScribble(): void {
  if (!scribble || !ctx) return;
  const s = scribble;
  scribble = null;
  s.gain.gain.setTargetAtTime(0, ctx.currentTime, 0.03);
  s.src.stop(ctx.currentTime + 0.2);
}

export const sfx = {
  click() {
    tone('square', 1400, 1200, 0, 0.03, 0.08);
  },
  bloop() {
    tone('sine', 180, 900, 0, 0.18, 0.5);
    tone('sine', 900, 600, 0.12, 0.1, 0.25);
  },
  boing() {
    const base = 140 + Math.random() * 80;
    const a = audio();
    if (!a) return;
    const { ac, out } = a;
    const t = ac.currentTime;
    const osc = ac.createOscillator();
    const lfo = ac.createOscillator();
    const lfoGain = ac.createGain();
    const gain = ac.createGain();
    osc.type = 'triangle';
    osc.frequency.setValueAtTime(base, t);
    osc.frequency.exponentialRampToValueAtTime(base * 3, t + 0.35);
    lfo.frequency.value = 18;
    lfoGain.gain.value = base * 0.3;
    lfo.connect(lfoGain).connect(osc.frequency);
    gain.gain.setValueAtTime(0.0001, t);
    gain.gain.exponentialRampToValueAtTime(0.5, t + 0.01);
    gain.gain.exponentialRampToValueAtTime(0.0001, t + 0.4);
    osc.connect(gain).connect(out);
    osc.start(t);
    lfo.start(t);
    osc.stop(t + 0.42);
    lfo.stop(t + 0.42);
  },
  pop() {
    tone('sine', 600, 120, 0, 0.08, 0.4);
  },
  bang() {
    burst(0, 1.2, 3000, 60, 1, 'lowpass');
    tone('sine', 120, 30, 0, 0.6, 0.9);
    burst(0.05, 0.5, 6000, 1500, 0.3, 'highpass');
  },
  fuse() {
    burst(0, 0.5, 6000, 3000, 0.15, 'highpass');
  },
  uhOh() {
    // Two falling notes through a vowel-ish filter: "uh-oh!"
    const a = audio();
    if (!a) return;
    const { ac, out } = a;
    const notes: [number, number, number][] = [
      [0, 330, 0.16],
      [0.2, 247, 0.3],
    ];
    for (const [start, freq, dur] of notes) {
      const t = ac.currentTime + start;
      const osc = ac.createOscillator();
      osc.type = 'sawtooth';
      osc.frequency.setValueAtTime(freq * 1.06, t);
      osc.frequency.exponentialRampToValueAtTime(freq, t + 0.05);
      const f1 = ac.createBiquadFilter();
      f1.type = 'bandpass';
      f1.frequency.value = start === 0 ? 700 : 500;
      f1.Q.value = 5;
      const gain = ac.createGain();
      gain.gain.setValueAtTime(0.0001, t);
      gain.gain.exponentialRampToValueAtTime(0.9, t + 0.02);
      gain.gain.exponentialRampToValueAtTime(0.0001, t + dur);
      osc.connect(f1).connect(gain).connect(out);
      osc.start(t);
      osc.stop(t + dur + 0.02);
    }
  },
  redo() {
    tone('square', 400, 800, 0, 0.12, 0.12);
  },
  sparkle() {
    [1318, 1568, 2093, 2637].forEach((f, i) => tone('triangle', f, f, i * 0.05, 0.12, 0.2));
  },
  save() {
    [523, 659, 784, 1047].forEach((f, i) => tone('square', f, f, i * 0.07, 0.14, 0.12));
  },
  error() {
    tone('square', 200, 180, 0, 0.12, 0.2);
    tone('square', 150, 140, 0.13, 0.2, 0.2);
  },
  /** One blip per typed letter, like a text box in an RPG. */
  blip() {
    tone('square', 620 + Math.random() * 40, 600, 0, 0.04, 0.08);
  },
};
