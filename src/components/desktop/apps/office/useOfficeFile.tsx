import { useCallback, useEffect, useRef, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { cleanFsError, getFsBridge, parentPath } from '@/lib/fs';
import type { FileFilter } from '@/lib/fileFilters';
import { setCloseGuard } from '@/lib/closeGuards';
import { invalidateListings } from '@/hooks/useFileSystem';
import { useWindowActions } from '@/contexts/WindowManagerContext';
import { useWindowTitle } from '@/contexts/WindowTitleContext';
import { useFilePicker } from '@/contexts/FilePickerContext';
import { ACCENTS, type OfficeApp } from './accent';
import { OfficeButton, OfficeDialog, type RecentFile } from './chrome';

/** Bigger files than this aren't read. */
const MAX_BYTES = 512 * 1024 * 1024;
const RECENT_MAX = 20;

export const basename = (path: string) => path.slice(path.lastIndexOf('/') + 1);
export const stem = (name: string) => (name.lastIndexOf('.') > 0 ? name.slice(0, name.lastIndexOf('.')) : name);
export const extOf = (path: string) => {
  const name = basename(path);
  const i = name.lastIndexOf('.');
  return i > 0 ? name.slice(i + 1).toLowerCase() : '';
};

const untitledCounters: Partial<Record<OfficeApp, number>> = {};

function recentKey(app: OfficeApp) {
  return `din:office:recent:${app}`;
}

export function readRecent(app: OfficeApp): RecentFile[] {
  try {
    const v: unknown = JSON.parse(localStorage.getItem(recentKey(app)) ?? '[]');
    return Array.isArray(v) ? v.filter((r): r is RecentFile => typeof r?.path === 'string' && typeof r?.time === 'number') : [];
  } catch {
    return [];
  }
}

function addRecent(app: OfficeApp, path: string): RecentFile[] {
  const list = [{ path, time: Date.now() }, ...readRecent(app).filter((r) => r.path !== path)].slice(0, RECENT_MAX);
  localStorage.setItem(recentKey(app), JSON.stringify(list));
  return list;
}

const RECENT_CHANGED = 'din:office:recent';

export function removeRecent(app: OfficeApp, path: string) {
  localStorage.setItem(recentKey(app), JSON.stringify(readRecent(app).filter((r) => r.path !== path)));
  window.dispatchEvent(new CustomEvent(RECENT_CHANGED, { detail: app }));
}

export interface OfficeFileOptions {
  windowId: string;
  /** The app id in Din's registry, for opening files in a window of their own. */
  appId: string;
  app: OfficeApp;
  /** "Document", "Book", "Presentation": new files are Document1, Document2... */
  untitled: string;
  initialPath: string | null;
  openExtensions: string[];
  /** Save As choices; the first is the app's own format. */
  saveTypes: FileFilter[];
  /** Read a file's bytes into the app. Throw (with a message for people) if it can't be. */
  onLoad: (bytes: Uint8Array, path: string) => Promise<void> | void;
  /** The bytes to write for a path; its extension says which format. */
  onSave: (path: string) => Promise<Uint8Array> | Uint8Array;
}

/**
 * A document window's file: which file it is, whether it has unsaved
 * changes, Open / Save / Save As through Din's file picker, the recent
 * files list, and asking before closing over unsaved work, Office's way.
 */
export function useOfficeFile(opts: OfficeFileOptions) {
  const { windowId, appId, app, untitled, initialPath, openExtensions, saveTypes } = opts;
  const fs = getFsBridge();
  const { open, close, focus } = useWindowActions();
  const { pickFile, pickFiles } = useFilePicker();
  const queryClient = useQueryClient();
  const optsRef = useRef(opts);
  useEffect(() => {
    optsRef.current = opts;
  });

  const [untitledName] = useState(() => {
    const n = (untitledCounters[app] ?? 0) + 1;
    untitledCounters[app] = n;
    return `${untitled}${n}`;
  });
  const [path, setPath] = useState<string | null>(null);
  const [dirty, setDirtyState] = useState(false);
  const [loading, setLoading] = useState(initialPath !== null && fs !== undefined);
  const [error, setError] = useState<string | null>(null);
  const [status, setStatus] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [asking, setAsking] = useState(false);
  const [recent, setRecent] = useState(() => readRecent(app));
  const dirtyRef = useRef(false);
  const loadSeq = useRef(0);

  useEffect(() => {
    const onChange = (e: Event) => {
      if ((e as CustomEvent<OfficeApp>).detail === app) setRecent(readRecent(app));
    };
    window.addEventListener(RECENT_CHANGED, onChange);
    return () => window.removeEventListener(RECENT_CHANGED, onChange);
  }, [app]);

  const name = path ? basename(path) : untitledName;
  const docName = path ? stem(basename(path)) : untitledName;
  useWindowTitle(`${dirty ? '• ' : ''}${name}`);

  const setDirty = useCallback((v: boolean) => {
    dirtyRef.current = v;
    setDirtyState(v);
  }, []);

  const load = useCallback(
    (target: string) => {
      if (!fs) return;
      const seq = ++loadSeq.current;
      fs.readFile(target, MAX_BYTES)
        .then(async (result) => {
          if (result.truncated) throw new Error('It’s too big to open (over 512 MB).');
          if (seq !== loadSeq.current) return;
          await optsRef.current.onLoad(result.data, target);
          if (seq !== loadSeq.current) return;
          setPath(target);
          setError(null);
          setDirty(false);
          setStatus(null);
          setRecent(addRecent(app, target));
          setLoading(false);
        })
        .catch((err: unknown) => {
          if (seq !== loadSeq.current) return;
          setPath(target);
          setError(err instanceof Error && !('code' in err) ? err.message : cleanFsError(err));
          setLoading(false);
        });
    },
    [fs, app, setDirty],
  );

  const [prevInitial, setPrevInitial] = useState<string | null>(null);
  if (initialPath !== prevInitial) {
    setPrevInitial(initialPath);
    if (initialPath && fs) setLoading(true);
  }
  useEffect(() => {
    if (initialPath) load(initialPath);
  }, [initialPath, load]);

  const writeTo = useCallback(
    async (target: string): Promise<boolean> => {
      if (!fs) return false;
      setSaving(true);
      setStatus('Saving…');
      try {
        const bytes = await optsRef.current.onSave(target);
        await fs.writeFile(target, bytes);
        setPath(target);
        setDirty(false);
        setError(null);
        setStatus('Saved');
        setRecent(addRecent(app, target));
        void queryClient.invalidateQueries({ queryKey: ['fs', 'readFile', target] });
        void invalidateListings(queryClient, target);
        return true;
      } catch (err) {
        setStatus(`Couldn’t save: ${err instanceof Error && !('code' in err) ? err.message : cleanFsError(err)}`);
        return false;
      } finally {
        setSaving(false);
      }
    },
    [fs, app, queryClient, setDirty],
  );

  const saveAs = useCallback(
    async (filterIndex = 0): Promise<boolean> => {
      const types = saveTypes;
      const filter = types[filterIndex] ?? types[0];
      const ext = filter.patterns[0].slice(1);
      const result = await pickFiles({
        mode: 'save',
        title: filterIndex === 0 ? 'Save As' : `Export as ${filter.name}`,
        currentName: `${docName}${ext}`,
        initialPath: path ? parentPath(path) : undefined,
        filters: filterIndex === 0 ? types : [filter],
      });
      if (!result) return false;
      let target = result.paths[0];
      const chosen = filterIndex === 0 ? (types[result.filter ?? 0] ?? types[0]) : filter;
      const known = types.some((t) => t.patterns.some((p) => p.slice(2) === extOf(target)));
      if (!known) target += chosen.patterns[0].slice(1);
      return writeTo(target);
    },
    [saveTypes, pickFiles, docName, path, writeTo],
  );

  /** Export writes a copy without making it this window's file. */
  const exportCopy = useCallback(
    async (filterIndex: number): Promise<boolean> => {
      if (!fs) return false;
      const filter = saveTypes[filterIndex];
      const ext = filter.patterns[0].slice(1);
      const result = await pickFiles({
        mode: 'save',
        title: `Export as ${filter.name}`,
        currentName: `${docName}${ext}`,
        initialPath: path ? parentPath(path) : undefined,
        filters: [filter],
      });
      if (!result) return false;
      let target = result.paths[0];
      if (extOf(target) !== ext.slice(1)) target += ext;
      try {
        const bytes = await optsRef.current.onSave(target);
        await fs.writeFile(target, bytes);
        setStatus(`Exported ${basename(target)}`);
        void invalidateListings(queryClient, target);
        return true;
      } catch (err) {
        setStatus(`Couldn’t export: ${err instanceof Error && !('code' in err) ? err.message : cleanFsError(err)}`);
        return false;
      }
    },
    [fs, saveTypes, pickFiles, docName, path, queryClient],
  );

  const save = useCallback((): Promise<boolean> => (path && !error ? writeTo(path) : saveAs()), [path, error, writeTo, saveAs]);

  /** Open a file here if this window holds nothing yet, otherwise in a new window. */
  const openPath = useCallback(
    (target: string) => {
      if (target === path && !error) return;
      if (dirtyRef.current || path) open(appId, { path: target });
      else {
        setLoading(true);
        setError(null);
        load(target);
      }
    },
    [path, error, open, appId, load],
  );

  const browse = useCallback(async () => {
    const target = await pickFile({ title: 'Open', extensions: openExtensions, initialPath: path ? parentPath(path) : undefined });
    if (target) openPath(target);
  }, [pickFile, openExtensions, path, openPath]);

  // Closing with unsaved changes asks first.
  useEffect(() => {
    if (!dirty) return;
    setCloseGuard(windowId, () => {
      focus(windowId);
      setAsking(true);
      return true;
    });
    return () => setCloseGuard(windowId, null);
  }, [dirty, windowId, focus]);

  const closeNow = useCallback(() => {
    setCloseGuard(windowId, null);
    setAsking(false);
    close(windowId);
  }, [windowId, close]);

  const requestClose = useCallback(() => {
    if (dirtyRef.current) setAsking(true);
    else closeNow();
  }, [closeNow]);

  const prompt = asking ? (
    <OfficeDialog
      title={ACCENTS[app].name}
      onCancel={() => setAsking(false)}
      width={420}
      footer={
        <>
          <OfficeButton
            primary
            autoFocus
            disabled={saving}
            onClick={() => {
              setAsking(false);
              void save().then((ok) => ok && closeNow());
            }}
          >
            Save
          </OfficeButton>
          <OfficeButton onClick={closeNow} disabled={saving}>
            Don’t Save
          </OfficeButton>
          <OfficeButton onClick={() => setAsking(false)}>Cancel</OfficeButton>
        </>
      }
    >
      <p className="text-[14px]">Want to save your changes to “{docName}”?</p>
    </OfficeDialog>
  ) : null;

  return {
    fs,
    path,
    name,
    docName,
    dirty,
    setDirty,
    loading,
    error,
    status,
    setStatus,
    saving,
    save,
    saveAs,
    exportCopy,
    openPath,
    browse,
    recent,
    requestClose,
    prompt,
    newWindow: () => open(appId),
  };
}
