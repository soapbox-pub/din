import { useCallback, useMemo, useSyncExternalStore } from 'react';
import { useCurrentUser } from '@/hooks/useCurrentUser';
import { useToast } from '@/hooks/useToast';
import { useFilePicker } from '@/contexts/FilePickerContext';
import { cleanFsError } from '@/lib/fs';
import { bookmarkFileName, exportBookmarkFileTo, importBookmarkFileAt } from '@/lib/bookmarkFile';
import {
  addBookmark,
  addBookmarkFolder,
  getBookmarks,
  moveBookmark,
  isBookmarksBarShown,
  removeBookmarks,
  restoreBookmarks,
  setBookmarksBarShown,
  subscribeBookmarks,
  updateBookmark,
  type BookmarkNode,
  type BookmarkTree,
  type RemovedBookmark,
} from '@/lib/browserBookmarks';

export interface BookmarkActions {
  add: (page: { url: string; title?: string | null; icon?: string | null }, parentId?: string, index?: number) => ReturnType<typeof addBookmark>;
  addFolder: (title: string, parentId?: string, index?: number) => ReturnType<typeof addBookmarkFolder>;
  update: (id: string, changes: { title?: string; url?: string }) => boolean;
  remove: (ids: string[]) => RemovedBookmark[];
  restore: (removed: RemovedBookmark[]) => void;
  move: (id: string, parentId: string, index?: number) => boolean;
}

/**
 * The web browser's bookmarks for the signed-in account (see
 * `browserBookmarks`), kept on this device only; they never sync to relays.
 */
export function useBrowserBookmarks(): { owner: string; tree: BookmarkTree; actions: BookmarkActions } {
  const { user } = useCurrentUser();
  const owner = user?.pubkey ?? 'local';
  const tree = useSyncExternalStore(subscribeBookmarks, () => getBookmarks(owner));

  const add = useCallback<BookmarkActions['add']>((page, parentId, index) => addBookmark(owner, page, parentId, index), [owner]);
  const addFolder = useCallback<BookmarkActions['addFolder']>((title, parentId, index) => addBookmarkFolder(owner, title, parentId, index), [owner]);
  const update = useCallback<BookmarkActions['update']>((id, changes) => updateBookmark(owner, id, changes), [owner]);
  const remove = useCallback<BookmarkActions['remove']>((ids) => removeBookmarks(owner, ids), [owner]);
  const restore = useCallback<BookmarkActions['restore']>((removed) => restoreBookmarks(owner, removed), [owner]);
  const move = useCallback<BookmarkActions['move']>((id, parentId, index) => moveBookmark(owner, id, parentId, index), [owner]);
  const actions = useMemo(() => ({ add, addFolder, update, remove, restore, move }), [add, addFolder, update, remove, restore, move]);

  return { owner, tree, actions };
}

/** Whether the bookmarks bar shows on every page (see `isBookmarksBarShown`), and a way to change it. */
export function useBookmarksBarShown(): [boolean, (shown: boolean) => void] {
  return [useSyncExternalStore(subscribeBookmarks, isBookmarksBarShown), setBookmarksBarShown];
}

/**
 * Delete with an Undo on the notification, rather than asking first: what
 * went comes back where it was.
 */
export function useDeleteBookmarks(actions: BookmarkActions): (nodes: BookmarkNode[]) => void {
  const { toast } = useToast();
  return (nodes) => {
    const removed = actions.remove(nodes.map((n) => n.id));
    if (!removed.length) return;
    const one = removed.length === 1 ? removed[0].node : null;
    toast({
      title: one ? `Deleted “${one.title}”` : `Deleted ${removed.length} bookmarks`,
      actions: [{ id: 'undo', label: 'Undo' }],
      onAction: (action) => {
        if (action === 'undo') actions.restore(removed);
      },
    });
  };
}

function plural(n: number): string {
  return n === 1 ? '1 bookmark' : `${n.toLocaleString()} bookmarks`;
}

/**
 * Importing a bookmarks.html file the user picks, and exporting every
 * bookmark to one they name, with Din's file dialogs (desktop only).
 */
export function useBookmarkFiles(): { importFile: () => Promise<void>; exportFile: () => Promise<void> } {
  const { user } = useCurrentUser();
  const owner = user?.pubkey ?? 'local';
  const { pickFile, pickFiles } = useFilePicker();
  const { toast } = useToast();

  const importFile = useCallback(async () => {
    const path = await pickFile({
      title: 'Import bookmarks',
      confirmLabel: 'Import',
      extensions: ['.html', '.htm'],
    }).catch(() => null);
    if (!path) return;
    try {
      const { found, added } = await importBookmarkFileAt(owner, path);
      toast({
        title: added ? `Imported ${plural(added)}` : 'No new bookmarks',
        description:
          added === found
            ? 'Your other browser’s bookmarks bar is on this one’s; the rest are in Other bookmarks.'
            : `${plural(found - added)} in that file ${found - added === 1 ? 'was' : 'were'} already here.`,
      });
    } catch (error) {
      toast({ title: 'Couldn’t import bookmarks', description: cleanFsError(error), variant: 'destructive' });
    }
  }, [owner, pickFile, toast]);

  const exportFile = useCallback(async () => {
    const result = await pickFiles({
      mode: 'save',
      title: 'Export bookmarks',
      confirmLabel: 'Export',
      currentName: bookmarkFileName(),
      extensions: ['.html'],
    }).catch(() => null);
    const path = result?.paths[0];
    if (!path) return;
    try {
      const count = await exportBookmarkFileTo(owner, path);
      toast({ title: `Exported ${plural(count)}`, description: path.slice(path.lastIndexOf('/') + 1) });
    } catch (error) {
      toast({ title: 'Couldn’t export bookmarks', description: cleanFsError(error), variant: 'destructive' });
    }
  }, [owner, pickFiles, toast]);

  return { importFile, exportFile };
}
