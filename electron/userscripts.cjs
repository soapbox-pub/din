// Userscript engine for the Web Browser app: native support for
// Greasemonkey-format scripts, managed like extensions.
//
// The shell renderer owns the script library (src/hooks/useUserscripts.ts)
// and syncs the full list here over `userscripts:sync`; a copy is persisted
// to userData/userscripts.json so injection works from the first page load
// after a restart, before any renderer sync arrives.
//
// Injection targets browser-tab guests only (main.cjs calls attachUserscripts
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
// break chrome.webRequest for extensions — see the warning in main.cjs).

const path = require('node:path');
const fs = require('node:fs');
const { app, ipcMain, net } = require('electron');

/** Upper bounds keeping a hostile sync/fetch from bloating disk or memory. */
const MAX_SCRIPTS = 200;
const MAX_CODE_BYTES = 2 * 1024 * 1024;

/** The current script list (sanitized renderer data). */
let scripts = [];

function storeFile() {
  return path.join(app.getPath('userData'), 'userscripts.json');
}

/**
 * Validate one renderer-supplied script record. The renderer is the trusted
 * shell (assertShellSender gates the IPC), but records also round-trip
 * through a JSON file on disk, so shape-check everything defensively.
 */
function sanitizeScript(raw) {
  if (!raw || typeof raw !== 'object') return null;
  if (typeof raw.id !== 'string' || !/^[A-Za-z0-9_-]{1,64}$/.test(raw.id)) return null;
  if (typeof raw.code !== 'string' || raw.code.length > MAX_CODE_BYTES) return null;
  if (typeof raw.name !== 'string' || !raw.name) return null;
  const strings = (value) =>
    Array.isArray(value) ? value.filter((item) => typeof item === 'string') : [];
  const runAt = ['document-start', 'document-end', 'document-idle'].includes(raw.runAt)
    ? raw.runAt
    : 'document-end';
  return {
    id: raw.id,
    name: raw.name,
    namespace: typeof raw.namespace === 'string' ? raw.namespace : '',
    version: typeof raw.version === 'string' ? raw.version : '',
    description: typeof raw.description === 'string' ? raw.description : '',
    enabled: raw.enabled === true,
    runAt,
    matches: strings(raw.matches),
    includes: strings(raw.includes),
    excludes: strings(raw.excludes),
    code: raw.code,
  };
}

function sanitizeScripts(list) {
  if (!Array.isArray(list)) return [];
  const seen = new Set();
  const out = [];
  for (const raw of list) {
    const script = sanitizeScript(raw);
    if (!script || seen.has(script.id)) continue;
    seen.add(script.id);
    out.push(script);
    if (out.length >= MAX_SCRIPTS) break;
  }
  return out;
}

function loadFromDisk() {
  try {
    scripts = sanitizeScripts(JSON.parse(fs.readFileSync(storeFile(), 'utf8')));
  } catch {
    // Missing or corrupt store: start empty; the renderer re-syncs anyway.
    scripts = [];
  }
}

function saveToDisk() {
  try {
    fs.writeFileSync(storeFile(), JSON.stringify(scripts));
  } catch (error) {
    console.error('userscripts: failed to persist store:', error);
  }
}

// --- URL matching (Greasemonkey semantics) ---------------------------------

/** Compile a glob (* wildcards) into an anchored RegExp. */
function globToRegExp(glob) {
  const escaped = glob.replace(/[.+^${}()|[\]\\?]/g, '\\$&').replace(/\*/g, '.*');
  return new RegExp(`^${escaped}$`);
}

/** An @include/@exclude rule: /regex/ when slash-delimited, else a glob. */
function includeRuleMatches(rule, url) {
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
function matchPatternMatches(pattern, url) {
  let target;
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
function scriptMatchesUrl(script, url) {
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
function buildInjectionSource(script) {
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
function injectForStage(contents, stage) {
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
function attachUserscripts(contents) {
  contents.on('dom-ready', () => injectForStage(contents, 'ready'));
  contents.on('did-finish-load', () => injectForStage(contents, 'idle'));
}

/** Whether a URL points at a userscript file (an install link). */
function isUserscriptInstallUrl(url) {
  try {
    const { protocol, pathname } = new URL(url);
    return (protocol === 'https:' || protocol === 'http:') && pathname.endsWith('.user.js');
  } catch {
    return false;
  }
}

/** Register the userscripts:* IPC surface and load the persisted store. */
function registerUserscriptHandlers({ assertShellSender }) {
  loadFromDisk();

  // Full-list replacement from the shell (the renderer is authoritative).
  ipcMain.on('userscripts:sync', (event, list) => {
    assertShellSender(event);
    scripts = sanitizeScripts(list);
    saveToDisk();
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

module.exports = {
  registerUserscriptHandlers,
  attachUserscripts,
  isUserscriptInstallUrl,
};
