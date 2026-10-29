import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { getIconThemeBridge } from '@/lib/iconTheme';
import type { IconThemeInfo, IconThemeStatus } from '@/lib/iconTheme';

/** TanStack Query hooks over the icon theme bridge (window.dinos.iconTheme). */

function requireBridge() {
  const iconTheme = getIconThemeBridge();
  if (!iconTheme) throw new Error('Icon theme bridge unavailable');
  return iconTheme;
}

/** The icon theme, and whether it can be changed here. */
export function useIconThemeStatus() {
  return useQuery<IconThemeStatus>({
    queryKey: ['icon-theme', 'status'],
    queryFn: () => requireBridge().status(),
    enabled: getIconThemeBridge() !== undefined,
    retry: false,
  });
}

/** The installed icon themes, with a few icons of each. */
export function useIconThemes() {
  return useQuery<IconThemeInfo[]>({
    queryKey: ['icon-theme', 'themes'],
    queryFn: () => requireBridge().themes(),
    enabled: getIconThemeBridge() !== undefined,
    staleTime: 60_000,
    retry: false,
  });
}

/** Make a theme the session's. */
export function useSetIconTheme() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (theme: string) => requireBridge().set(theme),
    onSettled: () => queryClient.invalidateQueries({ queryKey: ['icon-theme', 'status'] }),
  });
}
