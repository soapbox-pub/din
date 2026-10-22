import { extensionOf, fileCategory } from '@/lib/fileTypes';

/**
 * A file-type filter for the file picker, as apps describe them to the
 * desktop portal: a name ("Images") and globs ("*.png") or MIME types
 * ("image/*"). A file matches if any of them does.
 */
export interface FileFilter {
  name: string;
  patterns: string[];
  mimeTypes: string[];
}

/** Subtypes whose files don't go by the subtype's own name. */
const SUBTYPE_EXTENSIONS: Record<string, string[]> = {
  jpeg: ['jpg', 'jpeg', 'jpe'],
  'svg+xml': ['svg'],
  'x-icon': ['ico'],
  'vnd.microsoft.icon': ['ico'],
  tiff: ['tif', 'tiff'],
  plain: ['txt', 'text'],
  markdown: ['md', 'markdown'],
  javascript: ['js', 'mjs', 'cjs'],
  quicktime: ['mov'],
  'x-matroska': ['mkv'],
  mpeg: ['mp3', 'mpeg', 'mpg'],
  'x-wav': ['wav'],
  'x-flac': ['flac'],
  'vnd.oasis.opendocument.text': ['odt'],
  'vnd.openxmlformats-officedocument.wordprocessingml.document': ['docx'],
  msword: ['doc'],
  gzip: ['gz', 'tgz'],
  'x-tar': ['tar'],
  'x-7z-compressed': ['7z'],
};

const globs = new Map<string, RegExp>();

/** A shell glob ("*.[pP][nN][gG]") as a regex over the whole name. */
function globRegex(glob: string): RegExp {
  let regex = globs.get(glob);
  if (!regex) {
    let source = '';
    for (let i = 0; i < glob.length; i++) {
      const c = glob[i];
      if (c === '*') source += '.*';
      else if (c === '?') source += '.';
      else if (c === '[') {
        const close = glob.indexOf(']', i + 2);
        if (close === -1) source += '\\[';
        else {
          source += `[${glob.slice(i + 1, close).replace(/^!/, '^').replace(/\\/g, '\\\\')}]`;
          i = close;
        }
      } else source += c.replace(/[.+^${}()|\\/]/g, '\\$&');
    }
    // Apps list both cases where they care ("*.png", "*.PNG"); one is enough.
    regex = new RegExp(`^${source}$`, 'i');
    globs.set(glob, regex);
  }
  return regex;
}

function mimeMatches(mime: string, name: string): boolean {
  const [type, subtype = ''] = mime.toLowerCase().split(';')[0].trim().split('/');
  if (type === '*' || (type === 'application' && subtype === 'octet-stream')) return true;
  if (subtype === '*') {
    const category = fileCategory(name, 'file');
    if (type === 'text') return category === 'text' || category === 'code';
    return category === type;
  }
  return (SUBTYPE_EXTENSIONS[subtype] ?? [subtype]).includes(extensionOf(name));
}

/** Whether a file passes a filter (null lets everything through). */
export function filterMatches(filter: FileFilter | null, name: string): boolean {
  if (!filter || (filter.patterns.length === 0 && filter.mimeTypes.length === 0)) return true;
  return (
    filter.patterns.some((glob) => globRegex(glob).test(name)) ||
    filter.mimeTypes.some((mime) => mimeMatches(mime, name))
  );
}

/** The filter for a list of extensions (".CurXPTheme", "zip"). */
export function extensionFilter(extensions: string[]): FileFilter {
  const exts = extensions.map((e) => (e.startsWith('.') ? e : `.${e}`));
  return { name: exts.join(', '), patterns: exts.map((e) => `*${e}`), mimeTypes: [] };
}
