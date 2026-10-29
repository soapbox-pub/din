import { useEffect, useState } from 'react';
import { getSystemMonitorBridge, type SystemSnapshot } from '@/lib/systemMonitor';

/** Snapshots kept for the CPU, memory and GPU graphs: a minute's worth. */
export const SYSTEM_HISTORY_LENGTH = 30;

interface SystemMonitorState {
  snapshot: SystemSnapshot | null;
  /** Recent whole-machine CPU use, in percent, oldest first. */
  cpuHistory: number[];
  /** Recent memory use, in percent of the total, oldest first. */
  memoryHistory: number[];
  /** Recent GPU use, in percent, oldest first. */
  gpuHistory: number[];
}

const EMPTY: SystemMonitorState = { snapshot: null, cpuHistory: [], memoryHistory: [], gpuHistory: [] };

/**
 * What's running, refreshed every couple of seconds. The main process only
 * samples while something is subscribed, so this costs nothing once the
 * last subscriber unmounts. `available` is false outside the Electron shell.
 */
export function useSystemMonitor() {
  const bridge = getSystemMonitorBridge();
  const [state, setState] = useState<SystemMonitorState>(EMPTY);

  useEffect(() => {
    if (!bridge) return;
    return bridge.subscribe((snapshot) =>
      setState((prev) => ({
        snapshot,
        cpuHistory: [...prev.cpuHistory, snapshot.cpu].slice(-SYSTEM_HISTORY_LENGTH),
        memoryHistory: [
          ...prev.memoryHistory,
          snapshot.memory.total > 0 ? (snapshot.memory.used / snapshot.memory.total) * 100 : 0,
        ].slice(-SYSTEM_HISTORY_LENGTH),
        gpuHistory: [...prev.gpuHistory, snapshot.gpu?.busy ?? 0].slice(-SYSTEM_HISTORY_LENGTH),
      })),
    );
  }, [bridge]);

  return { available: bridge !== undefined, ...state };
}
