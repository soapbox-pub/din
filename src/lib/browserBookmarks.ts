import { z } from 'zod';

/**
 * The web browser's bookmarks, kept on this device only, in localStorage: one
 * tree per account, never synced to relays. Like Chrome's, the tree has two
 * fixed folders: the bookmarks bar, shown under the toolbar, and Other
 * bookmarks, for the rest. Each account's tree is read once and every change
 * is written through, so the star in the address bar and the bar itself
 * answer synchronously.
 *
 * They go in and out of Din as a Netscape bookmark file (bookmarks.html, see
 * `bookmarkFile.ts`), the format every browser imports and exports.
 */

/** A saved page. */
export interface Bookmark {
  type: 'bookmark';
  id: string;
  title: string;
  url: string;
  /** Unix seconds it was added. */
  addedAt: number;
  /** The page's favicon (http(s) only), when it reported one. */
  icon?: string;
}

/** A folder of bookmarks and folders. */
export interface BookmarkFolder {
  type: 'folder';
  id: string;
  title: string;
  addedAt: number;
  children: BookmarkNode[];
}

export type BookmarkNode = Bookmark | BookmarkFolder;

/** An account's bookmarks: the two fixed folders. */
export interface BookmarkTree {
  bar: BookmarkFolder;
  other: BookmarkFolder;
}

/** The fixed folders' ids, which can't be renamed, moved or removed. */
export const BOOKMARKS_BAR_ID = 'bar';
export const OTHER_BOOKMARKS_ID = 'other';

export function isRootFolder(id: string): boolean {
  return id === BOOKMARKS_BAR_ID || id === OTHER_BOOKMARKS_ID;
}

const MAX_URL_LENGTH = 4096;
const MAX_TITLE_LENGTH = 300;

/**
 * Whether a URL can be bookmarked: pages the browser opens (https and http,
 * nsites, nostr: and blossom: links). Never javascript: or data:, so an imported file
 * can't plant a bookmarklet that runs in the browser's chrome.
 */
export function isBookmarkableUrl(url: string): boolean {
  return url.length <= MAX_URL_LENGTH && /^(https?:\/\/|nsite:\/\/|nostr:|blossom:)/i.test(url);
}

/** A favicon worth keeping: a plain http(s) URL, not a data: URI. */
export function cleanIcon(icon: string | null | undefined): string | undefined {
  return icon && /^https?:\/\//i.test(icon) && icon.length <= MAX_URL_LENGTH ? icon : undefined;
}

export function cleanTitle(title: string): string {
  return title.replace(/\s+/g, ' ').trim().slice(0, MAX_TITLE_LENGTH);
}

const nodeSchema: z.ZodType<BookmarkNode> = z.lazy(() =>
  z.discriminatedUnion('type', [
    z.object({
      type: z.literal('bookmark'),
      id: z.string(),
      title: z.string(),
      url: z.string().refine(isBookmarkableUrl),
      addedAt: z.number(),
      icon: z.string().optional(),
    }),
    z.object({
      type: z.literal('folder'),
      id: z.string(),
      title: z.string(),
      addedAt: z.number(),
      children: z.array(nodeSchema),
    }),
  ]),
);

const treeSchema = z.object({ bar: z.array(nodeSchema), other: z.array(nodeSchema) });

export function newId(): string {
  return crypto.randomUUID();
}

function now(): number {
  return Math.floor(Date.now() / 1000);
}

function emptyTree(): BookmarkTree {
  return {
    bar: { type: 'folder', id: BOOKMARKS_BAR_ID, title: 'Bookmarks bar', addedAt: 0, children: [] },
    other: { type: 'folder', id: OTHER_BOOKMARKS_ID, title: 'Other bookmarks', addedAt: 0, children: [] },
  };
}

const trees = new Map<string, BookmarkTree>();
const listeners = new Set<() => void>();

function storageKey(owner: string): string {
  return `din-browser-bookmarks:${owner}`;
}

/** Subscribe to changes in any account's bookmarks. Returns an unsubscribe fn. */
export function subscribeBookmarks(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** An account's bookmarks. Stable until they change. */
export function getBookmarks(owner: string): BookmarkTree {
  let tree = trees.get(owner);
  if (!tree) {
    tree = emptyTree();
    try {
      const raw = localStorage.getItem(storageKey(owner));
      const parsed = raw ? treeSchema.safeParse(JSON.parse(raw)) : null;
      if (parsed?.success) {
        tree.bar.children = parsed.data.bar;
        tree.other.children = parsed.data.other;
      } else if (parsed) {
        console.warn('Ignoring unreadable browser bookmarks:', parsed.error);
      }
    } catch (error) {
      console.warn('Failed to load browser bookmarks:', error);
    }
    trees.set(owner, tree);
  }
  return tree;
}

function save(owner: string, tree: BookmarkTree): void {
  trees.set(owner, tree);
  try {
    localStorage.setItem(
      storageKey(owner),
      JSON.stringify({ bar: tree.bar.children, other: tree.other.children }),
    );
  } catch (error) {
    console.warn('Failed to save browser bookmarks:', error);
  }
  for (const listener of listeners) listener();
}

// ---- reading the tree ----

/** Every node in a folder, depth first, with the folder each is in. */
export function* walkBookmarks(
  folder: BookmarkFolder,
): Generator<{ node: BookmarkNode; parent: BookmarkFolder }> {
  for (const node of folder.children) {
    yield { node, parent: folder };
    if (node.type === 'folder') yield* walkBookmarks(node);
  }
}

function* walkTree(tree: BookmarkTree): Generator<{ node: BookmarkNode; parent: BookmarkFolder }> {
  yield* walkBookmarks(tree.bar);
  yield* walkBookmarks(tree.other);
}

/** A node by id (the fixed folders included), with its parent (null for those). */
export function findBookmark(
  tree: BookmarkTree,
  id: string,
): { node: BookmarkNode; parent: BookmarkFolder | null } | null {
  if (id === BOOKMARKS_BAR_ID) return { node: tree.bar, parent: null };
  if (id === OTHER_BOOKMARKS_ID) return { node: tree.other, parent: null };
  for (const entry of walkTree(tree)) if (entry.node.id === id) return entry;
  return null;
}

/** The bookmarks of one URL, wherever they are. */
export function bookmarksOfUrl(tree: BookmarkTree, url: string): Bookmark[] {
  const found: Bookmark[] = [];
  for (const { node } of walkTree(tree)) {
    if (node.type === 'bookmark' && node.url === url) found.push(node);
  }
  return found;
}

/** Every bookmark, depth first, bar first. */
export function allBookmarks(tree: BookmarkTree): Bookmark[] {
  const found: Bookmark[] = [];
  for (const { node } of walkTree(tree)) if (node.type === 'bookmark') found.push(node);
  return found;
}

/** Every folder, the fixed ones first, each with its path ("Bookmarks bar / News"). */
export function allFolders(tree: BookmarkTree): { folder: BookmarkFolder; path: string; depth: number }[] {
  const out: { folder: BookmarkFolder; path: string; depth: number }[] = [];
  const visit = (folder: BookmarkFolder, path: string, depth: number) => {
    out.push({ folder, path, depth });
    for (const child of folder.children) {
      if (child.type === 'folder') visit(child, `${path} / ${child.title}`, depth + 1);
    }
  };
  visit(tree.bar, tree.bar.title, 0);
  visit(tree.other, tree.other.title, 0);
  return out;
}

/** Whether `id` is `folderId` or somewhere inside it. */
function isWithin(tree: BookmarkTree, folderId: string, id: string): boolean {
  const found = findBookmark(tree, folderId);
  if (!found || found.node.type !== 'folder') return false;
  if (folderId === id) return true;
  for (const { node } of walkBookmarks(found.node)) if (node.id === id) return true;
  return false;
}

// ---- changing the tree ----

/** A copy of a folder with `fn` applied to the folder `id` inside it (or itself). */
function mapFolder(
  folder: BookmarkFolder,
  id: string,
  fn: (folder: BookmarkFolder) => BookmarkFolder,
): BookmarkFolder {
  if (folder.id === id) return fn(folder);
  let changed = false;
  const children = folder.children.map((child) => {
    if (child.type !== 'folder') return child;
    const next = mapFolder(child, id, fn);
    if (next !== child) changed = true;
    return next;
  });
  return changed ? { ...folder, children } : folder;
}

function updateFolder(
  tree: BookmarkTree,
  id: string,
  fn: (folder: BookmarkFolder) => BookmarkFolder,
): BookmarkTree {
  return { bar: mapFolder(tree.bar, id, fn), other: mapFolder(tree.other, id, fn) };
}

/** A copy of a folder without the nodes `ids`, anywhere in it. */
function without(folder: BookmarkFolder, ids: ReadonlySet<string>): BookmarkFolder {
  let changed = false;
  const children: BookmarkNode[] = [];
  for (const child of folder.children) {
    if (ids.has(child.id)) {
      changed = true;
      continue;
    }
    const next = child.type === 'folder' ? without(child, ids) : child;
    if (next !== child) changed = true;
    children.push(next);
  }
  return changed ? { ...folder, children } : folder;
}

function insert(tree: BookmarkTree, parentId: string, node: BookmarkNode, index?: number): BookmarkTree {
  return updateFolder(tree, parentId, (folder) => {
    const children = [...folder.children];
    const at = index === undefined ? children.length : Math.max(0, Math.min(index, children.length));
    children.splice(at, 0, node);
    return { ...folder, children };
  });
}

function folderExists(tree: BookmarkTree, id: string): boolean {
  return findBookmark(tree, id)?.node.type === 'folder';
}

/**
 * Bookmark a page, in `parentId` (the bookmarks bar by default), at the end
 * or at `index`. Returns the new bookmark, or null for a URL that can't be.
 */
export function addBookmark(
  owner: string,
  page: { url: string; title?: string | null; icon?: string | null },
  parentId: string = BOOKMARKS_BAR_ID,
  index?: number,
): Bookmark | null {
  if (!isBookmarkableUrl(page.url)) return null;
  const tree = getBookmarks(owner);
  if (!folderExists(tree, parentId)) return null;
  const bookmark: Bookmark = {
    type: 'bookmark',
    id: newId(),
    title: cleanTitle(page.title ?? '') || page.url,
    url: page.url,
    addedAt: now(),
    icon: cleanIcon(page.icon),
  };
  save(owner, insert(tree, parentId, bookmark, index));
  return bookmark;
}

/** Make a folder in `parentId`. Returns it, or null when there's no such parent. */
export function addBookmarkFolder(
  owner: string,
  title: string,
  parentId: string = BOOKMARKS_BAR_ID,
  index?: number,
): BookmarkFolder | null {
  const tree = getBookmarks(owner);
  if (!folderExists(tree, parentId)) return null;
  const folder: BookmarkFolder = {
    type: 'folder',
    id: newId(),
    title: cleanTitle(title) || 'New folder',
    addedAt: now(),
    children: [],
  };
  save(owner, insert(tree, parentId, folder, index));
  return folder;
}

/** Rename a bookmark or folder, or change a bookmark's address. */
export function updateBookmark(owner: string, id: string, changes: { title?: string; url?: string }): boolean {
  if (isRootFolder(id)) return false;
  const tree = getBookmarks(owner);
  const found = findBookmark(tree, id);
  if (!found?.parent) return false;
  if (changes.url !== undefined && (found.node.type !== 'bookmark' || !isBookmarkableUrl(changes.url))) {
    return false;
  }
  const node = found.node;
  const title = changes.title === undefined ? node.title : cleanTitle(changes.title) || node.title;
  const next: BookmarkNode =
    node.type === 'bookmark'
      ? { ...node, title, url: changes.url ?? node.url, icon: changes.url && changes.url !== node.url ? undefined : node.icon }
      : { ...node, title };
  save(
    owner,
    updateFolder(tree, found.parent.id, (folder) => ({
      ...folder,
      children: folder.children.map((c) => (c.id === id ? next : c)),
    })),
  );
  return true;
}

/** A node taken out of the tree, and where it was, so it can be put back. */
export interface RemovedBookmark {
  node: BookmarkNode;
  parentId: string;
  index: number;
}

/** Remove bookmarks and folders (with everything in them). Returns what went, for `restoreBookmarks`. */
export function removeBookmarks(owner: string, ids: string[]): RemovedBookmark[] {
  const tree = getBookmarks(owner);
  const removed: RemovedBookmark[] = [];
  const set = new Set<string>();
  for (const id of ids) {
    if (isRootFolder(id) || set.has(id)) continue;
    const found = findBookmark(tree, id);
    if (!found?.parent) continue;
    set.add(id);
    removed.push({ node: found.node, parentId: found.parent.id, index: found.parent.children.indexOf(found.node) });
  }
  if (!set.size) return [];
  save(owner, { bar: without(tree.bar, set), other: without(tree.other, set) });
  return removed;
}

/** Undo `removeBookmarks`: each node back where it was, or in Other bookmarks when its folder's gone too. */
export function restoreBookmarks(owner: string, removed: RemovedBookmark[]): void {
  let tree = getBookmarks(owner);
  for (const { node, parentId, index } of [...removed].sort((a, b) => a.index - b.index)) {
    if (findBookmark(tree, node.id)) continue;
    tree = insert(tree, folderExists(tree, parentId) ? parentId : OTHER_BOOKMARKS_ID, node, index);
  }
  save(owner, tree);
}

// ---- the bookmarks bar's visibility ----

const BAR_KEY = 'din:browser:bookmarks-bar';
let barShown: boolean | null = null;

/**
 * Whether the bookmarks bar shows under every page, or (false) only on the
 * new-tab page, as Chrome's does. One setting for every account and window.
 */
export function isBookmarksBarShown(): boolean {
  if (barShown === null) {
    try {
      barShown = localStorage.getItem(BAR_KEY) === 'true';
    } catch {
      barShown = false;
    }
  }
  return barShown;
}

export function setBookmarksBarShown(shown: boolean): void {
  barShown = shown;
  try {
    localStorage.setItem(BAR_KEY, String(shown));
  } catch (error) {
    console.warn('Failed to save the bookmarks bar setting:', error);
  }
  for (const listener of listeners) listener();
}

/**
 * Move a bookmark or folder into `parentId`, before the node at `index` as
 * the folder is now (the end when it's left out). A folder can't go into
 * itself.
 */
export function moveBookmark(owner: string, id: string, parentId: string, index?: number): boolean {
  if (isRootFolder(id)) return false;
  const tree = getBookmarks(owner);
  const found = findBookmark(tree, id);
  if (!found?.parent || !folderExists(tree, parentId) || isWithin(tree, id, parentId)) return false;
  let at = index;
  // Taking it out first shifts what comes after it in the same folder.
  if (at !== undefined && found.parent.id === parentId) {
    const from = found.parent.children.findIndex((c) => c.id === id);
    if (from < at) at -= 1;
  }
  const removed = { bar: without(tree.bar, new Set([id])), other: without(tree.other, new Set([id])) };
  save(owner, insert(removed, parentId, found.node, at));
  return true;
}

/**
 * Add nodes into a folder the way an import does: a folder named like one
 * already there is merged into it, and a bookmark of an address already
 * directly in the folder is skipped, so importing the same file twice
 * changes nothing. Returns how many bookmarks were added.
 */
function mergeInto(folder: BookmarkFolder, incoming: BookmarkNode[]): { folder: BookmarkFolder; added: number } {
  const children = [...folder.children];
  let added = 0;
  for (const node of incoming) {
    if (node.type === 'bookmark') {
      if (children.some((c) => c.type === 'bookmark' && c.url === node.url)) continue;
      children.push(node);
      added += 1;
      continue;
    }
    const index = children.findIndex((c) => c.type === 'folder' && c.title === node.title);
    if (index < 0) {
      children.push(node);
      for (const { node: inner } of walkBookmarks(node)) if (inner.type === 'bookmark') added += 1;
      continue;
    }
    const merged = mergeInto(children[index] as BookmarkFolder, node.children);
    children[index] = merged.folder;
    added += merged.added;
  }
  return { folder: { ...folder, children }, added };
}

/**
 * Add an imported tree: what was on the other browser's bookmarks bar goes on
 * this one's, the rest in Other bookmarks, merged with what's there (see
 * `mergeInto`). Returns how many bookmarks were added.
 */
export function importBookmarks(owner: string, imported: { bar: BookmarkNode[]; other: BookmarkNode[] }): number {
  const tree = getBookmarks(owner);
  const bar = mergeInto(tree.bar, imported.bar);
  const other = mergeInto(tree.other, imported.other);
  if (bar.added + other.added === 0) return 0;
  save(owner, { bar: bar.folder, other: other.folder });
  return bar.added + other.added;
}
