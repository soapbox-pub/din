import { useEffect, useRef, useState } from 'react';
import { Film, Loader2, MoreHorizontal, X } from 'lucide-react';
import { ContextMenu, ContextMenuContent, ContextMenuTrigger } from '@/components/ui/context-menu';
import { DropdownMenu, DropdownMenuContent, DropdownMenuTrigger } from '@/components/ui/dropdown-menu';
import { Skeleton } from '@/components/ui/skeleton';
import type { TakeInfo } from '@/lib/capture';
import { cn } from '@/lib/utils';
import { formatTime, formatWhen } from '../format';
import { useFileUrl, type TakeAction } from '../takes';
import { TakeActionItems } from './TakeActionItems';

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
  if (take.status === 'finishing') return 'Saving…';
  if (take.status === 'interrupted') return 'Cut off';
  if (take.transcript === 'working') return 'Transcribing…';
  return null;
}

function RenameField({ take, onDone }: { take: TakeInfo; onDone: (title: string | null) => void }) {
  const [value, setValue] = useState(take.title);
  const ref = useRef<HTMLInputElement>(null);
  useEffect(() => {
    ref.current?.focus();
    ref.current?.select();
  }, []);
  return (
    <input
      ref={ref}
      value={value}
      aria-label="Take name"
      onChange={(e) => setValue(e.target.value)}
      onClick={(e) => e.stopPropagation()}
      onKeyDown={(e) => {
        e.stopPropagation();
        if (e.key === 'Enter') onDone(value.trim() || null);
        if (e.key === 'Escape') onDone(null);
      }}
      onBlur={() => onDone(value.trim() || null)}
      className="w-full rounded-sm bg-background px-1 text-sm font-medium outline-none ring-2 ring-ring"
    />
  );
}

function TakeRow({
  take,
  selected,
  renaming,
  options,
  onOpen,
  onAction,
  onRenamed,
}: {
  take: TakeInfo;
  selected: boolean;
  renaming: boolean;
  options: { canTranscribe: boolean; canAssist: boolean };
  onOpen: () => void;
  onAction: (action: TakeAction) => void;
  onRenamed: (title: string | null) => void;
}) {
  const note = status(take);
  const startsEditing = useRef(false);
  const act = (action: TakeAction) => {
    if (action === 'rename') startsEditing.current = true;
    onAction(action);
  };
  const keepFocus = (e: Event) => {
    if (startsEditing.current) e.preventDefault();
    startsEditing.current = false;
  };
  return (
    <ContextMenu>
      <ContextMenuTrigger asChild disabled={renaming}>
        <li
          className={cn(
            'group relative flex cursor-default items-center gap-3 rounded-lg p-2 outline-none hover:bg-accent/60 focus-visible:ring-2 focus-visible:ring-ring',
            selected && 'bg-accent',
          )}
          // A row Enter opens, which keeps its right-click menu as a list item.
          // eslint-disable-next-line jsx-a11y-x/no-noninteractive-tabindex
          tabIndex={0}
          aria-current={selected || undefined}
          onClick={onOpen}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !renaming) onOpen();
          }}
        >
          <Poster take={take} className="aspect-video w-24" />
          <div className="min-w-0 flex-1">
            {renaming ? <RenameField take={take} onDone={onRenamed} /> : <p className="truncate text-sm font-medium">{take.title}</p>}
            <p className="truncate text-xs text-muted-foreground">
              {formatWhen(take.created)}
              {take.duration > 0 && ` · ${formatTime(take.duration * 1000)}`}
            </p>
            {note && (
              <p className="mt-0.5 flex items-center gap-1 text-xs text-muted-foreground">
                {(take.status === 'finishing' || take.transcript === 'working') && <Loader2 className="size-3 animate-spin" aria-hidden />}
                {note}
              </p>
            )}
          </div>
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
              <TakeActionItems take={take} kind="dropdown" options={options} onAction={act} />
            </DropdownMenuContent>
          </DropdownMenu>
        </li>
      </ContextMenuTrigger>
      <ContextMenuContent className="w-56" onCloseAutoFocus={keepFocus}>
        <TakeActionItems take={take} kind="context" options={options} onAction={act} />
      </ContextMenuContent>
    </ContextMenu>
  );
}

/** The takes so far, beside the stage. */
export function TakesList({
  takes,
  loading,
  selected,
  renaming,
  options,
  onOpen,
  onAction,
  onRenamed,
  onClose,
}: {
  takes: TakeInfo[];
  loading: boolean;
  selected: string | null;
  renaming: string | null;
  options: { canTranscribe: boolean; canAssist: boolean };
  onOpen: (take: TakeInfo) => void;
  onAction: (take: TakeInfo, action: TakeAction) => void;
  onRenamed: (take: TakeInfo, title: string | null) => void;
  onClose: () => void;
}) {
  return (
    <aside aria-label="Takes" className="flex w-80 shrink-0 flex-col border-l border-border/60 bg-background">
      <div className="flex h-12 shrink-0 items-center justify-between px-4">
        <h2 className="text-sm font-semibold">Takes</h2>
        <button type="button" onClick={onClose} aria-label="Hide takes" className="grid size-7 place-items-center rounded-md text-muted-foreground outline-none hover:bg-accent hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring">
          <X className="size-4" />
        </button>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto px-2 pb-2">
        {loading ? (
          <ul className="flex flex-col gap-1" aria-label="Loading takes">
            {[0, 1, 2].map((i) => (
              <li key={i} className="flex items-center gap-3 p-2">
                <Skeleton className="aspect-video w-24 rounded-md" />
                <div className="flex-1 space-y-1.5">
                  <Skeleton className="h-4 w-24" />
                  <Skeleton className="h-3 w-32" />
                </div>
              </li>
            ))}
          </ul>
        ) : takes.length === 0 ? (
          <div className="m-2 rounded-xl border border-dashed px-6 py-10 text-center">
            <p className="text-sm text-muted-foreground">Your takes show up here. Each one is a folder in Videos › Studio that the Assistant can edit.</p>
          </div>
        ) : (
          <ul className="flex flex-col gap-0.5">
            {takes.map((take) => (
              <TakeRow
                key={take.path}
                take={take}
                selected={take.path === selected}
                renaming={take.path === renaming}
                options={options}
                onOpen={() => onOpen(take)}
                onAction={(action) => onAction(take, action)}
                onRenamed={(title) => onRenamed(take, title)}
              />
            ))}
          </ul>
        )}
      </div>
    </aside>
  );
}
