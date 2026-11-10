import { getSystemCursorBridge } from '@/lib/systemCursor';

/**
 * A published cursor theme tried on for real (the App Store's Try On): made
 * the system's pointer, then put back. The pointer worn before, and whether
 * the tried theme was installed only to try it, are kept in localStorage
 * while it's on, so a Din that quits mid-try puts the pointer back when it
 * starts again (restoreCursorTryOn) rather than leaving the tried one on.
 *
 * It's the system's pointer rather than CSS cursors over the desktop because
 * Chromium on Wayland keeps playing an animated theme cursor over a page's
 * own (WaylandCursor::UpdateBitmap doesn't stop its animation timer), so a
 * CSS cursor under an animated pointer shows for one frame.
 */

const KEY = 'din:cursor-try-on';

interface Saved {
  previous: { theme: string; size: number };
  /** The theme tried on, once it's installed. */
  tried: string | null;
  /** Whether it was installed to be tried, and goes when it's taken off. */
  remove: boolean;
}

function read(): Saved | null {
  try {
    const value: unknown = JSON.parse(localStorage.getItem(KEY) ?? 'null');
    if (!value || typeof value !== 'object') return null;
    const saved = value as Partial<Saved>;
    const previous = saved.previous;
    if (!previous || typeof previous.theme !== 'string' || typeof previous.size !== 'number') return null;
    return {
      previous: { theme: previous.theme, size: previous.size },
      tried: typeof saved.tried === 'string' ? saved.tried : null,
      remove: saved.remove === true,
    };
  } catch {
    return null;
  }
}

function write(saved: Saved | null): void {
  if (saved) localStorage.setItem(KEY, JSON.stringify(saved));
  else localStorage.removeItem(KEY);
}

// One change to the pointer at a time, so a try started while another is
// downloading takes that one off first.
let chain: Promise<unknown> = Promise.resolve();
function serial<T>(run: () => Promise<T>): Promise<T> {
  const next = chain.then(run, run);
  chain = next.catch(() => {});
  return next;
}

/** Whether a cursor theme can be tried on as the system's pointer here. */
export function canTryOnSystemCursor(): boolean {
  return getSystemCursorBridge() !== undefined;
}

/**
 * Take off what's tried on, if anything, then make the theme `install`
 * resolves with (installing it, unless `installed` names it already) the
 * pointer. Resolves with its id.
 */
export function tryOnSystemCursor(installed: string | null, install: () => Promise<string>): Promise<string> {
  return serial(async () => {
    const bridge = getSystemCursorBridge();
    if (!bridge) throw new Error('The cursor can’t be changed here');
    // Taking off a theme got only to try it removes it, so it's got again.
    // One that can't be put back (its theme gone) doesn't stop every try after it.
    const removed = await takeOff(false).catch(() => {
      write(null);
      return null;
    });
    if (installed && installed === removed) installed = null;
    const status = await bridge.status();
    if (!status.canChange) throw new Error('Din can’t change the pointer on this computer');
    const saved: Saved = { previous: { theme: status.theme, size: status.size }, tried: installed, remove: !installed };
    write(saved);
    try {
      const id = installed ?? (await install());
      write({ ...saved, tried: id });
      await bridge.set({ theme: id, size: status.size });
      return id;
    } catch (error) {
      await takeOff(false).catch(() => {});
      throw error;
    }
  });
}

/** Resolves with the theme it removed, if it removed one. */
async function takeOff(keep: boolean): Promise<string | null> {
  const saved = read();
  if (!saved) return null;
  const bridge = getSystemCursorBridge();
  if (keep || !bridge) {
    write(null);
    return null;
  }
  // A pointer chosen in Settings meanwhile stays on.
  const current = saved.tried ? await bridge.status().catch(() => null) : null;
  if (!current || current.theme === saved.tried) await bridge.set(saved.previous);
  // Forgotten only once it's back, so a failure leaves it for the next try.
  write(null);
  if (!saved.remove || !saved.tried || saved.tried === saved.previous.theme) return null;
  await bridge.removeTheme(saved.tried).catch(() => {});
  return saved.tried;
}

/** Put back the pointer worn before trying one on, or with `keep`, keep the one tried. */
export function endSystemCursorTryOn(keep = false): Promise<void> {
  return serial(async () => {
    await takeOff(keep);
  });
}

/** Put back a pointer left tried on when Din last quit. */
export function restoreCursorTryOn(): Promise<void> {
  return read() ? endSystemCursorTryOn(false) : Promise.resolve();
}
