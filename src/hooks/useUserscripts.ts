import { useCallback, useEffect, useState } from 'react';
import {
  getUserscriptsBridge,
  newUserscriptId,
  parseUserscriptMeta,
  type Userscript,
} from '@/lib/userscripts';

const STORAGE_KEY = 'din:browser:userscripts';
/** Same-document change signal (the `storage` event only fires cross-tab). */
const CHANGE_EVENT = 'din:userscripts-changed';

function readAll(): Userscript[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    const parsed: unknown = raw ? JSON.parse(raw) : [];
    return Array.isArray(parsed) ? (parsed as Userscript[]) : [];
  } catch (error) {
    console.warn('Failed to load userscripts:', error);
    return [];
  }
}

function writeAll(scripts: Userscript[]) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(scripts));
  } catch (error) {
    console.warn('Failed to save userscripts:', error);
  }
  getUserscriptsBridge()?.sync(scripts);
  window.dispatchEvent(new Event(CHANGE_EVENT));
}

/**
 * The browser's userscript library. Scripts persist per-device in
 * localStorage; every change is synced to the Electron main process, which
 * injects matching scripts into browser tabs (see src/lib/userscripts.ts).
 *
 * Mutations re-read localStorage first, so concurrent hook instances (e.g.
 * two browser windows) never clobber each other's edits with stale state.
 */
export function useUserscripts() {
  const [scripts, setScripts] = useState<Userscript[]>(readAll);

  useEffect(() => {
    // Prime the main process with the persisted library on mount.
    getUserscriptsBridge()?.sync(readAll());

    const refresh = () => setScripts(readAll());
    const onStorage = (e: StorageEvent) => {
      if (e.key === STORAGE_KEY) refresh();
    };
    window.addEventListener(CHANGE_EVENT, refresh);
    window.addEventListener('storage', onStorage);
    return () => {
      window.removeEventListener(CHANGE_EVENT, refresh);
      window.removeEventListener('storage', onStorage);
    };
  }, []);

  const mutate = useCallback((fn: (prev: Userscript[]) => Userscript[]) => {
    const next = fn(readAll());
    writeAll(next);
    setScripts(next);
  }, []);

  /**
   * Install (or update) a script from its source text. Re-installing a script
   * with the same download URL, or the same name + namespace, replaces the
   * existing entry in place, keeping its id and enabled state.
   * Throws when the source has no valid ==UserScript== block.
   */
  const install = useCallback(
    (code: string, downloadUrl?: string): Userscript => {
      const meta = parseUserscriptMeta(code);
      if (!meta) {
        throw new Error('Missing or invalid ==UserScript== metadata block');
      }
      let installed: Userscript | undefined;
      mutate((prev) => {
        const existing = prev.find(
          (s) =>
            (downloadUrl !== undefined && s.downloadUrl === downloadUrl) ||
            (s.name === meta.name && s.namespace === meta.namespace),
        );
        const now = Date.now();
        installed = {
          ...meta,
          id: existing?.id ?? newUserscriptId(),
          enabled: existing?.enabled ?? true,
          code,
          downloadUrl: downloadUrl ?? existing?.downloadUrl,
          installedAt: existing?.installedAt ?? now,
          updatedAt: now,
        };
        const script = installed;
        return existing
          ? prev.map((s) => (s.id === script.id ? script : s))
          : [...prev, script];
      });
      if (!installed) throw new Error('Install failed');
      return installed;
    },
    [mutate],
  );

  const remove = useCallback(
    (id: string) => mutate((prev) => prev.filter((s) => s.id !== id)),
    [mutate],
  );

  const setEnabled = useCallback(
    (id: string, enabled: boolean) =>
      mutate((prev) => prev.map((s) => (s.id === id ? { ...s, enabled } : s))),
    [mutate],
  );

  return { scripts, install, remove, setEnabled };
}
