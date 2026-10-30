import { Plus } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { ContextMenu, ContextMenuContent, ContextMenuTrigger } from '@/components/ui/context-menu';
import { Skeleton } from '@/components/ui/skeleton';
import { cn } from '@/lib/utils';
import type { VmInfo, VmState } from '@/lib/vms';
import { WindowDragRegion } from '@/sdk/react';
import { STATE_LABELS } from './bridge';
import type { VmAction } from './actions';
import { VmActionItems } from './ActionItems';
import { OsBadge } from './fields';

const DOT: Record<VmState, string> = {
  stopped: 'bg-muted-foreground/50',
  starting: 'bg-amber-500 motion-safe:animate-pulse',
  running: 'bg-emerald-500',
  paused: 'bg-amber-500',
  stopping: 'bg-amber-500 motion-safe:animate-pulse',
};

export function StateDot({ state, className }: { state: VmState; className?: string }) {
  return <span aria-hidden className={cn('inline-block size-2 shrink-0 rounded-full', DOT[state], className)} />;
}

export function Sidebar({
  vms,
  loading,
  selected,
  onSelect,
  onNew,
  onAction,
  className,
}: {
  vms: VmInfo[];
  loading: boolean;
  selected: string | null;
  onSelect: (id: string) => void;
  onNew: () => void;
  onAction: (vm: VmInfo, action: VmAction) => void;
  className?: string;
}) {
  return (
    <nav aria-label="Virtual machines" className={cn('flex h-full w-60 shrink-0 flex-col border-r border-border/60 bg-muted/40', className)}>
      <WindowDragRegion className="flex h-12 shrink-0 items-center justify-end px-2">
        <Button variant="ghost" size="icon" className="size-8" aria-label="New virtual machine" title="New Virtual Machine" onClick={onNew}>
          <Plus className="size-4" />
        </Button>
      </WindowDragRegion>
      <div className="min-h-0 flex-1 space-y-0.5 overflow-y-auto px-2 pb-2">
        {loading &&
          Array.from({ length: 3 }, (_, i) => (
            <div key={i} className="flex items-center gap-3 px-2 py-2">
              <Skeleton className="size-8 rounded-lg" />
              <div className="flex-1 space-y-1.5">
                <Skeleton className="h-3.5 w-28" />
                <Skeleton className="h-3 w-16" />
              </div>
            </div>
          ))}
        {vms.map((vm) => (
          <ContextMenu key={vm.id}>
            <ContextMenuTrigger asChild>
              <button
                type="button"
                onClick={() => onSelect(vm.id)}
                aria-current={vm.id === selected ? 'true' : undefined}
                className={cn(
                  'flex w-full items-center gap-3 rounded-lg px-2 py-2 text-left',
                  'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
                  vm.id === selected ? 'bg-primary/15' : 'hover:bg-foreground/10',
                )}
              >
                <OsBadge os={vm.config.os} />
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-sm font-medium">{vm.config.name}</span>
                  <span className="flex items-center gap-1.5 text-xs text-muted-foreground">
                    <StateDot state={vm.state} />
                    {vm.error && vm.state === 'stopped' ? 'Stopped with an error' : STATE_LABELS[vm.state]}
                  </span>
                </span>
              </button>
            </ContextMenuTrigger>
            <ContextMenuContent className="w-48">
              <VmActionItems vm={vm} kind="context" onAction={(action) => onAction(vm, action)} />
            </ContextMenuContent>
          </ContextMenu>
        ))}
      </div>
    </nav>
  );
}
