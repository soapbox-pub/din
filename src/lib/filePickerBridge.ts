/**
 * Typed access to the file-picker bridge host exposed by the Electron preload
 * (`window.dinos.filePickerHost`, see electron/preload.cjs + electron/main.mts).
 *
 * A native `<input type=file>` click inside a browser tab or installed web-app
 * guest is intercepted over CDP in the main process and relayed here, to the
 * shell renderer, where `FilePickerBridgeHost` opens the in-Din
 * file picker window (via `useFilePicker`) and answers with the absolute path
 * the user chose — which the main process then hands back to the page with
 * `DOM.setFileInputFiles`. This keeps uploads inside Din instead of popping the
 * host OS file dialog.
 *
 * Native Linux apps' Open and Save dialogs arrive the same way, from the
 * desktop portal's file chooser backend (electron/file-chooser.mts), with
 * `options` saying what kind of dialog it is.
 *
 * The page never supplies the path: a request carries only `{ requestId,
 * origin }`, and the shell only ever returns a path the user explicitly picked.
 * In a plain browser (`npm run dev:browser`) the bridge is absent — there are
 * no `<webview>` guests to intercept — so callers feature-detect via
 * `getFilePickerHostBridge()`.
 */

import type { FileFilter } from '@/lib/fileFilters';

/** What a native app's dialog asks for (see electron/file-chooser-portal.mts). */
export interface FilePickerBridgeOptions {
  title: string;
  confirmLabel: string | null;
  mode: 'open' | 'save';
  multiple: boolean;
  directory: boolean;
  filters: FileFilter[];
  currentFilter: number | null;
  currentName: string | null;
  initialPath: string | null;
}

/** A file-chooser request relayed from a guest whose file input was clicked. */
export interface FilePickerBridgeRequest {
  /** Correlates the eventual response back to the waiting page. */
  requestId: number;
  /** The guest's origin host (for the picker title), or `''` if unknown. */
  origin: string;
  /** The input takes several files. */
  multiple?: boolean;
  /** A native app's dialog, through the desktop portal. */
  options?: FilePickerBridgeOptions;
}

/** The shell renderer's answer to a relayed file-chooser request. */
export interface FilePickerBridgeResponse {
  requestId: number;
  /** The (first) chosen absolute path, or `null` when the user cancelled. */
  path: string | null;
  /** Every chosen path. */
  paths: string[] | null;
  /** Index of the file type filter in use, if the request had filters. */
  filter: number | null;
}

export interface FilePickerHostBridge {
  /** Subscribe to relayed file-chooser requests. Returns an unsubscribe fn. */
  onRequest(callback: (request: FilePickerBridgeRequest) => void): () => void;
  /** Subscribe to requests withdrawn unanswered. Returns an unsubscribe fn. */
  onCancel(callback: (requestId: number) => void): () => void;
  /** Answer a relayed request. */
  respond(response: FilePickerBridgeResponse): void;
}

declare global {
  interface Dinos {
    /** Present only inside the Electron shell. */
    filePickerHost?: FilePickerHostBridge;
  }
}

/** The file-picker host bridge, or undefined when running outside the shell. */
export function getFilePickerHostBridge(): FilePickerHostBridge | undefined {
  if (typeof window === 'undefined') return undefined;
  return window.dinos?.filePickerHost;
}
