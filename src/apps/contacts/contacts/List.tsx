import { useEffect, useMemo, useRef } from 'react';
import { Search, X } from 'lucide-react';
import { ContextMenu, ContextMenuContent, ContextMenuTrigger } from '@/components/ui/context-menu';
import { Skeleton } from '@/components/ui/skeleton';
import { cn } from '@/lib/utils';
import { displayName, indexLetter, type Contact, type SortBy } from '@/shared/vcard';
import { Avatar } from './Avatar';
import type { ContactAction, MenuEntry } from './menu';
import { ContextEntries } from './MenuEntries';
import { CONTACT_DRAG } from './model';

export interface ListItem {
  key: string;
  contact: Contact;
}

/** How a row says who it is: the name, the family name bold as Apple's does when sorting by it. */
function RowName({ c, sortBy }: { c: Contact; sortBy: SortBy }) {
  const name = displayName(c);
  if (!name) return <span className="text-muted-foreground">No Name</span>;
  const bold = sortBy === 'family' ? c.family : c.given;
  if (!bold || c.formatted) return <span className="font-semibold">{name}</span>;
  const at = name.lastIndexOf(bold);
  if (at < 0) return <span className="font-semibold">{name}</span>;
  return (
    <>
      {name.slice(0, at)}
      <span className="font-semibold">{bold}</span>
      {name.slice(at + bold.length)}
    </>
  );
}

function secondLine(c: Contact): string {
  if (!displayName(c)) return '';
  if (c.organization && displayName(c) !== c.organization) return c.organization;
  return c.phones[0]?.value ?? c.emails[0]?.value ?? '';
}

export function ContactList({
  title,
  items,
  sortBy,
  selected,
  onSelect,
  menuFor,
  onAction,
  search,
  onSearch,
  loading,
  empty,
  header,
  dragKeys,
}: {
  title: string;
  items: ListItem[];
  sortBy: SortBy;
  selected: ReadonlySet<string>;
  onSelect: (key: string, how: { range: boolean; toggle: boolean }) => void;
  /** The right-click menu for a row: the selection's, when the row is in it. */
  menuFor: (key: string) => MenuEntry[];
  onAction: (key: string, action: ContactAction) => void;
  search: string;
  onSearch: (q: string) => void;
  loading: boolean;
  empty: React.ReactNode;
  header?: React.ReactNode;
  /** What dragging a row onto a group carries: the selection, when the row is in it. */
  dragKeys?: (key: string) => string[];
}) {
  const listRef = useRef<HTMLDivElement>(null);

  const sections = useMemo(() => {
    const out: { letter: string; items: ListItem[] }[] = [];
    for (const it of items) {
      const letter = indexLetter(it.contact, sortBy);
      const last = out[out.length - 1];
      if (last?.letter === letter) last.items.push(it);
      else out.push({ letter, items: [it] });
    }
    return out;
  }, [items, sortBy]);

  // The selected row stays in view as the keys move it.
  const lead = [...selected].pop();
  useEffect(() => {
    if (!lead) return;
    listRef.current?.querySelector<HTMLElement>(`[data-key="${CSS.escape(lead)}"]`)?.scrollIntoView({ block: 'nearest' });
  }, [lead]);

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (!items.length || !['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(e.key)) return;
    e.preventDefault();
    const at = lead ? items.findIndex((it) => it.key === lead) : -1;
    const next =
      e.key === 'Home' ? 0
        : e.key === 'End' ? items.length - 1
          : Math.min(items.length - 1, Math.max(0, at + (e.key === 'ArrowDown' ? 1 : -1)));
    onSelect(items[next].key, { range: e.shiftKey, toggle: false });
  };

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="px-3 pt-1 pb-2">
        <label className="relative block">
          <span className="sr-only">Search {title}</span>
          <Search className="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-muted-foreground" aria-hidden />
          <input
            id="contacts-search"
            type="search"
            value={search}
            onChange={(e) => onSearch(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Escape' && search) {
                e.stopPropagation();
                onSearch('');
              } else if (e.key === 'ArrowDown') {
                e.preventDefault();
                listRef.current?.focus();
                if (items[0] && !lead) onSelect(items[0].key, { range: false, toggle: false });
              }
            }}
            placeholder="Search"
            className="h-8 w-full rounded-lg border border-transparent bg-foreground/[0.06] pr-8 pl-8 text-sm outline-none placeholder:text-muted-foreground focus-visible:border-ring focus-visible:bg-background focus-visible:ring-2 focus-visible:ring-ring/40 [&::-webkit-search-cancel-button]:hidden"
          />
          {search && (
            <button
              type="button"
              aria-label="Clear search"
              onClick={() => onSearch('')}
              className="absolute top-1/2 right-1.5 grid size-5 -translate-y-1/2 place-items-center rounded-full text-muted-foreground outline-none hover:bg-foreground/10 hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/60"
            >
              <X className="size-3.5" />
            </button>
          )}
        </label>
      </div>
      {header}

      {loading ? (
        <div className="space-y-1 px-3 pt-2" aria-label="Loading contacts">
          {Array.from({ length: 8 }, (_, i) => (
            <div key={i} className="flex items-center gap-3 px-2 py-1.5">
              <Skeleton className="size-9 rounded-full" />
              <div className="flex-1 space-y-1.5">
                <Skeleton className="h-3.5 w-32" />
                <Skeleton className="h-3 w-20" />
              </div>
            </div>
          ))}
        </div>
      ) : items.length === 0 ? (
        <div className="px-4 pt-6">{empty}</div>
      ) : (
        <div
          ref={listRef}
          role="listbox"
          aria-label={title}
          aria-multiselectable
          tabIndex={0}
          onKeyDown={onKeyDown}
          className="min-h-0 flex-1 overflow-y-auto px-2 pb-3 outline-none focus-visible:ring-2 focus-visible:ring-ring/40 focus-visible:ring-inset"
        >
          {sections.map((s) => (
            <div key={s.letter} role="group" aria-label={s.letter}>
              <div className="sticky top-0 z-10 bg-background/95 px-2 pt-2 pb-1 text-xs font-semibold text-muted-foreground backdrop-blur-sm" aria-hidden>
                {s.letter}
              </div>
              {s.items.map((it) => {
                const on = selected.has(it.key);
                const sub = secondLine(it.contact);
                return (
                  <ContextMenu key={it.key}>
                    <ContextMenuTrigger asChild>
                      <div
                        role="option"
                        aria-selected={on}
                        data-key={it.key}
                        draggable={!!dragKeys}
                        onDragStart={dragKeys ? (e) => {
                          const keys = dragKeys(it.key);
                          e.dataTransfer.setData(CONTACT_DRAG, keys.join('\n'));
                          e.dataTransfer.setData('text/plain', keys.length === 1 ? displayName(it.contact) : `${keys.length} contacts`);
                          e.dataTransfer.effectAllowed = 'link';
                        } : undefined}
                        onMouseDown={(e) => {
                          // Right-click a row outside the selection: it's the one acted on.
                          if (e.button === 2 && !on) onSelect(it.key, { range: false, toggle: false });
                        }}
                        onClick={(e) => onSelect(it.key, { range: e.shiftKey, toggle: e.ctrlKey || e.metaKey })}
                        className={cn(
                          'flex cursor-default items-center gap-3 rounded-lg px-2 py-1.5',
                          on ? 'bg-primary text-primary-foreground' : 'hover:bg-foreground/[0.05]',
                        )}
                      >
                        <Avatar contact={it.contact} className="size-9 text-[13px]" />
                        <div className="min-w-0 flex-1">
                          <div className="truncate text-[15px] font-normal"><RowName c={it.contact} sortBy={sortBy} /></div>
                          {sub && <div className={cn('truncate text-xs', on ? 'text-primary-foreground/80' : 'text-muted-foreground')}>{sub}</div>}
                        </div>
                      </div>
                    </ContextMenuTrigger>
                    <ContextMenuContent className="w-56">
                      <ContextEntries entries={menuFor(it.key)} onPick={(a) => onAction(it.key, a)} />
                    </ContextMenuContent>
                  </ContextMenu>
                );
              })}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
