import { useMemo, useState } from 'react';
import {
  Bookmark as BookmarkIcon,
  ChevronRight,
  Download,
  Folder,
  FolderOpen,
  FolderPlus,
  MoreHorizontal,
  Upload,
} from 'lucide-react';
import { cn } from '@/lib/utils';
import {
  allBookmarks,
  allFolders,
  findBookmark,
  BOOKMARKS_BAR_ID,
  type BookmarkFolder,
  type BookmarkNode,
} from '@/lib/browserBookmarks';
import { useBookmarksBarShown, useBrowserBookmarks, useDeleteBookmarks } from '@/hooks/useBrowserBookmarks';
import {
  bookmarkMenu,
  draggedBookmarkId,
  folderMenu,
  startBookmarkDrag,
  type BookmarkMenuEntry,
  type BookmarkMenuHandlers,
  type BookmarkOpeners,
} from '@/components/desktop/apps/bookmarkMenus';
import {
  BookmarkEditDialog,
  BookmarkNodeIcon,
  ContextMenuEntries,
  DropdownMenuEntries,
  type BookmarkDialogState,
} from '@/components/desktop/apps/BrowserBookmarks';
import { EmptyState, PillButton, SearchField, ToolButton } from '@/shared/appChrome';
import { sidebarWidthClass, titleSearch, toolIcon } from '@/shared/appChromeStyles';
import { ContextMenu, ContextMenuContent, ContextMenuTrigger } from '@/components/ui/context-menu';
import { DropdownMenu, DropdownMenuContent, DropdownMenuTrigger } from '@/components/ui/dropdown-menu';
import { Switch } from '@/components/ui/switch';
import { Label } from '@/components/ui/label';
import { settingsGroup } from '@/shared/settingsChromeStyles';

/** Everything about:bookmarks needs from the browser window hosting it. */
export interface BookmarksPageProps {
  openers: BookmarkOpeners;
  /** Import a bookmarks file (bookmarks.html) the user picks. */
  onImport: () => void;
  /** Export every bookmark to a bookmarks file the user names. */
  onExport: () => void;
}

/**
 * The bookmark manager, rendered over a blank tab's surface when the tab's
 * URL is `about:bookmarks` (see `src/lib/internalPages.ts`): the folders on
 * the left, what's in the chosen one on the right, a search over all of
 * them, and importing and exporting bookmarks.html files.
 */
export function BookmarksPage({ openers, onImport, onExport }: BookmarksPageProps) {
  const { tree, actions } = useBrowserBookmarks();
  const [barShown, setBarShown] = useBookmarksBarShown();
  const [folderId, setFolderId] = useState(BOOKMARKS_BAR_ID);
  const [query, setQuery] = useState('');
  const [dialog, setDialog] = useState<BookmarkDialogState>(null);
  const onDelete = useDeleteBookmarks(actions);
  const handlers: BookmarkMenuHandlers = {
    openers,
    actions,
    tree,
    onEdit: (node) => setDialog({ kind: 'edit', node }),
    onDelete,
  };

  // The chosen folder, or the bar when it's gone (deleted, or moved away and removed).
  const found = findBookmark(tree, folderId);
  const folder: BookmarkFolder = found?.node.type === 'folder' ? found.node : tree.bar;
  const folderPaths = useMemo(() => new Map(allFolders(tree).map((f) => [f.folder.id, f.path])), [tree]);

  const results = useMemo(() => {
    const terms = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
    if (!terms.length) return null;
    return allBookmarks(tree).filter((b) => {
      const text = `${b.title} ${b.url}`.toLowerCase();
      return terms.every((t) => text.includes(t));
    });
  }, [tree, query]);

  const newFolder = () => {
    const made = actions.addFolder('New folder', folder.id);
    if (made) setDialog({ kind: 'edit', node: made });
  };

  const rows: BookmarkNode[] = results ?? folder.children;

  return (
    // Opaque, like the other internal pages: the surface underneath is a
    // white about:blank.
    <div className="@container absolute inset-0 flex flex-col overflow-hidden bg-background text-foreground">
      {/* A 48px band, as a window's toolbar: the search, then what to do. */}
      <header className="flex h-14 shrink-0 items-center gap-2 px-4">
        <BookmarkIcon className="ml-1 size-5 shrink-0 text-ink-accent" strokeWidth={1.75} aria-hidden />
        <h1 className="mr-2 shrink-0 font-[family-name:var(--font-title)] text-lg font-semibold">Bookmarks</h1>
        <SearchField value={query} onValueChange={setQuery} placeholder="Search bookmarks" aria-label="Search bookmarks" className={titleSearch} />
        <div className="min-w-2 flex-1" />
        <ToolButton label="New Folder" onClick={newFolder}>
          <FolderPlus {...toolIcon} />
        </ToolButton>
        <ToolButton label="Import Bookmarks…" onClick={onImport}>
          <Upload {...toolIcon} />
        </ToolButton>
        <ToolButton label="Export Bookmarks…" onClick={onExport}>
          <Download {...toolIcon} />
        </ToolButton>
      </header>

      <div className="flex min-h-0 flex-1">
        <nav aria-label="Bookmark folders" className={cn(sidebarWidthClass, 'hidden shrink-0 flex-col gap-4 overflow-y-auto px-2 pb-2 @2xl:flex [&>*]:shrink-0')}>
          <ul className="space-y-0.5">
            {[tree.bar, tree.other].map((root) => (
              <FolderTreeItem
                key={root.id}
                folder={root}
                depth={0}
                selected={results ? null : folder.id}
                onSelect={(id) => {
                  setQuery('');
                  setFolderId(id);
                }}
                handlers={handlers}
              />
            ))}
          </ul>
          <div className="mt-auto flex items-center justify-between gap-3 px-2.5 py-2">
            <Label htmlFor="bookmarks-show-bar" className="text-[13px] font-normal">
              Show bookmarks bar
            </Label>
            <Switch id="bookmarks-show-bar" checked={barShown} onCheckedChange={setBarShown} />
          </div>
        </nav>

        <section className="mr-2 mb-2 min-w-0 flex-1 overflow-y-auto rounded-2xl bg-card px-4 py-4 clay @2xl:px-6" aria-label={results ? 'Search results' : folder.title}>
          <h2 className="mb-3 truncate px-1 text-sm font-semibold text-foreground/90">
            {results ? `${results.length} found` : folderPaths.get(folder.id) ?? folder.title}
          </h2>
          {rows.length === 0 ? (
            <EmptyState
              action={
                !results &&
                folder.id === BOOKMARKS_BAR_ID && (
                  <PillButton onClick={onImport}>
                    <Upload aria-hidden />
                    Import Bookmarks…
                  </PillButton>
                )
              }
            >
              {results
                ? 'No bookmarks match your search.'
                : folder.id === BOOKMARKS_BAR_ID
                  ? 'Nothing here yet. Bookmark a page with the star in the address bar, or import bookmarks from another browser.'
                  : 'This folder is empty.'}
            </EmptyState>
          ) : (
            <ul className={settingsGroup}>
              {rows.map((node, index) => (
                <BookmarkRow
                  key={node.id}
                  node={node}
                  path={results ? folderPaths.get(findBookmark(tree, node.id)?.parent?.id ?? '') : undefined}
                  handlers={handlers}
                  onOpenFolder={(id) => setFolderId(id)}
                  // Reordering only makes sense within the folder shown.
                  onDropBefore={
                    results
                      ? undefined
                      : (id, after) => actions.move(id, folder.id, after ? index + 1 : index)
                  }
                />
              ))}
            </ul>
          )}
        </section>
      </div>

      <BookmarkEditDialog state={dialog} actions={actions} onClose={() => setDialog(null)} />
    </div>
  );
}

/** A folder in the sidebar, with its subfolders under it; a bookmark dropped on it is filed there. */
function FolderTreeItem({
  folder,
  depth,
  selected,
  onSelect,
  handlers,
}: {
  folder: BookmarkFolder;
  depth: number;
  selected: string | null;
  onSelect: (id: string) => void;
  handlers: BookmarkMenuHandlers;
}) {
  const [expanded, setExpanded] = useState(true);
  const [dropping, setDropping] = useState(false);
  const subfolders = folder.children.filter((c): c is BookmarkFolder => c.type === 'folder');
  const active = selected === folder.id;
  const Icon = active ? FolderOpen : Folder;

  return (
    <li>
      <ContextMenu>
        <ContextMenuTrigger asChild>
          <div
            className={cn(
              'flex h-8 items-center gap-1 rounded-md pr-2 text-sm',
              active ? 'bg-selected font-medium' : 'hover:bg-foreground/5',
              dropping && 'ring-2 ring-ring/60',
            )}
            style={{ paddingInlineStart: depth * 12 + 4 }}
            onDragOver={(e) => {
              if (draggedBookmarkId(e) === null) return;
              e.preventDefault();
              e.dataTransfer.dropEffect = 'move';
              setDropping(true);
            }}
            onDragLeave={() => setDropping(false)}
            onDrop={(e) => {
              e.preventDefault();
              setDropping(false);
              const id = draggedBookmarkId(e);
              if (id) handlers.actions.move(id, folder.id);
            }}
          >
            <button
              type="button"
              aria-label={expanded ? `Collapse ${folder.title}` : `Expand ${folder.title}`}
              aria-expanded={expanded}
              onClick={() => setExpanded(!expanded)}
              className={cn(
                'grid size-5 shrink-0 place-items-center rounded text-muted-foreground hover:text-foreground outline-none focus-visible:ring-2 focus-visible:ring-ring/60',
                !subfolders.length && 'invisible',
              )}
            >
              <ChevronRight className={cn('size-4 motion-safe:transition-transform', expanded && 'rotate-90')} strokeWidth={1.75} aria-hidden />
            </button>
            <button
              type="button"
              aria-current={active ? 'true' : undefined}
              onClick={() => onSelect(folder.id)}
              className="flex h-full min-w-0 flex-1 items-center gap-2.5 rounded text-left outline-none focus-visible:ring-2 focus-visible:ring-ring/60"
            >
              <Icon className="size-4.5 shrink-0 text-ink-accent" strokeWidth={1.75} aria-hidden />
              <span className="truncate">{folder.title}</span>
            </button>
          </div>
        </ContextMenuTrigger>
        <ContextMenuContent className="w-56" onCloseAutoFocus={(e) => e.preventDefault()}>
          <ContextMenuEntries entries={folderMenu(folder, handlers)} />
        </ContextMenuContent>
      </ContextMenu>
      {expanded && subfolders.length > 0 && (
        <ul className="mt-0.5 space-y-0.5">
          {subfolders.map((sub) => (
            <FolderTreeItem key={sub.id} folder={sub} depth={depth + 1} selected={selected} onSelect={onSelect} handlers={handlers} />
          ))}
        </ul>
      )}
    </li>
  );
}

/**
 * A bookmark (opens in a new tab) or folder (opens in the list), with its ⋯
 * menu and the same menu on right-click. Drag to reorder, or onto a folder in
 * the sidebar to file it.
 */
function BookmarkRow({
  node,
  path,
  handlers,
  onOpenFolder,
  onDropBefore,
}: {
  node: BookmarkNode;
  /** The folder it's in, shown in search results. */
  path?: string;
  handlers: BookmarkMenuHandlers;
  onOpenFolder: (id: string) => void;
  /** Move a dragged node to this row's place (`after` it, in its lower half). */
  onDropBefore?: (id: string, after: boolean) => void;
}) {
  const [drop, setDrop] = useState<'before' | 'after' | null>(null);
  const { openers } = handlers;
  const entries: BookmarkMenuEntry[] =
    node.type === 'bookmark'
      ? bookmarkMenu(node, handlers)
      : folderMenu(node, handlers, [{ label: 'Open', icon: FolderOpen, onSelect: () => onOpenFolder(node.id) }]);
  const count = node.type === 'folder' ? node.children.length : 0;

  return (
    <ContextMenu>
      <ContextMenuTrigger asChild>
        <li
          className={cn(
            'group relative flex items-center gap-3 py-1.5 pr-2 pl-4 hover:bg-foreground/5',
            drop === 'before' && 'shadow-[inset_0_2px_0_0_var(--ink-accent)]',
            drop === 'after' && 'shadow-[inset_0_-2px_0_0_var(--ink-accent)]',
          )}
          draggable
          onDragStart={(e) => startBookmarkDrag(e, node)}
          onDragOver={(e) => {
            if (!onDropBefore || draggedBookmarkId(e) === null) return;
            e.preventDefault();
            e.dataTransfer.dropEffect = 'move';
            const rect = e.currentTarget.getBoundingClientRect();
            setDrop(e.clientY - rect.top < rect.height / 2 ? 'before' : 'after');
          }}
          onDragLeave={() => setDrop(null)}
          onDrop={(e) => {
            e.preventDefault();
            const id = draggedBookmarkId(e);
            const after = drop === 'after';
            setDrop(null);
            if (id && id !== node.id) onDropBefore?.(id, after);
          }}
        >
          <button
            type="button"
            onClick={() => (node.type === 'bookmark' ? openers.openInNewTab(node.url) : onOpenFolder(node.id))}
            onAuxClick={(e) => {
              if (e.button === 1 && node.type === 'bookmark') openers.openInNewTab(node.url, true);
            }}
            title={node.type === 'bookmark' ? node.url : undefined}
            className="flex min-w-0 flex-1 items-center gap-3 rounded text-left outline-none focus-visible:ring-2 focus-visible:ring-ring/60"
          >
            <BookmarkNodeIcon node={node} className="size-4 shrink-0" />
            <span className="min-w-0 max-w-[50%] shrink-0 truncate text-sm">{node.title}</span>
            <span className="min-w-0 flex-1 truncate text-xs text-muted-foreground">
              {node.type === 'bookmark' ? node.url : count === 1 ? '1 item' : `${count} items`}
              {path && ` · ${path}`}
            </span>
          </button>
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <ToolButton size="sm" label={`More actions for ${node.title}`}>
                <MoreHorizontal className="size-4.5" strokeWidth={1.75} aria-hidden />
              </ToolButton>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="w-56" onCloseAutoFocus={(e) => e.preventDefault()}>
              <DropdownMenuEntries entries={entries} />
            </DropdownMenuContent>
          </DropdownMenu>
        </li>
      </ContextMenuTrigger>
      <ContextMenuContent className="w-56" onCloseAutoFocus={(e) => e.preventDefault()}>
        <ContextMenuEntries entries={entries} />
      </ContextMenuContent>
    </ContextMenu>
  );
}
