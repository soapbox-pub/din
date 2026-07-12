/**
 * Singleton bus for inspector dock commands sent from an undocked DevTools
 * window back to the Web Browser that owns the inspected tab.
 *
 * When DevTools is undocked into its own desktop window, its dock controls
 * live in that window's component tree - separate from the browser that owns
 * the tab's dock state. The DevTools window publishes a re-dock request here
 * keyed by the inspected tab's WebContents id; the owning browser window
 * (which subscribes and filters by wcId, like it does for devtools bridge
 * commands) applies it.
 */

/** A request to move an inspected tab's inspector to a new dock position. */
export interface InspectorDockCommand {
  /** WebContents id of the inspected tab. */
  targetWcId: number;
  /** Where to move the inspector: re-dock, or close it. */
  mode: 'bottom' | 'right' | 'closed';
}

type Consumer = (command: InspectorDockCommand) => void;

const consumers = new Set<Consumer>();

/** Ask the owning browser to re-dock the inspector for a tab. */
export function publishInspectorDock(command: InspectorDockCommand): void {
  for (const consumer of consumers) consumer(command);
}

/**
 * Subscribe to inspector dock commands. The browser filters by its tabs'
 * WebContents ids. Returns an unsubscribe fn.
 */
export function consumeInspectorDock(consumer: Consumer): () => void {
  consumers.add(consumer);
  return () => {
    consumers.delete(consumer);
  };
}
