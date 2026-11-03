import { useCallback, useEffect } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { cleanFsError } from '@/lib/fs';
import { useDin } from '@/sdk/react';
import { loadLocalCalendars, type CalendarFs, type LocalCalendars } from '@/shared/localCalendar';
import { toast } from '@/shared/toast';

const LOCAL = ['calendar', 'local'] as const;

/** Calendar's own folder, by path (its manifest's `din.folders`). */
export function useCalendarFs(): CalendarFs | null {
  return useDin().system.fs ?? null;
}

/**
 * The calendars on this computer, read again whenever something changes
 * their folder (`din calendar`, a sync tool, another window).
 */
export function useLocalCalendars() {
  const fs = useDin().system.fs ?? null;
  const qc = useQueryClient();
  const query = useQuery<LocalCalendars>({
    queryKey: LOCAL,
    queryFn: () => loadLocalCalendars(fs!),
    enabled: !!fs,
    staleTime: Infinity,
  });
  // Watches don't reach into subfolders: the root (calendars coming and going, settings) and each calendar's.
  const folders = query.data ? [query.data.root, ...query.data.calendars.map((c) => c.folder)].join('\n') : '';
  useEffect(() => {
    if (!fs || !folders) return;
    const list = folders.split('\n');
    const root = list[0];
    const ids: number[] = [];
    let gone = false;
    const off = fs.onChange((path) => {
      if (path === root || path.startsWith(`${root}/`)) void qc.invalidateQueries({ queryKey: LOCAL });
    });
    for (const folder of list) {
      void fs.watch(folder).then(
        (id) => {
          if (id === null) return;
          if (gone) void fs.unwatch(id);
          else ids.push(id);
        },
        () => {},
      );
    }
    return () => {
      gone = true;
      off();
      for (const id of ids) void fs.unwatch(id);
    };
  }, [fs, folders, qc]);
  return query;
}

/** Run a change to the calendars on this computer: a failure is a toast, and they're read again either way. */
export function useLocalChange() {
  const fs = useCalendarFs();
  const qc = useQueryClient();
  return useCallback(
    async <T,>(change: (fs: CalendarFs) => Promise<T>, failure: string): Promise<T | undefined> => {
      if (!fs) return undefined;
      try {
        return await change(fs);
      } catch (error) {
        toast(failure, { body: cleanFsError(error), destructive: true });
        return undefined;
      } finally {
        await qc.invalidateQueries({ queryKey: LOCAL });
      }
    },
    [fs, qc],
  );
}
