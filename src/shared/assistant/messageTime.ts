/** When messages in a conversation were sent, as the transcript shows it. */

const full = new Intl.DateTimeFormat(undefined, { dateStyle: 'full', timeStyle: 'short' });
const weekday = new Intl.DateTimeFormat(undefined, { weekday: 'long' });
const thisYear = new Intl.DateTimeFormat(undefined, { weekday: 'long', month: 'short', day: 'numeric' });
const otherYear = new Intl.DateTimeFormat(undefined, { weekday: 'long', month: 'short', day: 'numeric', year: 'numeric' });

/** "Tuesday, November 25, 2026 at 3:42 PM", for a tooltip. */
export function fullTime(at: number): string {
  return full.format(at);
}

/** Midnight of the day `at` is in, local time. */
export function dayOf(at: number): number {
  const date = new Date(at);
  date.setHours(0, 0, 0, 0);
  return date.getTime();
}

/**
 * Which of `times` (oldest first) begin a new day, for a divider above them:
 * each that's on a later day than the one before, and the first unless it's `now`'s day.
 */
export function dayBreaks(times: number[], now: number): boolean[] {
  return times.map((at, index) => dayOf(at) !== dayOf(index === 0 ? now : times[index - 1]));
}

/** "Today", "Yesterday", "Monday" within the week, then "Monday, Nov 24" (with the year if it isn't this one). */
export function dayLabel(at: number, now = Date.now()): string {
  const day = dayOf(at);
  const today = dayOf(now);
  // Days between, robust to daylight-saving days of 23 or 25 hours.
  const days = Math.round((today - day) / 86_400_000);
  if (days === 0) return 'Today';
  if (days === 1) return 'Yesterday';
  if (days > 1 && days < 7) return weekday.format(at);
  return new Date(at).getFullYear() === new Date(now).getFullYear() ? thisYear.format(at) : otherYear.format(at);
}
