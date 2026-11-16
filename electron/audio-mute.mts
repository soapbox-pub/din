// Why a web guest is muted. More than one part of Din mutes pages: the user,
// from a tab's speaker (media.mts), the volume menu's Pause when a page won't
// stop (media.mts), and a limited site whose time ran out (site-limits.mts).
// Each says only whether it wants the page quiet, and the page stays muted
// while any of them does, so one letting go never unmutes what another muted.
//
// Runs as TypeScript directly via Node's native type stripping - erasable
// syntax only, like the rest of electron/.

import type { WebContents } from 'electron';

export type MuteReason = 'user' | 'paused' | 'site-limit';

const reasons = new Map<number, Set<MuteReason>>();

/** Mute a guest for `reason`, or stop muting it for that reason. */
export function muteFor(contents: WebContents, reason: MuteReason, on: boolean): void {
  if (contents.isDestroyed()) return;
  let set = reasons.get(contents.id);
  if (on) {
    if (!set) {
      set = new Set();
      reasons.set(contents.id, set);
      contents.once('destroyed', () => reasons.delete(contents.id));
    }
    set.add(reason);
  } else {
    set?.delete(reason);
  }
  const muted = (set?.size ?? 0) > 0;
  if (contents.isAudioMuted() !== muted) contents.setAudioMuted(muted);
}

/** Whether a guest is muted for `reason`. */
export function isMutedFor(contents: WebContents, reason: MuteReason): boolean {
  return reasons.get(contents.id)?.has(reason) ?? false;
}
