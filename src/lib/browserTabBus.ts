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
