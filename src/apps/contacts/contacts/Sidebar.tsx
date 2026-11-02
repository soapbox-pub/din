import { useState } from 'react';
import { BookUser, Download, Pencil, Plus, Smartphone, Tag, Trash2 } from 'lucide-react';
import { ContextMenu, ContextMenuContent, ContextMenuItem, ContextMenuSeparator, ContextMenuTrigger } from '@/components/ui/context-menu';
import type { PhoneDevice } from '@/lib/phone';
import { cn } from '@/lib/utils';
import { CONTACT_DRAG, type Source } from './model';

function Entry({
  icon: Icon,
  label,
  count,
  active,
  onClick,
  onDrop,
}: {
  icon: typeof Tag;
  label: string;
  count?: number;
  active: boolean;
  onClick: () => void;
  /** Contacts dragged from the list onto a group. */
  onDrop?: (keys: string[]) => void;
}) {
  const [over, setOver] = useState(false);
  return (
    <button
      type="button"
      onClick={onClick}
      aria-current={active ? 'true' : undefined}
      onDragOver={onDrop ? (e) => {
        if (!e.dataTransfer.types.includes(CONTACT_DRAG)) return;
        e.preventDefault();
        e.dataTransfer.dropEffect = 'link';
        setOver(true);
      } : undefined}
      onDragLeave={() => setOver(false)}
      onDrop={onDrop ? (e) => {
        setOver(false);
        const keys = e.dataTransfer.getData(CONTACT_DRAG);
        if (!keys) return;
        e.preventDefault();
        onDrop(keys.split('\n'));
      } : undefined}
      className={cn(
        'flex h-8 w-full items-center gap-2.5 rounded-md px-2 text-left text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring/60',
        active ? 'bg-foreground/[0.09] font-medium' : 'hover:bg-foreground/[0.05]',
        over && 'bg-primary/15 ring-2 ring-primary/50',
      )}
    >
      <Icon className={cn('size-4 shrink-0', active ? 'text-primary' : 'text-muted-foreground')} strokeWidth={1.75} />
      <span className="min-w-0 flex-1 truncate">{label}</span>
      {count !== undefined && <span className="text-xs text-muted-foreground tabular-nums">{count}</span>}
    </button>
  );
}

export function Sidebar({
  source,
  onSource,
  total,
  groups,
  counts,
  phones,
  phoneCounts,
  onNewGroup,
  onRenameGroup,
  onDeleteGroup,
  onExportGroup,
  onDropOnGroup,
}: {
  source: Source;
  onSource: (s: Source) => void;
  total: number;
  groups: readonly string[];
  counts: ReadonlyMap<string, number>;
  phones: readonly PhoneDevice[];
  phoneCounts: ReadonlyMap<string, number>;
  onNewGroup: () => void;
  onRenameGroup: (name: string) => void;
  onDeleteGroup: (name: string) => void;
  onExportGroup: (name: string) => void;
  onDropOnGroup: (group: string, keys: string[]) => void;
}) {
  return (
    <nav aria-label="Address book" className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto px-2 pb-3">
      <ul className="space-y-px">
        <li>
          <Entry icon={BookUser} label="All Contacts" count={total} active={source.kind === 'all'} onClick={() => onSource({ kind: 'all' })} />
        </li>
      </ul>

      <section aria-labelledby="groups-heading">
        <div className="flex items-center px-2 pb-1">
          <h2 id="groups-heading" className="flex-1 text-xs font-semibold text-muted-foreground">Groups</h2>
          <button
            type="button"
            aria-label="New group"
            title="New group"
            onClick={onNewGroup}
            className="grid size-6 place-items-center rounded-md text-muted-foreground outline-none hover:bg-foreground/[0.07] hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/60"
          >
            <Plus className="size-3.5" />
          </button>
        </div>
        {groups.length === 0 ? (
          <p className="px-2 text-xs text-muted-foreground">Family, Work, Book Club… Groups keep people together.</p>
        ) : (
          <ul className="space-y-px">
            {groups.map((g) => (
              <ContextMenu key={g}>
                <ContextMenuTrigger asChild>
                  <li>
                    <Entry
                      icon={Tag}
                      label={g}
                      count={counts.get(g) ?? 0}
                      active={source.kind === 'group' && source.name === g}
                      onClick={() => onSource({ kind: 'group', name: g })}
                      onDrop={(keys) => onDropOnGroup(g, keys)}
                    />
                  </li>
                </ContextMenuTrigger>
                <ContextMenuContent className="w-52" onCloseAutoFocus={(e) => e.preventDefault()}>
                  <ContextMenuItem onSelect={() => onRenameGroup(g)}>
                    <Pencil /> Rename…
                  </ContextMenuItem>
                  <ContextMenuItem onSelect={() => onExportGroup(g)}>
                    <Download /> Export Group…
                  </ContextMenuItem>
                  <ContextMenuSeparator />
                  <ContextMenuItem variant="destructive" onSelect={() => onDeleteGroup(g)}>
                    <Trash2 /> Delete Group…
                  </ContextMenuItem>
                </ContextMenuContent>
              </ContextMenu>
            ))}
          </ul>
        )}
      </section>

      {phones.length > 0 && (
        <section aria-labelledby="phones-heading">
          <h2 id="phones-heading" className="px-2 pb-1 text-xs font-semibold text-muted-foreground">On Your Phone</h2>
          <ul className="space-y-px">
            {phones.map((p) => (
              <li key={p.id}>
                <Entry
                  icon={Smartphone}
                  label={p.name}
                  count={phoneCounts.get(p.id)}
                  active={source.kind === 'phone' && source.id === p.id}
                  onClick={() => onSource({ kind: 'phone', id: p.id })}
                />
              </li>
            ))}
          </ul>
        </section>
      )}
    </nav>
  );
}
