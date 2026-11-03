import { useEffect, useSyncExternalStore } from 'react';
import { useQueryClient, type QueryClient } from '@tanstack/react-query';
import { useAppContext } from '@/hooks/useAppContext';
import { gameInFullscreen, subscribeGameFullscreen } from '@/lib/gameMode';
import { getPowerBridge } from '@/lib/power';

const PERFORMANCE = 'performance';
/** The mode to go back to, kept so a Din that quit mid-game still does. */
const PREVIOUS_KEY = 'din:game-performance-previous';

/** Whether the performance mode is wanted now (the latest word on it). */
let wanted = false;
/** Switches, one after another: each acts on the latest `wanted`. */
let queue: Promise<void> = Promise.resolve();

function previousMode(): string | null {
  return localStorage.getItem(PREVIOUS_KEY);
}

function setPreviousMode(mode: string | null): void {
  if (mode) localStorage.setItem(PREVIOUS_KEY, mode);
  else localStorage.removeItem(PREVIOUS_KEY);
}

/**
 * Bring the power mode in line with `wanted`. Run one at a time, so a game
 * leaving and re-entering full screen quickly can't race the switches.
 */
async function sync(queryClient: QueryClient): Promise<void> {
  const bridge = getPowerBridge();
  if (!bridge) return;
  const profiles = await bridge.profiles();
  if (!profiles.available) return;
  const previous = previousMode();
  let next;
  if (wanted && previous === null) {
    if (!profiles.active || profiles.active === PERFORMANCE || !profiles.profiles.includes(PERFORMANCE)) return;
    setPreviousMode(profiles.active);
    next = await bridge.setProfile(PERFORMANCE);
  } else if (!wanted && previous !== null) {
    setPreviousMode(null);
    // Changed by hand meanwhile: left as it is.
    if (profiles.active !== PERFORMANCE || !profiles.profiles.includes(previous)) return;
    next = await bridge.setProfile(previous);
  } else {
    return;
  }
  queryClient.setQueryData(['power', 'profiles'], next);
}

/**
 * While a game is in full screen (src/lib/gameMode.ts), the computer runs in
 * the performance power mode, and goes back to the mode it was in once no
 * game is, unless `gamePerformance` is off or the mode was changed by hand.
 */
export function GamePerformanceHost() {
  const { config } = useAppContext();
  const queryClient = useQueryClient();
  const playing = useSyncExternalStore(subscribeGameFullscreen, gameInFullscreen);

  useEffect(() => {
    wanted = playing && config.gamePerformance;
    queue = queue.then(() => sync(queryClient)).catch(() => {});
  }, [playing, config.gamePerformance, queryClient]);

  return null;
}
