/**
 * Typed access to the OS terminal bridge exposed by the Electron preload
 * (`window.pty`, see electron/preload.cjs + electron/main.cjs + pty-host.py).
 *
 * Each session is a real login shell attached to a pseudo-terminal, running
 * as the unprivileged OS user. Output arrives as raw bytes (Uint8Array) and
 * input is sent as the string data xterm.js produces - both are passed
 * through to the pty untouched.
 *
 * In a plain browser (`make dev-browser`) the bridge is absent; callers must
 * feature-detect via `getPtyBridge()` and render a fallback.
 */

export interface PtySize {
  cols: number;
  rows: number;
}

/** A command that ran in a session, as its pty saw it. */
export interface CommandDone {
  /** Its command line, roughly as typed (no exit code: the shell keeps that). */
  command: string;
  /** How long it ran. */
  seconds: number;
}

export interface PtyBridge {
  /** Start a shell session; resolves to its session id. */
  spawn(size: PtySize, cwd?: string): Promise<number>;
  /** Send user keystrokes/paste data to a session. */
  write(id: number, data: string): void;
  /** Inform the session's pty of a new terminal size. */
  resize(id: number, cols: number, rows: number): void;
  /** Terminate a session. */
  kill(id: number): void;
  /** Subscribe to output from all sessions. Returns an unsubscribe fn. */
  onData(callback: (id: number, data: Uint8Array) => void): () => void;
  /** Subscribe to session exits. Returns an unsubscribe fn. */
  onExit(callback: (id: number, code: number) => void): () => void;
  /**
   * Subscribe to commands finishing in any session: the shell got the
   * terminal back. Returns an unsubscribe fn.
   */
  onCommandDone(callback: (id: number, done: CommandDone) => void): () => void;
}

declare global {
  interface Window {
    /** Present only inside the Electron shell. */
    pty?: PtyBridge;
  }
}

/** The pty bridge, or undefined when running outside the Electron shell. */
export function getPtyBridge(): PtyBridge | undefined {
  if (typeof window === 'undefined') return undefined;
  return window.pty;
}
