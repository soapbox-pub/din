import type { AppDefinition } from '@/lib/apps';
import type { Permission } from '@/sdk/din';
import { PROVIDER_WINDOW_APP_ID } from '@/shared/assistant/providerWindow';

/**
 * What an app may open with `window.open(appLink(id, params))` or
 * `din.app.launch` (DinAppFrame's `app.open`), and with which launch params.
 *
 * Launch params are how the desktop sets up its own windows: a browser
 * window's tabs (`restoreSession`, `adoptTab`), a pop-up's page, a
 * userscript to install, a nostrconnect:// link to connect, a native
 * window to wrap (`xid`), a frameless window at a size of its choosing. An
 * app is anything from Din's own to an untrusted folder, so it can't hand
 * those over:
 *
 * - Another app of its own kind (a built-in app, an app from a folder, one
 *   the `din` command runs) reads its params as coming from anywhere, so it
 *   gets them, without the window manager's (`DESKTOP_PARAMS`).
 * - An installed web app or nsite opens, with none.
 * - Of the desktop's own windows, only those in `DESKTOP_WINDOWS` open, each
 *   with only the params named there; the rest (DevTools, pop-ups, the
 *   userscript installer, Connect an App, the file picker, printing,
 *   native windows, the Installer…) are the desktop's alone to open.
 */

/** Params the window manager and the desktop's own launches set, which no app may. */
const DESKTOP_PARAMS = new Set([
  // The window itself: frameless (at a size, which could pass for anything
  // the desktop draws), under another app's Dock tile. A plain `width` and
  // `height` stay: they're Paint's and Photo Editor's new picture's.
  'frameless',
  'dockAs',
  // A native window's X id.
  'xid',
  // A browser window's tabs, from the desktop's session or a tab drag.
  'restoreSession',
  'adoptTab',
  // A share, which only the share sheet makes.
  'shareNonce',
  // Files, which travel as handles the app holds (DinAppFrame turns them back into paths).
  'path',
  'paths',
  'readOnlyPaths',
  // Who asked, which the desktop says itself.
  'opener',
  // A Dock or launcher action's moment.
  'actionAt',
]);

/** The desktop's own windows an app may open, the params each takes from one, and the permission it needs, if any. */
const DESKTOP_WINDOWS: Record<string, { params: readonly string[]; needs?: Permission }> = {
  // A new browser window (links open through window.open, not here).
  'web-browser': { params: ['private'] },
  // A section of Settings: Messages' Phone, Games' Optional Features.
  settings: { params: ['section', 'add', 'nonce'] },
  'system-monitor': { params: [] },
  screenshot: { params: [] },
  // Adding or reconnecting an AI provider, from the Assistant and apps that talk to it.
  [PROVIDER_WINDOW_APP_ID]: { params: ['provider', 'at'], needs: 'assistant' },
};

/**
 * The params an app's launch of `target` opens it with, or null when the app
 * may not open it at all.
 */
export function appLaunchParams(
  target: AppDefinition | undefined,
  params: Record<string, unknown>,
  permissions: readonly Permission[],
): Record<string, unknown> | null {
  if (!target || target.native) return null;
  if (target.sandboxed) {
    return Object.fromEntries(Object.entries(params).filter(([key]) => !DESKTOP_PARAMS.has(key)));
  }
  if (target.web) return {};
  const allowed = DESKTOP_WINDOWS[target.id];
  if (!allowed || (allowed.needs && !permissions.includes(allowed.needs))) return null;
  return Object.fromEntries(Object.entries(params).filter(([key]) => allowed.params.includes(key)));
}
