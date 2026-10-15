/**
 * Typed access to the prompt host exposed by the Electron preload
 * (`window.promptHost`, see electron/preload.cjs + electron/main.mts).
 *
 * The main process asks the user yes/no questions through it: a web page
 * requesting the camera, microphone, location, or notifications, and the
 * Chrome Web Store asking to install an extension. `PromptHost` renders each
 * one and answers with `respond`. A prompt left unanswered times out in main
 * as "no" and arrives here as a cancel.
 *
 * In a plain browser (`npm run dev:browser`) the bridge is absent, so callers
 * feature-detect via `getPromptHostBridge()`.
 */

/** A capability a site has to ask the user for. */
export type SiteCapability = 'camera' | 'microphone' | 'geolocation' | 'notifications';

export type ShellPromptRequest =
  | {
      requestId: number;
      kind: 'permission';
      /** The requesting page's origin (e.g. `https://meet.example`). */
      origin: string;
      capabilities: SiteCapability[];
    }
  | {
      requestId: number;
      kind: 'extension-install';
      name: string;
      /** API permissions (tabs, storage, ...). */
      permissions: string[];
      /** Sites the extension can read and change (match patterns). */
      hostPermissions: string[];
    };

export interface PromptHostBridge {
  /** Subscribe to prompts. Returns an unsubscribe fn. */
  onRequest(callback: (request: ShellPromptRequest) => void): () => void;
  /** Subscribe to prompts main has timed out. Returns an unsubscribe fn. */
  onCancel(callback: (requestId: number) => void): () => void;
  /** Answer a prompt. */
  respond(response: { requestId: number; allow: boolean }): void;
}

declare global {
  interface Window {
    /** Present only inside the Electron shell. */
    promptHost?: PromptHostBridge;
  }
}

/** The prompt host bridge, or undefined when running outside the shell. */
export function getPromptHostBridge(): PromptHostBridge | undefined {
  if (typeof window === 'undefined') return undefined;
  return window.promptHost;
}
