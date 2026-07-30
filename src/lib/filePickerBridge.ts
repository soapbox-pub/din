/**
 * Typed access to the file-picker bridge host exposed by the Electron preload
 * (`window.filePickerHost`, see electron/preload.cjs + electron/main.mts).
 *
 * A native `<input type=file>` click inside a browser tab or installed web-app
 * guest is intercepted over CDP in the main process and relayed here, to the
 * shell renderer, where `FilePickerBridgeHost` opens the in-Din
 * `FilePickerDialog` (via `useFilePicker`) and answers with the absolute path
 * the user chose — which the main process then hands back to the page with
 * `DOM.setFileInputFiles`. This keeps uploads inside Din instead of popping the
 * host OS file dialog.
 *
 * The page never supplies the path: a request carries only `{ requestId,
 * origin }`, and the shell only ever returns a path the user explicitly picked.
 * In a plain browser (`npm run dev:browser`) the bridge is absent — there are
 * no `<webview>` guests to intercept — so callers feature-detect via
 * `getFilePickerHostBridge()`.
 */

/** A file-chooser request relayed from a guest whose file input was clicked. */
export interface FilePickerBridgeRequest {
  /** Correlates the eventual response back to the waiting page. */
  requestId: number;
  /** The guest's origin host (for the picker title), or `''` if unknown. */
  origin: string;
}

/** The shell renderer's answer to a relayed file-chooser request. */
export interface FilePickerBridgeResponse {
  requestId: number;
  /** The chosen absolute path, or `null` when the user cancelled. */
  path: string | null;
}

export interface FilePickerHostBridge {
  /** Subscribe to relayed file-chooser requests. Returns an unsubscribe fn. */
  onRequest(callback: (request: FilePickerBridgeRequest) => void): () => void;
  /** Answer a relayed request. */
  respond(response: FilePickerBridgeResponse): void;
}

declare global {
  interface Window {
    /** Present only inside the Electron shell. */
    filePickerHost?: FilePickerHostBridge;
  }
}

/** The file-picker host bridge, or undefined when running outside the shell. */
export function getFilePickerHostBridge(): FilePickerHostBridge | undefined {
  if (typeof window === 'undefined') return undefined;
  return window.filePickerHost;
}
