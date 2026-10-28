import { useEffect, useState } from 'react';
import { GuestSurface } from '@/platform/GuestSurface';
import { getDevtoolsBridge } from '@/lib/devtools';

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
  const [hostId, setHostId] = useState<number | null>(null);

  useEffect(() => {
    const devtools = getDevtoolsBridge();
    if (hostId === null || !devtools) return;
    let disposed = false;
    devtools
      .open(targetWcId, hostId)
      .then(() => {
        if (!disposed) onReady?.();
      })
      .catch(() => {
        // The tab died mid-flight.
      });
    return () => {
      disposed = true;
      // Unmounting destroys the host; close the target's devtools first so
      // it detaches cleanly. No-op if the tab is already gone.
      devtools.close(targetWcId).catch(() => {});
    };
  }, [targetWcId, hostId, onReady]);

  return (
    <GuestSurface
      // A blank start page; the main process navigates the guest to the
      // devtools frontend once devtools.open() wires the session up.
      src="about:blank"
      // See DEVTOOLS_PARTITION in electron/main.mts.
      partition="persist:devtools"
      guestClassName="h-full w-full bg-white"
      onAttach={setHostId}
    />
  );
}
