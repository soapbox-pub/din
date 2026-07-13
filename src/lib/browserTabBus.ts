import type { CrxTabCommand } from '@/lib/crx';

/**
 * Singleton bus routing extension-initiated tab commands (see `window.crx`)
 * to the mounted Web Browser app.
 *
 * The extension system can ask for tabs at any time - including while no
 * browser window is open (e.g. an extension background script calls
 * chrome.tabs.create). <BrowserExtensionHost> subscribes to the bridge for
 * the lifetime of the desktop, opens the browser app when needed, and
 * publishes commands here; the WebBrowser component consumes them, draining
 * anything queued while it was closed.
 *
 * When multiple browser windows are open, the most recently mounted one
 * receives commands (consumers form a stack).
 */

type Consumer = (command: CrxTabCommand) => void;

const consumers: Consumer[] = [];
const queue: CrxTabCommand[] = [];

/** Deliver a tab command to the active consumer, or queue it for the next. */
export function publishTabCommand(command: CrxTabCommand): void {
  const consumer = consumers[consumers.length - 1];
  if (consumer) {
    consumer(command);
  } else {
    queue.push(command);
  }
}

/** Whether a Web Browser instance is currently consuming commands. */
export function hasTabConsumer(): boolean {
  return consumers.length > 0;
}

/**
 * Register the mounted Web Browser as the consumer of tab commands. Any
 * queued commands are delivered immediately. Returns an unsubscribe fn.
 */
export function consumeTabCommands(consumer: Consumer): () => void {
  consumers.push(consumer);
  if (consumers[consumers.length - 1] === consumer) {
    while (queue.length > 0) {
      consumer(queue.shift() as CrxTabCommand);
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
  action: 'new-tab' | 'close-tab';
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
