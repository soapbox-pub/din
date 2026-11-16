import { useSyncExternalStore } from 'react';

/**
 * Which web pages are making sound, and which the user muted, for the
 * speaker on their browser tabs (as Chrome's): from electron/media.mts by
 * way of `window.dinos.media`. A page counts as making sound for a couple of
 * seconds after it goes quiet, so the speaker doesn't flicker; one the user
 * muted keeps its crossed-out speaker until they unmute it.
 *
 * The state is keyed by the page's guest (its wcId), not the tab, so every
 * browser window reads the same store and a tab's speaker follows its page.
 */

export interface TabAudioState {
  wcId: number;
  /** It's making sound (or would be, muted), or was a moment ago. */
  audible: boolean;
  /** The user muted it. */
  muted: boolean;
  title: string;
  url: string;
}

/** What a tab's speaker shows: nothing, a speaker, or a crossed-out one. */
export type TabAudio = 'playing' | 'muted' | null;

let states = new Map<number, TabAudioState>();
const listeners = new Set<() => void>();
let started = false;

function receive(list: TabAudioState[]): void {
  states = new Map((Array.isArray(list) ? list : []).map((s) => [s.wcId, s]));
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void): () => void {
  if (!started) {
    started = true;
    const bridge = window.dinos?.media;
    if (bridge) {
      bridge.onTabAudio(receive);
      bridge.tabAudio().then(receive, () => {});
    }
  }
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function audioOf(wcId: number | null): TabAudio {
  const state = wcId === null ? undefined : states.get(wcId);
  if (!state) return null;
  return state.muted ? 'muted' : state.audible ? 'playing' : null;
}

/** What the speaker on the tab showing guest `wcId` should show. */
export function useTabAudio(wcId: number | null): TabAudio {
  return useSyncExternalStore(subscribe, () => audioOf(wcId), () => null);
}

/** Whether the page in guest `wcId` is muted by the user. */
export function isTabMuted(wcId: number | null): boolean {
  return wcId !== null && states.get(wcId)?.muted === true;
}

/** Mute or unmute the page in guest `wcId`. False if there's no such page. */
export async function setTabMuted(wcId: number, muted: boolean): Promise<boolean> {
  const bridge = window.dinos?.media;
  if (!bridge) return false;
  return bridge.setTabMuted(wcId, muted);
}

/** The pages making sound or muted, fresh from main (for `din browser audio`). */
export async function listTabAudio(): Promise<TabAudioState[] | null> {
  const bridge = window.dinos?.media;
  if (!bridge) return null;
  return bridge.tabAudio();
}
