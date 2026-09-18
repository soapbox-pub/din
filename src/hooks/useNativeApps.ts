import { useEffect } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import {
  getNativeAppsBridge,
  type NativeApp,
  type NativeAppList,
  type NativeWindow,
} from '@/lib/nativeApps';

/**
 * TanStack Query hooks over the native-app bridge (window.nativeApps).
 *
 * The installed-app list is expensive to produce (a scan of every XDG
 * desktop entry plus icon-theme lookups, with icons inlined as data URLs) and
 * almost never changes, so it's fetched once and kept. The window list is the
 * opposite: it changes constantly and is pushed from the main process on
 * every X11 event, so the query is seeded once and then updated in place -
 * no polling.
 */

/** Stable empty results, so consumers don't re-render on a fresh []. */
const NO_APPS: NativeApp[] = [];
const NO_WINDOWS: NativeWindow[] = [];

function requireBridge() {
  const bridge = getNativeAppsBridge();
  if (!bridge) throw new Error('Native app bridge unavailable');
  return bridge;
}

/**
 * Installed Linux applications. Empty outside the Electron shell, and in
 * sessions with no X11 window manager for Din to hand windows to.
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

/** The session's live native windows, pushed from the main process. */
export function useNativeWindows(): NativeWindow[] {
  const bridge = getNativeAppsBridge();
  const queryClient = useQueryClient();

  const { data } = useQuery<NativeWindow[]>({
    queryKey: ['native-apps', 'windows'],
    queryFn: () => requireBridge().windows(),
    enabled: bridge !== undefined,
    staleTime: Infinity,
    retry: false,
  });

  useEffect(() => {
    if (!bridge) return;
    return bridge.onWindows((windows) => {
      queryClient.setQueryData(['native-apps', 'windows'], windows);
    });
  }, [bridge, queryClient]);

  return data ?? NO_WINDOWS;
}
