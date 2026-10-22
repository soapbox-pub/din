/**
 * Typed access to the date & time bridge exposed by the Electron preload
 * (`window.datetime`, see electron/preload.cjs + electron/datetime.mts), and
 * helpers for the clock's format.
 *
 * The time zone and clock are the system's. Din can change them on DinOS;
 * elsewhere they're only shown. In a plain browser the bridge is absent.
 */

import type { ClockFormat } from '@/contexts/AppContext';

export interface DateTimeStatus {
  /** IANA name of the system's time zone, e.g. "America/New_York". */
  timeZone: string;
  /** Whether the clock is set from the network; null where that's unknown. */
  automatic: boolean | null;
  /** Whether the clock has been set from the network since it started. */
  synchronized: boolean;
  /** Whether Din can change the time zone and clock here. */
  canChange: boolean;
  /** Whether there's a network time service to turn on and off. */
  canAutomatic: boolean;
}

export interface DateTimeBridge {
  status(): Promise<DateTimeStatus>;
  /** Every time zone there is, as IANA names. */
  zones(): Promise<string[]>;
  /** Make a time zone the system's. */
  setZone(zone: string): Promise<void>;
  /** Set the clock from the network, or don't. */
  setAutomatic(automatic: boolean): Promise<void>;
  /** Set the clock, as local time "YYYY-MM-DD HH:MM:SS". */
  setTime(time: string): Promise<void>;
}

declare global {
  interface Window {
    /** Present only inside the Electron shell. */
    datetime?: DateTimeBridge;
  }
}

/** The date & time bridge, or undefined when running outside the Electron shell. */
export function getDateTimeBridge(): DateTimeBridge | undefined {
  if (typeof window === 'undefined') return undefined;
  return window.datetime;
}

/** Whether a clock in this format shows 12-hour time; 'auto' follows the locale. */
export function usesHour12(format: ClockFormat): boolean {
  if (format !== 'auto') return format === '12';
  const { hourCycle } = new Intl.DateTimeFormat([], { hour: 'numeric' }).resolvedOptions();
  return hourCycle === 'h11' || hourCycle === 'h12';
}

/** Intl options for a time of day in this format, optionally with seconds. */
export function timeFormatOptions(format: ClockFormat, seconds = false): Intl.DateTimeFormatOptions {
  return {
    hour: 'numeric',
    minute: '2-digit',
    ...(seconds && { second: '2-digit' }),
    ...(format !== 'auto' && { hourCycle: format === '12' ? 'h12' : 'h23' }),
  };
}

/** A zone's place name and the region it's in, e.g. "Buenos Aires", "America · Argentina". */
export function describeZone(zone: string): { city: string; region: string } {
  const parts = zone.split('/').map((part) => part.replace(/_/g, ' '));
  const city = parts.pop() ?? zone;
  return { city, region: parts.join(' · ') };
}

/** A zone's offset from UTC right now, e.g. "UTC−4", "UTC+5:30", "UTC". */
export function zoneOffset(zone: string, at: Date = new Date()): string {
  try {
    const name = new Intl.DateTimeFormat('en-US', { timeZone: zone, timeZoneName: 'shortOffset' })
      .formatToParts(at)
      .find((part) => part.type === 'timeZoneName')?.value;
    return (name ?? 'GMT').replace('GMT', 'UTC').replace('-', '−');
  } catch {
    return '';
  }
}

/** A zone's name in the user's language, e.g. "Eastern Daylight Time". */
export function zoneLongName(zone: string, at: Date = new Date()): string {
  try {
    return new Intl.DateTimeFormat([], { timeZone: zone, timeZoneName: 'long' })
      .formatToParts(at)
      .find((part) => part.type === 'timeZoneName')?.value ?? '';
  } catch {
    return '';
  }
}
