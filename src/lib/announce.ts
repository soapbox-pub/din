/**
 * Say something to a screen reader: what changed on screen without the
 * keyboard going there (a notification popping up, the volume keys). The
 * desktop's Announcer (src/components/desktop/Announcer.tsx) holds the live
 * regions it's read from.
 */

export type Politeness = 'polite' | 'assertive';

type Listener = (message: string, politeness: Politeness) => void;

const listeners = new Set<Listener>();

/** Polite waits for the reader to finish what it's saying; assertive interrupts it. */
export function announce(message: string, politeness: Politeness = 'polite'): void {
  const text = message.trim();
  if (!text) return;
  for (const listener of listeners) listener(text, politeness);
}

export function onAnnounce(listener: Listener): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}
