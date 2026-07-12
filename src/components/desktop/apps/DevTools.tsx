import { Code } from 'lucide-react';
import type { AppComponentProps } from '@/lib/apps';
import { DevToolsPane } from '@/components/desktop/apps/DevToolsPane';
import { InspectorToolbar } from '@/components/desktop/apps/InspectorToolbar';
import { useWindowManager } from '@/contexts/WindowManagerContext';
import { publishInspectorDock } from '@/lib/inspectorBus';

/**
 * A DevTools session hosted in its own desktop window - the "open in separate
 * window" mode of the Web Browser's inspector.
 *
 * The window is opened by the browser (see WebBrowser) with the inspected
 * tab's WebContents id in its launch params. It fills the window with a
 * {@link DevToolsPane} targeting that tab, topped by the same
 * {@link InspectorToolbar} strip as the docked pane. The dock controls here
 * re-dock the inspector back into the browser via the inspector bus (keyed by
 * the tab's WebContents id); closing this window closes the inspector.
 *
 * The device menu is omitted: the responsive frame is rendered by the browser
 * window and can't follow the inspector into this separate window. The CDP
 * wiring is identical to a docked pane (see src/lib/devtools.ts). Electron
 * shell only - the browser never offers undocking in the iframe fallback.
 *
 * If the target tab is gone (invalid or missing id), it shows a short empty
 * state instead of a blank pane.
 */
export function DevTools({ windowId, params }: AppComponentProps) {
  const { close: closeWindow } = useWindowManager();
  const targetWcId =
    typeof params?.targetWcId === 'number' ? params.targetWcId : null;

  if (targetWcId === null) {
    return (
      <div className="grid h-full w-full place-items-center bg-background p-6 text-center">
        <div className="max-w-xs space-y-2">
          <Code className="mx-auto size-8 text-muted-foreground" aria-hidden />
          <p className="text-sm text-muted-foreground">
            This inspector isn't attached to a page. Close it and reopen
            developer tools from the browser.
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="flex h-full w-full flex-col bg-white">
      <InspectorToolbar
        // This window IS the undocked inspector; reflect that in the menu.
        dock="window"
        onSetDock={(mode) => {
          if (mode === 'window') return; // already a window
          // Re-dock into the browser; this window closes itself.
          publishInspectorDock({ targetWcId, mode });
          closeWindow(windowId);
        }}
        // Closing from the strip closes this window (the browser reconciles
        // the tab's dock state when the window disappears).
        onClose={() => closeWindow(windowId)}
      />
      <div className="min-h-0 flex-1">
        <DevToolsPane targetWcId={targetWcId} />
      </div>
    </div>
  );
}
