import { exportBookmarkFileTo, importBookmarkFileAt } from '@/lib/bookmarkFile';
import {
  addBookmark,
  addBookmarkFolder,
  allFolders,
  findBookmark,
  getBookmarks,
  isBookmarkableUrl,
  isRootFolder,
  moveBookmark,
  removeBookmarks,
  setBookmarksBarShown,
  updateBookmark,
  walkBookmarks,
  type BookmarkFolder,
  type BookmarkNode,
} from '@/lib/browserBookmarks';
import { getFsBridge } from '@/lib/fs';
import { CommandError, type Command, type CommandContext, type Param } from './types';
import { call, command, need, pick } from './util';

/**
 * `din browser` bookmark commands: the Web Browser's bookmarks, as its star,
 * bookmarks bar and about:bookmarks have them, on this device only, for the
 * signed-in account. Import and export are bookmarks.html files, the format
 * every browser reads.
 */

const ownerOf = (ctx: CommandContext) => ctx.pubkey ?? 'local';

const BOOKMARK: Param = { name: 'bookmark', type: 'string', positional: true, help: 'Its id, address or name (din browser bookmarks)' };
const FOLDER_HELP = 'A folder’s id, name or path, e.g. “Bookmarks bar / News” (default: the bookmarks bar)';

function nodes(ctx: CommandContext): { node: BookmarkNode; folder: string }[] {
  const tree = getBookmarks(ownerOf(ctx));
  const paths = new Map(allFolders(tree).map((f) => [f.folder.id, f.path]));
  return [tree.bar, tree.other].flatMap((root) =>
    [...walkBookmarks(root)].map(({ node, parent }) => ({ node, folder: paths.get(parent.id) ?? parent.title })),
  );
}

function pickNode(ctx: CommandContext, query: string): BookmarkNode {
  return pick(nodes(ctx), query, ({ node }) => [node.id, node.type === 'bookmark' ? node.url : null, node.title], 'bookmark or folder').node;
}

function pickFolder(ctx: CommandContext, query: string | undefined): BookmarkFolder {
  const tree = getBookmarks(ownerOf(ctx));
  if (query === undefined) return tree.bar;
  return pick(allFolders(tree), query, (f) => [f.folder.id, f.folder.title, f.path], 'folder').folder;
}

function row(node: BookmarkNode, folder: string) {
  return {
    id: node.id,
    type: node.type,
    title: node.title,
    url: node.type === 'bookmark' ? node.url : null,
    folder,
    added: node.addedAt ? new Date(node.addedAt * 1000).toISOString() : null,
  };
}

/** `~/x` from the command line, made absolute. */
async function absolute(path: string): Promise<string> {
  if (path !== '~' && !path.startsWith('~/')) return path;
  const home = await call(need(getFsBridge(), 'Files').homedir());
  return `${home.replace(/\/+$/, '')}${path.slice(1)}`;
}

function count(folder: BookmarkFolder): number {
  let n = 0;
  for (const { node } of walkBookmarks(folder)) if (node.type === 'bookmark') n += 1;
  return n;
}

export const bookmarkCommands: Command[] = [
  command('browser', 'bookmarks', 'The bookmarks and their folders, or those in one folder', [
    { name: 'folder', type: 'string', optional: true, help: FOLDER_HELP.replace(' (default: the bookmarks bar)', '') },
    { name: 'search', type: 'string', positional: true, optional: true, rest: true, help: 'Only those whose name or address has these words' },
  ], async (args, ctx) => {
    let list = nodes(ctx);
    const folder = args.optString('folder');
    if (folder !== undefined) {
      const chosen = pickFolder(ctx, folder);
      list = list.filter(({ node }) => findBookmark(getBookmarks(ownerOf(ctx)), node.id)?.parent?.id === chosen.id);
    }
    const terms = args.list('search').join(' ').toLowerCase().split(/\s+/).filter(Boolean);
    if (terms.length) {
      list = list.filter(({ node }) => {
        const text = `${node.title} ${node.type === 'bookmark' ? node.url : ''}`.toLowerCase();
        return terms.every((t) => text.includes(t));
      });
    }
    return { data: list.map(({ node, folder: path }) => row(node, path)) };
  }),
  command('browser', 'bookmark', 'Bookmark a page, as the address bar’s star does', [
    { name: 'url', type: 'string', positional: true, help: 'Its address (https://, http://, nsite://, nostr: or blossom:)' },
    { name: 'title', type: 'string', optional: true, help: 'Its name (default: the address)' },
    { name: 'folder', type: 'string', optional: true, help: FOLDER_HELP },
  ], async (args, ctx) => {
    const url = args.string('url');
    if (!isBookmarkableUrl(url)) throw new CommandError(`Can’t bookmark ${url}: use an https://, http://, nsite://, nostr: or blossom: address`, 'usage');
    const folder = pickFolder(ctx, args.optString('folder'));
    const made = addBookmark(ownerOf(ctx), { url, title: args.optString('title') }, folder.id);
    if (!made) throw new CommandError(`Couldn’t bookmark ${url}`);
    return { data: row(made, folder.title), text: `Bookmarked “${made.title}” in ${folder.title}` };
  }),
  command('browser', 'new-bookmark-folder', 'Make a bookmarks folder', [
    { name: 'name', type: 'string', positional: true, help: 'Its name' },
    { name: 'in', type: 'string', optional: true, help: `The folder to make it in: ${FOLDER_HELP.charAt(0).toLowerCase()}${FOLDER_HELP.slice(1)}` },
  ], async (args, ctx) => {
    const parent = pickFolder(ctx, args.optString('in'));
    const made = addBookmarkFolder(ownerOf(ctx), args.string('name'), parent.id);
    if (!made) throw new CommandError('Couldn’t make that folder');
    return { data: row(made, parent.title), text: `Made “${made.title}” in ${parent.title}` };
  }),
  command('browser', 'edit-bookmark', 'Rename a bookmark or folder, or change a bookmark’s address', [
    BOOKMARK,
    { name: 'title', type: 'string', optional: true, help: 'Its new name' },
    { name: 'url', type: 'string', optional: true, help: 'A bookmark’s new address' },
  ], async (args, ctx) => {
    const node = pickNode(ctx, args.string('bookmark'));
    const title = args.optString('title');
    const url = args.optString('url');
    if (title === undefined && url === undefined) throw new CommandError('Give a --title or a --url', 'usage');
    if (url !== undefined && (node.type !== 'bookmark' || !isBookmarkableUrl(url))) {
      throw new CommandError(node.type === 'bookmark' ? `Can’t bookmark ${url}` : 'A folder has no address', 'usage');
    }
    if (!updateBookmark(ownerOf(ctx), node.id, { title, url })) throw new CommandError(`Couldn’t change “${node.title}”`);
    return { text: `Changed “${node.title}”` };
  }),
  command('browser', 'move-bookmark', 'Move a bookmark or folder into another folder', [
    BOOKMARK,
    { name: 'folder', type: 'string', positional: true, help: 'A folder’s id, name or path' },
    { name: 'position', type: 'integer', optional: true, min: 1, help: 'Where in the folder, from 1 (default: at the end)' },
  ], async (args, ctx) => {
    const node = pickNode(ctx, args.string('bookmark'));
    const folder = pickFolder(ctx, args.string('folder'));
    const position = args.optNumber('position');
    if (!moveBookmark(ownerOf(ctx), node.id, folder.id, position === undefined ? undefined : position - 1)) {
      throw new CommandError(`Can’t move “${node.title}” into ${folder.title}`);
    }
    return { text: `Moved “${node.title}” into ${folder.title}` };
  }),
  command('browser', 'remove-bookmark', 'Delete a bookmark, or a folder with everything in it (asks on screen first for a folder of bookmarks)', [
    BOOKMARK,
  ], async (args, ctx) => {
    const node = pickNode(ctx, args.string('bookmark'));
    if (isRootFolder(node.id)) throw new CommandError(`${node.title} can’t be deleted`, 'usage');
    const inside = node.type === 'folder' ? count(node) : 0;
    if (inside > 0) {
      const ok = await ctx.confirm({
        title: `Delete “${node.title}”?`,
        description: `A command asked to delete the bookmarks folder “${node.title}” and the ${inside === 1 ? 'bookmark' : `${inside} bookmarks`} in it.`,
        action: 'Delete',
        destructive: true,
      });
      if (!ok) throw new CommandError('You didn’t allow it');
    }
    removeBookmarks(ownerOf(ctx), [node.id]);
    return { text: `Deleted “${node.title}”` };
  }),
  command('browser', 'import-bookmarks', 'Add the bookmarks in a bookmarks.html file another browser exported: its bookmarks bar onto this one’s, the rest into Other bookmarks, skipping ones already there', [
    { name: 'file', type: 'path', positional: true, help: 'The bookmarks.html file' },
  ], async (args, ctx) => {
    const { found, added } = await call(importBookmarkFileAt(ownerOf(ctx), await absolute(args.string('file'))));
    return { data: { found, added }, text: `Imported ${added} of the ${found} bookmarks in that file` };
  }),
  command('browser', 'export-bookmarks', 'Save every bookmark to a bookmarks.html file, which any browser can import (asks on screen first before replacing a file)', [
    { name: 'file', type: 'path', positional: true, help: 'Where to write it' },
  ], async (args, ctx) => {
    const path = await absolute(args.string('file'));
    const fs = need(getFsBridge(), 'Files');
    const exists = await fs.stat(path).then(() => true, () => false);
    if (exists) {
      const name = path.slice(path.lastIndexOf('/') + 1);
      const ok = await ctx.confirm({
        title: `Replace ${name}?`,
        description: `A command asked to save your bookmarks over ${path}.`,
        action: 'Replace',
        destructive: true,
      });
      if (!ok) throw new CommandError('You didn’t allow it');
    }
    const n = await call(exportBookmarkFileTo(ownerOf(ctx), path));
    return { data: { path, bookmarks: n }, text: `Exported ${n} bookmarks to ${path}` };
  }),
  command('browser', 'bookmarks-bar', 'Show the bookmarks bar under every page, or only on new tabs (Ctrl+Shift+B)', [
    { name: 'shown', type: 'string', positional: true, choices: ['on', 'off'], help: 'on: every page; off: new tabs only' },
  ], async (args) => {
    const on = args.string('shown') === 'on';
    setBookmarksBarShown(on);
    return { text: on ? 'The bookmarks bar shows under every page' : 'The bookmarks bar shows on new tabs only' };
  }),
];
