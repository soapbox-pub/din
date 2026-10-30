/**
 * Apps from folders on this computer (electron/din-file-apps.mts): a folder
 * with an index.html the user added in the App Store, served at
 * din+file://<hash>/ (its id is file-<hash>) with window.din like a
 * built-in app's, and reloaded whenever a file in it changes. For
 * developing an app outside Din's tree, as the `din` command is, but kept
 * in the launcher.
 *
 * Their manifests are untrusted, as launched apps' are: the desktop keeps
 * what sanitizeManifest allows, and FileAppFrame asks before granting what
 * they ask for. The list is this computer's (the folders are), in
 * localStorage, with each app's manifest as last read so the launcher has
 * its name and icon before main has opened the folder again.
 */
import { createElement, lazy } from 'react';
import type { ComponentType } from 'react';
import type { AppComponentProps, AppDefinition } from '@/lib/apps';
import { getAppsBridge, isFileAppId } from '@/lib/dinApps';
import { manifestDefinition, sanitizeManifest } from '@/lib/launchedApps';
import type { DinManifest } from '@/sdk/din';

const FileAppFrame = lazy(() =>
  import('@/components/desktop/FileAppFrame').then((m) => ({ default: m.FileAppFrame })),
);

export const FILE_APPS_KEY = 'din:file-apps';

export interface FileAppEntry {
  /** file-<host>: the app at din+file://<host>/. */
  appId: string;
  /** The folder, absolute, symlinks resolved. */
  path: string;
  /** Its manifest as last read, sanitized. */
  manifest: DinManifest;
  /** Unix seconds. */
  addedAt: number;
}

/** A folder as main opened it (dinos.apps.folder). */
export interface OpenedFolder {
  appId: string;
  path: string;
  manifest: unknown;
}

/** Whether apps can come from folders here: only inside the Electron shell. */
export function canAddFileApps(): boolean {
  return Boolean(getAppsBridge());
}

/** What main says went wrong, without Electron's wrapping. */
export function folderError(error: unknown): string {
  return error instanceof Error ? error.message.replace(/^Error invoking remote method '[^']+': (Error: )?/, '') : String(error);
}

function folderName(path: string): string {
  return path.replace(/\/+$/, '').split('/').pop() || path;
}

/** An entry for a folder main opened, its manifest sanitized. */
export function fileAppEntry(opened: OpenedFolder, addedAt = Math.floor(Date.now() / 1000)): FileAppEntry {
  return { appId: opened.appId, path: opened.path, manifest: sanitizeManifest(opened.manifest, folderName(opened.path)), addedAt };
}

/** The stored list, with anything malformed dropped (manifests are sanitized again: storage is the desktop's, but cheap to check). */
export function parseFileApps(value: unknown): FileAppEntry[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((raw) => {
    const e = raw as Partial<FileAppEntry> | null;
    if (!e || typeof e.appId !== 'string' || !isFileAppId(e.appId) || typeof e.path !== 'string' || !e.path.startsWith('/')) return [];
    return [{
      appId: e.appId,
      path: e.path,
      manifest: sanitizeManifest(e.manifest, folderName(e.path)),
      addedAt: typeof e.addedAt === 'number' ? e.addedAt : 0,
    }];
  });
}

/** Window bodies, one per app, so a window keeps its component as the manifest changes. */
const components = new Map<string, ComponentType<AppComponentProps>>();

/** A folder's app, as the window manager knows it. */
export function fileAppDefinition(entry: FileAppEntry): AppDefinition {
  let component = components.get(entry.appId);
  if (!component) {
    const { appId } = entry;
    component = function FileApp(props: AppComponentProps) {
      return createElement(FileAppFrame, { ...props, appId });
    };
    components.set(appId, component);
  }
  return manifestDefinition(entry.appId, entry.manifest, component);
}
