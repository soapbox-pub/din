/**
 * Typed access to the boot bridge exposed by the Electron preload
 * (`window.boot`, see electron/preload.cjs).
 *
 * The shell window starts hidden (see electron/main.mts) and is shown only
 * after the renderer reports its first frame is on the way, so the window
 * never maps onto an unpainted (white/garbage) buffer on bare X11. In a
 * plain browser there is no host to signal and this is a no-op.
 */

export interface BootBridge {
  /** Signal that the shell's first frame is ready to be shown. */
  ready(): void;
}

declare global {
  interface Window {
    /** Present only inside the Electron shell. */
    boot?: BootBridge;
  }
}

/** The boot bridge, or undefined when running outside the Electron shell. */
export function getBootBridge(): BootBridge | undefined {
  if (typeof window === 'undefined') return undefined;
  return window.boot;
}
