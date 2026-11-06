import { Check, ChevronDown, FolderOpen, Plus } from 'lucide-react';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuShortcut,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import type { ProjectInfo } from '@/lib/capture';
import { cn } from '@/lib/utils';
import { formatWhen } from '../format';

function summary(p: ProjectInfo): string {
  const takes = p.items.filter((i) => i.take.kind === 'recording').length;
  const clips = p.items.length - takes;
  const parts = [takes === 1 ? '1 take' : `${takes} takes`];
  if (clips) parts.push(clips === 1 ? '1 clip' : `${clips} clips`);
  return `${parts.join(', ')} · ${formatWhen(p.updated)}`;
}

/** Which project takes go into, in the title bar: the ones there are, and a new one. */
export function ProjectSwitcher({
  projects,
  current,
  disabled,
  onSelect,
  onNew,
}: {
  projects: ProjectInfo[];
  current: ProjectInfo | null;
  /** While recording: the take goes where it started. */
  disabled: boolean;
  onSelect: (project: ProjectInfo) => void;
  onNew: () => void;
}) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild disabled={disabled}>
        <button
          type="button"
          aria-label={`Project: ${current?.title ?? 'New Project'}`}
          title={disabled ? 'The take goes into this project' : 'Switch projects'}
          className="flex h-8 max-w-56 min-w-0 items-center gap-1.5 rounded-full px-3 text-sm font-medium outline-none hover:bg-foreground/5 focus-visible:ring-2 focus-visible:ring-ring/60 disabled:opacity-60 disabled:hover:bg-transparent"
        >
          <FolderOpen strokeWidth={1.75} className="size-4.5 shrink-0 text-ink-accent" aria-hidden />
          <span className={cn('truncate', !current && 'text-muted-foreground')}>{current?.title ?? 'New Project'}</span>
          <ChevronDown className="size-4 shrink-0 text-muted-foreground" strokeWidth={1.75} aria-hidden />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="max-h-[min(28rem,70vh)] w-72 overflow-y-auto">
        <DropdownMenuItem onSelect={onNew}>
          <Plus className="size-4.5" strokeWidth={1.75} aria-hidden />
          New Project
          <DropdownMenuShortcut>Ctrl+N</DropdownMenuShortcut>
        </DropdownMenuItem>
        {projects.length > 0 && (
          <>
            <DropdownMenuSeparator />
            <DropdownMenuLabel className="text-xs text-muted-foreground">Projects</DropdownMenuLabel>
            {projects.map((p) => (
              <DropdownMenuItem key={p.path} onSelect={() => onSelect(p)} className="items-start">
                <Check className={cn('mt-0.5 size-4', p.path !== current?.path && 'invisible')} aria-hidden />
                <span className="min-w-0 flex-1">
                  <span className="block truncate">{p.title}</span>
                  <span className="block truncate text-xs text-muted-foreground">{summary(p)}</span>
                </span>
              </DropdownMenuItem>
            ))}
          </>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
