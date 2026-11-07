/**
 * The TV view's sounds: a soft tick as focus moves, a brighter one for what's
 * chosen, a lower one going back, made on the spot with Web Audio (no files).
 * They play only for a controller or the keys, never for the mouse, and can be
 * turned off from the TV view's menu.
 */

const KEY = 'games:sounds';

export type UiSound = 'move' | 'select' | 'back' | 'open' | 'close' | 'section' | 'type' | 'play';

let context: AudioContext | null = null;

export function soundsOn(): boolean {
  return localStorage.getItem(KEY) !== 'off';
}

export function setSoundsOn(on: boolean): void {
  localStorage.setItem(KEY, on ? 'on' : 'off');
}

/** One blip: a pitch (or a glide between two) that fades out fast. */
function blip(ctx: AudioContext, at: number, from: number, to: number, length: number, volume: number, type: OscillatorType = 'sine') {
  const osc = ctx.createOscillator();
  const gain = ctx.createGain();
  osc.type = type;
  osc.frequency.setValueAtTime(from, at);
  if (to !== from) osc.frequency.exponentialRampToValueAtTime(to, at + length);
  gain.gain.setValueAtTime(0.0001, at);
  gain.gain.exponentialRampToValueAtTime(volume, at + 0.006);
  gain.gain.exponentialRampToValueAtTime(0.0001, at + length);
  osc.connect(gain).connect(ctx.destination);
  osc.start(at);
  osc.stop(at + length + 0.02);
}

export function playSound(sound: UiSound): void {
  if (!soundsOn()) return;
  try {
    context ??= new AudioContext();
    const ctx = context;
    if (ctx.state === 'suspended') void ctx.resume();
    const t = ctx.currentTime + 0.005;
    switch (sound) {
      case 'move':
        blip(ctx, t, 1250, 1100, 0.045, 0.035, 'triangle');
        return;
      case 'type':
        blip(ctx, t, 1600, 1500, 0.03, 0.03, 'triangle');
        return;
      case 'section':
        blip(ctx, t, 700, 1050, 0.08, 0.04, 'triangle');
        return;
      case 'select':
        blip(ctx, t, 880, 880, 0.06, 0.05, 'triangle');
        blip(ctx, t + 0.05, 1320, 1320, 0.09, 0.045, 'triangle');
        return;
      case 'back':
        blip(ctx, t, 700, 520, 0.09, 0.045, 'triangle');
        return;
      case 'open':
        blip(ctx, t, 420, 840, 0.14, 0.04);
        return;
      case 'close':
        blip(ctx, t, 840, 420, 0.12, 0.035);
        return;
      case 'play':
        blip(ctx, t, 523, 523, 0.12, 0.05, 'triangle');
        blip(ctx, t + 0.09, 659, 659, 0.12, 0.05, 'triangle');
        blip(ctx, t + 0.18, 1047, 1047, 0.3, 0.05, 'triangle');
        return;
    }
  } catch {
    // No audio device: silence.
  }
}
