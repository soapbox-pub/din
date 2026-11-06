import { useState } from 'react';
import { BookUser, Download, Pencil, Plus, Smartphone, Tag, Trash2 } from 'lucide-react';
import { ContextMenu, ContextMenuContent, ContextMenuItem, ContextMenuSeparator, ContextMenuTrigger } from '@/components/ui/context-menu';
import type { PhoneDevice } from '@/lib/phone';
import { cn } from '@/lib/utils';
import { SidebarHeading, ToolButton } from '@/shared/appChrome';
import { sidebarHeadingClass, sidebarRowClass } from '@/shared/appChromeStyles';
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
        sidebarRowClass(active),
        over && 'bg-selected ring-2 ring-ring/60',
      )}
    >
      <Icon className="size-4.5 shrink-0 text-ink-accent" strokeWidth={1.75} />
      <span className="min-w-0 flex-1 truncate">{label}</span>
      {count !== undefined && <span className={cn('text-xs tabular-nums', active ? 'font-semibold' : 'text-muted-foreground')}>{count}</span>}
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
    <nav aria-label="Address book" className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto px-2 pb-3 [&>*]:shrink-0">
      <ul className="space-y-0.5">
        <li>
          <Entry icon={BookUser} label="All Contacts" count={total} active={source.kind === 'all'} onClick={() => onSource({ kind: 'all' })} />
        </li>
      </ul>

      <section aria-labelledby="groups-heading">
        <SidebarHeading className="pr-1">
          <h2 id="groups-heading" className="flex-1">Groups</h2>
          <ToolButton size="xs" label="New group" onClick={onNewGroup}>
            <Plus className="size-4" />
          </ToolButton>
        </SidebarHeading>
        {groups.length === 0 ? (
          <p className="px-2 text-xs text-muted-foreground">Family, Work, Book Club… Groups keep people together.</p>
        ) : (
          <ul className="space-y-0.5">
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
          <h2 id="phones-heading" className={sidebarHeadingClass}>On Your Phone</h2>
          <ul className="space-y-0.5">
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
