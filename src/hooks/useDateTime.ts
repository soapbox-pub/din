import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { getDateTimeBridge } from '@/lib/datetime';
import type { DateTimeStatus } from '@/lib/datetime';

/** TanStack Query hooks over the date & time bridge (window.dinos.datetime). */

function requireBridge() {
  const datetime = getDateTimeBridge();
  if (!datetime) throw new Error('Date & time bridge unavailable');
  return datetime;
}

/** The system's time zone and clock, and whether they can be changed here. */
export function useDateTimeStatus() {
  return useQuery<DateTimeStatus>({
    queryKey: ['datetime', 'status'],
    queryFn: () => requireBridge().status(),
    enabled: getDateTimeBridge() !== undefined,
    // Whether the clock has synchronized changes on its own.
    refetchInterval: 15_000,
    retry: false,
  });
}

/** Every time zone there is (they don't change while Din runs). */
export function useTimeZones() {
  return useQuery<string[]>({
    queryKey: ['datetime', 'zones'],
    queryFn: () => requireBridge().zones(),
    enabled: getDateTimeBridge() !== undefined,
    staleTime: Infinity,
    retry: false,
  });
}

function useDateTimeMutation<T>(mutationFn: (value: T) => Promise<void>) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn,
    onSettled: () => queryClient.invalidateQueries({ queryKey: ['datetime', 'status'] }),
  });
}

/** Make a time zone the system's. */
export function useSetTimeZone() {
  return useDateTimeMutation((zone: string) => requireBridge().setZone(zone));
}

/** Set the clock from the network, or don't. */
export function useSetAutomaticTime() {
  return useDateTimeMutation((automatic: boolean) => requireBridge().setAutomatic(automatic));
}

/** Set the clock, as local time "YYYY-MM-DD HH:MM:SS". */
export function useSetTime() {
  return useDateTimeMutation((time: string) => requireBridge().setTime(time));
}
