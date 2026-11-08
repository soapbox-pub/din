import { controlMedia, getNowPlaying, subscribeNowPlaying } from '@/lib/nowPlaying';

/**
 * Other media pauses while the microphone records the user's voice, as iOS
 * and Android do for dictation and voice notes: a podcast turned down is
 * still words lost, and the microphone hears it anyway (echo cancellation
 * takes out only what the recording page plays itself).
 *
 * `holdMedia()` pauses everything playing in Din's media controls (the
 * Media Player, the shell's elements, web pages, native apps over MPRIS)
 * and returns a release. When the last hold is released, what it paused
 * plays again, unless the user took it back meanwhile: played it again
 * themselves, or it went away. Settings → Sound turns it off
 * (`pauseMediaWhileRecording`), and then a hold does nothing.
 *
 * Holders: dictation (src/lib/dictation.ts, and so apps' SpeechRecognition),
 * and the assistant's Record Audio (its host's `pauseMedia`, on the desktop
 * or an app's `din.desktop.pauseMedia()`).
 */

/** What plays again waits this long after the recording stops, so the two don't overlap. */
const RESUME_DELAY_MS = 400;

let enabled = true;
let holds = 0;
/**
 * What a hold paused, by source id: 'pausing' until the source says it has,
 * then 'paused'. One seen playing again after that the user played.
 */
const paused = new Map<string, 'pausing' | 'paused'>();
let unsubscribe: (() => void) | null = null;
let resumeTimer: ReturnType<typeof setTimeout> | null = null;

/** Settings → Sound's switch, kept current by the desktop. */
export function setPauseMediaWhileRecording(on: boolean): void {
  enabled = on;
}

function watch(): void {
  const sources = new Map(getNowPlaying().map((s) => [s.id, s]));
  for (const [id, state] of paused) {
    const source = sources.get(id);
    if (!source) paused.delete(id);
    else if (!source.playing && state === 'pausing') paused.set(id, 'paused');
    else if (source.playing && state === 'paused') paused.delete(id);
  }
}

function resume(): void {
  resumeTimer = null;
  unsubscribe?.();
  unsubscribe = null;
  const sources = new Map(getNowPlaying().map((s) => [s.id, s]));
  for (const id of paused.keys()) {
    const source = sources.get(id);
    if (source && !source.playing && source.canPlay) controlMedia(id, 'play');
  }
  paused.clear();
}

/** Pause what's playing until the returned function is called. */
export function holdMedia(): () => void {
  if (!enabled) return () => {};
  holds++;
  if (resumeTimer) {
    // Another recording right after one: what's paused stays so.
    clearTimeout(resumeTimer);
    resumeTimer = null;
  }
  if (holds === 1) {
    unsubscribe ??= subscribeNowPlaying(watch);
    for (const source of getNowPlaying()) {
      if (!source.playing || paused.has(source.id)) continue;
      paused.set(source.id, 'pausing');
      controlMedia(source.id, 'pause');
    }
  }
  let released = false;
  return () => {
    if (released) return;
    released = true;
    holds--;
    if (holds === 0) resumeTimer = setTimeout(resume, RESUME_DELAY_MS);
  };
}
