import { createContext } from 'react';

/** What a reply's relative file links resolve against. */
export interface FileLinkBase {
  /** The conversation's working folder. */
  directory?: string;
  home?: string;
}

export const FileLinkBaseContext = createContext<FileLinkBase>({});

/**
 * The absolute path a Markdown link points at, or null when it isn't a file:
 * `file:` URLs, absolute and `~/` paths, and anything without a scheme, which
 * is relative to the working folder (`public/icon.png`, `../x.ts`). The
 * `path:line` and `#L12` forms agents use for code locations name the file.
 */
export function filePathOfHref(href: string, base: FileLinkBase): string | null {
  let raw = href.trim();
  if (/^file:/i.test(raw)) {
    try {
      const url = new URL(raw);
      if (url.host && url.host !== 'localhost') return null;
      raw = decodeURIComponent(url.pathname);
    } catch {
      return null;
    }
  } else {
    // A scheme is letters then a colon, but `src/a.ts:12` is a file and line.
    if (/^[a-z][a-z0-9+.-]*:(?!\d)/i.test(raw) || raw.startsWith('//') || raw.startsWith('#') || /^www\./i.test(raw)) {
      return null;
    }
    raw = raw.replace(/[?#].*$/, '');
    try {
      raw = decodeURIComponent(raw);
    } catch {
      // Not percent-encoded after all: a literal % in the name.
    }
  }
  raw = raw.replace(/:\d+(?::\d+)?$/, '');
  if (!raw) return null;

  let path: string;
  if (raw === '~' || raw.startsWith('~/')) {
    if (!base.home) return null;
    path = base.home + raw.slice(1);
  } else if (raw.startsWith('/')) {
    path = raw;
  } else {
    if (!base.directory) return null;
    path = `${base.directory}/${raw}`;
  }
  return normalizePath(path);
}

function normalizePath(path: string): string {
  const parts: string[] = [];
  for (const part of path.split('/')) {
    if (!part || part === '.') continue;
    if (part === '..') parts.pop();
    else parts.push(part);
  }
  return `/${parts.join('/')}`;
}
