/**
 * Userscripts for the Web Browser app.
 *
 * The shell renderer owns the script library (persisted per-device in
 * localStorage, see useUserscripts) and syncs it to the main process over the
 * `window.dinos.userscripts` bridge (electron/preload.cjs). The main process
 * (electron/userscripts.cjs) matches scripts against page URLs and injects
 * them into browser-tab <webview> guests as pages load — so scripts behave
 * like extensions: installed once, running automatically on matching sites.
 *
 * Navigations to *.user.js files inside a browser tab are intercepted by the
 * main process and surfaced here as install requests, mirroring how a
 * userscript manager extension hooks script downloads.
 *
 * In a plain browser (`npm run dev:browser`) the bridge is absent; callers
 * must feature-detect via `getUserscriptsBridge()` and hide userscript UI.
 */

/** When a script asks to run, from its `@run-at` header. */
export type UserscriptRunAt = 'document-start' | 'document-end' | 'document-idle';

/** Metadata parsed from a script's `==UserScript==` block. */
export interface UserscriptMeta {
  name: string;
  namespace: string;
  version: string;
  description: string;
  runAt: UserscriptRunAt;
  /** `@noframes`: only run in top-level documents (always true here — the
   * injector only targets main frames — but kept for fidelity). */
  noframes: boolean;
  /** `@match` patterns (scheme://host/path with wildcards). */
  matches: string[];
  /** `@include` rules (globs, or /regex/ when slash-delimited). */
  includes: string[];
  /** `@exclude` / `@exclude-match` rules (same forms as includes). */
  excludes: string[];
}

/** An installed userscript: parsed metadata plus source and install state. */
export interface Userscript extends UserscriptMeta {
  id: string;
  enabled: boolean;
  code: string;
  /** URL the script was installed from (a *.user.js link), if any. */
  downloadUrl?: string;
  installedAt: number;
  updatedAt: number;
}

const META_BLOCK_RE = /\/\/[ \t]*==UserScript==[ \t]*\r?\n([\s\S]*?)\/\/[ \t]*==\/UserScript==/;
const META_LINE_RE = /^[ \t]*\/\/[ \t]*@([\w:-]+)(?:[ \t]+(.*?))?[ \t]*$/;

/**
 * Parse a userscript's `==UserScript==` metadata block. Returns null when the
 * block is missing or names no script — the caller should reject the source
 * as "not a userscript".
 */
export function parseUserscriptMeta(code: string): UserscriptMeta | null {
  const block = META_BLOCK_RE.exec(code);
  if (!block) return null;

  const meta: UserscriptMeta = {
    name: '',
    namespace: '',
    version: '',
    description: '',
    runAt: 'document-end',
    noframes: false,
    matches: [],
    includes: [],
    excludes: [],
  };

  for (const line of block[1].split(/\r?\n/)) {
    const parsed = META_LINE_RE.exec(line);
    if (!parsed) continue;
    const key = parsed[1];
    const value = (parsed[2] ?? '').trim();
    switch (key) {
      // Localized variants (@name:fr) fall through to default; the plain key
      // wins and the first occurrence is kept.
      case 'name':
        if (!meta.name) meta.name = value;
        break;
      case 'namespace':
        if (!meta.namespace) meta.namespace = value;
        break;
      case 'version':
        if (!meta.version) meta.version = value;
        break;
      case 'description':
        if (!meta.description) meta.description = value;
        break;
      case 'match':
        if (value) meta.matches.push(value);
        break;
      case 'include':
        if (value) meta.includes.push(value);
        break;
      case 'exclude':
      case 'exclude-match':
        if (value) meta.excludes.push(value);
        break;
      case 'run-at': {
        const runAt = value.replace(/_/g, '-');
        if (
          runAt === 'document-start' ||
          runAt === 'document-end' ||
          runAt === 'document-idle'
        ) {
          meta.runAt = runAt;
        }
        break;
      }
      case 'noframes':
        meta.noframes = true;
        break;
    }
  }

  if (!meta.name) return null;
  return meta;
}

/** Whether a URL points at a userscript file (an install link). */
export function isUserscriptUrl(url: string): boolean {
  try {
    const { protocol, pathname } = new URL(url);
    return (protocol === 'https:' || protocol === 'http:') && pathname.endsWith('.user.js');
  } catch {
    return false;
  }
}

/** A fresh unique script id (also embedded in injected code as a run guard). */
export function newUserscriptId(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(8));
  return `us-${Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('')}`;
}

/** A *.user.js navigation intercepted by the main process. */
export interface UserscriptInstallRequested {
  /** The script file's URL. */
  url: string;
  /** WebContents id of the tab that navigated (identifies the owning window). */
  wcId: number;
}

export interface UserscriptsBridge {
  /** Replace the main process's script list (the renderer is authoritative). */
  sync(scripts: Userscript[]): void;
  /** Fetch a userscript's source text over https (size-capped, in main). */
  fetchText(url: string): Promise<string>;
  /** Subscribe to *.user.js install requests. Returns an unsubscribe fn. */
  onInstallRequested(
    callback: (request: UserscriptInstallRequested) => void,
  ): () => void;
}

declare global {
  interface Dinos {
    /** Present only inside the Electron shell. */
    userscripts?: UserscriptsBridge;
  }
}

/** The userscripts bridge, or undefined outside the Electron shell. */
export function getUserscriptsBridge(): UserscriptsBridge | undefined {
  if (typeof window === 'undefined') return undefined;
  return window.dinos?.userscripts;
}
