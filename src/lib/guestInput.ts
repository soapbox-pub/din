/**
 * Typed access to the guest-input bridge exposed by the Electron preload
 * (`window.guestInput`, see electron/preload.cjs + electron/main.mts).
 *
 * Pointer input inside Electron <webview> guests (browser tabs, web apps,
 * devtools panes) goes to the guest's document and never reaches the shell's.
 * The main process observes it and forwards what the shell reacts to;
 * GuestInputHost replays it on the guest's <webview> element as DOM events.
 * Coordinates are in the guest's view, in DIPs.
 *
 * In a plain browser (`npm run dev:browser`) the bridge is absent.
 */

/** Pointer input observed inside a guest. */
export type GuestInput =
  | {
      /** The pointer moved over the guest (at most once per frame). */
      type: 'move';
      wcId: number;
      x: number;
      y: number;
    }
  | {
      /** A mouse button went down in the guest. */
      type: 'down';
      wcId: number;
      x: number;
      y: number;
      button: 'left' | 'middle' | 'right';
    };

export interface GuestInputBridge {
  /** Subscribe to forwarded guest input. Returns an unsubscribe fn. */
  onInput(callback: (input: GuestInput) => void): () => void;
}

declare global {
  interface Window {
    /** Present only inside the Electron shell. */
    guestInput?: GuestInputBridge;
  }
}

/** The guest-input bridge, or undefined outside the Electron shell. */
export function getGuestInput(): GuestInputBridge | undefined {
  if (typeof window === 'undefined') return undefined;
  return window.guestInput;
}
