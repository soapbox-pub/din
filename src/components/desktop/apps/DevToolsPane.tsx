import { useEffect, useRef } from 'react';
import { getDevtoolsBridge } from '@/lib/devtools';

/**
 * The docked Chrome DevTools surface for one browser tab.
 *
 * Renders a devtools host <webview> and, once its guest attaches, asks the
 * main process to dock the inspected tab's devtools into it
 * (webContents.setDevToolsWebContents + openDevTools, see electron/main.cjs).
 *
 * The host lives in its own in-memory session partition ("devtools") so it
 * is never treated as a browser tab: the Chrome extension system ignores it
 * and it carries no persistent state. Electron-shell only - the parent must
 * not render this in the iframe fallback (the bridge is absent there).
 */
export function DevToolsPane({
  targetWcId,
  onReady,
}: {
  /** WebContents id of the tab to inspect. */
  targetWcId: number;
  /** Called once the tab's devtools are open inside this pane. */
  onReady?: () => void;
}) {
  const webviewRef = useRef<DevtoolsWebviewElement>(null);

  useEffect(() => {
    const el = webviewRef.current;
    const devtools = getDevtoolsBridge();
    if (!el || !devtools) return;

    let opened = false;
    let disposed = false;

    // The guest attaches asynchronously after mount; getWebContentsId()
    // throws until then, so retry across the attachment events.
    const attach = () => {
      if (opened || disposed) return;
      let hostId: number;
      try {
        hostId = el.getWebContentsId();
      } catch {
        return; // not attached yet; a later event retries
      }
      opened = true;
      devtools
        .open(targetWcId, hostId)
        .then(() => {
          if (!disposed) onReady?.();
        })
        .catch(() => {
          opened = false; // e.g. the tab died mid-flight
        });
    };

    el.addEventListener('did-attach', attach);
    el.addEventListener('dom-ready', attach);
    attach();

    return () => {
      disposed = true;
      el.removeEventListener('did-attach', attach);
      el.removeEventListener('dom-ready', attach);
      // Unmounting destroys the host; close the target's devtools first so
      // it detaches cleanly. No-op if the tab is already gone.
      devtools.close(targetWcId).catch(() => {});
    };
  }, [targetWcId, onReady]);

  return (
    <webview
      ref={webviewRef}
      // setDevToolsWebContents requires a host that has never navigated.
      src="about:blank"
      // In-memory partition (no persist:) - see electron/main.cjs.
      partition="devtools"
      className="h-full w-full bg-white"
      style={{ display: 'flex' }}
    />
  );
}

/** Minimal typing for the Electron <webview> element methods we use. */
interface DevtoolsWebviewElement extends HTMLElement {
  getWebContentsId(): number;
}
