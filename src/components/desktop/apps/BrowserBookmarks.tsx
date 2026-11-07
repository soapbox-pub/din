import { useLayoutEffect, useRef, useState } from 'react';
import { ChevronsRight, Folder, Globe, Library, SquarePlus, Star } from 'lucide-react';
import { cn } from '@/lib/utils';
import { sanitizeImageUrl } from '@/lib/sanitizeUrl';
import {
  allFolders,
  bookmarksOfUrl,
  findBookmark,
  isBookmarkableUrl,
  BOOKMARKS_BAR_ID,
  type Bookmark,
  type BookmarkFolder,
  type BookmarkNode,
  type BookmarkTree,
} from '@/lib/browserBookmarks';
import {
  useBookmarksBarShown,
  useBrowserBookmarks,
  useDeleteBookmarks,
  type BookmarkActions,
} from '@/hooks/useBrowserBookmarks';
import {
  BOOKMARK_DRAG_TYPE,
  bookmarkMenu,
  draggedBookmarkId,
  folderMenu,
  startBookmarkDrag,
  type BookmarkMenuEntry,
  type BookmarkMenuHandlers,
  type BookmarkOpeners,
} from '@/components/desktop/apps/bookmarkMenus';
import { Button } from '@/components/ui/button';
import {
  ContextMenu,
  ContextMenuCheckboxItem,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuSub,
  ContextMenuSubContent,
  ContextMenuSubTrigger,
  ContextMenuTrigger,
} from '@/components/ui/context-menu';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';

// ---- menus ----

/** The menu entries in a right-click menu. */
export function ContextMenuEntries({ entries }: { entries: BookmarkMenuEntry[] }) {
  return entries.map((entry, i) => {
    if (entry === 'separator') return <ContextMenuSeparator key={i} />;
    const Icon = entry.icon;
    if (entry.items) {
      return (
        <ContextMenuSub key={i}>
          <ContextMenuSubTrigger disabled={entry.disabled} className="gap-2">
            {Icon && <Icon aria-hidden />}
            {entry.label}
          </ContextMenuSubTrigger>
          <ContextMenuSubContent className="max-h-80 overflow-y-auto">
            <ContextMenuEntries entries={entry.items} />
          </ContextMenuSubContent>
        </ContextMenuSub>
      );
    }
    if (entry.checked !== undefined) {
      return (
        <ContextMenuCheckboxItem key={i} checked={entry.checked} onSelect={entry.onSelect} disabled={entry.disabled}>
          {entry.label}
        </ContextMenuCheckboxItem>
      );
    }
    return (
      <ContextMenuItem
        key={i}
        variant={entry.destructive ? 'destructive' : 'default'}
        disabled={entry.disabled}
        onSelect={entry.onSelect}
      >
        {Icon && <Icon aria-hidden />}
        {entry.label}
      </ContextMenuItem>
    );
  });
}

/** The same entries in a dropdown (⋯) menu. */
export function DropdownMenuEntries({ entries }: { entries: BookmarkMenuEntry[] }) {
  return entries.map((entry, i) => {
    if (entry === 'separator') return <DropdownMenuSeparator key={i} />;
    const Icon = entry.icon;
    if (entry.items) {
      return (
        <DropdownMenuSub key={i}>
          <DropdownMenuSubTrigger disabled={entry.disabled} className="gap-2">
            {Icon && <Icon aria-hidden className="text-muted-foreground" />}
            {entry.label}
          </DropdownMenuSubTrigger>
          <DropdownMenuSubContent className="max-h-80 overflow-y-auto">
            <DropdownMenuEntries entries={entry.items} />
          </DropdownMenuSubContent>
        </DropdownMenuSub>
      );
    }
    return (
      <DropdownMenuItem
        key={i}
        variant={entry.destructive ? 'destructive' : 'default'}
        disabled={entry.disabled}
        onSelect={entry.onSelect}
      >
        {Icon && <Icon aria-hidden />}
        {entry.label}
      </DropdownMenuItem>
    );
  });
}

// ---- editing ----

/** What the edit dialog is editing: a node, or a folder being made. */
export type BookmarkDialogState = { kind: 'edit'; node: BookmarkNode } | null;

/** Rename a bookmark or folder, or change a bookmark's address. A quick question, so a dialog. */
export function BookmarkEditDialog({
  state,
  actions,
  onClose,
}: {
  state: BookmarkDialogState;
  actions: BookmarkActions;
  onClose: () => void;
}) {
  return (
    <Dialog open={state !== null} onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="sm:max-w-md">
        {state && <BookmarkEditForm key={state.node.id} node={state.node} actions={actions} onClose={onClose} />}
      </DialogContent>
    </Dialog>
  );
}

function BookmarkEditForm({ node, actions, onClose }: { node: BookmarkNode; actions: BookmarkActions; onClose: () => void }) {
  const [title, setTitle] = useState(node.title);
  const [url, setUrl] = useState(node.type === 'bookmark' ? node.url : '');
  const isBookmark = node.type === 'bookmark';
  const urlValid = !isBookmark || isBookmarkableUrl(url.trim());

  return (
    <form
      className="space-y-4"
      onSubmit={(e) => {
        e.preventDefault();
        e.stopPropagation();
        if (!urlValid) return;
        actions.update(node.id, isBookmark ? { title, url: url.trim() } : { title });
        onClose();
      }}
    >
      <DialogHeader>
        <DialogTitle>{isBookmark ? 'Edit bookmark' : 'Rename folder'}</DialogTitle>
        <DialogDescription className="sr-only">
          {isBookmark ? 'Change the bookmark’s name and address.' : 'Change the folder’s name.'}
        </DialogDescription>
      </DialogHeader>
      <div className="space-y-2">
        <Label htmlFor="bookmark-edit-title">Name</Label>
        <Input id="bookmark-edit-title" value={title} autoFocus onChange={(e) => setTitle(e.target.value)} autoComplete="off" />
      </div>
      {isBookmark && (
        <div className="space-y-2">
          <Label htmlFor="bookmark-edit-url">Address</Label>
          <Input
            id="bookmark-edit-url"
            value={url}
            onChange={(e) => setUrl(e.target.value)}
            aria-invalid={!urlValid}
            spellCheck={false}
            autoComplete="off"
          />
          {!urlValid && (
            <p className="text-xs text-destructive">Use an https://, http://, nsite://, nostr: or blossom: address.</p>
          )}
        </div>
      )}
      <DialogFooter>
        <Button type="button" variant="ghost" onClick={onClose}>
          Cancel
        </Button>
        <Button type="submit" disabled={!urlValid}>
          Save
        </Button>
      </DialogFooter>
    </form>
  );
}

// ---- icons ----

/** A bookmark's favicon, or a globe; a folder's folder. */
export function BookmarkNodeIcon({ node, className }: { node: BookmarkNode; className?: string }) {
  const [failed, setFailed] = useState(false);
  if (node.type === 'folder') return <Folder className={cn('text-muted-foreground', className)} aria-hidden />;
  const icon = node.icon ? sanitizeImageUrl(node.icon) : null;
  if (!icon || failed) return <Globe className={cn('text-muted-foreground', className)} aria-hidden />;
  return (
    <img
      src={icon}
      alt=""
      aria-hidden
      draggable={false}
      onError={() => setFailed(true)}
      className={cn('object-contain', className)}
    />
  );
}

// ---- the address bar's star ----

/**
 * The star at the end of the address bar: filled when the page is
 * bookmarked. Clicking it (or Ctrl+D) bookmarks the page on the bookmarks bar
 * and opens it for naming and filing, as Chrome's does; the browser window
 * owns `open`, so the shortcut can open it too (see `bookmarkPage`).
 */
export function BookmarkStarButton({
  url,
  open,
  onOpenChange,
  onBookmark,
  onOpenManager,
}: {
  url: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Bookmark the page (if it isn't) and open the popover. */
  onBookmark: () => void;
  onOpenManager: () => void;
}) {
  const { tree, actions } = useBrowserBookmarks();
  const bookmark = bookmarksOfUrl(tree, url)[0] ?? null;

  return (
    <Popover open={open && !!bookmark} onOpenChange={(next) => (next ? onBookmark() : onOpenChange(false))}>
      <PopoverTrigger asChild>
        <button
          type="button"
          aria-label={bookmark ? 'Edit bookmark for this page' : 'Bookmark this page'}
          title={bookmark ? 'Edit bookmark (Ctrl+D)' : 'Bookmark this page (Ctrl+D)'}
          className={cn(
            'grid size-7 shrink-0 place-items-center rounded-full text-muted-foreground',
            'hover:bg-foreground/[0.07] hover:text-foreground data-[state=open]:bg-foreground/[0.07]',
            'outline-none focus-visible:ring-2 focus-visible:ring-ring/60',
          )}
        >
          <Star className={cn('size-4.5', bookmark && 'fill-ink-accent text-ink-accent')} strokeWidth={1.75} aria-hidden />
        </button>
      </PopoverTrigger>
      <PopoverContent align="end" sideOffset={10} className="w-80">
        {bookmark && (
          <StarEditor
            key={bookmark.id}
            bookmark={bookmark}
            tree={tree}
            actions={actions}
            onClose={() => onOpenChange(false)}
            onOpenManager={() => {
              onOpenChange(false);
              onOpenManager();
            }}
          />
        )}
      </PopoverContent>
    </Popover>
  );
}

/** The star's popover: the bookmark's name and folder, changed as they're edited. */
function StarEditor({
  bookmark,
  tree,
  actions,
  onClose,
  onOpenManager,
}: {
  bookmark: Bookmark;
  tree: BookmarkTree;
  actions: BookmarkActions;
  onClose: () => void;
  onOpenManager: () => void;
}) {
  const [title, setTitle] = useState(bookmark.title);
  // Seconds old: this click (or Ctrl+D) is what made it.
  const [fresh] = useState(() => Date.now() / 1000 - bookmark.addedAt < 3);
  const parent = findBookmark(tree, bookmark.id)?.parent?.id ?? BOOKMARKS_BAR_ID;
  const folders = allFolders(tree);

  return (
    <form
      className="space-y-3"
      onSubmit={(e) => {
        e.preventDefault();
        e.stopPropagation();
        onClose();
      }}
    >
      <h3 className="text-sm font-medium">{fresh ? 'Bookmark added' : 'Edit bookmark'}</h3>
      <div className="space-y-1">
        <Label htmlFor="star-bookmark-title" className="text-xs">
          Name
        </Label>
        <Input
          id="star-bookmark-title"
          value={title}
          autoFocus
          onFocus={(e) => e.currentTarget.select()}
          onChange={(e) => {
            setTitle(e.target.value);
            if (e.target.value.trim()) actions.update(bookmark.id, { title: e.target.value });
          }}
          autoComplete="off"
          className="h-8"
        />
      </div>
      <div className="space-y-1">
        <Label htmlFor="star-bookmark-folder" className="text-xs">
          Folder
        </Label>
        <Select value={parent} onValueChange={(id) => actions.move(bookmark.id, id)}>
          <SelectTrigger id="star-bookmark-folder" className="h-8 w-full">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {folders.map(({ folder, depth }) => (
              <SelectItem key={folder.id} value={folder.id}>
                <span style={{ paddingInlineStart: depth * 12 }}>{folder.title}</span>
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>
      <div className="flex items-center gap-2 pt-1">
        <Button type="button" variant="link" size="sm" className="mr-auto h-8 px-0" onClick={onOpenManager}>
          All bookmarks
        </Button>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          onClick={() => {
            actions.remove([bookmark.id]);
            onClose();
          }}
        >
          Remove
        </Button>
        <Button type="submit" size="sm">
          Done
        </Button>
      </div>
    </form>
  );
}

// ---- the bookmarks bar ----

const chipClass = cn(
  'flex h-7 max-w-44 shrink-0 items-center gap-1.5 rounded-full px-2.5 text-[13px] text-foreground/85',
  'hover:bg-foreground/[0.07] hover:text-foreground data-[state=open]:bg-foreground/[0.07]',
  'outline-none focus-visible:ring-2 focus-visible:ring-ring/60',
);

/**
 * The bookmarks bar under the toolbar: the bar folder's bookmarks as
 * buttons, its folders as menus, and what doesn't fit behind a » menu. Drag
 * to reorder, or onto a folder to file; right-click for the rest.
 */
export function BookmarksBar({
  openers,
  onOpenManager,
  onImport,
  style,
}: {
  openers: BookmarkOpeners;
  onOpenManager: () => void;
  /** Import a bookmarks file (offered while the bar is empty). */
  onImport: () => void;
  style?: React.CSSProperties;
}) {
  const { tree, actions } = useBrowserBookmarks();
  const [shown, setShown] = useBookmarksBarShown();
  const [dialog, setDialog] = useState<BookmarkDialogState>(null);
  const onDelete = useDeleteBookmarks(actions);
  const handlers: BookmarkMenuHandlers = { openers, actions, tree, onEdit: (node) => setDialog({ kind: 'edit', node }), onDelete };
  const items = tree.bar.children;

  // How many items fit before the » menu takes the rest.
  const rowRef = useRef<HTMLDivElement>(null);
  const [fits, setFits] = useState(items.length);
  useLayoutEffect(() => {
    const row = rowRef.current;
    if (!row) return;
    const measure = () => {
      const limit = row.clientWidth;
      const chips = [...row.querySelectorAll<HTMLElement>('[data-bookmark-chip]')];
      // Room for the » button when anything spills.
      const all = chips.every((c) => c.offsetLeft + c.offsetWidth <= limit);
      const room = all ? limit : limit - 32;
      let n = 0;
      while (n < chips.length && chips[n].offsetLeft + chips[n].offsetWidth <= room) n += 1;
      setFits(n);
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(row);
    return () => observer.disconnect();
  }, [items]);

  // Where a dragged bookmark would land: before item `index`, or into folder `into`.
  const [drop, setDrop] = useState<{ index: number; into?: string } | null>(null);
  const dropAt = (e: React.DragEvent, index: number, node?: BookmarkNode) => {
    const rect = e.currentTarget.getBoundingClientRect();
    const x = (e.clientX - rect.left) / rect.width;
    if (node?.type === 'folder' && x > 0.25 && x < 0.75) return { index, into: node.id };
    return { index: x < 0.5 ? index : index + 1 };
  };
  const accepts = (e: React.DragEvent) =>
    e.dataTransfer.types.includes(BOOKMARK_DRAG_TYPE) || e.dataTransfer.types.includes('text/uri-list');
  const onDrop = (e: React.DragEvent, target: { index: number; into?: string }) => {
    e.preventDefault();
    setDrop(null);
    const id = draggedBookmarkId(e);
    if (id) {
      if (target.into) actions.move(id, target.into);
      else actions.move(id, BOOKMARKS_BAR_ID, target.index);
      return;
    }
    // A link from somewhere else: bookmark it there.
    const url = e.dataTransfer.getData('text/uri-list').split('\n').find((l) => l && !l.startsWith('#'))?.trim();
    if (!url || !isBookmarkableUrl(url)) return;
    actions.add({ url, title: e.dataTransfer.getData('text/plain') !== url ? e.dataTransfer.getData('text/plain') : null }, target.into ?? BOOKMARKS_BAR_ID, target.into ? undefined : target.index);
  };

  const barMenu: BookmarkMenuEntry[] = [
    ...folderMenu(tree.bar, handlers),
    'separator',
    { label: 'Show bookmarks bar', checked: shown, onSelect: () => setShown(!shown) },
    { label: 'Bookmarks', icon: Library, onSelect: onOpenManager },
  ];

  return (
    <>
      <ContextMenu>
        <ContextMenuTrigger asChild>
          <div
            role="toolbar"
            aria-label="Bookmarks bar"
            style={style}
            data-titlebar-seamless=""
            className="flex h-9 shrink-0 items-center gap-0.5 px-2 pb-1.5"
            onDragOver={(e) => {
              if (!accepts(e)) return;
              e.preventDefault();
              e.dataTransfer.dropEffect = draggedBookmarkId(e) !== null ? 'move' : 'copy';
              if (e.target === e.currentTarget || e.target === rowRef.current) setDrop({ index: items.length });
            }}
            onDragLeave={(e) => {
              if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setDrop(null);
            }}
            onDrop={(e) => onDrop(e, drop ?? { index: items.length })}
          >
            <div ref={rowRef} className="relative flex min-w-0 flex-1 items-center gap-0.5 overflow-hidden">
              {items.length === 0 && (
                <span className="flex min-w-0 items-center gap-2 truncate px-2 text-xs text-muted-foreground">
                  For quick access, put bookmarks here: click the star in the address bar, or drag a link.
                  <button
                    type="button"
                    onClick={onImport}
                    className="shrink-0 rounded px-1 font-medium text-foreground/80 underline-offset-2 hover:underline outline-none focus-visible:ring-2 focus-visible:ring-ring/60"
                  >
                    Import bookmarks…
                  </button>
                </span>
              )}
              {items.map((node, i) => (
                <div
                  key={node.id}
                  data-bookmark-chip=""
                  className={cn('relative shrink-0', i >= fits && 'invisible')}
                  aria-hidden={i >= fits || undefined}
                  onDragOver={(e) => {
                    if (!accepts(e)) return;
                    e.preventDefault();
                    e.stopPropagation();
                    setDrop(dropAt(e, i, node));
                  }}
                  onDrop={(e) => {
                    e.stopPropagation();
                    onDrop(e, dropAt(e, i, node));
                  }}
                >
                  {drop && !drop.into && drop.index === i && <DropMarker side="left" />}
                  {drop && !drop.into && drop.index === i + 1 && i === items.length - 1 && <DropMarker side="right" />}
                  {node.type === 'bookmark' ? (
                    <BarBookmark bookmark={node} handlers={handlers} tabIndex={i >= fits ? -1 : undefined} />
                  ) : (
                    <BarFolder
                      folder={node}
                      handlers={handlers}
                      highlighted={drop?.into === node.id}
                      tabIndex={i >= fits ? -1 : undefined}
                    />
                  )}
                </div>
              ))}
            </div>
            {fits < items.length && (
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <button type="button" aria-label="More bookmarks" title="More bookmarks" className={cn(chipClass, 'px-1.5')}>
                    <ChevronsRight className="size-4.5" strokeWidth={1.75} aria-hidden />
                  </button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end" className="max-h-96 w-64 overflow-y-auto">
                  <FolderMenuItems nodes={items.slice(fits)} handlers={handlers} />
                </DropdownMenuContent>
              </DropdownMenu>
            )}
          </div>
        </ContextMenuTrigger>
        <ContextMenuContent className="w-56">
          <ContextMenuEntries entries={barMenu} />
        </ContextMenuContent>
      </ContextMenu>
      <BookmarkEditDialog state={dialog} actions={actions} onClose={() => setDialog(null)} />
    </>
  );
}

function DropMarker({ side }: { side: 'left' | 'right' }) {
  return (
    <span
      aria-hidden
      className={cn('absolute inset-y-1 z-10 w-0.5 rounded-full bg-ink-accent', side === 'left' ? '-left-px' : '-right-px')}
    />
  );
}

/** Opens on click, in a background tab on a middle click. */
function BarBookmark({ bookmark, handlers, tabIndex }: { bookmark: Bookmark; handlers: BookmarkMenuHandlers; tabIndex?: number }) {
  const { openers } = handlers;
  return (
    <ContextMenu>
      <ContextMenuTrigger asChild>
        <button
          type="button"
          title={`${bookmark.title}\n${bookmark.url}`}
          tabIndex={tabIndex}
          draggable
          onDragStart={(e) => startBookmarkDrag(e, bookmark)}
          onClick={(e) => (e.ctrlKey || e.metaKey ? openers.openInNewTab(bookmark.url, !e.shiftKey) : openers.open(bookmark.url))}
          onAuxClick={(e) => {
            if (e.button === 1) openers.openInNewTab(bookmark.url, true);
          }}
          onContextMenu={(e) => e.stopPropagation()}
          className={chipClass}
        >
          <BookmarkNodeIcon node={bookmark} className="size-4 shrink-0" />
          <span className="truncate">{bookmark.title}</span>
        </button>
      </ContextMenuTrigger>
      <ContextMenuContent className="w-52" onCloseAutoFocus={(e) => e.preventDefault()}>
        <ContextMenuEntries entries={bookmarkMenu(bookmark, handlers)} />
      </ContextMenuContent>
    </ContextMenu>
  );
}

/** A folder on the bar: a menu of what's in it. */
function BarFolder({
  folder,
  handlers,
  highlighted,
  tabIndex,
}: {
  folder: BookmarkFolder;
  handlers: BookmarkMenuHandlers;
  highlighted: boolean;
  tabIndex?: number;
}) {
  return (
    <ContextMenu>
      <DropdownMenu>
        <ContextMenuTrigger asChild>
          <DropdownMenuTrigger asChild>
            <button
              type="button"
              title={folder.title}
              tabIndex={tabIndex}
              draggable
              onDragStart={(e) => startBookmarkDrag(e, folder)}
              onContextMenu={(e) => e.stopPropagation()}
              className={cn(chipClass, highlighted && 'bg-selected ring-2 ring-ring/60')}
            >
              <Folder className="size-4.5 shrink-0 text-ink-accent" strokeWidth={1.75} aria-hidden />
              <span className="truncate">{folder.title}</span>
            </button>
          </DropdownMenuTrigger>
        </ContextMenuTrigger>
        <DropdownMenuContent align="start" className="max-h-96 w-64 overflow-y-auto">
          <FolderMenuItems nodes={folder.children} handlers={handlers} folder={folder} />
        </DropdownMenuContent>
      </DropdownMenu>
      <ContextMenuContent className="w-56" onCloseAutoFocus={(e) => e.preventDefault()}>
        <ContextMenuEntries entries={folderMenu(folder, handlers)} />
      </ContextMenuContent>
    </ContextMenu>
  );
}

/** A folder's contents as menu items, subfolders as submenus, and "Open all" under them. */
function FolderMenuItems({
  nodes,
  handlers,
  folder,
}: {
  nodes: BookmarkNode[];
  handlers: BookmarkMenuHandlers;
  folder?: BookmarkFolder;
}) {
  const { openers } = handlers;
  const links = nodes.filter((n): n is Bookmark => n.type === 'bookmark');
  return (
    <>
      {nodes.length === 0 && <DropdownMenuItem disabled>(empty)</DropdownMenuItem>}
      {nodes.map((node) =>
        node.type === 'bookmark' ? (
          <DropdownMenuItem
            key={node.id}
            title={node.url}
            onSelect={() => openers.open(node.url)}
            onAuxClick={(e) => {
              if (e.button === 1) openers.openInNewTab(node.url, true);
            }}
          >
            <BookmarkNodeIcon node={node} className="size-4 shrink-0" />
            <span className="truncate">{node.title}</span>
          </DropdownMenuItem>
        ) : (
          <DropdownMenuSub key={node.id}>
            <DropdownMenuSubTrigger className="gap-2">
              <Folder className="size-4.5 shrink-0 text-ink-accent" strokeWidth={1.75} aria-hidden />
              <span className="truncate">{node.title}</span>
            </DropdownMenuSubTrigger>
            <DropdownMenuSubContent className="max-h-96 w-64 overflow-y-auto">
              <FolderMenuItems nodes={node.children} handlers={handlers} folder={node} />
            </DropdownMenuSubContent>
          </DropdownMenuSub>
        ),
      )}
      {folder && links.length > 1 && (
        <>
          <DropdownMenuSeparator />
          <DropdownMenuItem onSelect={() => links.forEach((b, i) => openers.openInNewTab(b.url, i > 0))}>
            <SquarePlus aria-hidden />
            Open all ({links.length}) in new tabs
          </DropdownMenuItem>
        </>
      )}
    </>
  );
}
