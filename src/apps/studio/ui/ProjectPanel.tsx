import { useEffect, useRef, useState } from 'react';
import { Eye, EyeOff, Film, GripVertical, Loader2, MoreHorizontal, Plus, Scissors, Sparkles, StickyNote, X } from 'lucide-react';
import { ContextMenu, ContextMenuContent, ContextMenuTrigger } from '@/components/ui/context-menu';
import { DropdownMenu, DropdownMenuContent, DropdownMenuTrigger } from '@/components/ui/dropdown-menu';
import { Skeleton } from '@/components/ui/skeleton';
import type { ProjectInfo, ProjectItem, TakeInfo } from '@/lib/capture';
import { cn } from '@/lib/utils';
import { formatTime } from '../format';
import { itemActions, projectActions, usedLength, useFileUrl, type ItemAction, type ProjectAction } from '../takes';
import { ActionItems } from './ActionItems';

/** What a take being dragged to a new place carries. */
const TAKE_MIME = 'application/x-din-studio-take';

export function Poster({ take, className }: { take: TakeInfo; className?: string }) {
  const url = useFileUrl(take.poster);
  return (
    <div className={cn('relative grid shrink-0 place-items-center overflow-hidden rounded-md bg-neutral-900', className)}>
      {url ? <img src={url} alt="" className="h-full w-full object-contain" draggable={false} /> : <Film className="size-5 text-white/30" aria-hidden />}
    </div>
  );
}

function status(take: TakeInfo): string | null {
  if (take.status === 'recording') return 'Recording';
  if (take.status === 'finishing') return take.kind === 'clip' ? 'Adding…' : 'Saving…';
  if (take.status === 'interrupted') return 'Cut off';
  if (take.transcript === 'working') return 'Transcribing…';
  return null;
}

export function RenameField({ value: initial, label, onDone, className }: { value: string; label: string; onDone: (title: string | null) => void; className?: string }) {
  const [value, setValue] = useState(initial);
  const ref = useRef<HTMLInputElement>(null);
  const done = useRef(false);
  useEffect(() => {
    ref.current?.focus();
    ref.current?.select();
  }, []);
  const finish = (title: string | null) => {
    if (done.current) return;
    done.current = true;
    onDone(title);
  };
  return (
    <input
      ref={ref}
      value={value}
      aria-label={label}
      onChange={(e) => setValue(e.target.value)}
      onClick={(e) => e.stopPropagation()}
      onKeyDown={(e) => {
        e.stopPropagation();
        if (e.key === 'Enter') finish(value.trim() || null);
        if (e.key === 'Escape') finish(null);
      }}
      onBlur={() => finish(value.trim() || null)}
      className={cn('w-full rounded-sm bg-background px-1 text-sm font-medium outline-none ring-2 ring-ring', className)}
    />
  );
}

function ItemRow({
  item,
  index,
  count,
  selected,
  fresh,
  renaming,
  canTranscribe,
  dropAt,
  onOpen,
  onAction,
  onRenamed,
  onDragOverRow,
}: {
  item: ProjectItem;
  index: number;
  count: number;
  selected: boolean;
  /** Just recorded or added: shown so. */
  fresh: boolean;
  renaming: boolean;
  canTranscribe: boolean;
  /** Where a dragged take would land: above this row, below it, or neither. */
  dropAt: 'before' | 'after' | null;
  onOpen: () => void;
  onAction: (action: ItemAction) => void;
  onRenamed: (title: string | null) => void;
  onDragOverRow: (e: React.DragEvent, index: number) => void;
}) {
  const { take } = item;
  const note = status(take);
  const startsEditing = useRef(false);
  const ref = useRef<HTMLLIElement>(null);
  useEffect(() => {
    if (fresh) ref.current?.scrollIntoView({ block: 'nearest' });
  }, [fresh]);
  const act = (action: ItemAction) => {
    if (action === 'rename') startsEditing.current = true;
    onAction(action);
  };
  const keepFocus = (e: Event) => {
    if (startsEditing.current) e.preventDefault();
    startsEditing.current = false;
  };
  const groups = itemActions(item, { first: index === 0, last: index === count - 1 }, { canTranscribe });
  const trimmed = item.in !== null || item.out !== null;
  const length = usedLength(item);
  return (
    <ContextMenu>
      <ContextMenuTrigger asChild disabled={renaming}>
        <li
          ref={ref}
          className={cn(
            'group relative flex cursor-default items-center gap-2 rounded-lg py-2 pr-2 pl-1 outline-none hover:bg-accent/60 focus-visible:ring-2 focus-visible:ring-ring',
            selected && 'bg-accent',
            fresh && !selected && 'bg-primary/10',
          )}
          // A row Enter opens, which keeps its right-click menu as a list item.
          // eslint-disable-next-line jsx-a11y-x/no-noninteractive-tabindex
          tabIndex={0}
          aria-current={selected || undefined}
          aria-label={`${index + 1}. ${take.title}${item.keep ? '' : ', left out'}`}
          draggable={!renaming}
          onDragStart={(e) => {
            e.dataTransfer.setData(TAKE_MIME, take.name);
            e.dataTransfer.effectAllowed = 'move';
          }}
          onDragOver={(e) => onDragOverRow(e, index)}
          onClick={onOpen}
          onKeyDown={(e) => {
            if (renaming) return;
            if (e.key === 'Enter') onOpen();
            else if (e.altKey && e.key === 'ArrowUp' && index > 0) {
              e.preventDefault();
              onAction('up');
            } else if (e.altKey && e.key === 'ArrowDown' && index < count - 1) {
              e.preventDefault();
              onAction('down');
            }
          }}
        >
          {dropAt && <span aria-hidden className={cn('pointer-events-none absolute inset-x-2 h-0.5 rounded-full bg-primary', dropAt === 'before' ? '-top-px' : '-bottom-px')} />}
          <GripVertical className="size-4 shrink-0 cursor-grab text-muted-foreground/50 opacity-0 group-hover:opacity-100" aria-hidden />
          <div className={cn('relative', !item.keep && 'opacity-40')}>
            <Poster take={take} className="aspect-video w-20" />
            <span className="absolute top-1 left-1 grid min-w-5 place-items-center rounded bg-black/70 px-1 text-[11px] font-semibold text-white tabular-nums">{index + 1}</span>
          </div>
          <div className={cn('min-w-0 flex-1', !item.keep && 'text-muted-foreground')}>
            {renaming ? <RenameField value={take.title} label="Take name" onDone={onRenamed} /> : <p className={cn('truncate text-sm font-medium', !item.keep && 'line-through')}>{take.title}</p>}
            <p className="flex items-center gap-1 truncate text-xs text-muted-foreground">
              {take.kind === 'clip' && <span className="rounded bg-muted px-1 font-medium">Clip</span>}
              {length > 0 && <span className="tabular-nums">{formatTime(length * 1000)}</span>}
              {trimmed && <Scissors className="size-3" aria-label="Trimmed" />}
              {item.note && <StickyNote className="size-3" aria-label="Has a note" />}
              {!item.keep && <span>Left out</span>}
            </p>
            {note && (
              <p className="mt-0.5 flex items-center gap-1 text-xs text-muted-foreground">
                {(take.status === 'finishing' || take.transcript === 'working') && <Loader2 className="size-3 animate-spin" aria-hidden />}
                {note}
              </p>
            )}
          </div>
          <button
            type="button"
            aria-label={item.keep ? `Leave ${take.title} out of the edit` : `Use ${take.title} in the edit`}
            aria-pressed={!item.keep}
            title={item.keep ? 'Leave out of the edit' : 'Use in the edit'}
            onClick={(e) => {
              e.stopPropagation();
              onAction('keep');
            }}
            className={cn(
              'grid size-7 shrink-0 place-items-center rounded-md text-muted-foreground outline-none hover:bg-background hover:text-foreground focus-visible:opacity-100 focus-visible:ring-2 focus-visible:ring-ring',
              item.keep ? 'opacity-0 group-hover:opacity-100' : 'opacity-100',
            )}
          >
            {item.keep ? <Eye className="size-4" /> : <EyeOff className="size-4" />}
          </button>
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <button
                type="button"
                aria-label={`More for ${take.title}`}
                onClick={(e) => e.stopPropagation()}
                className="grid size-7 shrink-0 place-items-center rounded-md text-muted-foreground opacity-0 outline-none group-hover:opacity-100 hover:bg-background hover:text-foreground focus-visible:opacity-100 focus-visible:ring-2 focus-visible:ring-ring data-[state=open]:opacity-100"
              >
                <MoreHorizontal className="size-4" />
              </button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="w-56" onCloseAutoFocus={keepFocus}>
              <ActionItems groups={groups} kind="dropdown" onAction={act} />
            </DropdownMenuContent>
          </DropdownMenu>
        </li>
      </ContextMenuTrigger>
      <ContextMenuContent className="w-56" onCloseAutoFocus={keepFocus}>
        <ActionItems groups={groups} kind="context" onAction={act} />
      </ContextMenuContent>
    </ContextMenu>
  );
}

/** Handles for what was dropped, of the files a drop carries. */
async function droppedFiles(e: React.DragEvent): Promise<FileSystemFileHandle[]> {
  const pending: Promise<FileSystemHandle | null>[] = [];
  for (const item of e.dataTransfer.items) {
    if (item.kind !== 'file') continue;
    const get = (item as DataTransferItem & { getAsFileSystemHandle?: () => Promise<FileSystemHandle | null> }).getAsFileSystemHandle;
    if (get) pending.push(get.call(item));
  }
  const handles = await Promise.all(pending);
  return handles.filter((h): h is FileSystemFileHandle => h?.kind === 'file');
}

/**
 * The project being worked on, beside the stage: its takes and clips in the
 * order they go, each to watch, leave out, move, trim and note, and what
 * goes to the Assistant.
 */
export function ProjectPanel({
  project,
  loading,
  selected,
  fresh,
  renaming,
  renamingProject,
  options,
  importing,
  onOpen,
  onItemAction,
  onRenamed,
  onProjectAction,
  onProjectRenamed,
  onMove,
  onImport,
  onPickClips,
  onNewProject,
  onMake,
  onClose,
}: {
  project: ProjectInfo | null;
  loading: boolean;
  /** The take open in the main area. */
  selected: string | null;
  fresh: string | null;
  renaming: string | null;
  renamingProject: boolean;
  options: { canTranscribe: boolean; canAssist: boolean; recording: boolean };
  /** Clips being added, by name. */
  importing: string[];
  onOpen: (item: ProjectItem) => void;
  onItemAction: (item: ProjectItem, action: ItemAction) => void;
  onRenamed: (item: ProjectItem, title: string | null) => void;
  onProjectAction: (action: ProjectAction) => void;
  onProjectRenamed: (title: string | null) => void;
  /** Put a take at a new place in the order. */
  onMove: (name: string, to: number) => void;
  onImport: (files: FileSystemFileHandle[]) => void;
  onPickClips: () => void;
  onNewProject: () => void;
  onMake: () => void;
  onClose: () => void;
}) {
  const [drop, setDrop] = useState<{ index: number; at: 'before' | 'after' } | null>(null);
  const [filesOver, setFilesOver] = useState(false);
  const startsEditing = useRef(false);
  const items = project?.items ?? [];
  const kept = items.filter((i) => i.keep);
  const total = kept.reduce((sum, i) => sum + usedLength(i), 0);
  const groups = project ? projectActions(project, options) : [];
  const keepFocus = (e: Event) => {
    if (startsEditing.current) e.preventDefault();
    startsEditing.current = false;
  };
  const projectAct = (action: ProjectAction) => {
    if (action === 'rename') startsEditing.current = true;
    onProjectAction(action);
  };

  const overRow = (e: React.DragEvent, index: number) => {
    if (!e.dataTransfer.types.includes(TAKE_MIME)) return;
    e.preventDefault();
    e.stopPropagation();
    e.dataTransfer.dropEffect = 'move';
    const rect = e.currentTarget.getBoundingClientRect();
    const at = e.clientY < rect.top + rect.height / 2 ? 'before' : 'after';
    setDrop((d) => (d?.index === index && d.at === at ? d : { index, at }));
  };

  const dropped = (e: React.DragEvent) => {
    setFilesOver(false);
    const name = e.dataTransfer.getData(TAKE_MIME);
    if (name) {
      e.preventDefault();
      const target = drop;
      setDrop(null);
      if (!target) return;
      const from = items.findIndex((i) => i.take.name === name);
      let to = target.index + (target.at === 'after' ? 1 : 0);
      if (from !== -1 && from < to) to -= 1;
      if (from !== to) onMove(name, to);
      return;
    }
    if (project && e.dataTransfer.types.includes('Files')) {
      e.preventDefault();
      void droppedFiles(e).then((files) => files.length && onImport(files));
    }
  };

  return (
    <aside
      aria-label="Project"
      className={cn('relative flex w-80 shrink-0 flex-col border-l border-border/60 bg-background', filesOver && 'ring-2 ring-inset ring-primary')}
      onDragOver={(e) => {
        if (project && !e.dataTransfer.types.includes(TAKE_MIME) && e.dataTransfer.types.includes('Files')) {
          e.preventDefault();
          e.dataTransfer.dropEffect = 'copy';
          setFilesOver(true);
        }
      }}
      onDragLeave={(e) => {
        if (!e.currentTarget.contains(e.relatedTarget as Node | null)) {
          setFilesOver(false);
          setDrop(null);
        }
      }}
      onDrop={dropped}
      onDragEnd={() => setDrop(null)}
    >
      <ContextMenu>
        <ContextMenuTrigger asChild disabled={!project || renamingProject}>
          <div className="flex h-12 shrink-0 items-center gap-1 pr-2 pl-4">
            <div className="min-w-0 flex-1">
              {project && renamingProject ? (
                <RenameField value={project.title} label="Project name" onDone={onProjectRenamed} />
              ) : (
                <h2 className="truncate text-sm font-semibold" title={project?.title}>{project?.title ?? 'New Project'}</h2>
              )}
            </div>
            {project && (
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <button type="button" aria-label={`More for ${project.title}`} className="grid size-7 shrink-0 place-items-center rounded-md text-muted-foreground outline-none hover:bg-accent hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring">
                    <MoreHorizontal className="size-4" />
                  </button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end" className="w-56" onCloseAutoFocus={keepFocus}>
                  <ActionItems groups={groups} kind="dropdown" onAction={projectAct} />
                </DropdownMenuContent>
              </DropdownMenu>
            )}
            <button type="button" onClick={onClose} aria-label="Hide the project" className="grid size-7 shrink-0 place-items-center rounded-md text-muted-foreground outline-none hover:bg-accent hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring">
              <X className="size-4" />
            </button>
          </div>
        </ContextMenuTrigger>
        <ContextMenuContent className="w-56" onCloseAutoFocus={keepFocus}>
          <ActionItems groups={groups} kind="context" onAction={projectAct} />
        </ContextMenuContent>
      </ContextMenu>

      <div className="min-h-0 flex-1 overflow-y-auto px-2 pb-2">
        {loading ? (
          <ul className="flex flex-col gap-1" aria-label="Loading the project">
            {[0, 1, 2].map((i) => (
              <li key={i} className="flex items-center gap-3 p-2">
                <Skeleton className="aspect-video w-20 rounded-md" />
                <div className="flex-1 space-y-1.5">
                  <Skeleton className="h-4 w-24" />
                  <Skeleton className="h-3 w-16" />
                </div>
              </li>
            ))}
          </ul>
        ) : !project ? (
          <div className="m-2 rounded-xl border border-dashed px-6 py-10 text-center">
            <p className="text-sm text-muted-foreground">
              Record as many takes as you like: each one lands here, in order. Leave out the ones that didn’t work, add clips you already have, then have the Assistant make one video from them.
            </p>
            <button type="button" onClick={onNewProject} className="mt-4 inline-flex h-8 items-center gap-1.5 rounded-md border px-3 text-sm outline-none hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring">
              <Plus className="size-4" aria-hidden />
              New Project
            </button>
          </div>
        ) : items.length === 0 && importing.length === 0 ? (
          <div className="m-2 rounded-xl border border-dashed px-6 py-10 text-center">
            <p className="text-sm text-muted-foreground">Nothing here yet. Press Record for your first take, or drop video files here to add them as clips.</p>
          </div>
        ) : (
          <ol className="flex flex-col gap-0.5" aria-label={`${project.title}: takes and clips, in order`}>
            {items.map((item, index) => (
              <ItemRow
                key={item.take.path}
                item={item}
                index={index}
                count={items.length}
                selected={item.take.path === selected}
                fresh={item.take.path === fresh}
                renaming={item.take.path === renaming}
                canTranscribe={options.canTranscribe}
                dropAt={drop?.index === index ? drop.at : null}
                onOpen={() => onOpen(item)}
                onAction={(action) => onItemAction(item, action)}
                onRenamed={(title) => onRenamed(item, title)}
                onDragOverRow={overRow}
              />
            ))}
            {importing.map((name, i) => (
              <li key={`${name}:${i}`} className="flex items-center gap-3 rounded-lg p-2 text-sm text-muted-foreground">
                <Loader2 className="size-4 animate-spin" aria-hidden />
                <span className="truncate">Adding {name}…</span>
              </li>
            ))}
          </ol>
        )}
      </div>

      {project && (
        <div className="shrink-0 space-y-2 border-t border-border/60 p-3">
          <div className="flex items-center justify-between gap-2 text-xs text-muted-foreground">
            <span>
              {items.length === 0 ? 'No takes yet' : `${kept.length} of ${items.length} in the edit`}
              {total > 0 && ` · ${formatTime(total * 1000)}`}
            </span>
            <button type="button" onClick={onPickClips} className="inline-flex h-7 items-center gap-1 rounded-md px-2 font-medium text-foreground outline-none hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring">
              <Plus className="size-3.5" aria-hidden />
              Add Clips
            </button>
          </div>
          <button
            type="button"
            onClick={onMake}
            disabled={!groups[0]?.[0]?.enabled}
            className="flex h-9 w-full items-center justify-center gap-2 rounded-lg bg-primary text-sm font-medium text-primary-foreground outline-none transition-opacity hover:bg-primary/90 focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:opacity-40"
          >
            <Sparkles className="size-4" aria-hidden />
            Make with Assistant
          </button>
        </div>
      )}
    </aside>
  );
}
