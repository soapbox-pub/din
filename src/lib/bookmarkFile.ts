import { getFsBridge } from '@/lib/fs';
import {
  cleanIcon,
  cleanTitle,
  getBookmarks,
  importBookmarks,
  isBookmarkableUrl,
  newId,
  type BookmarkFolder,
  type BookmarkNode,
  type BookmarkTree,
} from '@/lib/browserBookmarks';

/**
 * The Netscape bookmark file (`bookmarks.html`): the format Chrome, Firefox,
 * Safari, Edge and Brave all export and import. A `<DL>` list of `<DT>`
 * items, each an `<A HREF>` bookmark or an `<H3>` folder heading followed by
 * the folder's own `<DL>`. The folder on the other browser's bookmarks bar
 * has `PERSONAL_TOOLBAR_FOLDER="true"`.
 */

const FILE_HEADER = `<!DOCTYPE NETSCAPE-Bookmark-file-1>
<!-- This is an automatically generated file.
     It will be read and overwritten.
     DO NOT EDIT! -->
<META HTTP-EQUIV="Content-Type" CONTENT="text/html; charset=UTF-8">
<TITLE>Bookmarks</TITLE>
<H1>Bookmarks</H1>
`;

/** The name a bookmarks file is saved under, dated like Chrome's. */
export function bookmarkFileName(date = new Date()): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  return `bookmarks_${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}.html`;
}

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function writeNodes(nodes: BookmarkNode[], depth: number, lines: string[]): void {
  const indent = '    '.repeat(depth);
  for (const node of nodes) {
    if (node.type === 'bookmark') {
      const icon = node.icon ? ` ICON_URI="${escapeHtml(node.icon)}"` : '';
      lines.push(
        `${indent}<DT><A HREF="${escapeHtml(node.url)}" ADD_DATE="${node.addedAt}"${icon}>${escapeHtml(node.title)}</A>`,
      );
    } else {
      writeFolder(node, depth, lines);
    }
  }
}

function writeFolder(folder: BookmarkFolder, depth: number, lines: string[], toolbar = false): void {
  const indent = '    '.repeat(depth);
  const flag = toolbar ? ' PERSONAL_TOOLBAR_FOLDER="true"' : '';
  lines.push(`${indent}<DT><H3 ADD_DATE="${folder.addedAt}" LAST_MODIFIED="0"${flag}>${escapeHtml(folder.title)}</H3>`);
  lines.push(`${indent}<DL><p>`);
  writeNodes(folder.children, depth + 1, lines);
  lines.push(`${indent}</DL><p>`);
}

/**
 * Write bookmarks as a Netscape bookmark file. Like Chrome's, the bookmarks
 * bar is a toolbar folder and Other bookmarks' contents sit at the top level,
 * where every browser's import finds them.
 */
export function serializeBookmarkFile(tree: BookmarkTree): string {
  const lines = ['<DL><p>'];
  writeFolder(tree.bar, 1, lines, true);
  writeNodes(tree.other.children, 1, lines);
  lines.push('</DL><p>');
  return `${FILE_HEADER}${lines.join('\n')}\n`;
}

/** Unix seconds from an `ADD_DATE`, which some browsers write in microseconds. */
function readDate(value: string | null): number {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return Math.floor(Date.now() / 1000);
  return Math.floor(n > 1e11 ? n / 1e6 : n);
}

/**
 * The `<DT>` items of a `<DL>`. The HTML parser usually makes them its
 * children, but the `<p>`s every exporter writes can wrap them, so look
 * through those too.
 */
function itemsOf(list: Element): Element[] {
  const items: Element[] = [];
  for (const child of list.children) {
    const tag = child.tagName;
    if (tag === 'DT') items.push(child);
    else if (tag === 'P') items.push(...itemsOf(child));
  }
  return items;
}

/** The list a folder heading's contents are in: inside its `<DT>`, or just after it. */
function folderListOf(item: Element, heading: Element): Element | null {
  for (let el = heading.nextElementSibling; el; el = el.nextElementSibling) {
    if (el.tagName === 'DL') return el;
  }
  for (let el = item.nextElementSibling; el; el = el.nextElementSibling) {
    if (el.tagName === 'DL') return el;
    if (el.tagName === 'DD') {
      const inner = el.querySelector(':scope > dl');
      if (inner) return inner;
    }
    if (el.tagName === 'DT') break;
  }
  return null;
}

interface Parsed {
  bar: BookmarkNode[];
  other: BookmarkNode[];
}

function readList(list: Element, out: Parsed, top: boolean): BookmarkNode[] {
  const nodes: BookmarkNode[] = [];
  for (const item of itemsOf(list)) {
    const link = item.querySelector(':scope > a');
    if (link) {
      const url = (link.getAttribute('href') ?? '').trim();
      if (!isBookmarkableUrl(url)) continue;
      nodes.push({
        type: 'bookmark',
        id: newId(),
        title: cleanTitle(link.textContent ?? '') || url,
        url,
        addedAt: readDate(link.getAttribute('add_date')),
        icon: cleanIcon(link.getAttribute('icon_uri')),
      });
      continue;
    }
    const heading = item.querySelector(':scope > h3');
    if (!heading) continue;
    const inner = folderListOf(item, heading);
    const children = inner ? readList(inner, out, false) : [];
    // The other browser's bookmarks bar, wherever it is, is this one's.
    if (heading.getAttribute('personal_toolbar_folder') === 'true') {
      out.bar.push(...children);
      continue;
    }
    // Firefox's "Other Bookmarks" is this one's too.
    if (top && heading.getAttribute('unfiled_bookmarks_folder') === 'true') {
      nodes.push(...children);
      continue;
    }
    nodes.push({
      type: 'folder',
      id: newId(),
      title: cleanTitle(heading.textContent ?? '') || 'Folder',
      addedAt: readDate(heading.getAttribute('add_date')),
      children,
    });
  }
  return nodes;
}

/**
 * Read a Netscape bookmark file: the bookmarks bar's contents, and the rest.
 * Throws when the file isn't one. Parsed with DOMParser, whose documents run
 * no scripts and load nothing, and only http(s), nsite and nostr: links are
 * kept.
 */
export function parseBookmarkFile(html: string): Parsed {
  const doc = new DOMParser().parseFromString(html, 'text/html');
  const root = doc.querySelector('dl');
  if (!root) {
    throw new Error('That isn’t a bookmarks file (bookmarks.html)');
  }
  const out: Parsed = { bar: [], other: [] };
  out.other = readList(root, out, true);
  return out;
}

/** How many bookmarks a parsed file holds. */
export function countBookmarks(nodes: BookmarkNode[]): number {
  let n = 0;
  for (const node of nodes) n += node.type === 'bookmark' ? 1 : countBookmarks(node.children);
  return n;
}

/** Bigger than any real bookmarks file; Chrome's for 10,000 bookmarks is a few MB. */
const MAX_FILE_BYTES = 64 * 1024 * 1024;

function fs() {
  const bridge = getFsBridge();
  if (!bridge) throw new Error('Files aren’t available here');
  return bridge;
}

/**
 * Import the bookmarks file at `path` into an account's bookmarks (see
 * `importBookmarks`). Resolves with how many were in the file and how many
 * of those were new. What the about:bookmarks page and `din browser
 * import-bookmarks` both do.
 */
export async function importBookmarkFileAt(owner: string, path: string): Promise<{ found: number; added: number }> {
  const file = await fs().readFile(path, MAX_FILE_BYTES);
  if (file.truncated) throw new Error('That file is too big to be a bookmarks file');
  const parsed = parseBookmarkFile(new TextDecoder().decode(file.data));
  const found = countBookmarks(parsed.bar) + countBookmarks(parsed.other);
  if (!found) throw new Error('There are no bookmarks in that file');
  return { found, added: importBookmarks(owner, parsed) };
}

/** Save an account's bookmarks to `path` as a bookmarks file. Resolves with how many. */
export async function exportBookmarkFileTo(owner: string, path: string): Promise<number> {
  const tree = getBookmarks(owner);
  await fs().writeFile(path, serializeBookmarkFile(tree));
  return countBookmarks(tree.bar.children) + countBookmarks(tree.other.children);
}
