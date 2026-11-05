import { useCallback, useEffect, useState } from 'react';
import { ArrowDown, ArrowUp, Eye, EyeOff, FolderOpen, Pencil, Play, Plus, RefreshCw, Sparkles, Trash2, type LucideIcon } from 'lucide-react';
import type { CaptureBridge, ProjectInfo, ProjectItem } from '@/lib/capture';
import { useDin } from '@/sdk/react';

function sorted(list: ProjectInfo[]): ProjectInfo[] {
  return [...list].sort((a, b) => b.updated.localeCompare(a.updated));
}

/** The projects, the one added to last first, kept current as Studio records and main finishes takes. */
export function useProjects(capture: CaptureBridge | undefined): {
  projects: ProjectInfo[];
  loading: boolean;
  /** Put a project as main just gave it. */
  put: (project: ProjectInfo | { path: string; removed: true }) => void;
  refresh: (path: string) => void;
} {
  const [projects, setProjects] = useState<ProjectInfo[]>([]);
  const [loading, setLoading] = useState(() => capture !== undefined);

  const put = useCallback((project: ProjectInfo | { path: string; removed: true }) => {
    setProjects((list) => {
      const rest = list.filter((p) => p.path !== project.path);
      return 'removed' in project ? rest : sorted([project, ...rest]);
    });
  }, []);

  const refresh = useCallback(
    (path: string) => {
      void capture?.project(path).then((p) => put(p ?? { path, removed: true }), () => put({ path, removed: true }));
    },
    [capture, put],
  );

  useEffect(() => {
    if (!capture) return;
    let live = true;
    capture.projects().then(
      (list) => {
        if (!live) return;
        setProjects(sorted(list));
        setLoading(false);
      },
      () => live && setLoading(false),
    );
    const offProject = capture.onProjectChanged(put);
    // A take from before projects is a project of its own.
    const offTake = capture.onChanged((take) => {
      if ('removed' in take || take.project === null) refresh(take.path);
    });
    return () => {
      live = false;
      offProject();
      offTake();
    };
  }, [capture, put, refresh]);

  return { projects, loading, put, refresh };
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
      pending = din.files.fromPath(path).then((handle) => din.files.url(handle as FileSystemFileHandle));
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

/** The part of a take the edit uses, in seconds. */
export function usedLength(item: ProjectItem): number {
  const end = item.out ?? item.take.duration;
  return Math.max(0, end - (item.in ?? 0));
}

export type ItemAction = 'open' | 'keep' | 'up' | 'down' | 'reveal' | 'rename' | 'transcribe' | 'trash';

interface ActionInfo<T extends string> {
  id: T;
  label: string;
  icon: LucideIcon;
  enabled: boolean;
  destructive?: boolean;
}

/** A take's or clip's actions, in groups, for its ⋯ menu and its right-click menu alike. */
export function itemActions(
  item: ProjectItem,
  place: { first: boolean; last: boolean },
  options: { canTranscribe: boolean },
): ActionInfo<ItemAction>[][] {
  const { take } = item;
  const finished = take.status === 'ready' || take.status === 'interrupted';
  return [
    [
      { id: 'open', label: 'Open', icon: Play, enabled: true },
      item.keep
        ? { id: 'keep', label: 'Leave Out of the Edit', icon: EyeOff, enabled: true }
        : { id: 'keep', label: 'Use in the Edit', icon: Eye, enabled: true },
    ],
    [
      { id: 'up', label: 'Move Up', icon: ArrowUp, enabled: !place.first },
      { id: 'down', label: 'Move Down', icon: ArrowDown, enabled: !place.last },
    ],
    [
      { id: 'reveal', label: 'Show in Files', icon: FolderOpen, enabled: true },
      { id: 'rename', label: 'Rename', icon: Pencil, enabled: true },
      { id: 'transcribe', label: 'Transcribe Again', icon: RefreshCw, enabled: finished && options.canTranscribe && take.transcript !== 'working' },
    ],
    [{ id: 'trash', label: 'Move to Trash', icon: Trash2, enabled: take.status !== 'recording' && take.status !== 'finishing', destructive: true }],
  ];
}

export type ProjectAction = 'assistant' | 'import' | 'rename' | 'reveal' | 'trash';

/** A project's actions, for its ⋯ menu and its right-click menu alike. */
export function projectActions(project: ProjectInfo, options: { canAssist: boolean; recording: boolean }): ActionInfo<ProjectAction>[][] {
  const ready = project.items.some((i) => i.keep && (i.take.status === 'ready' || i.take.status === 'interrupted'));
  return [
    [
      { id: 'assistant', label: 'Make with Assistant…', icon: Sparkles, enabled: options.canAssist && ready },
      { id: 'import', label: 'Add Clips…', icon: Plus, enabled: true },
    ],
    [
      { id: 'reveal', label: 'Show in Files', icon: FolderOpen, enabled: true },
      { id: 'rename', label: 'Rename Project', icon: Pencil, enabled: true },
    ],
    [{ id: 'trash', label: 'Move Project to Trash', icon: Trash2, enabled: !options.recording, destructive: true }],
  ];
}
