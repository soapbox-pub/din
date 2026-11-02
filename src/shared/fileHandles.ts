/**
 * The web's file handles as Din's apps use them (docs/din/files.md): the
 * pickers, answering cancel with nothing rather than an AbortError, writing
 * a whole file, the file types apps list by extension, and the files the
 * window was launched with, from `launchQueue`. Only web APIs; what the
 * web's handles can't do is `din.files`.
 */
import { useEffect, useLayoutEffect, useRef } from 'react';
import type { OpenFilePickerOptions, PickerOptions, SaveFilePickerOptions, DirectoryPickerOptions } from '@/sdk';
import { launched, onLaunch, windowLaunch } from '@/shared/launch';

/** "Pictures": `.png`, `.jpg`: a picker's type by its extensions, whatever their MIME types. */
export interface FileTypeFilter {
  description: string;
  /** With the dot. */
  extensions: string[];
}

/** A picker's `types` from filters by extension (Din's pickers go by the extensions alone). */
export function fileTypes(filters: readonly FileTypeFilter[]): NonNullable<PickerOptions['types']> {
  return filters.map((f) => ({ description: f.description, accept: { 'application/octet-stream': f.extensions } }));
}

const cancelled = (error: unknown) => error instanceof DOMException && error.name === 'AbortError';

/** `showOpenFilePicker`, with what was chosen, or nothing when it's cancelled. */
export async function pickFiles(options?: OpenFilePickerOptions): Promise<FileSystemFileHandle[]> {
  try {
    return await showOpenFilePicker(options);
  } catch (error) {
    if (cancelled(error)) return [];
    throw error;
  }
}

/** `showDirectoryPicker`, or null when it's cancelled. */
export async function pickFolder(options?: DirectoryPickerOptions): Promise<FileSystemDirectoryHandle | null> {
  try {
    return await showDirectoryPicker(options);
  } catch (error) {
    if (cancelled(error)) return null;
    throw error;
  }
}

/** `showSaveFilePicker`, or null when it's cancelled. */
export async function pickSaveFile(options?: SaveFilePickerOptions): Promise<FileSystemFileHandle | null> {
  try {
    return await showSaveFilePicker(options);
  } catch (error) {
    if (cancelled(error)) return null;
    throw error;
  }
}

/** Replace a file's contents (and create it, for a handle from the save picker). */
export async function writeFile(handle: FileSystemFileHandle, data: Blob | ArrayBuffer | ArrayBufferView | string): Promise<void> {
  const writable = await handle.createWritable();
  try {
    await writable.write(data as Blob | BufferSource | string);
  } catch (error) {
    await writable.abort().catch(() => {});
    throw error;
  }
  await writable.close();
}

/** Whether the app may write to a file it holds (one picked with `mode: 'read'` it may not). */
export async function canWrite(handle: FileSystemHandle): Promise<boolean> {
  return (await handle.queryPermission({ mode: 'readwrite' })) === 'granted';
}

/** A folder's handles, in the order it lists them. */
export async function folderEntries(folder: FileSystemDirectoryHandle): Promise<FileSystemHandle[]> {
  const entries: FileSystemHandle[] = [];
  for await (const handle of folder.values()) entries.push(handle);
  return entries;
}

// ---- launchQueue ----

/** The files this window was launched with (from Files, a drop on the Dock tile, Open With). */
export async function launchedFiles(): Promise<readonly FileSystemHandle[]> {
  return (await launched()).files;
}

/**
 * The same, at once: `startApp` waits for them before the app renders, so
 * an app's first render can start with its document.
 */
export function windowLaunchFiles(): readonly FileSystemHandle[] {
  return windowLaunch().files;
}

/** The first file (not folder) the window was launched with, or null. */
export function windowLaunchFile(): FileSystemFileHandle | null {
  return (windowLaunchFiles().find((h) => h.kind === 'file') as FileSystemFileHandle | undefined) ?? null;
}

/** Files from each launch after the window's own (a single-instance app launched again). */
export function onLaunchFiles(cb: (files: readonly FileSystemHandle[]) => void): () => void {
  return onLaunch(({ files }) => {
    if (files.length > 0) cb(files);
  });
}

/** The window's launch files once mounted (if any), then each later launch's, while mounted. */
export function useLaunchFiles(consumer: (files: readonly FileSystemHandle[]) => void): void {
  const latest = useRef(consumer);
  useLayoutEffect(() => {
    latest.current = consumer;
  });
  const started = useRef(false);
  useEffect(() => {
    if (!started.current) {
      started.current = true;
      const own = windowLaunchFiles();
      if (own.length > 0) latest.current(own);
    }
    return onLaunchFiles((files) => latest.current(files));
  }, []);
}
