// A guest's DevTools protocol connection, shared. Electron gives each
// WebContents one `debugger`, and several parts of Din use it: a tab's
// docked DevTools and its device emulation (devtools-bridge.mts), files
// dragged into a page (main.mts), web pages' uploads going to Din's file
// picker (main.mts), and Din's accessibility preferences as CSS media
// features (accessibility.mts). Each holds it here under a name, and it's
// detached when the last lets go.
//
// A holder that leaves the connection in a state nobody else should inherit
// (DevTools, whose frontend enabled the Debugger and every other domain)
// lets go with `reset`: the debugger is detached and attached afresh, and
// the holders left are asked to apply what they had again.
//
// Runs as TypeScript directly via Node's native type stripping - erasable
// syntax only, like the rest of electron/.

/** Holders by WebContents id, each with its `reapply` for after a reset. */
const holders = new Map<number, Map<string, (() => void) | null>>();
/** Guests whose debugger this module listens to. */
const watched = new WeakSet<Electron.WebContents>();
/** Guests being detached and attached again by a reset. */
const resetting = new Set<number>();

function watch(contents: Electron.WebContents): void {
  if (watched.has(contents)) return;
  watched.add(contents);
  const id = contents.id;
  // Detached from outside (the guest crashed or went away): every hold goes.
  contents.debugger.on('detach', () => {
    if (resetting.has(id)) return;
    if (contents.isDestroyed() || !contents.debugger.isAttached()) holders.delete(id);
  });
  contents.once('destroyed', () => holders.delete(id));
}

/**
 * Hold the guest's debugger, attaching it if it isn't. False when it can't
 * be (the guest is gone).
 */
export function holdDebugger(contents: Electron.WebContents, holder: string, reapply?: () => void): boolean {
  if (contents.isDestroyed()) return false;
  watch(contents);
  if (!contents.debugger.isAttached()) {
    try {
      contents.debugger.attach('1.3');
    } catch {
      return false;
    }
  }
  let held = holders.get(contents.id);
  if (!held) holders.set(contents.id, (held = new Map()));
  held.set(holder, reapply ?? null);
  return true;
}

/** Whether `holder` holds the guest's debugger. */
export function holdsDebugger(contents: Electron.WebContents, holder: string): boolean {
  return !contents.isDestroyed() && contents.debugger.isAttached() && (holders.get(contents.id)?.has(holder) ?? false);
}

/**
 * Detach the guest's debugger and attach it afresh, asking its holders to
 * apply what they had again: for a holder (DevTools) that has to start
 * from a connection nobody has set up yet.
 */
export function resetDebugger(contents: Electron.WebContents): void {
  const held = holders.get(contents.id);
  if (!held || contents.isDestroyed()) return;
  resetting.add(contents.id);
  try {
    if (contents.debugger.isAttached()) contents.debugger.detach();
    contents.debugger.attach('1.3');
  } catch {
    holders.delete(contents.id);
    return;
  } finally {
    resetting.delete(contents.id);
  }
  for (const reapply of held.values()) reapply?.();
}

/** Let go of the guest's debugger; the last to let go detaches it. */
export function releaseDebugger(contents: Electron.WebContents, holder: string, options: { reset?: boolean } = {}): void {
  const held = holders.get(contents.id);
  if (!held?.delete(holder) || contents.isDestroyed()) return;
  if (held.size > 0 && !options.reset) return;
  resetting.add(contents.id);
  try {
    if (contents.debugger.isAttached()) contents.debugger.detach();
    if (held.size === 0) {
      holders.delete(contents.id);
      return;
    }
    contents.debugger.attach('1.3');
  } catch {
    holders.delete(contents.id);
    return;
  } finally {
    resetting.delete(contents.id);
  }
  for (const reapply of held.values()) reapply?.();
}
