/**
 * The tick the volume keys play at the new level, as a Mac's do, so you hear
 * how loud it is now without anything playing. Made on the spot with Web
 * Audio (no file), through the desktop's own output stream, which follows the
 * default output and its volume like everything else.
 *
 * The context is let go a little after the last tick, so the desktop doesn't
 * hold a stream open on the sound card (or keep Bluetooth headphones awake)
 * between presses. Settings → Sound turns it off (AppConfig's volumeFeedback).
 */

/** How long after the last tick the output stream is closed. */
const IDLE_CLOSE_MS = 4000;
/** Ticks closer than this (a held key repeating) play once. */
const MIN_GAP_MS = 60;

let context: AudioContext | null = null;
let closeTimer: number | undefined;
let lastAt = 0;

export function playVolumeFeedback(): void {
  const now = performance.now();
  if (now - lastAt < MIN_GAP_MS) return;
  lastAt = now;
  try {
    context ??= new AudioContext({ latencyHint: 'interactive' });
    const ctx = context;
    if (ctx.state === 'suspended') void ctx.resume();
    const at = ctx.currentTime + 0.01;
    // A soft, round knock: a sine dropping a little in pitch, gone in 90ms,
    // with a quieter octave above for some presence on small speakers.
    tone(ctx, at, 1180, 940, 0.09, 0.28);
    tone(ctx, at, 2360, 1880, 0.05, 0.06);
  } catch {
    // No audio output: silence.
    return;
  }
  window.clearTimeout(closeTimer);
  closeTimer = window.setTimeout(() => {
    const ctx = context;
    context = null;
    void ctx?.close().catch(() => {});
  }, IDLE_CLOSE_MS);
}

function tone(ctx: AudioContext, at: number, from: number, to: number, length: number, volume: number): void {
  const osc = ctx.createOscillator();
  const gain = ctx.createGain();
  osc.type = 'sine';
  osc.frequency.setValueAtTime(from, at);
  osc.frequency.exponentialRampToValueAtTime(to, at + length);
  gain.gain.setValueAtTime(0.0001, at);
  gain.gain.exponentialRampToValueAtTime(volume, at + 0.004);
  gain.gain.exponentialRampToValueAtTime(0.0001, at + length);
  osc.connect(gain).connect(ctx.destination);
  osc.start(at);
  osc.stop(at + length + 0.02);
}
