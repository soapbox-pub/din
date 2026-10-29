import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { getSystemCursorBridge, previewToDataUrl } from '@/lib/systemCursor';
import type { CursorEffectPackageInfo, SystemCursorStatus, SystemCursorTheme } from '@/lib/systemCursor';

/** TanStack Query hooks over the cursor bridge (window.dinos.cursor). */

function requireBridge() {
  const cursor = getSystemCursorBridge();
  if (!cursor) throw new Error('Cursor bridge unavailable');
  return cursor;
}

/** The pointer's theme and size, and whether they can be changed here. */
export function useSystemCursorStatus() {
  return useQuery<SystemCursorStatus>({
    queryKey: ['cursor', 'status'],
    queryFn: () => requireBridge().status(),
    enabled: getSystemCursorBridge() !== undefined,
    retry: false,
  });
}

/** The installed cursor themes. */
export function useSystemCursorThemes() {
  return useQuery<SystemCursorTheme[]>({
    queryKey: ['cursor', 'themes'],
    queryFn: () => requireBridge().themes(),
    enabled: getSystemCursorBridge() !== undefined,
    staleTime: 60_000,
    retry: false,
  });
}

/** A few of a theme's cursors (arrow, hand, I-beam, resize) as data URLs. */
export function useSystemCursorPreview(id: string) {
  return useQuery<{ role: string; src: string }[]>({
    queryKey: ['cursor', 'preview', id],
    queryFn: async () =>
      (await requireBridge().preview(id, 48)).map((preview) => ({
        role: preview.role,
        src: previewToDataUrl(preview),
      })),
    enabled: getSystemCursorBridge() !== undefined,
    staleTime: Infinity,
    retry: false,
  });
}

/** Make a theme and size the pointer's. */
export function useSetSystemCursor() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (choice: { theme: string; size: number }) => requireBridge().set(choice),
    onSettled: () => queryClient.invalidateQueries({ queryKey: ['cursor', 'status'] }),
  });
}

/** Import the cursor themes in a file or folder, and use the first. */
export function useImportSystemCursor() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (source: string) => requireBridge().importTheme(source),
    // A theme imported anew keeps its id, so its preview is refetched too.
    onSettled: () => queryClient.invalidateQueries({ queryKey: ['cursor'] }),
  });
}

/** Delete a theme Din imported. */
export function useRemoveSystemCursor() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => requireBridge().removeTheme(id),
    onSettled: () => queryClient.invalidateQueries({ queryKey: ['cursor'] }),
  });
}

/** The imported effect packages (CursorFX effects and trails). */
export function useCursorEffectPackages() {
  return useQuery<CursorEffectPackageInfo[]>({
    queryKey: ['cursor', 'effects'],
    queryFn: () => requireBridge().effects(),
    enabled: getSystemCursorBridge() !== undefined,
    staleTime: 60_000,
    retry: false,
  });
}

/** Delete an imported effect package. */
export function useRemoveCursorEffectPackage() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => requireBridge().removeEffect(id),
    onSettled: () => queryClient.invalidateQueries({ queryKey: ['cursor', 'effects'] }),
  });
}
