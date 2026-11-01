import { useCallback, useEffect, useState } from 'react';
import { FolderOpen, Pencil, Play, RefreshCw, Sparkles, Trash2, type LucideIcon } from 'lucide-react';
import type { CaptureBridge, TakeInfo } from '@/lib/capture';
import { useDin } from '@/sdk/react';

/** The takes, newest first, kept current as Studio records and main finishes them. */
export function useTakes(capture: CaptureBridge | undefined): {
  takes: TakeInfo[];
  loading: boolean;
  forget: (path: string) => void;
  refresh: (path: string) => void;
} {
  const [takes, setTakes] = useState<TakeInfo[]>([]);
  const [loading, setLoading] = useState(() => capture !== undefined);

  const put = useCallback((take: TakeInfo | { path: string; removed: true }) => {
    setTakes((list) => {
      const rest = list.filter((t) => t.path !== take.path);
      if ('removed' in take) return rest;
      return [take, ...rest].sort((a, b) => b.created.localeCompare(a.created));
    });
  }, []);

  useEffect(() => {
    if (!capture) return;
    let live = true;
    capture.takes().then(
      (list) => {
        if (!live) return;
        setTakes(list);
        setLoading(false);
      },
      () => live && setLoading(false),
    );
    const off = capture.onChanged(put);
    return () => {
      live = false;
      off();
    };
  }, [capture, put]);

  const forget = useCallback((path: string) => setTakes((list) => list.filter((t) => t.path !== path)), []);
  const refresh = useCallback(
    (path: string) => {
      void capture?.take(path).then((take) => put(take ?? { path, removed: true }), () => {});
    },
    [capture, put],
  );
  return { takes, loading, forget, refresh };
}

const urls = new Map<string, Promise<string>>();

/** A URL to load one of Studio's files from (a take's video, its poster), or null until it's ready. */
export function useFileUrl(path: string | null): string | null {
  const din = useDin();
  const [url, setUrl] = useState<{ path: string; url: string } | null>(null);
  useEffect(() => {
    if (!path) return;
    let live = true;
    let pending = urls.get(path);
    if (!pending) {
      pending = din.files.fromPath(path).then((handle) => handle.url());
      urls.set(path, pending);
      pending.catch(() => urls.delete(path));
    }
    pending.then((u) => live && setUrl({ path, url: u }), () => {});
    return () => {
      live = false;
    };
  }, [din, path]);
  return path && url?.path === path ? url.url : null;
}

/** A file changed under the same path (a transcript rewritten, a poster saved): load it afresh. */
export function forgetFileUrl(path: string): void {
  urls.delete(path);
}

export type TakeAction = 'open' | 'assistant' | 'reveal' | 'rename' | 'transcribe' | 'trash';

interface ActionInfo {
  id: TakeAction;
  label: string;
  icon: LucideIcon;
  enabled: boolean;
  destructive?: boolean;
}

/** A take's actions, in groups, for its ⋯ menu and its right-click menu alike. */
export function takeActions(take: TakeInfo, options: { canTranscribe: boolean; canAssist: boolean }): ActionInfo[][] {
  const finished = take.status === 'ready' || take.status === 'interrupted';
  return [
    [
      { id: 'open', label: 'Open', icon: Play, enabled: true },
      { id: 'assistant', label: 'Make with Assistant…', icon: Sparkles, enabled: finished && options.canAssist },
    ],
    [
      { id: 'reveal', label: 'Show in Files', icon: FolderOpen, enabled: true },
      { id: 'rename', label: 'Rename', icon: Pencil, enabled: true },
      { id: 'transcribe', label: 'Transcribe Again', icon: RefreshCw, enabled: finished && options.canTranscribe && take.transcript !== 'working' },
    ],
    [{ id: 'trash', label: 'Move to Trash', icon: Trash2, enabled: take.status !== 'recording', destructive: true }],
  ];
}
