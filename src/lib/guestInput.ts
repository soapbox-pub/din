/**
 * Typed access to the guest-input bridge exposed by the Electron preload
 * (`window.dinos.guestInput`, see electron/preload.cjs + electron/main.mts).
 *
 * Pointer input inside Electron <webview> guests (browser tabs, web apps,
 * devtools panes) goes to the guest's document and never reaches the shell's.
 * The main process observes it and forwards what the shell reacts to;
 * GuestInputHost replays it on the guest's <webview> element as DOM events.
 * Coordinates are in DIPs: `x`/`y` in the guest's view, `sx`/`sy` (when the
 * event carried a screen position) in the shell's.
 *
 * In a plain browser (`npm run dev:browser`) the bridge is absent.
 */

/** Where the pointer was, in the guest's view and (if known) the shell's. */
interface GuestPoint {
  x: number;
  y: number;
  /**
   * The same point in the shell's view. It doesn't depend on where the
   * shell has the guest by the time the input arrives, which a guest-local
   * point does: prefer it while the guest's window is moving.
   */
  sx?: number;
  sy?: number;
}

/** Pointer input observed inside a guest. */
export type GuestInput =
  | (GuestPoint & {
      /** The pointer moved over the guest (at most once per frame). */
      type: 'move';
      wcId: number;
      /** Whether Super (Meta) was held. */
      meta: boolean;
    })
  | (GuestPoint & {
      /** A mouse button went down in the guest. */
      type: 'down';
      wcId: number;
      button: 'left' | 'middle' | 'right';
      /** Whether Super (Meta) was held. */
      meta: boolean;
    });

export interface GuestInputBridge {
  /** Subscribe to forwarded guest input. Returns an unsubscribe fn. */
  onInput(callback: (input: GuestInput) => void): () => void;
}

declare global {
  interface Dinos {
    /** Present only inside the Electron shell. */
    guestInput?: GuestInputBridge;
  }
}

/** The guest-input bridge, or undefined outside the Electron shell. */
export function getGuestInput(): GuestInputBridge | undefined {
  if (typeof window === 'undefined') return undefined;
  return window.dinos?.guestInput;
}
