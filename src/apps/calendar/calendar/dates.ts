export type View = 'day' | 'week' | 'month';

export const locale = navigator.language;

/** The first day of the week where the user is: 0 Sunday … 6 Saturday. */
export const FIRST_DAY: number = (() => {
  try {
    const info = new Intl.Locale(locale) as Intl.Locale & { getWeekInfo?: () => { firstDay: number }; weekInfo?: { firstDay: number } };
    return (info.getWeekInfo?.().firstDay ?? info.weekInfo?.firstDay ?? 7) % 7;
  } catch {
    return 0;
  }
})();

/** Whether the user's locale writes times on a 24-hour clock. */
export const HOUR_24 = new Intl.DateTimeFormat(locale, { hour: 'numeric' }).resolvedOptions().hourCycle?.startsWith('h2') ?? false;

export const TIME_ZONE = Intl.DateTimeFormat().resolvedOptions().timeZone;

export function startOfDay(d: Date | number): Date {
  const x = new Date(d);
  return new Date(x.getFullYear(), x.getMonth(), x.getDate());
}

export function addDays(d: Date, n: number): Date {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate() + n, d.getHours(), d.getMinutes());
}

export function addMonths(d: Date, n: number): Date {
  const target = new Date(d.getFullYear(), d.getMonth() + n, 1);
  const last = new Date(target.getFullYear(), target.getMonth() + 1, 0).getDate();
  return new Date(target.getFullYear(), target.getMonth(), Math.min(d.getDate(), last));
}

export function startOfWeek(d: Date): Date {
  const x = startOfDay(d);
  return addDays(x, -((x.getDay() - FIRST_DAY + 7) % 7));
}

export function sameDay(a: Date | number, b: Date | number): boolean {
  const x = new Date(a);
  const y = new Date(b);
  return x.getFullYear() === y.getFullYear() && x.getMonth() === y.getMonth() && x.getDate() === y.getDate();
}

export function isWeekend(d: Date): boolean {
  return d.getDay() === 0 || d.getDay() === 6;
}

/** The days a view shows, and the first and last instants of them. */
export function rangeOf(view: View, date: Date): { days: Date[]; from: number; to: number } {
  let first: Date;
  let count: number;
  if (view === 'day') {
    first = startOfDay(date);
    count = 1;
  } else if (view === 'week') {
    first = startOfWeek(date);
    count = 7;
  } else {
    first = startOfWeek(new Date(date.getFullYear(), date.getMonth(), 1));
    // Six weeks, so every month fits and the grid doesn't change height.
    count = 42;
  }
  const days = Array.from({ length: count }, (_, i) => addDays(first, i));
  return { days, from: first.getTime(), to: addDays(first, count).getTime() };
}

/** Move a view a page backward or forward. */
export function step(view: View, date: Date, delta: number): Date {
  if (view === 'day') return addDays(date, delta);
  if (view === 'week') return addDays(date, delta * 7);
  return addMonths(date, delta);
}

/** The toolbar's title for what a view shows. */
export function titleOf(view: View, date: Date): string {
  if (view === 'month') return new Intl.DateTimeFormat(locale, { month: 'long', year: 'numeric' }).format(date);
  if (view === 'day') return new Intl.DateTimeFormat(locale, { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' }).format(date);
  const { days } = rangeOf('week', date);
  return new Intl.DateTimeFormat(locale, { month: 'long', day: 'numeric', year: 'numeric' }).formatRange(days[0], days[6]);
}

const timeFmt = new Intl.DateTimeFormat(locale, { hour: 'numeric', minute: '2-digit' });
const hourFmt = new Intl.DateTimeFormat(locale, { hour: 'numeric' });

export function formatTime(t: number | Date): string {
  return timeFmt.format(t);
}

/** "9 AM", "13" — a time grid's hour labels. */
export function formatHour(hour: number): string {
  return hourFmt.format(new Date(2024, 0, 1, hour));
}

export function weekdayName(d: Date, width: 'short' | 'long' | 'narrow' = 'short'): string {
  return new Intl.DateTimeFormat(locale, { weekday: width }).format(d);
}

/** `HH:MM` for a time input. */
export function timeInput(t: number): string {
  const d = new Date(t);
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

/** A date at the time in a time input's value. */
export function withTime(date: Date, value: string): Date {
  const [h, m] = value.split(':').map(Number);
  return new Date(date.getFullYear(), date.getMonth(), date.getDate(), h || 0, m || 0);
}

/** How a time-based event sits in a day column. */
export interface Placed<T> {
  event: T;
  /** Minutes from the day's midnight. */
  top: number;
  height: number;
  /** Which of `columns` side-by-side slots it takes. */
  column: number;
  columns: number;
}

/** Lay out a day's timed events in side-by-side columns where they overlap. */
export function layoutDay<T extends { start: number; end: number }>(events: readonly T[], day: Date): Placed<T>[] {
  const dayStart = startOfDay(day).getTime();
  const dayEnd = addDays(startOfDay(day), 1).getTime();
  const items = events
    .map((event) => {
      const start = Math.max(event.start, dayStart);
      const end = Math.min(Math.max(event.end, event.start + 30 * 60_000), dayEnd);
      return { event, start, end: Math.max(end, start + 20 * 60_000) };
    })
    .sort((a, b) => a.start - b.start || b.end - a.end);

  const out: Placed<T>[] = [];
  let cluster: { item: (typeof items)[number]; column: number }[] = [];
  let clusterEnd = -Infinity;
  const flush = () => {
    const columns = Math.max(1, ...cluster.map((c) => c.column + 1));
    for (const { item, column } of cluster) {
      out.push({ event: item.event, top: (item.start - dayStart) / 60_000, height: (item.end - item.start) / 60_000, column, columns });
    }
    cluster = [];
  };
  for (const item of items) {
    if (item.start >= clusterEnd) {
      flush();
      clusterEnd = -Infinity;
    }
    const taken = new Set(cluster.filter((c) => c.item.end > item.start).map((c) => c.column));
    let column = 0;
    while (taken.has(column)) column++;
    cluster.push({ item, column });
    clusterEnd = Math.max(clusterEnd, item.end);
  }
  flush();
  return out;
}
