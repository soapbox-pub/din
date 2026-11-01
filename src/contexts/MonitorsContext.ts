import { createContext, useContext } from 'react';
import type { Monitor, WorkArea } from '@/lib/monitors';

/** The monitors Din's window spans (see src/lib/monitors.ts). */
export interface MonitorsLayout {
  /** Every monitor, in viewport CSS pixels. */
  monitors: Monitor[];
  /** The one carrying the menu bar, Dock, and system UI. */
  primary: Monitor;
  /** The whole viewport. */
  width: number;
  height: number;
  /** Whether the host's monitors are known yet (until then, the viewport stands in). */
  ready: boolean;
}

export const MonitorsContext = createContext<MonitorsLayout | undefined>(undefined);

/** Access the monitor layout. Must be used within a MonitorsProvider. */
export function useMonitors(): MonitorsLayout {
  const ctx = useContext(MonitorsContext);
  if (!ctx) {
    throw new Error('useMonitors must be used within a MonitorsProvider');
  }
  return ctx;
}

/**
 * The desktop's monitors in workspace coordinates, for the window manager:
 * one work area per monitor (the primary's leaves out the menu bar).
 */
export const WorkAreasContext = createContext<WorkArea[] | undefined>(undefined);

/** Access the desktop's work areas. Must be used within the Desktop. */
export function useWorkAreas(): WorkArea[] {
  const ctx = useContext(WorkAreasContext);
  if (!ctx) {
    throw new Error('useWorkAreas must be used within a Desktop');
  }
  return ctx;
}
