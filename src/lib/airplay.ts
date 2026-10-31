/**
 * Typed access to the AirPlay bridge exposed by the Electron preload
 * (`window.dinos.airplay`, see electron/preload.cjs + electron/airplay.mts).
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
  /** The last session that ended with an error: CONNECTING when it never streamed. */
  failure: { target: string; message: string; connecting: boolean; at: number } | null;
}

export interface AirPlayBridge {
  state(): Promise<AirPlayState>;
  scan(): Promise<void>;
  /**
   * Connect the way the receiver was last shared, extending by default.
   * Resolves once it streams, or once it failed: the failure is in the state.
   */
  connect(target: string): Promise<void>;
  /** Remember MODE for the receiver, and switch it over if it's streaming. */
  mode(target: string, mode: AirPlayMode): Promise<void>;
  code(target: string, code: string): Promise<void>;
  disconnect(target: string): Promise<void>;
  onChanged(callback: (state: AirPlayState) => void): () => void;
  /** The display-switch key switched a receiver to MODE. */
  onOsd(callback: (change: { name: string; mode: AirPlayMode }) => void): () => void;
}

declare global {
  interface Dinos {
    /** Present only inside the Electron shell. */
    airplay?: AirPlayBridge;
  }
}

/** The AirPlay bridge, or undefined outside the Electron shell. */
export function getAirPlayBridge(): AirPlayBridge | undefined {
  if (typeof window === 'undefined') return undefined;
  return window.dinos?.airplay;
}

/** Strip Electron's IPC error prefix so users see just the underlying message. */
export function cleanAirPlayError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.replace(/^Error invoking remote method '[^']*':\s*(?:Error:\s*)?/, '');
}
