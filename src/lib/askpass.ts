/**
 * Typed access to sudo's requests (`window.dinos.askpass`, see
 * electron/preload.cjs + electron/askpass.mts): sudo asking to approve a
 * command, or for the computer's password with no terminal to ask on, for a
 * program other than the Assistant (whose commands ask in their
 * conversation). `AdminPromptHost` shows each one. Absent in a plain browser.
 */

export interface AskpassRequest {
  requestId: number;
  /** Who's asking: "Assistant", or the program's name. */
  requester: string;
  /** The sudo command line. */
  command: string;
  /** Allow or Deny, rather than the password. */
  approve: boolean;
  /** Din itself asked, because the user just did (installing a package): open the dialog at once. */
  direct: boolean;
  /** What the command does, in words ("update Din"), for one of Din's own; then shown instead of it. */
  action: string | null;
  /** What comes of it, in a sentence, with `action`. */
  detail: string | null;
}


export interface AskpassBridge {
  onRequest(callback: (request: AskpassRequest) => void): () => void;
  onCancel(callback: (requestId: number) => void): () => void;
  /** The password, or null to cancel. `ok` is false when the password isn't right. */
  answer(requestId: number, password: string | null): Promise<{ ok: boolean }>;
  /** Allow an approval request, or deny it. */
  approve(requestId: number, allow: boolean): Promise<void>;
}

declare global {
  interface Dinos {
    /** Present only inside the Electron shell. */
    askpass?: AskpassBridge;
  }
}

/** The bridge, or undefined outside the Electron shell. */
export function getAskpassBridge(): AskpassBridge | undefined {
  if (typeof window === 'undefined') return undefined;
  return window.dinos?.askpass;
}
