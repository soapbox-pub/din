import { useQuery } from '@tanstack/react-query';
import {
  getNativeAppsBridge,
  type NativeApp,
  type NativeAppList,
} from '@/lib/nativeApps';

/**
 * TanStack Query hook over the native-app bridge (window.nativeApps).
 *
 * The installed-app list is expensive to produce (a scan of every XDG
 * desktop entry plus icon-theme lookups, with icons inlined as data URLs) and
 * almost never changes, so it's fetched once and kept.
 */

/** Stable empty result, so consumers don't re-render on a fresh []. */
const NO_APPS: NativeApp[] = [];

function requireBridge() {
  const bridge = getNativeAppsBridge();
  if (!bridge) throw new Error('Native app bridge unavailable');
  return bridge;
}

/**
 * Installed Linux applications. Empty outside the Electron shell, and
 * where Din's embedded display can't run.
 */
export function useNativeApps(): { apps: NativeApp[]; available: boolean } {
  const bridge = getNativeAppsBridge();
  const { data } = useQuery<NativeAppList>({
    queryKey: ['native-apps', 'list'],
    queryFn: () => requireBridge().list(),
    enabled: bridge !== undefined,
    // Apps are installed and removed rarely; the main process re-scans on its
    // own schedule, so refetching here would only re-transfer the icons.
    staleTime: Infinity,
    gcTime: Infinity,
    retry: false,
  });
  return { apps: data?.apps ?? NO_APPS, available: data?.available ?? false };
}
