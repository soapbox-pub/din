/**
 * Typed access to polkit's requests (`window.dinos.polkit`, see
 * electron/preload.cjs + electron/polkit-agent.mts): a program asking polkit
 * for something that needs the computer's password, as pkexec does.
 * `PolkitPromptHost` shows each one. Absent in a plain browser.
 */

export interface PolkitRequest {
  requestId: number;
  /** Who's asking: "Terminal", "Assistant", or the program's name. */
  requester: string;
  /** polkit's words for what it's for: "Authentication is needed to run …". */
  message: string;
  /** The polkit action, as `org.freedesktop.policykit.exec`. */
  action: string;
  /** Whose password, when it isn't this user's own, or null. */
  user: string | null;
}

export interface PolkitBridge {
  onRequest(callback: (request: PolkitRequest) => void): () => void;
  /** A request went: answered, the program gave up, or it timed out. */
  onCancel(callback: (requestId: number) => void): () => void;
  /** The password, or null to cancel. `ok` is false when the password isn't right. */
  answer(requestId: number, password: string | null): Promise<{ ok: boolean }>;
}

declare global {
  interface Dinos {
    /** Present only inside the Electron shell. */
    polkit?: PolkitBridge;
  }
}

/** The bridge, or undefined outside the Electron shell. */
export function getPolkitBridge(): PolkitBridge | undefined {
  if (typeof window === 'undefined') return undefined;
  return window.dinos?.polkit;
}
