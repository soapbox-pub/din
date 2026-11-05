import { useCallback, useEffect, useRef, useState } from 'react';
import type { FsBridge } from '@/lib/fs';
import { CAMERA_FOLDER, cameraItemKind } from '@/shared/cameraEffects';

/** A photo or video in ~/Pictures/Camera. */
export interface CameraItem {
  name: string;
  path: string;
  kind: 'photo' | 'video';
  mtimeMs: number;
}

export interface Library {
  /** The folder, once home is known. */
  dir: string | null;
  /** Oldest first, as the strip shows them. */
  items: CameraItem[];
  loaded: boolean;
  /** Write a file into the folder under a name not taken yet; resolves with it. */
  save(base: string, extension: string, blob: Blob): Promise<CameraItem>;
  trash(item: CameraItem): Promise<void>;
}

const pad = (n: number) => String(n).padStart(2, '0');

/** "Photo 2026-11-05 at 14.27.03": sorts by time, and has no colons. */
export function stampedName(prefix: string, when = new Date()): string {
  const date = `${when.getFullYear()}-${pad(when.getMonth() + 1)}-${pad(when.getDate())}`;
  return `${prefix} ${date} at ${pad(when.getHours())}.${pad(when.getMinutes())}.${pad(when.getSeconds())}`;
}

export function useLibrary(fs: FsBridge | undefined): Library {
  const [dir, setDir] = useState<string | null>(null);
  const [items, setItems] = useState<CameraItem[]>([]);
  const [loaded, setLoaded] = useState(false);
  const itemsRef = useRef(items);
  useEffect(() => {
    itemsRef.current = items;
  }, [items]);

  useEffect(() => {
    if (!fs) return;
    let live = true;
    void fs.homedir().then(async (home) => {
      const path = `${home.replace(/\/$/, '')}/${CAMERA_FOLDER}`;
      await fs.mkdir(path).catch(() => {});
      if (live) setDir(path);
    });
    return () => {
      live = false;
    };
  }, [fs]);

  const refresh = useCallback(async () => {
    if (!fs || !dir) return;
    try {
      const listing = await fs.readdir(dir);
      const found: CameraItem[] = [];
      for (const e of listing.entries) {
        const kind = e.kind === 'file' ? cameraItemKind(e.name) : null;
        if (kind) found.push({ name: e.name, path: `${dir}/${e.name}`, kind, mtimeMs: e.mtimeMs ?? 0 });
      }
      found.sort((a, b) => a.mtimeMs - b.mtimeMs || a.name.localeCompare(b.name));
      setItems(found);
    } catch {
      setItems([]);
    }
    setLoaded(true);
  }, [fs, dir]);

  useEffect(() => {
    if (!fs || !dir) return;
    let watchId: number | null = null;
    let live = true;
    // Listed once it's watched, so nothing made in between is missed.
    void fs
      .watch(dir)
      .catch(() => null)
      .then((id) => {
        if (!live) {
          if (id !== null) void fs.unwatch(id);
          return;
        }
        watchId = id;
        void refresh();
      });
    const off = fs.onChange((changed) => {
      if (changed.replace(/\/$/, '') === dir) void refresh();
    });
    return () => {
      live = false;
      off();
      if (watchId !== null) void fs.unwatch(watchId);
    };
  }, [fs, dir, refresh]);

  const save = useCallback(
    async (base: string, extension: string, blob: Blob): Promise<CameraItem> => {
      if (!fs || !dir) throw new Error('The Camera folder isn’t ready');
      const taken = new Set(itemsRef.current.map((i) => i.name));
      let name = `${base}.${extension}`;
      for (let n = 2; taken.has(name) || (await fs.stat(`${dir}/${name}`).then(() => true, () => false)); n++) name = `${base} (${n}).${extension}`;
      const path = `${dir}/${name}`;
      await fs.writeFile(path, new Uint8Array(await blob.arrayBuffer()));
      const item: CameraItem = { name, path, kind: cameraItemKind(name) ?? 'photo', mtimeMs: Date.now() };
      setItems((list) => (list.some((i) => i.path === path) ? list : [...list, item]));
      return item;
    },
    [fs, dir],
  );

  const trash = useCallback(
    async (item: CameraItem) => {
      if (!fs) return;
      await fs.trash(item.path);
      setItems((list) => list.filter((i) => i.path !== item.path));
    },
    [fs],
  );

  return { dir, items, loaded, save, trash };
}
