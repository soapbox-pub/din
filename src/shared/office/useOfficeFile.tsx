import { useCallback, useEffect, useRef, useState } from 'react';
import { typesFromFilters, type Din } from '@/sdk';
import { useCloseGuard, useDin, useWindowTitle } from '@/sdk/react';
import type { FileFilter } from '@/lib/fileFilters';
import { ACCENTS, type OfficeApp } from './accent';
import { OfficeButton, OfficeDialog, type RecentFile } from './chrome';
import { fileTypes, pickFiles, pickSaveFile, windowLaunchFile, writeFile } from '@/shared/fileHandles';
import { forgetHandle, loadHandle, storeHandle } from '@/shared/handleStore';
import { appLink } from '@/shared/launch';

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

const errorText = (err: unknown) => (err instanceof Error ? err.message : String(err));

const untitledCounters: Partial<Record<OfficeApp, number>> = {};

function recentKey(app: OfficeApp) {
  return `din:office:recent:${app}`;
}

/**
 * Files opened or saved lately, newest first. Each keeps its grant with a
 * `persist()` token, released when the entry leaves the list.
 */
export function readRecent(app: OfficeApp): RecentFile[] {
  try {
    const v: unknown = JSON.parse(localStorage.getItem(recentKey(app)) ?? '[]');
    return Array.isArray(v)
      ? v
          .filter((r): r is RecentFile => typeof r?.token === 'string' && typeof r?.key === 'string' && typeof r?.name === 'string' && typeof r?.time === 'number')
          .map((r) => ({ token: r.token, key: r.key, name: r.name, path: typeof r.path === 'string' ? r.path : '', time: r.time }))
      : [];
  } catch {
    return [];
  }
}

async function addRecent(din: Din, app: OfficeApp, handle: FileSystemFileHandle): Promise<RecentFile[]> {
  const path = din.files.path(handle);
  const token = readRecent(app).find((r) => r.path === path)?.token ?? (await storeHandle(handle));
  // Read again after the await: another window may have changed the list meanwhile.
  const list = readRecent(app);
  const entry = { token, key: path, name: handle.name, path, time: Date.now() };
  const all = [entry, ...list.filter((r) => r.path !== path)];
  const next = all.slice(0, RECENT_MAX);
  localStorage.setItem(recentKey(app), JSON.stringify(next));
  for (const r of all.slice(RECENT_MAX)) forgetHandle(r.token);
  return next;
}

const RECENT_CHANGED = 'din:office:recent';

export function removeRecent(din: Din, app: OfficeApp, key: string) {
  const list = readRecent(app);
  localStorage.setItem(recentKey(app), JSON.stringify(list.filter((r) => r.key !== key)));
  for (const r of list) if (r.key === key) forgetHandle(r.token);
  window.dispatchEvent(new CustomEvent(RECENT_CHANGED, { detail: app }));
}

/** The folder a path is in, as the Recent list and Backstage show it. */
export const folderOf = (path: string) => path.slice(0, path.lastIndexOf('/')) || '/';

export interface OfficeFileOptions {
  app: OfficeApp;
  /** "Document", "Book", "Presentation": new files are Document1, Document2... */
  untitled: string;
  openExtensions: string[];
  /** Save As choices; the first is the app's own format. */
  saveTypes: FileFilter[];
  /** Read a file's bytes into the app. Throw (with a message for people) if it can't be. */
  onLoad: (bytes: Uint8Array, name: string) => Promise<void> | void;
  /** The bytes to write for a file name; its extension says which format. */
  onSave: (name: string) => Promise<Uint8Array> | Uint8Array;
}

/**
 * A document window's file: which file it is, whether it has unsaved
 * changes, Open / Save / Save As through Din's file picker, the recent
 * files list, and asking before closing over unsaved work, Office's way.
 * The window opens the file it was launched with, if any.
 */
export function useOfficeFile(opts: OfficeFileOptions) {
  const { app, untitled, openExtensions, saveTypes } = opts;
  const din = useDin();
  const optsRef = useRef(opts);
  useEffect(() => {
    optsRef.current = opts;
  });

  const [initialFile] = useState<FileSystemFileHandle | null>(() => windowLaunchFile());
  const [untitledName] = useState(() => {
    const n = (untitledCounters[app] ?? 0) + 1;
    untitledCounters[app] = n;
    return `${untitled}${n}`;
  });
  const [handle, setHandle] = useState<FileSystemFileHandle | null>(null);
  const [dirty, setDirtyState] = useState(false);
  const [loading, setLoading] = useState(initialFile !== null);
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
    // The app's other windows are documents of their own: they change the list through storage.
    const onStorage = (e: StorageEvent) => {
      if (e.key === recentKey(app)) setRecent(readRecent(app));
    };
    window.addEventListener(RECENT_CHANGED, onChange);
    window.addEventListener('storage', onStorage);
    return () => {
      window.removeEventListener(RECENT_CHANGED, onChange);
      window.removeEventListener('storage', onStorage);
    };
  }, [app]);

  const remember = useCallback(
    (target: FileSystemFileHandle) => {
      addRecent(din, app, target).then(setRecent, () => {});
    },
    [din, app],
  );

  const name = handle ? handle.name : untitledName;
  const docName = handle ? stem(handle.name) : untitledName;
  useWindowTitle(`${dirty ? '• ' : ''}${name}`);

  const setDirty = useCallback((v: boolean) => {
    dirtyRef.current = v;
    setDirtyState(v);
  }, []);

  const load = useCallback(
    (target: FileSystemFileHandle) => {
      const seq = ++loadSeq.current;
      target
        .getFile()
        .then(async (blob) => {
          if (blob.size > MAX_BYTES) throw new Error('It’s too big to open (over 512 MB).');
          const bytes = new Uint8Array(await blob.arrayBuffer());
          if (seq !== loadSeq.current) return;
          await optsRef.current.onLoad(bytes, target.name);
          if (seq !== loadSeq.current) return;
          setHandle(target);
          setError(null);
          setDirty(false);
          setStatus(null);
          remember(target);
          setLoading(false);
        })
        .catch((err: unknown) => {
          if (seq !== loadSeq.current) return;
          setHandle(target);
          setError(errorText(err));
          setLoading(false);
        });
    },
    [remember, setDirty],
  );

  useEffect(() => {
    if (initialFile) load(initialFile);
  }, [initialFile, load]);

  const writeTo = useCallback(
    async (target: FileSystemFileHandle): Promise<boolean> => {
      setSaving(true);
      setStatus('Saving…');
      try {
        const bytes = await optsRef.current.onSave(target.name);
        await writeFile(target, bytes);
        setHandle(target);
        setDirty(false);
        setError(null);
        setStatus('Saved');
        remember(target);
        return true;
      } catch (err) {
        setStatus(`Couldn’t save: ${errorText(err)}`);
        return false;
      } finally {
        setSaving(false);
      }
    },
    [remember, setDirty],
  );

  const saveAs = useCallback(
    async (filterIndex = 0): Promise<boolean> => {
      const filter = saveTypes[filterIndex] ?? saveTypes[0];
      const target = await pickSaveFile({
        title: filterIndex === 0 ? 'Save As' : `Export as ${filter.name}`,
        suggestedName: `${docName}${filter.patterns[0].slice(1)}`,
        startIn: handle ?? undefined,
        types: typesFromFilters(filterIndex === 0 ? saveTypes : [filter]),
      });
      return target ? writeTo(target) : false;
    },
    [saveTypes, docName, handle, writeTo],
  );

  /** Export writes a copy without making it this window's file. */
  const exportCopy = useCallback(
    async (filterIndex: number): Promise<boolean> => {
      const filter = saveTypes[filterIndex];
      const target = await pickSaveFile({
        title: `Export as ${filter.name}`,
        suggestedName: `${docName}${filter.patterns[0].slice(1)}`,
        startIn: handle ?? undefined,
        types: typesFromFilters([filter]),
      });
      if (!target) return false;
      try {
        const bytes = await optsRef.current.onSave(target.name);
        await writeFile(target, bytes);
        setStatus(`Exported ${target.name}`);
        return true;
      } catch (err) {
        setStatus(`Couldn’t export: ${errorText(err)}`);
        return false;
      }
    },
    [saveTypes, docName, handle],
  );

  const save = useCallback((): Promise<boolean> => (handle && !error ? writeTo(handle) : saveAs()), [handle, error, writeTo, saveAs]);

  /** Open a file here if this window holds nothing yet, otherwise in a new window. */
  const openFile = useCallback(
    (target: FileSystemFileHandle) => {
      if (handle && din.files.path(target) === din.files.path(handle) && !error) return;
      if (dirtyRef.current || handle) void din.app.launch(appLink(null), [target]);
      else {
        setLoading(true);
        setError(null);
        load(target);
      }
    },
    [din, handle, error, load],
  );

  /** A Recent entry's file, or null (and the entry gone from the list) if it can't be found. */
  const restoreRecent = useCallback(
    async (entry: RecentFile): Promise<FileSystemFileHandle | null> => {
      const restored = await loadHandle(entry.token).catch(() => null);
      const target = restored?.kind === 'file' ? (restored as FileSystemFileHandle) : null;
      if (!target) {
        removeRecent(din, app, entry.key);
        setStatus(`Couldn’t find ${entry.name}. It may have been moved or deleted.`);
      }
      return target;
    },
    [din, app],
  );

  const openRecent = useCallback(
    async (entry: RecentFile) => {
      const target = await restoreRecent(entry);
      if (target) openFile(target);
    },
    [restoreRecent, openFile],
  );

  /** Files, opened on the entry's folder with the file selected. */
  const showRecentInFiles = useCallback(
    async (entry: RecentFile) => {
      const target = await restoreRecent(entry);
      if (target) void din.app.launch(appLink('file-browser'), [target]);
    },
    [din, restoreRecent],
  );

  const browse = useCallback(async () => {
    const [target] = await pickFiles({
      title: 'Open',
      types: fileTypes([{ description: ACCENTS[app].files, extensions: openExtensions.map((e) => (e.startsWith('.') ? e : `.${e}`)) }]),
      startIn: handle ?? undefined,
    });
    if (target) openFile(target);
  }, [app, openExtensions, handle, openFile]);

  /** A file picked to put into the document (a picture), read whole. */
  const pickInsert = useCallback(
    async (title: string, extensions: string[]): Promise<{ bytes: Uint8Array; name: string } | null> => {
      const [target] = await pickFiles({
        title,
        types: fileTypes([{ description: 'Pictures', extensions: extensions.map((e) => (e.startsWith('.') ? e : `.${e}`)) }]),
        mode: 'read',
      });
      if (!target) return null;
      const blob = await target.getFile();
      if (blob.size > 64 * 1024 * 1024) throw new Error(`${target.name} is too big to insert (over 64 MB).`);
      return { bytes: new Uint8Array(await blob.arrayBuffer()), name: target.name };
    },
    [],
  );

  // Closing with unsaved changes asks first.
  useCloseGuard(
    dirty
      ? () => {
          window.focus();
          setAsking(true);
          return true;
        }
      : null,
  );

  const closeNow = useCallback(() => {
    setAsking(false);
    window.close();
  }, []);

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
    handle,
    /** Where the file is, to show; null until it is saved. */
    path: handle ? din.files.path(handle) : null,
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
    openFile,
    openRecent,
    showRecentInFiles,
    browse,
    pickInsert,
    recent,
    requestClose,
    prompt,
    newWindow: () => void window.open(appLink(null)),
  };
}
