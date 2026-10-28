import type { CrxTabCommand } from '@/lib/crx';

/**
 * Singleton bus routing extension-initiated tab commands (see `window.dinos.crx`)
 * to the mounted Web Browser app.
 *
 * The extension system can ask for tabs at any time - including while no
 * browser window is open (e.g. an extension background script calls
 * chrome.tabs.create). <BrowserExtensionHost> subscribes to the bridge for
 * the lifetime of the desktop, opens the browser app when needed, and
 * publishes commands here; the WebBrowser component consumes them, draining
 * anything queued while it was closed.
 *
 * A command that references a specific tab (a page-opened link's opener, or
 * the target of chrome.tabs.update/remove) is routed to the browser window
 * that owns that tab, so a new tab always opens in the same window - and thus
 * the same session - as its opener. This keeps private-window links out of the
 * persistent, authenticated session (and vice versa). Commands with no such
 * reference (chrome.tabs.create, desktop link clicks) go to the most recently
 * mounted window (consumers form a stack).
 *
 * Pop-up windows (WebPopup) consume too, but only the commands bound to their
 * one page; they are never a browser window that unbound commands fall to.
 */

interface Consumer {
  /** Apply a tab command to this browser window's tabs. */
  handle: (command: CrxTabCommand) => void;
  /** Whether this window hosts the tab with the given WebContents id. */
  ownsTab: (wcId: number) => boolean;
  /** A pop-up window: takes bound commands only. */
  popup: boolean;
}

const consumers: Consumer[] = [];
const queue: CrxTabCommand[] = [];

/**
 * The WebContents id a command is bound to, if it references a specific tab:
 * an `open`'s opener, or a `select`/`close` target. Such commands must reach
 * the window that owns that tab; others (`create`) have no binding.
 */
function boundWcId(command: CrxTabCommand): number | undefined {
  switch (command.type) {
    case 'open':
      return command.openerWcId;
    case 'select':
    case 'close':
      return command.wcId;
    default:
      return undefined;
  }
}

/** The newest browser window (not a pop-up), if any. */
function topBrowser(): Consumer | undefined {
  return consumers.findLast((c) => !c.popup);
}

/** The consumer that should handle a command: its tab owner, else top-of-stack. */
function targetFor(command: CrxTabCommand): Consumer | undefined {
  const wcId = boundWcId(command);
  const owner =
    wcId !== undefined ? consumers.find((c) => c.ownsTab(wcId)) : undefined;
  return owner ?? topBrowser();
}

/** Deliver a tab command to the owning (or active) consumer, or queue it. */
export function publishTabCommand(command: CrxTabCommand): void {
  const consumer = targetFor(command);
  if (consumer) {
    consumer.handle(command);
  } else {
    queue.push(command);
  }
}

/** Whether a Web Browser instance is currently consuming commands. */
export function hasTabConsumer(): boolean {
  return topBrowser() !== undefined;
}

/**
 * Register a mounted Web Browser as a consumer of tab commands. `ownsTab`
 * reports whether this window hosts a given tab, so commands route to the
 * right window. Any queued commands (issued while no browser was open, hence
 * ownerless) are delivered immediately. A pop-up window passes `popup` and
 * gets only the commands bound to its page. Returns an unsubscribe fn.
 */
export function consumeTabCommands(
  handle: Consumer['handle'],
  ownsTab: Consumer['ownsTab'],
  popup = false,
): () => void {
  const consumer: Consumer = { handle, ownsTab, popup };
  consumers.push(consumer);
  if (!popup) {
    while (queue.length > 0) {
      consumer.handle(queue.shift() as CrxTabCommand);
    }
  }
  return () => {
    const index = consumers.indexOf(consumer);
    if (index !== -1) consumers.splice(index, 1);
  };
}

/**
 * A browser hotkey routed by the desktop's global handler (DesktopHotkeys):
 * Ctrl+T / Ctrl+W act on the focused desktop window, which the shell knows
 * but the browser app doesn't. Scoped by window id so only the targeted
 * browser instance acts; not queued (a hotkey with no live target is stale).
 */
export interface BrowserHotkey {
  /** Desktop window id of the target browser instance. */
  windowId: string;
  action:
    | 'new-tab'
    | 'close-tab'
    | 'focus-address'
    | 'find'
    | 'view-source'
    | 'print'
    | 'reload'
    | 'force-reload'
    | 'cycle-tab'
    | 'goto-tab'
    | 'back'
    | 'forward'
    | 'reopen-tab'
    | 'new-window'
    | 'new-private-window'
    | 'close-window'
    | 'clear-data'
    | 'zoom-in'
    | 'zoom-out'
    | 'zoom-reset';
  /** Direction for 'cycle-tab' (Ctrl+Shift+Tab). */
  backward?: boolean;
  /** Pressed digit for 'goto-tab' (1-9; 9 = last tab). */
  digit?: number;
}

type HotkeyConsumer = (hotkey: BrowserHotkey) => void;

const hotkeyConsumers: HotkeyConsumer[] = [];

/** Deliver a hotkey to every mounted browser (each filters by window id). */
export function publishBrowserHotkey(hotkey: BrowserHotkey): void {
  for (const consumer of [...hotkeyConsumers]) consumer(hotkey);
}

/** Subscribe a mounted Web Browser to hotkeys. Returns an unsubscribe fn. */
export function consumeBrowserHotkeys(consumer: HotkeyConsumer): () => void {
  hotkeyConsumers.push(consumer);
  return () => {
    const index = hotkeyConsumers.indexOf(consumer);
    if (index !== -1) hotkeyConsumers.splice(index, 1);
  };
}
