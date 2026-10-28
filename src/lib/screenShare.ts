/**
 * Typed access to the screen-sharing bridge exposed by the Electron preload
 * (`window.dinos.screenShare`, see electron/preload.cjs + electron/screen-share.mts).
 *
 * A web page's getDisplayMedia() arrives as a pick: the page's origin and
 * what it may share (the entire screen, or one of the open web windows).
 * `ScreenSharePicker` answers with a source, or null to refuse. A pick left
 * unanswered times out in main and arrives here as a cancel. The shares
 * running are listed for the menu bar, which can stop them.
 *
 * In a plain browser (`npm run dev:browser`) the bridge is absent, so callers
 * feature-detect via `getScreenShareBridge()`.
 */

export interface ScreenShareSource {
  id: string;
  kind: 'screen' | 'window';
  title: string;
  /** The page's host, for a window. */
  subtitle: string;
  /** A JPEG data URL, or null when the window isn't drawn (a background tab). */
  thumbnail: string | null;
}

export interface ScreenShareRequest {
  requestId: number;
  /** The requesting page's origin (e.g. `https://meet.example`). */
  origin: string;
  /** Whether the page asked for audio too, which a window can give. */
  audioRequested: boolean;
  sources: ScreenShareSource[];
}

export interface ActiveScreenShare {
  id: string;
  origin: string;
  kind: 'screen' | 'window';
  /** 'Entire screen', or the shared window's title. */
  title: string;
  audio: boolean;
}

export interface ScreenShareBridge {
  onPick(callback: (request: ScreenShareRequest) => void): () => void;
  onCancel(callback: (requestId: number) => void): () => void;
  choose(response: { requestId: number; sourceId: string | null; audio: boolean }): void;
  list(): Promise<ActiveScreenShare[]>;
  onActive(callback: (shares: ActiveScreenShare[]) => void): () => void;
  stop(id: string): Promise<void>;
}

declare global {
  interface Dinos {
    /** Present only inside the Electron shell. */
    screenShare?: ScreenShareBridge;
  }
}

/** The screen-sharing bridge, or undefined when running outside the shell. */
export function getScreenShareBridge(): ScreenShareBridge | undefined {
  if (typeof window === 'undefined') return undefined;
  return window.dinos?.screenShare;
}

/** An origin as a readable host (`meet.example`), falling back to the raw string. */
export function displayHost(origin: string): string {
  try {
    return new URL(origin).host || origin;
  } catch {
    return origin;
  }
}
