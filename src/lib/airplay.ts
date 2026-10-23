/**
 * Typed access to the AirPlay bridge exposed by the Electron preload
 * (`window.airplay`, see electron/preload.cjs + electron/airplay.mts).
 *
 * Shares the screen with AirPlay receivers (Apple TVs, AirPlay TVs, Rokus)
 * through deckmon: mirroring the primary display, or extending the desktop
 * onto the receiver as a display of its own. Absent outside the Electron
 * shell; `available: false` where deckmon isn't installed.
 */

export type AirPlayMode = 'mirror' | 'extend';

export interface AirPlayReceiver {
  /** The receiver's name, which it's connected to by. */
  name: string;
  host: string;
  model: string;
}

export interface AirPlaySession {
  /** The receiver's name, as connected to. */
  target: string;
  name: string;
  state: 'connecting' | 'waiting_for_code' | 'streaming';
  /** What the receiver asks for while waiting for a code. */
  prompt: 'pin' | 'password' | 'code' | null;
  /** The receiver is a display of its own, rather than a mirror. */
  extend: boolean;
  /** The display the receiver shows. */
  output: string | null;
  audio: boolean;
}

export interface AirPlayState {
  available: boolean;
  scanning: boolean;
  receivers: AirPlayReceiver[];
  sessions: AirPlaySession[];
  /** The last session that ended with an error. */
  failure: { target: string; message: string; at: number } | null;
}

export interface AirPlayBridge {
  state(): Promise<AirPlayState>;
  scan(): Promise<void>;
  /** Connect the way the receiver was last shared, extending by default. */
  connect(target: string): Promise<void>;
  /** Remember MODE for the receiver, and switch it over if it's streaming. */
  mode(target: string, mode: AirPlayMode): Promise<void>;
  code(target: string, code: string): Promise<void>;
  disconnect(target: string): Promise<void>;
  onChanged(callback: (state: AirPlayState) => void): () => void;
}

declare global {
  interface Window {
    /** Present only inside the Electron shell. */
    airplay?: AirPlayBridge;
  }
}

/** The AirPlay bridge, or undefined outside the Electron shell. */
export function getAirPlayBridge(): AirPlayBridge | undefined {
  if (typeof window === 'undefined') return undefined;
  return window.airplay;
}

/** Strip Electron's IPC error prefix so users see just the underlying message. */
export function cleanAirPlayError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.replace(/^Error invoking remote method '[^']*':\s*(?:Error:\s*)?/, '');
}
