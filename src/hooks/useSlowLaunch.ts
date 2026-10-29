import { useEffect, useState } from 'react';

/** How long an app may take to appear before its launch splash shows its icon. */
const SLOW_LAUNCH_MS = 600;

/**
 * Whether the app window that mounted this has been launching long enough to
 * show its icon on the splash. Most apps appear well before, and an icon
 * shown only for a moment reads as a flash rather than a launch.
 */
export function useSlowLaunch(): boolean {
  const [slow, setSlow] = useState(false);
  useEffect(() => {
    const timer = setTimeout(() => setSlow(true), SLOW_LAUNCH_MS);
    return () => clearTimeout(timer);
  }, []);
  return slow;
}
