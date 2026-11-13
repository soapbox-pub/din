// Userscript engine for the Web Browser app: native support for
// Greasemonkey-format scripts, managed like extensions.
//
// The library is kept here, in userData/userscripts.json, and nowhere else:
// the shell asks for what's installed (everything but the code) and has
// scripts installed, removed and switched over `userscripts:*`
// (src/hooks/useUserscripts.ts). A script's code can be megabytes, and the
// shell needs it only once, to hand it over.
//
// Injection targets browser-tab guests only (main.mts calls attachUserscripts
// on webviews in the persist:webbrowser session). Scripts run in the page's
// main world via webContents.executeJavaScript — the same privilege level as
// the page itself, never the shell's — wrapped in an IIFE that provides a
// small Greasemonkey-compatible API (GM_getValue/GM_setValue backed by the
// page origin's localStorage, GM_addStyle, GM_info, GM.* promise aliases,
// unsafeWindow).
//
// Timing: `@run-at document-start` and `document-end` inject on dom-ready,
// `document-idle` on did-finish-load. True document-start would need preload
// machinery in the guests; dom-ready is the earliest safe point with
// executeJavaScript. A per-document window flag makes injection idempotent.
//
// Deliberately NOT here: session.webRequest interception (it would silently
// break chrome.webRequest for extensions — see the warning in main.mts).

import path from 'node:path';
import fs from 'node:fs';
import { randomBytes } from 'node:crypto';
import { app, ipcMain, net } from 'electron';

/** Upper bounds keeping a hostile install/fetch from bloating disk or memory. */
const MAX_SCRIPTS = 200;
const MAX_CODE_BYTES = 2 * 1024 * 1024;
const MAX_URL_LENGTH = 2048;

type RunAt = 'document-start' | 'document-end' | 'document-idle';

/** One sanitized Greasemonkey-format script record. */
interface Userscript {
  id: string;
  name: string;
  namespace: string;
  version: string;
  description: string;
  enabled: boolean;
  runAt: RunAt;
  noframes: boolean;
  matches: string[];
  includes: string[];
  excludes: string[];
  code: string;
  /** The *.user.js link it was installed from, if any. */
  downloadUrl?: string;
  installedAt: number;
  updatedAt: number;
}

/** A script as the shell is told of it: everything but its code. */
type UserscriptInfo = Omit<Userscript, 'code'>;

/** The library. */
let scripts: Userscript[] = [];
/**
 * Whether the file on disk is the library itself. Until Din kept it here it
 * was the shell's, in localStorage, and the file a copy for injecting from;
 * that copy is replaced by the shell's own (`userscripts:adopt`) once.
 */
let owned = false;

let sendToShell: (channel: string, payload?: unknown) => void = () => {};

function storeFile(): string {
  return path.join(app.getPath('userData'), 'userscripts.json');
}

function info(script: Userscript): UserscriptInfo {
  const { code: _code, ...rest } = script;
  return rest;
}

/**
 * Validate one script record. The renderer is the trusted shell
 * (assertShellSender gates the IPC), but records also round-trip through a
 * JSON file on disk, so shape-check everything defensively.
 */
function sanitizeScript(value: unknown): Userscript | null {
  if (!value || typeof value !== 'object') return null;
  const raw = value as Record<string, unknown>;
  if (typeof raw.id !== 'string' || !/^[A-Za-z0-9_-]{1,64}$/.test(raw.id)) return null;
  if (typeof raw.code !== 'string' || raw.code.length > MAX_CODE_BYTES) return null;
  if (typeof raw.name !== 'string' || !raw.name) return null;
  const strings = (value: unknown): string[] =>
    Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [];
  const runAt: RunAt =
    raw.runAt === 'document-start' || raw.runAt === 'document-idle' || raw.runAt === 'document-end'
      ? raw.runAt
      : 'document-end';
  const time = (value: unknown): number => (typeof value === 'number' && Number.isFinite(value) ? value : 0);
  return {
    id: raw.id,
    name: raw.name,
    namespace: typeof raw.namespace === 'string' ? raw.namespace : '',
    version: typeof raw.version === 'string' ? raw.version : '',
    description: typeof raw.description === 'string' ? raw.description : '',
    enabled: raw.enabled === true,
    runAt,
    noframes: raw.noframes === true,
    matches: strings(raw.matches),
    includes: strings(raw.includes),
    excludes: strings(raw.excludes),
    code: raw.code,
    ...(typeof raw.downloadUrl === 'string' && raw.downloadUrl.length <= MAX_URL_LENGTH ? { downloadUrl: raw.downloadUrl } : {}),
    installedAt: time(raw.installedAt),
    updatedAt: time(raw.updatedAt),
  };
}

function sanitizeScripts(list: unknown): Userscript[] {
  if (!Array.isArray(list)) return [];
  const seen = new Set<string>();
  const out: Userscript[] = [];
  for (const raw of list) {
    const script = sanitizeScript(raw);
    if (!script || seen.has(script.id)) continue;
    seen.add(script.id);
    out.push(script);
    if (out.length >= MAX_SCRIPTS) break;
  }
  return out;
}

function loadFromDisk(): void {
  try {
    const stored: unknown = JSON.parse(fs.readFileSync(storeFile(), 'utf8'));
    // A bare list is the copy the shell used to sync here.
    owned = !Array.isArray(stored);
    scripts = sanitizeScripts(owned ? (stored as { scripts?: unknown } | null)?.scripts : stored);
  } catch {
    // Missing or corrupt store: start empty.
    scripts = [];
  }
}

/** Write the library, whole or not at all: it's the only copy. */
function saveToDisk(): boolean {
  const file = storeFile();
  try {
    fs.writeFileSync(`${file}.tmp`, JSON.stringify({ version: 2, scripts }));
    fs.renameSync(`${file}.tmp`, file);
    owned = true;
    return true;
  } catch (error) {
    console.error('userscripts: failed to persist store:', error);
    return false;
  }
}

/** Make a change, kept or not made at all, and tell the shell what's installed now. */
function commit(next: Userscript[]): void {
  const before = scripts;
  scripts = next;
  if (!saveToDisk()) {
    scripts = before;
    throw new Error('The userscript library could not be saved');
  }
  sendToShell('userscripts:changed', scripts.map(info));
}

// --- URL matching (Greasemonkey semantics) ---------------------------------

/** Compile a glob (* wildcards) into an anchored RegExp. */
function globToRegExp(glob: string): RegExp {
  const escaped = glob.replace(/[.+^${}()|[\]\\?]/g, '\\$&').replace(/\*/g, '.*');
  return new RegExp(`^${escaped}$`);
}

/** An @include/@exclude rule: /regex/ when slash-delimited, else a glob. */
function includeRuleMatches(rule: string, url: string): boolean {
  try {
    if (rule.length > 2 && rule.startsWith('/') && rule.endsWith('/')) {
      return new RegExp(rule.slice(1, -1)).test(url);
    }
    return globToRegExp(rule).test(url);
  } catch {
    return false;
  }
}

/** An @match pattern: scheme://host/path (Chrome match-pattern semantics). */
function matchPatternMatches(pattern: string, url: string): boolean {
  let target: URL;
  try {
    target = new URL(url);
  } catch {
    return false;
  }
  if (target.protocol !== 'http:' && target.protocol !== 'https:') return false;
  if (pattern === '<all_urls>') return true;

  const parsed = /^(\*|https?):\/\/(\*|(?:\*\.)?[^/*]+)(\/.*)$/.exec(pattern);
  if (!parsed) return false;
  const [, scheme, host, pathPattern] = parsed;

  if (scheme !== '*' && `${scheme}:` !== target.protocol) return false;
  if (host !== '*') {
    if (host.startsWith('*.')) {
      const base = host.slice(2);
      if (target.hostname !== base && !target.hostname.endsWith(`.${base}`)) return false;
    } else if (target.hostname !== host) {
      return false;
    }
  }
  try {
    return globToRegExp(pathPattern).test(target.pathname + target.search);
  } catch {
    return false;
  }
}

/**
 * Whether a script runs on a URL: excludes veto, then any match/include rule
 * admits. A script with no rules at all runs everywhere (the conventional
 * userscript-manager behavior for headerless targeting).
 */
function scriptMatchesUrl(script: Userscript, url: string): boolean {
  for (const rule of script.excludes) {
    if (includeRuleMatches(rule, url)) return false;
  }
  if (script.matches.length === 0 && script.includes.length === 0) return true;
  for (const pattern of script.matches) {
    if (matchPatternMatches(pattern, url)) return true;
  }
  for (const rule of script.includes) {
    if (includeRuleMatches(rule, url)) return true;
  }
  return false;
}

// --- Injection -------------------------------------------------------------

/**
 * Wrap a script's source in an idempotent IIFE with a minimal GM_* API.
 * All metadata is embedded via JSON.stringify; the source itself is spliced
 * in raw (it is the JavaScript to run — a syntax error only breaks that
 * script's own wrapper, reported to the page console).
 */
function buildInjectionSource(script: Userscript): string {
  const flag = JSON.stringify(`__din_userscript_${script.id}`);
  const label = JSON.stringify(`[userscript ${script.name}]`);
  const prefix = JSON.stringify(`din-userscript:${script.id}:`);
  const info = JSON.stringify({
    scriptHandler: 'Din',
    version: app.getVersion(),
    script: {
      name: script.name,
      namespace: script.namespace,
      version: script.version,
      description: script.description,
    },
  });
  return `(function () {
'use strict';
if (window[${flag}]) return;
try { Object.defineProperty(window, ${flag}, { value: true }); } catch (e) { window[${flag}] = true; }
var unsafeWindow = window;
var GM_info = ${info};
var __dinPrefix = ${prefix};
function GM_getValue(name, defaultValue) {
  try {
    var raw = window.localStorage.getItem(__dinPrefix + name);
    return raw === null ? defaultValue : JSON.parse(raw);
  } catch (e) { return defaultValue; }
}
function GM_setValue(name, value) {
  try { window.localStorage.setItem(__dinPrefix + name, JSON.stringify(value)); } catch (e) {}
}
function GM_deleteValue(name) {
  try { window.localStorage.removeItem(__dinPrefix + name); } catch (e) {}
}
function GM_listValues() {
  var names = [];
  try {
    for (var i = 0; i < window.localStorage.length; i++) {
      var key = window.localStorage.key(i);
      if (key && key.indexOf(__dinPrefix) === 0) names.push(key.slice(__dinPrefix.length));
    }
  } catch (e) {}
  return names;
}
function GM_addStyle(css) {
  var el = document.createElement('style');
  el.textContent = css;
  (document.head || document.documentElement).appendChild(el);
  return el;
}
function GM_openInTab(url) { window.open(url); }
var GM = {
  info: GM_info,
  addStyle: GM_addStyle,
  openInTab: GM_openInTab,
  getValue: function (n, d) { return Promise.resolve(GM_getValue(n, d)); },
  setValue: function (n, v) { GM_setValue(n, v); return Promise.resolve(); },
  deleteValue: function (n) { GM_deleteValue(n); return Promise.resolve(); },
  listValues: function () { return Promise.resolve(GM_listValues()); },
};
void unsafeWindow; void GM;
try {
${script.code}
} catch (error) { console.error(${label}, error); }
})();
//# sourceURL=din-userscript:${encodeURIComponent(script.name)}.user.js`;
}

/**
 * Inject every enabled script that matches the guest's current URL at the
 * given stage ('ready' = dom-ready, 'idle' = did-finish-load).
 */
function injectForStage(contents: Electron.WebContents, stage: 'ready' | 'idle'): void {
  if (contents.isDestroyed() || scripts.length === 0) return;
  const url = contents.getURL();
  if (!/^https?:/i.test(url)) return;
  for (const script of scripts) {
    if (!script.enabled) continue;
    const idle = script.runAt === 'document-idle';
    if (stage === 'idle' ? !idle : idle) continue;
    if (!scriptMatchesUrl(script, url)) continue;
    contents.executeJavaScript(buildInjectionSource(script), true).catch((error) => {
      console.error(`userscript "${script.name}" failed:`, error);
    });
  }
}

/** Hook a browser-tab guest so matching userscripts inject on every load. */
export function attachUserscripts(contents: Electron.WebContents): void {
  contents.on('dom-ready', () => injectForStage(contents, 'ready'));
  contents.on('did-finish-load', () => injectForStage(contents, 'idle'));
}

/** Whether a URL points at a userscript file (an install link). */
export function isUserscriptInstallUrl(url: string): boolean {
  try {
    const { protocol, pathname } = new URL(url);
    return (protocol === 'https:' || protocol === 'http:') && pathname.endsWith('.user.js');
  } catch {
    return false;
  }
}

/** Register the userscripts:* IPC surface and load the library. */
export function registerUserscriptHandlers(deps: {
  assertShellSender: (event: Electron.IpcMainEvent | Electron.IpcMainInvokeEvent) => void;
  sendToShell: (channel: string, payload?: unknown) => void;
}): void {
  const { assertShellSender } = deps;
  sendToShell = deps.sendToShell;
  loadFromDisk();

  ipcMain.handle('userscripts:list', (event) => {
    assertShellSender(event);
    return scripts.map(info);
  });

  // Install a script, or replace the one from the same link or of the same
  // name and namespace, which keeps its id and whether it's on.
  ipcMain.handle('userscripts:install', (event, raw: unknown) => {
    assertShellSender(event);
    const now = Date.now();
    const draft = sanitizeScript({ ...(raw && typeof raw === 'object' ? raw : {}), id: 'new' });
    if (!draft) throw new Error('Not a userscript');
    const existing = scripts.find(
      (s) =>
        (draft.downloadUrl !== undefined && s.downloadUrl === draft.downloadUrl) ||
        (s.name === draft.name && s.namespace === draft.namespace),
    );
    if (!existing && scripts.length >= MAX_SCRIPTS) throw new Error(`No more than ${MAX_SCRIPTS} userscripts can be installed`);
    const script: Userscript = {
      ...draft,
      id: existing?.id ?? `us-${randomBytes(8).toString('hex')}`,
      enabled: existing?.enabled ?? true,
      ...(draft.downloadUrl === undefined && existing?.downloadUrl !== undefined ? { downloadUrl: existing.downloadUrl } : {}),
      installedAt: existing?.installedAt ?? now,
      updatedAt: now,
    };
    commit(existing ? scripts.map((s) => (s.id === script.id ? script : s)) : [...scripts, script]);
    return info(script);
  });

  ipcMain.handle('userscripts:remove', (event, id: unknown) => {
    assertShellSender(event);
    if (!scripts.some((s) => s.id === id)) return;
    commit(scripts.filter((s) => s.id !== id));
  });

  ipcMain.handle('userscripts:setEnabled', (event, id: unknown, enabled: unknown) => {
    assertShellSender(event);
    if (!scripts.some((s) => s.id === id && s.enabled !== (enabled === true))) return;
    commit(scripts.map((s) => (s.id === id ? { ...s, enabled: enabled === true } : s)));
  });

  // The library the shell kept in localStorage before it was kept here: taken
  // once, in place of the copy synced from it. True once it's safely here (or
  // was already), so the shell can drop its own.
  ipcMain.handle('userscripts:adopt', (event, list: unknown) => {
    assertShellSender(event);
    if (owned) return true;
    try {
      commit(sanitizeScripts(list));
      return true;
    } catch {
      return false;
    }
  });

  // Fetch a script's source for the install dialog. Done here (not in the
  // shell renderer) because the shell's CSP/CORS won't allow arbitrary
  // cross-origin reads, and the URL is https-only and size-capped.
  ipcMain.handle('userscripts:fetch', async (event, url) => {
    assertShellSender(event);
    if (typeof url !== 'string' || !/^https:\/\//i.test(url)) {
      throw new Error('Only https userscript URLs can be fetched');
    }
    const response = await net.fetch(url);
    if (!response.ok) throw new Error(`Request failed (${response.status})`);
    const text = await response.text();
    if (text.length > MAX_CODE_BYTES) throw new Error('Script is too large');
    return text;
  });
}
