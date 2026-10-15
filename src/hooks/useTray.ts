import { useEffect } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { getTrayBridge, type TrayItem } from '@/lib/tray';

const TRAY_ITEMS_KEY = ['tray', 'items'] as const;

/**
 * Apps' status icons. The main process pushes the whole list whenever it
 * changes, so this never polls.
 */
export function useTrayItems() {
  const tray = getTrayBridge();
  const queryClient = useQueryClient();

  useEffect(() => {
    if (!tray) return;
    return tray.onChanged((items) => queryClient.setQueryData(TRAY_ITEMS_KEY, items));
  }, [tray, queryClient]);

  return useQuery<TrayItem[]>({
    queryKey: TRAY_ITEMS_KEY,
    queryFn: () => getTrayBridge()?.list() ?? Promise.resolve([]),
    enabled: tray !== undefined,
    staleTime: Infinity,
    retry: false,
  });
}
