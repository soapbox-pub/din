import { createContext, useContext, type RefObject } from 'react';

/**
 * What the assistant's UI needs from wherever it's drawn: the desktop (the
 * menu bar's panel, the Super+A prompt, Settings) or an app (the Assistant,
 * CAD's palette), which reach the same things by different roads
 * (useWindowActions and Din's file picker there, window.din here). Each
 * provides one with AssistantHostContext; desktopHost.tsx and appHost.tsx.
 */
export interface AssistantHost {
  /** The folder new conversations work in, from Settings; '' for the home folder. */
  directory: string;
  /** Replies colored as in OpenCode's terminal (Settings). */
  colorfulReplies: boolean;
  /** Turn the assistant on or off, where Din's settings can be changed; else undefined. */
  setEnabled?: (enabled: boolean) => void;
  openApp(appId: string, params?: Record<string, unknown>): void;
  /** Open a web link in the browser. */
  openUrl(url: string): void;
  /** Open a file in the app Files would use, or a folder in Files. */
  openPath(path: string, kind: 'file' | 'directory'): void;
  /** Show a file selected in its folder, in Files. */
  showInFolder(path: string): void;
  /** Din's file picker, for files to attach: their paths, empty if cancelled. */
  pickFiles(options: { title: string; confirmLabel: string }): Promise<string[]>;
  /** Din's file picker, for a folder: its path, or null if cancelled. */
  pickFolder(options: { title: string; confirmLabel: string; initialPath?: string }): Promise<string | null>;
  /**
   * The paths of Din's files a paste or drop brings (files copied or
   * dragged in Files), or null when it brings none. Call it during the
   * event: a drop's items can only be read then.
   */
  transferredPaths(data: DataTransfer, kind: 'paste' | 'drop'): Promise<string[]> | null;
  /** A short-lived message (a toast). */
  notify(message: { title: string; description?: string; destructive?: boolean }): void;
  /**
   * The composer's mic: whether this computer takes dictation, whether it's
   * going into `ref`'s field now, and starting it there or finishing it.
   * A hook, so called on every render of the composer.
   */
  useDictation(ref: RefObject<HTMLTextAreaElement | null>): { available: boolean; active: boolean; toggle: () => void };
}

export const AssistantHostContext = createContext<AssistantHost | null>(null);

export function useAssistantHost(): AssistantHost {
  const host = useContext(AssistantHostContext);
  if (!host) throw new Error('The assistant’s UI needs an AssistantHostContext');
  return host;
}
