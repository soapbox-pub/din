/**
 * Din's startup sound, played as the desktop fades in (BootVeil): a rod
 * drawn across wind chimes, a long A, then a quick climb, C#, D, Eb, E,
 * that rings out and fades. Made on the spot with Web Audio (no file),
 * through the desktop's own output stream, like the volume keys' tick
 * (src/lib/volumeFeedback.ts). Settings → Sound turns it off (AppConfig's
 * startupSound).
 *
 * Each tube is the modes of a free bar (1 : 2.756 : 5.404 : 8.933), each a
 * slightly split pair that beats as a real tube's do, with a light clink
 * where the rod touches, in a short room.
 */

/** A tube: its MIDI note, when it's touched, how long it rings, how loud, and where. */
interface Tube {
  note: number;
  at: number;
  ring: number;
  level: number;
  pan: number;
}

const TUNE: Tube[] = [
  { note: 81, at: 0.1, ring: 0.45, level: 0.5, pan: 0 }, // A5, the long note
  { note: 85, at: 1.4, ring: 0.16, level: 0.36, pan: -0.3 }, // C#6
  { note: 86, at: 1.52, ring: 0.16, level: 0.4, pan: -0.1 }, // D6
  { note: 87, at: 1.62, ring: 0.2, level: 0.44, pan: 0.1 }, // Eb6
  { note: 88, at: 1.79, ring: 0.55, level: 0.55, pan: 0.25 }, // E6, rings out
];

/** A free bar's modes: ratio to the fundamental, level, decay (seconds). */
const MODES: [number, number, number][] = [
  [1, 1, 2.2],
  [2.756, 0.55, 1.1],
  [5.404, 0.28, 0.55],
  [8.933, 0.12, 0.28],
];

/** Overall level, a little under the other sounds of a desktop starting. */
const VOLUME = 0.25;
/** When the tail starts fading, and over how long. */
const FADE_FROM = 3.6;
const FADE_OVER = 1.6;
/** How long the sound lasts. */
export const STARTUP_SOUND_SECONDS = FADE_FROM + FADE_OVER + 0.1;

/** A small seeded generator, so the tubes' beating is the same every start. */
function random(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** The short room: decaying noise, darkened, per channel. */
function roomImpulse(ctx: BaseAudioContext, rand: () => number, seconds = 1.8, predelay = 0.02): AudioBuffer {
  const n = Math.round(seconds * ctx.sampleRate);
  const buffer = ctx.createBuffer(2, n, ctx.sampleRate);
  const smooth = Math.exp((-2 * Math.PI * 5000) / ctx.sampleRate);
  for (let ch = 0; ch < 2; ch++) {
    const data = buffer.getChannelData(ch);
    let lp = 0;
    let energy = 0;
    for (let i = 0; i < n; i++) {
      const white = rand() * 2 - 1;
      lp = lp * smooth + white * (1 - smooth);
      const v = i < predelay * ctx.sampleRate ? 0 : lp * Math.exp((-i / ctx.sampleRate) * (6.9 / seconds));
      data[i] = v;
      energy += v * v;
    }
    const scale = 1 / Math.sqrt(energy || 1);
    for (let i = 0; i < n; i++) data[i] *= scale;
  }
  return buffer;
}

/** The clink where the rod touches a tube: a few milliseconds of bright noise. */
function clinkBuffer(ctx: BaseAudioContext, rand: () => number): AudioBuffer {
  const n = Math.round(0.03 * ctx.sampleRate);
  const buffer = ctx.createBuffer(1, n, ctx.sampleRate);
  const data = buffer.getChannelData(0);
  for (let i = 0; i < n; i++) data[i] = (rand() * 2 - 1) * Math.exp(-i / ctx.sampleRate / 0.003);
  return buffer;
}

/**
 * Schedules the sound on a context, starting at `start`, into `destination`.
 * Returns when it ends.
 */
export function scheduleStartupSound(ctx: BaseAudioContext, start: number, destination: AudioNode = ctx.destination): number {
  const rand = random(7);
  const end = start + STARTUP_SOUND_SECONDS;

  // The whole mix, faded out at the end.
  const master = ctx.createGain();
  master.gain.setValueAtTime(VOLUME, start);
  const fade = new Float32Array(64);
  for (let i = 0; i < fade.length; i++) fade[i] = VOLUME * Math.cos(((i / (fade.length - 1)) * Math.PI) / 2) ** 2;
  master.gain.setValueCurveAtTime(fade, start + FADE_FROM, FADE_OVER);
  master.connect(destination);

  // Dry and the room.
  const dry = ctx.createGain();
  dry.gain.value = 0.78;
  dry.connect(master);
  const room = ctx.createConvolver();
  room.normalize = false;
  room.buffer = roomImpulse(ctx, rand);
  const wet = ctx.createGain();
  wet.gain.value = 0.22 * 3;
  room.connect(wet).connect(master);
  const bus = ctx.createGain();
  bus.connect(dry);
  bus.connect(room);

  const clink = clinkBuffer(ctx, rand);
  for (const tube of TUNE) {
    const at = start + tube.at;
    const freq = 440 * 2 ** ((tube.note - 69) / 12);
    const panner = ctx.createStereoPanner();
    panner.pan.value = tube.pan;
    panner.connect(bus);
    for (const [ratio, level, decay] of MODES) {
      if (freq * ratio > 18000) break;
      const split = 1 + rand() * 1.5;
      const env = ctx.createGain();
      // A millisecond's touch, then the mode dies away.
      env.gain.setValueAtTime(0, at);
      env.gain.linearRampToValueAtTime((tube.level * level) / 2, at + 0.001);
      env.gain.setTargetAtTime(0, at + 0.001, decay * tube.ring);
      env.connect(panner);
      // The pair starts in phase where the rod touches, then beats.
      for (const side of [-1, 1]) {
        const osc = ctx.createOscillator();
        osc.frequency.value = freq * ratio + (side * split) / 2;
        osc.connect(env);
        osc.start(at);
        osc.stop(end);
      }
    }
    const touch = ctx.createBufferSource();
    touch.buffer = clink;
    const high = ctx.createBiquadFilter();
    high.type = 'highpass';
    high.frequency.value = 5000;
    const low = ctx.createBiquadFilter();
    low.type = 'lowpass';
    low.frequency.value = 15000;
    const level = ctx.createGain();
    level.gain.value = 0.2 * tube.level;
    touch.connect(high).connect(low).connect(level).connect(panner);
    touch.start(at);
  }
  return end;
}

let playing: AudioContext | null = null;

/** Plays the startup sound once, then lets the output stream go. */
export function playStartupSound(): void {
  if (playing) return;
  try {
    const ctx = new AudioContext({ latencyHint: 'playback' });
    playing = ctx;
    if (ctx.state === 'suspended') void ctx.resume();
    const end = scheduleStartupSound(ctx, ctx.currentTime + 0.05);
    window.setTimeout(() => {
      playing = null;
      void ctx.close().catch(() => {});
    }, (end - ctx.currentTime + 0.5) * 1000);
  } catch {
    // No audio output: silence.
    playing = null;
  }
}
