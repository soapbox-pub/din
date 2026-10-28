import { useEffect } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import {
  getNativeAppsBridge,
  type NativeApp,
  type NativeAppList,
} from '@/lib/nativeApps';

/**
 * TanStack Query hook over the native-app bridge (window.dinos.nativeApps).
 *
 * The installed-app list is expensive to produce (a scan of every XDG
 * desktop entry plus icon-theme lookups, with icons inlined as data URLs) and
 * almost never changes, so it's fetched once and kept until the main process
 * reports an install.
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
  const queryClient = useQueryClient();

  // Installing a program (a Windows installer, a Flatpak) is the one time
  // the list does change; the main process says so.
  useEffect(() => {
    return bridge?.onChanged(() => {
      void queryClient.invalidateQueries({ queryKey: ['native-apps', 'list'] });
    });
  }, [bridge, queryClient]);

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
