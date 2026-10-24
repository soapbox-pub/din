/**
 * Excel's date serials: days since 0 January 1900, with the time of day as
 * the fraction. Excel (after Lotus 1-2-3) believes 1900 was a leap year, so
 * serial 60 is the 29th of February 1900 and everything before it is off by one.
 * Workbooks can use the 1904 system instead (old Mac Excel), which hasn't the bug.
 */

const DAY = 86400000;
const BASE = Date.UTC(1899, 11, 30);
const OFFSET_1904 = 1462;

function utc(y: number, m: number, d: number): number {
  const date = new Date(0);
  date.setUTCFullYear(y, m, d);
  date.setUTCHours(0, 0, 0, 0);
  return date.getTime();
}

/** The serial for a date (month 1–12, overflowing like DATE does). */
export function dateSerial(y: number, m: number, d: number, date1904 = false): number {
  // The first of the (normalized) month, then the days counted on from it,
  // so DATE(1900, 2, 29) lands on Excel's phantom leap day.
  let s = Math.round((utc(y, m - 1, 1) - BASE) / DAY);
  if (date1904) return s - OFFSET_1904 + d - 1;
  if (s < 61) s -= 1;
  return s + d - 1;
}

export interface DateParts {
  y: number;
  m: number;
  d: number;
  hh: number;
  mm: number;
  ss: number;
  /** Milliseconds, for fractional seconds. */
  ms: number;
  /** 0 = Sunday. */
  dow: number;
}

export function serialParts(serial: number, date1904 = false): DateParts {
  // Round to the millisecond, so 0.99999999 is midnight and not 23:59:59.
  let totalMs = Math.round(serial * DAY);
  let day = Math.floor(totalMs / DAY);
  totalMs -= day * DAY;
  if (date1904) day += OFFSET_1904;
  let y: number;
  let m: number;
  let d: number;
  if (!date1904 && day === 60) [y, m, d] = [1900, 2, 29];
  else if (!date1904 && day === 0) [y, m, d] = [1900, 1, 0];
  else {
    const t = new Date(BASE + (!date1904 && day < 60 ? day + 1 : day) * DAY);
    [y, m, d] = [t.getUTCFullYear(), t.getUTCMonth() + 1, t.getUTCDate()];
  }
  const hh = Math.floor(totalMs / 3600000);
  const mm = Math.floor((totalMs % 3600000) / 60000);
  const ss = Math.floor((totalMs % 60000) / 1000);
  const ms = totalMs % 1000;
  const dow = (((day + 6) % 7) + 7) % 7;
  return { y, m, d, hh, mm, ss, ms, dow };
}

export const timeSerial = (h: number, m: number, s: number) => (h * 3600 + m * 60 + s) / 86400;

export function todaySerial(date1904 = false): number {
  const now = new Date();
  return dateSerial(now.getFullYear(), now.getMonth() + 1, now.getDate(), date1904);
}

export function nowSerial(date1904 = false): number {
  const now = new Date();
  return todaySerial(date1904) + timeSerial(now.getHours(), now.getMinutes(), now.getSeconds() + now.getMilliseconds() / 1000);
}

export const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
export const DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

export function daysInMonth(y: number, m: number): number {
  if (m === 2 && y === 1900) return 29;
  return new Date(Date.UTC(y, m, 0)).getUTCDate();
}
