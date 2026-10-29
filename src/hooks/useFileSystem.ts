import { useEffect } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { QueryClient } from '@tanstack/react-query';
import { getFsBridge, joinPath, parentPath } from '@/lib/fs';
import type { FsDetails, FsDiskUsage, FsEntry, FsListing, FsReadResult, FsRecentFile } from '@/lib/fs';
import { readPickedFiles } from '@/lib/pickedFiles';

/**
 * TanStack Query hooks over the OS filesystem bridge (window.dinos.fs).
 *
 * Listings are cached per path so revisiting a directory is instant, while a
 * short staleTime keeps contents reasonably fresh; the Files app also exposes
 * an explicit refresh (via `refetch`). Write operations invalidate the cached
 * listings they affect so open Files windows converge on the new state.
 */

function requireBridge() {
  const fs = getFsBridge();
  if (!fs) throw new Error('Filesystem bridge unavailable');
  return fs;
}

/** The shell user's home directory (undefined while loading / no bridge). */
export function useHomeDir() {
  const fs = getFsBridge();
  return useQuery({
    queryKey: ['fs', 'homedir'],
    queryFn: () => requireBridge().homedir(),
    enabled: fs !== undefined,
    staleTime: Infinity,
  });
}

/** Directory listing for an absolute path. */
export function useDirectory(path: string | null) {
  const fs = getFsBridge();
  return useQuery<FsListing>({
    queryKey: ['fs', 'readdir', path],
    queryFn: () => {
      if (!path) throw new Error('No path');
      return requireBridge().readdir(path);
    },
    enabled: fs !== undefined && path !== null,
    staleTime: 5_000,
    retry: false,
  });
}

/** The file picker's Recent list: latest made, changed, or opened files. */
export function useRecentFiles(enabled: boolean) {
  const fs = getFsBridge();
  return useQuery<FsRecentFile[]>({
    queryKey: ['fs', 'recent'],
    queryFn: () => requireBridge().recent(readPickedFiles()),
    enabled: fs !== undefined && enabled,
    staleTime: 5_000,
    retry: false,
  });
}

/** Files a search found, at most, when it searched their contents. */
const MAX_CONTENT_RESULTS = 1_000;

/**
 * Everything beneath `root` matching `query`: by name, or with `contents`,
 * the files whose text contains it. Entries are named by their path
 * relative to `root`.
 */
export function useFindFiles(
  root: string | null,
  query: string,
  options: { hidden: boolean; contents: boolean },
  enabled: boolean,
) {
  const fs = getFsBridge();
  const { hidden, contents } = options;
  return useQuery<{ entries: FsEntry[]; truncated: boolean }>({
    queryKey: ['fs', 'find', root, query, hidden, contents],
    queryFn: async () => {
      if (!root) throw new Error('No path');
      const bridge = requireBridge();
      if (!contents) return bridge.find(root, query, { hidden });
      const result = await bridge.search(root, {
        query, regex: false, caseSensitive: false, wholeWord: false, include: '', exclude: '',
      });
      const files = result.files
        .filter((f) => hidden || !f.path.split('/').some((part) => part.startsWith('.')))
        .slice(0, MAX_CONTENT_RESULTS);
      const entries = await Promise.all(files.map(async ({ path }): Promise<FsEntry> => {
        try {
          const stat = await bridge.stat(joinPath(root, path));
          return { name: path, kind: stat.kind, symlink: false, size: stat.size, mtimeMs: stat.mtimeMs };
        } catch {
          return { name: path, kind: 'file', symlink: false, size: null, mtimeMs: null };
        }
      }));
      return { entries, truncated: result.truncated || result.files.length > MAX_CONTENT_RESULTS };
    },
    enabled: fs !== undefined && root !== null && query !== '' && enabled,
    // While the next search runs, the last one's results stand in (from the same folder, the same way).
    placeholderData: (previous, previousQuery) => {
      const [, , lastRoot, , lastHidden, lastContents] = previousQuery?.queryKey ?? [];
      return lastRoot === root && lastHidden === hidden && lastContents === contents ? previous : undefined;
    },
    staleTime: 5_000,
    retry: false,
  });
}

/** Read (a capped prefix of) a regular file, e.g. for previews. */
export function useFileContent(path: string | null, maxBytes?: number) {
  const fs = getFsBridge();
  return useQuery<FsReadResult>({
    queryKey: ['fs', 'readFile', path, maxBytes ?? null],
    queryFn: () => {
      if (!path) throw new Error('No path');
      return requireBridge().readFile(path, maxBytes);
    },
    enabled: fs !== undefined && path !== null,
    staleTime: 5_000,
    retry: false,
  });
}

/**
 * Write operations on the filesystem. Each mutation invalidates only the
 * cached listings a change can actually affect: the parent directory (its
 * children changed) plus the changed path and anything beneath it (renamed or
 * deleted directories another window may be viewing). Blanket-invalidating
 * every `['fs', 'readdir']` query made each rename/delete refetch and re-stat
 * every open directory - thousands of stat calls when a large directory like
 * ~/Downloads was open anywhere.
 */
export function invalidateListings(queryClient: QueryClient, ...paths: string[]) {
  const affected = paths.flatMap((p) => [p, parentPath(p)]);
  return queryClient.invalidateQueries({
    predicate: (query) => {
      const [scope, op, dir] = query.queryKey;
      if (scope !== 'fs' || typeof dir !== 'string') return false;
      // A search beneath a folder covers whatever changes inside it.
      if (op === 'find') return affected.some((p) => p === dir || p.startsWith(dir === '/' ? '/' : `${dir}/`));
      if (op !== 'readdir' && op !== 'details') return false;
      return affected.some(
        (p) => dir === p || dir.startsWith(p === '/' ? '/' : `${p}/`),
      );
    },
  });
}

export function useFsMutations() {
  const queryClient = useQueryClient();
  const invalidate = (...paths: string[]) => invalidateListings(queryClient, ...paths);

  const mkdir = useMutation({
    mutationFn: (path: string) => requireBridge().mkdir(path),
    onSuccess: (_data, path) => invalidate(path),
  });

  const rename = useMutation({
    mutationFn: ({ from, to }: { from: string; to: string }) =>
      requireBridge().rename(from, to),
    onSuccess: (_data, { from, to }) => invalidate(from, to),
  });

  const rm = useMutation({
    mutationFn: ({ path, recursive }: { path: string; recursive?: boolean }) =>
      requireBridge().rm(path, { recursive }),
    onSuccess: (_data, { path }) => invalidate(path),
  });

  return { mkdir, rename, rm };
}

/**
 * Refetch a folder's listing whenever it changes on disk (a terminal, a
 * download, another app), for as long as the caller shows it.
 */
export function useWatchDirectory(path: string | null) {
  const queryClient = useQueryClient();
  useEffect(() => {
    const fs = getFsBridge();
    if (!fs || !path) return;
    let id: number | null = null;
    let cancelled = false;
    void fs.watch(path).then((watchId) => {
      if (cancelled && watchId !== null) void fs.unwatch(watchId);
      else id = watchId;
    }).catch(() => {});
    const off = fs.onChange((changed) => {
      if (changed !== path) return;
      void queryClient.invalidateQueries({ queryKey: ['fs', 'readdir', path] });
    });
    return () => {
      cancelled = true;
      off();
      if (id !== null) void fs.unwatch(id);
    };
  }, [path, queryClient]);
}

/** Properties of a path (ownership, permissions, times, free space). */
export function useFsDetails(path: string | null) {
  const fs = getFsBridge();
  return useQuery<FsDetails>({
    queryKey: ['fs', 'details', path],
    queryFn: () => {
      if (!path) throw new Error('No path');
      return requireBridge().details(path);
    },
    enabled: fs !== undefined && path !== null,
    staleTime: 10_000,
    retry: false,
  });
}

/** A folder's total size and item counts (can take a while for big trees). */
export function useDiskUsage(path: string | null) {
  const fs = getFsBridge();
  return useQuery<FsDiskUsage>({
    queryKey: ['fs', 'du', path],
    queryFn: () => {
      if (!path) throw new Error('No path');
      return requireBridge().du(path);
    },
    enabled: fs !== undefined && path !== null,
    staleTime: 30_000,
    retry: false,
  });
}

/** The Trash's files folder. */
export function useTrashDir() {
  const fs = getFsBridge();
  return useQuery({
    queryKey: ['fs', 'trashDir'],
    queryFn: () => requireBridge().trashDir(),
    enabled: fs !== undefined,
    staleTime: Infinity,
  });
}

/** One sidebar favorite, from GTK's bookmarks file. */
export interface Bookmark {
  path: string;
  /** Custom label, or null to show the folder's name. */
  label: string | null;
}

/**
 * The bookmarks file GTK apps share (Nautilus's sidebar, every GTK file
 * chooser), so favorites added in Files show up in native Linux apps' file
 * dialogs too, and theirs in Files.
 */
function bookmarksFile(home: string) {
  return joinPath(home, '.config/gtk-3.0/bookmarks');
}

function fileUriToPath(uri: string): string | null {
  if (!uri.startsWith('file://')) return null;
  try {
    return decodeURIComponent(uri.slice('file://'.length)) || '/';
  } catch {
    return null;
  }
}

function pathToFileUri(path: string): string {
  return `file://${path.split('/').map(encodeURIComponent).join('/')}`;
}

/** Parsed bookmarks plus the raw lines Din doesn't show (sftp:// etc.), kept on write. */
interface BookmarksFile {
  bookmarks: Bookmark[];
  lines: string[];
}

async function readBookmarks(home: string): Promise<BookmarksFile> {
  let text = '';
  try {
    const result = await requireBridge().readFile(bookmarksFile(home), 256 * 1024);
    text = new TextDecoder().decode(result.data);
  } catch {
    // No bookmarks yet.
  }
  const lines = text.split('\n').filter((l) => l.trim() !== '');
  const bookmarks: Bookmark[] = [];
  for (const line of lines) {
    const space = line.indexOf(' ');
    const uri = space === -1 ? line : line.slice(0, space);
    const path = fileUriToPath(uri);
    if (path) bookmarks.push({ path, label: space === -1 ? null : line.slice(space + 1) || null });
  }
  return { bookmarks, lines };
}

export function useBookmarks(home: string | undefined) {
  const queryClient = useQueryClient();
  const query = useQuery<BookmarksFile>({
    queryKey: ['fs', 'bookmarks', home],
    queryFn: () => readBookmarks(home!),
    enabled: getFsBridge() !== undefined && home !== undefined,
    staleTime: Infinity,
  });

  const write = useMutation({
    mutationFn: async (update: (file: BookmarksFile) => string[]) => {
      if (!home) throw new Error('No home folder');
      const current = await readBookmarks(home);
      const lines = update(current);
      const fs = requireBridge();
      await fs.mkdir(parentPath(bookmarksFile(home)));
      await fs.writeFile(bookmarksFile(home), lines.length > 0 ? `${lines.join('\n')}\n` : '');
    },
    onSettled: () => queryClient.invalidateQueries({ queryKey: ['fs', 'bookmarks', home] }),
  });

  const lineFor = (b: Bookmark) => (b.label ? `${pathToFileUri(b.path)} ${b.label}` : pathToFileUri(b.path));
  const matches = (line: string, path: string) => fileUriToPath(line.split(' ')[0]) === path;

  return {
    bookmarks: query.data?.bookmarks ?? [],
    add: (path: string) =>
      write.mutate(({ lines }) =>
        lines.some((l) => matches(l, path)) ? lines : [...lines, lineFor({ path, label: null })],
      ),
    remove: (path: string) => write.mutate(({ lines }) => lines.filter((l) => !matches(l, path))),
    rename: (path: string, label: string | null) =>
      write.mutate(({ lines }) =>
        lines.map((l) => (matches(l, path) ? lineFor({ path, label }) : l)),
      ),
    move: (path: string, to: number) =>
      write.mutate(({ lines }) => {
        const from = lines.findIndex((l) => matches(l, path));
        if (from === -1) return lines;
        const next = [...lines];
        const [line] = next.splice(from, 1);
        next.splice(Math.min(to, next.length), 0, line);
        return next;
      }),
  };
}
