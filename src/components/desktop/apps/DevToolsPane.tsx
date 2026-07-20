import { useEffect, useRef } from 'react';
import { getDevtoolsBridge } from '@/lib/devtools';
import { GuestClickShield } from '@/components/desktop/GuestClickShield';

/**
 * The docked Chrome DevTools surface for one browser tab.
 *
 * Renders a devtools host <webview> and, once its guest attaches, asks the
 * main process to open the tab's devtools in it. Main navigates the host to
 * the bundled DevTools frontend, connected to the inspected tab over a
 * loopback CDP bridge (see electron/devtools-bridge.cjs for why the naive
 * setDevToolsWebContents wiring doesn't work for <webview> hosts).
 *
 * The host lives in its own session partition (persist:devtools) so it is
 * never treated as a browser tab: the Chrome extension system ignores it and
 * devtools preferences persist across runs. Electron-shell only - the parent
 * must not render this in the iframe fallback (the bridge is absent there).
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
    // The wrapper hosts GuestClickShield: while this pane's window is not on
    // top, the shield covers the devtools guest so a click into it raises the
    // window (guest input never reaches this document).
    <div className="relative h-full w-full" style={{ display: 'flex' }}>
      <webview
        ref={webviewRef}
        // A blank start page; the main process navigates the guest to the
        // devtools frontend once devtools.open() wires the session up.
        src="about:blank"
        // See DEVTOOLS_PARTITION in electron/main.cjs.
        partition="persist:devtools"
        className="h-full w-full bg-white"
        style={{ display: 'flex' }}
      />
      <GuestClickShield />
    </div>
  );
}

/** Minimal typing for the Electron <webview> element methods we use. */
interface DevtoolsWebviewElement extends HTMLElement {
  getWebContentsId(): number;
}
