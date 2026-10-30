import type { ComponentType, ReactNode } from 'react';
import { Folder, FolderPlus, KeyRound, Lock, Pencil, Settings, ShieldCheck, Star, StickyNote, Trash2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { ContextMenu, ContextMenuContent, ContextMenuItem, ContextMenuSeparator, ContextMenuTrigger } from '@/components/ui/context-menu';
import { cn } from '@/lib/utils';
import type { PasswordList } from '@/lib/passwords';
import { WindowDragRegion } from '@/sdk/react';
import { itemsIn, sameSection, type Section } from './vault';

/** A section's badge: a white glyph on a rounded square of its color. */
function Badge({ icon: Icon, className }: { icon: ComponentType<{ className?: string }>; className: string }) {
  return (
    <span aria-hidden className={cn('grid size-6 shrink-0 place-items-center rounded-md text-white shadow-sm', className)}>
      <Icon className="size-3.5" />
    </span>
  );
}

const FIXED: { section: Section; name: string; badge: ReactNode }[] = [
  { section: { type: 'all' }, name: 'All Items', badge: <Badge icon={KeyRound} className="bg-gradient-to-b from-sky-500 to-blue-600" /> },
  { section: { type: 'favorites' }, name: 'Favorites', badge: <Badge icon={Star} className="bg-gradient-to-b from-amber-400 to-orange-500" /> },
  { section: { type: 'codes' }, name: 'Codes', badge: <Badge icon={ShieldCheck} className="bg-gradient-to-b from-emerald-500 to-green-700" /> },
  { section: { type: 'notes' }, name: 'Secure Notes', badge: <Badge icon={StickyNote} className="bg-gradient-to-b from-yellow-500 to-amber-600" /> },
];

function Row({
  active,
  onClick,
  badge,
  name,
  count,
  depth = 0,
}: {
  active: boolean;
  onClick: () => void;
  badge: ReactNode;
  name: string;
  count: number;
  depth?: number;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-current={active ? 'page' : undefined}
      style={depth ? { paddingLeft: 8 + depth * 16 } : undefined}
      className={cn(
        'flex w-full items-center gap-2.5 rounded-lg px-2 py-1.5 text-left text-sm',
        'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
        active ? 'bg-primary/15 font-medium text-foreground' : 'text-foreground/85 hover:bg-foreground/10 hover:text-foreground',
      )}
    >
      {badge}
      <span className="min-w-0 flex-1 truncate">{name}</span>
      {count > 0 && <span className="text-xs tabular-nums text-muted-foreground">{count}</span>}
    </button>
  );
}

export function Sidebar({
  list,
  section,
  onSection,
  onNewFolder,
  onRenameFolder,
  onDeleteFolder,
  onEmptyTrash,
  onSettings,
  onLock,
  className,
}: {
  list: PasswordList;
  section: Section;
  onSection: (section: Section) => void;
  onNewFolder: () => void;
  onRenameFolder: (id: string) => void;
  onDeleteFolder: (id: string) => void;
  onEmptyTrash: () => void;
  onSettings: () => void;
  onLock: () => void;
  className?: string;
}) {
  const folders = list.groups.filter((g) => !g.trash);
  const trashed = itemsIn(list, { type: 'trash' }).length;
  return (
    <nav aria-label="Sections" className={cn('flex h-full w-56 shrink-0 flex-col border-r border-border/60 bg-muted/40', className)}>
      <WindowDragRegion className="h-12 shrink-0" />
      <div className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto px-2 pb-2">
        <div className="space-y-0.5">
          {FIXED.map(({ section: s, name, badge }) => (
            <Row key={name} active={sameSection(s, section)} onClick={() => onSection(s)} badge={badge} name={name} count={itemsIn(list, s).length} />
          ))}
        </div>

        <div className="space-y-0.5">
          <div className="flex items-center justify-between px-2 pb-1">
            <h2 className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">Folders</h2>
            <Button variant="ghost" size="icon" className="size-6" aria-label="New folder" title="New folder" onClick={onNewFolder}>
              <FolderPlus className="size-3.5" />
            </Button>
          </div>
          {folders.length === 0 && <p className="px-2 text-xs text-muted-foreground">Group items in folders of your own.</p>}
          {folders.map((folder) => (
            <ContextMenu key={folder.id}>
              <ContextMenuTrigger asChild>
                <div>
                  <Row
                    active={section.type === 'folder' && section.id === folder.id}
                    onClick={() => onSection({ type: 'folder', id: folder.id })}
                    badge={<Folder className="size-4 shrink-0 text-primary" aria-hidden />}
                    name={folder.name || 'Untitled'}
                    count={itemsIn(list, { type: 'folder', id: folder.id }).length}
                    depth={folder.depth}
                  />
                </div>
              </ContextMenuTrigger>
              <ContextMenuContent className="w-48">
                <ContextMenuItem onSelect={() => onRenameFolder(folder.id)}>
                  <Pencil className="size-4" aria-hidden />
                  Rename…
                </ContextMenuItem>
                <ContextMenuSeparator />
                <ContextMenuItem variant="destructive" onSelect={() => onDeleteFolder(folder.id)}>
                  <Trash2 className="size-4" aria-hidden />
                  Delete Folder…
                </ContextMenuItem>
              </ContextMenuContent>
            </ContextMenu>
          ))}
        </div>

        <div className="mt-auto space-y-0.5">
          <ContextMenu>
            <ContextMenuTrigger asChild>
              <div>
                <Row
                  active={section.type === 'trash'}
                  onClick={() => onSection({ type: 'trash' })}
                  badge={<Badge icon={Trash2} className="bg-gradient-to-b from-zinc-400 to-zinc-600" />}
                  name="Recently Deleted"
                  count={trashed}
                />
              </div>
            </ContextMenuTrigger>
            <ContextMenuContent className="w-48">
              <ContextMenuItem variant="destructive" disabled={trashed === 0} onSelect={onEmptyTrash}>
                <Trash2 className="size-4" aria-hidden />
                Delete All Now…
              </ContextMenuItem>
            </ContextMenuContent>
          </ContextMenu>
        </div>
      </div>
      <div className="flex items-center gap-1 border-t border-border/60 p-2">
        <Button variant="ghost" size="sm" className="flex-1 justify-start" onClick={onLock}>
          <Lock className="size-4" aria-hidden />
          Lock
        </Button>
        <Button variant="ghost" size="icon" className="size-8" aria-label="Passwords settings" title="Settings" onClick={onSettings}>
          <Settings className="size-4" />
        </Button>
      </div>
    </nav>
  );
}
