import { unzipSync } from 'fflate';

/**
 * Windows Media Player skin packages (.wmz: a zip of a .wms definition,
 * images and JScript files) and their definitions. A .wms is XML in spirit
 * only: values hold raw `&&` and `<` from JScript, tag and attribute names
 * come in any case, and the file may be UTF-16 or Latin-1. So it gets a
 * forgiving parser of its own rather than DOMParser.
 */

export interface WmsNode {
  /** Lower-cased tag name. */
  tag: string;
  /** Attributes by lower-cased name, values as written (entities decoded). */
  attrs: Record<string, string>;
  children: WmsNode[];
}

export interface WmzPackage {
  /** Look up a file by name, case-insensitively, ignoring folders. */
  file(name: string): Uint8Array | undefined;
  /** Every file's (lower-cased) name. */
  names(): string[];
  /** The parsed THEME element. */
  theme: WmsNode;
  /** Name of the .wms file, without extension. */
  name: string;
}

/** Decode text that may be UTF-16 (with or without BOM), UTF-8 or Latin-1. */
export function decodeSkinText(data: Uint8Array): string {
  if (data[0] === 0xff && data[1] === 0xfe) return new TextDecoder('utf-16le').decode(data.subarray(2));
  if (data[0] === 0xfe && data[1] === 0xff) return new TextDecoder('utf-16be').decode(data.subarray(2));
  if (data[0] === 0xef && data[1] === 0xbb && data[2] === 0xbf) return new TextDecoder('utf-8').decode(data.subarray(3));
  // UTF-16LE without a BOM: every other byte of ASCII text is zero.
  if (data.length > 4 && data[1] === 0 && data[3] === 0 && data[0] !== 0) return new TextDecoder('utf-16le').decode(data);
  const utf8 = new TextDecoder('utf-8', { fatal: false }).decode(data);
  return utf8.includes('\uFFFD') ? new TextDecoder('windows-1252').decode(data) : utf8;
}

const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };

function decodeEntities(s: string): string {
  return s.replace(/&(#x[0-9a-f]+|#\d+|amp|lt|gt|quot|apos);/gi, (_, e: string) => {
    if (e[0] === '#') return String.fromCodePoint(e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10));
    return ENTITIES[e.toLowerCase()] ?? _;
  });
}

/** Parse a .wms document into its element tree (a synthetic root holding the top level). */
export function parseWms(text: string): WmsNode {
  const root: WmsNode = { tag: '#root', attrs: {}, children: [] };
  const stack: WmsNode[] = [root];
  let i = 0;
  const n = text.length;
  while (i < n) {
    const lt = text.indexOf('<', i);
    if (lt === -1) break;
    i = lt;
    if (text.startsWith('<!--', i)) {
      const end = text.indexOf('-->', i + 4);
      i = end === -1 ? n : end + 3;
      continue;
    }
    if (text.startsWith('<?', i) || text.startsWith('<!', i)) {
      const end = text.indexOf('>', i);
      i = end === -1 ? n : end + 1;
      continue;
    }
    if (text[i + 1] === '/') {
      const end = text.indexOf('>', i);
      const tag = text.slice(i + 2, end === -1 ? n : end).trim().toLowerCase();
      // Pop to the matching element (forgiving unclosed children).
      for (let s = stack.length - 1; s > 0; s--) {
        if (stack[s].tag === tag) {
          stack.length = s;
          break;
        }
      }
      i = end === -1 ? n : end + 1;
      continue;
    }
    // An opening tag: name, then attributes until > or />.
    let j = i + 1;
    while (j < n && /[\w:.-]/.test(text[j])) j++;
    const tag = text.slice(i + 1, j).toLowerCase();
    if (!tag) {
      i++;
      continue;
    }
    const attrs: Record<string, string> = {};
    let selfClosing = false;
    for (;;) {
      while (j < n && /\s/.test(text[j])) j++;
      if (j >= n) break;
      if (text[j] === '>') {
        j++;
        break;
      }
      if (text[j] === '/' && text[j + 1] === '>') {
        selfClosing = true;
        j += 2;
        break;
      }
      const nameStart = j;
      while (j < n && !/[\s=>/]/.test(text[j])) j++;
      const name = text.slice(nameStart, j).toLowerCase();
      while (j < n && /\s/.test(text[j])) j++;
      let value = '';
      if (text[j] === '=') {
        j++;
        while (j < n && /\s/.test(text[j])) j++;
        const q = text[j];
        if (q === '"' || q === "'") {
          const end = text.indexOf(q, j + 1);
          value = text.slice(j + 1, end === -1 ? n : end);
          j = end === -1 ? n : end + 1;
        } else {
          const start = j;
          while (j < n && !/[\s>]/.test(text[j])) j++;
          value = text.slice(start, j);
        }
      }
      if (name) attrs[name] = decodeEntities(value);
      else j++;
    }
    const node: WmsNode = { tag, attrs, children: [] };
    stack[stack.length - 1].children.push(node);
    if (!selfClosing) stack.push(node);
    i = j;
  }
  return root;
}

/** Depth-first search for the first element with a tag. */
export function findNode(node: WmsNode, tag: string): WmsNode | undefined {
  for (const child of node.children) {
    if (child.tag === tag) return child;
    const found = findNode(child, tag);
    if (found) return found;
  }
  return undefined;
}

/** Unpack a .wmz (or a lone .wms, with no images). */
export function openWmz(bytes: Uint8Array): WmzPackage {
  let files: Record<string, Uint8Array>;
  try {
    files = unzipSync(bytes);
  } catch {
    files = { 'skin.wms': bytes };
  }
  const byName = new Map<string, Uint8Array>();
  for (const [path, data] of Object.entries(files)) {
    if (path.endsWith('/')) continue;
    const name = path.slice(path.lastIndexOf('/') + 1).toLowerCase();
    if (!byName.has(name)) byName.set(name, data);
  }
  const wmsName = [...byName.keys()].find((k) => k.endsWith('.wms'));
  if (!wmsName) throw new Error('This skin has no .wms definition');
  const root = parseWms(decodeSkinText(byName.get(wmsName)!));
  const theme = findNode(root, 'theme');
  if (!theme) throw new Error('This skin has no THEME');
  return {
    file: (name) => byName.get(name.replace(/\\/g, '/').split('/').pop()!.toLowerCase()),
    names: () => [...byName.keys()],
    theme,
    name: wmsName.replace(/\.wms$/, ''),
  };
}

export function imageMime(name: string): string {
  const ext = name.slice(name.lastIndexOf('.') + 1).toLowerCase();
  return ext === 'png' ? 'image/png' : ext === 'gif' ? 'image/gif' : ext === 'jpg' || ext === 'jpeg' ? 'image/jpeg' : 'image/bmp';
}
