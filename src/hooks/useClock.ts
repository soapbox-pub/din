import { useEffect, useState } from 'react';

/** The local wall-clock minute `d` falls in (local fields, so a timezone change counts). */
function minuteOf(d: Date): string {
  return `${d.toDateString()} ${d.getHours()}:${d.getMinutes()}`;
}

/**
 * Returns the current time, checked every second. With `'minute'`, the value
 * (and so the caller's render) only changes when the displayed minute does:
 * a clock without seconds re-renders once a minute instead of sixty times,
 * and still turns over within a second of the minute, or of waking from
 * sleep.
 */
export function useClock(precision: 'second' | 'minute' = 'second'): Date {
  const [now, setNow] = useState(() => new Date());

  useEffect(() => {
    const id = setInterval(() => {
      const next = new Date();
      setNow((prev) => (precision === 'minute' && minuteOf(prev) === minuteOf(next) ? prev : next));
    }, 1000);
    return () => clearInterval(id);
  }, [precision]);

  return now;
}
