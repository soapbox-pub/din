import {
  Copy,
  ExternalLink,
  FolderInput,
  FolderPlus,
  Globe,
  Pencil,
  SquarePlus,
  Trash2,
  type LucideIcon,
} from 'lucide-react';
import {
  allFolders,
  findBookmark,
  isRootFolder,
  type Bookmark,
  type BookmarkFolder,
  type BookmarkNode,
  type BookmarkTree,
} from '@/lib/browserBookmarks';
import type { DragEvent } from 'react';
import type { BookmarkActions } from '@/hooks/useBrowserBookmarks';

/**
 * The bookmarks' menus, as data, so a bookmark's ⋯ menu and its right-click
 * menu (BrowserBookmarks' ContextMenuEntries / DropdownMenuEntries) offer the
 * same items, and how bookmarks are dragged.
 */

/** Where the browser window hosting the bookmarks opens them. */
export interface BookmarkOpeners {
  /** In the tab the user is in. */
  open: (url: string) => void;
  /** In a new tab, brought to the front unless `background`. */
  openInNewTab: (url: string, background?: boolean) => void;
  /** In a window of its own (absent in private windows). */
  openInNewWindow?: (url: string) => void;
}

/** One item of a bookmark's menu, rendered the same in its ⋯ menu and its right-click menu. */
export type BookmarkMenuEntry =
  | 'separator'
  | {
      label: string;
      icon?: LucideIcon;
      onSelect?: () => void;
      destructive?: boolean;
      disabled?: boolean;
      /** A checkbox item, ticked or not. */
      checked?: boolean;
      /** A submenu. */
      items?: BookmarkMenuEntry[];
    };

/** What a bookmark or folder's menus offer. */
export interface BookmarkMenuHandlers {
  openers: BookmarkOpeners;
  actions: BookmarkActions;
  tree: BookmarkTree;
  /** Edit (rename, or change the address of) a node. */
  onEdit: (node: BookmarkNode) => void;
  /** Delete nodes, offering to undo. */
  onDelete: (nodes: BookmarkNode[]) => void;
}

function bookmarksIn(folder: BookmarkFolder): Bookmark[] {
  return folder.children.filter((c): c is Bookmark => c.type === 'bookmark');
}

/** The folders a node can move into, indented by depth, as a submenu. */
function moveEntries(node: BookmarkNode, { tree, actions }: BookmarkMenuHandlers): BookmarkMenuEntry[] {
  const current = findBookmark(tree, node.id)?.parent?.id;
  const inside = new Set<string>([node.id]);
  if (node.type === 'folder') {
    const collect = (f: BookmarkFolder) => {
      for (const c of f.children) {
        if (c.type === 'folder') {
          inside.add(c.id);
          collect(c);
        }
      }
    };
    collect(node);
  }
  return allFolders(tree)
    .filter(({ folder }) => !inside.has(folder.id))
    .map(({ folder, depth }) => ({
      label: `${' '.repeat(depth)}${folder.title}`,
      disabled: folder.id === current,
      onSelect: () => void actions.move(node.id, folder.id),
    }));
}

/** A bookmark's menu: open it, edit, move, copy its address, delete. */
export function bookmarkMenu(bookmark: Bookmark, handlers: BookmarkMenuHandlers): BookmarkMenuEntry[] {
  const { openers, onEdit, onDelete } = handlers;
  return [
    { label: 'Open', icon: Globe, onSelect: () => openers.open(bookmark.url) },
    { label: 'Open in new tab', icon: SquarePlus, onSelect: () => openers.openInNewTab(bookmark.url) },
    ...(openers.openInNewWindow
      ? [{ label: 'Open in new window', icon: ExternalLink, onSelect: () => openers.openInNewWindow?.(bookmark.url) }]
      : []),
    'separator',
    { label: 'Edit…', icon: Pencil, onSelect: () => onEdit(bookmark) },
    { label: 'Move to', icon: FolderInput, items: moveEntries(bookmark, handlers) },
    { label: 'Copy link', icon: Copy, onSelect: () => void navigator.clipboard?.writeText(bookmark.url).catch(() => {}) },
    'separator',
    { label: 'Delete', icon: Trash2, destructive: true, onSelect: () => onDelete([bookmark]) },
  ];
}

/** A folder's menu: open everything in it, rename, move, delete. */
export function folderMenu(folder: BookmarkFolder, handlers: BookmarkMenuHandlers, extra: BookmarkMenuEntry[] = []): BookmarkMenuEntry[] {
  const { openers, onEdit, onDelete, actions } = handlers;
  const links = bookmarksIn(folder);
  const root = isRootFolder(folder.id);
  return [
    ...extra,
    {
      label: links.length ? `Open all (${links.length}) in new tabs` : 'Open all in new tabs',
      icon: SquarePlus,
      disabled: !links.length,
      onSelect: () => links.forEach((b, i) => openers.openInNewTab(b.url, i > 0)),
    },
    { label: 'New folder', icon: FolderPlus, onSelect: () => void actions.addFolder('New folder', folder.id) },
    ...(root
      ? []
      : [
          'separator' as const,
          { label: 'Rename…', icon: Pencil, onSelect: () => onEdit(folder) },
          { label: 'Move to', icon: FolderInput, items: moveEntries(folder, handlers) },
          'separator' as const,
          { label: 'Delete', icon: Trash2, destructive: true, onSelect: () => onDelete([folder]) },
        ]),
  ];
}

/** What a dragged bookmark carries, so only bookmarks drop where bookmarks go. */
export const BOOKMARK_DRAG_TYPE = 'application/x-din-bookmark';

export function draggedBookmarkId(e: DragEvent): string | null {
  return e.dataTransfer.types.includes(BOOKMARK_DRAG_TYPE) ? e.dataTransfer.getData(BOOKMARK_DRAG_TYPE) || '' : null;
}

export function startBookmarkDrag(e: DragEvent, node: BookmarkNode): void {
  e.dataTransfer.setData(BOOKMARK_DRAG_TYPE, node.id);
  if (node.type === 'bookmark') {
    e.dataTransfer.setData('text/uri-list', node.url);
    e.dataTransfer.setData('text/plain', node.url);
  }
  e.dataTransfer.effectAllowed = 'copyMove';
}
