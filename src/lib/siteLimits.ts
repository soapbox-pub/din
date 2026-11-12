/**
 * Site limits: websites the user asked Din to keep them off, through the
 * `window.dinos.siteLimits` bridge (electron/preload.cjs, backed by
 * electron/site-limits.mts). The main process keeps the limits, counts the
 * time and stops the visits; the shell shows them and the page that stands
 * in for a limited site.
 *
 * In a plain browser (`npm run dev:browser`) the bridge is absent; callers
 * feature-detect via `getSiteLimitsBridge()` and hide the UI.
 */

export type SiteLimitMode = 'pause' | 'daily' | 'block';

export interface SiteLimit {
  /** A registrable domain (reddit.com); covers its subdomains. */
  site: string;
  mode: SiteLimitMode;
  /** The daily allowance, for 'daily'. */
  minutes: number;
}

export interface SiteUsage {
  /** Seconds on screen today. */
  seconds: number;
  /** Times the limit's page stopped a visit today. */
  attempts: number;
}

export interface SiteLimitSettings {
  limits: SiteLimit[];
  usage: Record<string, SiteUsage>;
}

export interface SiteLimitStatus {
  /** The site a limit on the host covers (or would). */
  site: string;
  limit: SiteLimit | null;
  seconds: number;
  attempts: number;
  passUntil: number | null;
}

/** The page over a guest stopped at a limited site. */
export interface SiteLimitBlock {
  wcId: number;
  url: string;
  site: string;
  mode: SiteLimitMode;
  minutes: number;
  seconds: number;
  attempts: number;
  /** When the page went up (ms), and the seconds it holds the way through shut. */
  since: number;
  wait: number;
  /** The passes it offers, in minutes; none for a block. */
  passes: number[];
  /** The guest's own page isn't the site, so it can stay there. */
  canStay: boolean;
}

export interface SiteLimitsBridge {
  get(): Promise<SiteLimitSettings>;
  status(hostname: string): Promise<SiteLimitStatus>;
  /** Limit a site (or null: lift its limit). Resolves to the site it covers. */
  set(hostname: string, limit: { mode: SiteLimitMode; minutes?: number } | null): Promise<string>;
  blockOf(wcId: number): Promise<SiteLimitBlock | null>;
  allow(wcId: number, minutes: number): Promise<void>;
  dismiss(wcId: number): Promise<void>;
  onSettings(callback: (settings: SiteLimitSettings) => void): () => void;
  onBlock(callback: (update: { wcId: number; block: SiteLimitBlock | null }) => void): () => void;
}

declare global {
  interface Dinos {
    /** Present only inside the Electron shell. */
    siteLimits?: SiteLimitsBridge;
  }
}

/** The site limits bridge, or undefined outside the Electron shell. */
export function getSiteLimitsBridge(): SiteLimitsBridge | undefined {
  if (typeof window === 'undefined') return undefined;
  return window.dinos?.siteLimits;
}

/** The daily allowances offered, in minutes (the main process takes these). */
export const DAILY_MINUTES = [5, 10, 15, 30, 45, 60, 90, 120, 180, 240];

/** "45 minutes", "1 hour", "1 hour 30 minutes". */
export function formatMinutes(minutes: number): string {
  const h = Math.floor(minutes / 60);
  const m = Math.round(minutes % 60);
  const hours = h ? `${h} ${h === 1 ? 'hour' : 'hours'}` : '';
  const mins = m || !h ? `${m} ${m === 1 ? 'minute' : 'minutes'}` : '';
  return [hours, mins].filter(Boolean).join(' ');
}

/** Time on screen, short: "under a minute", "12 min", "1 hr 5 min". */
export function formatSpent(seconds: number): string {
  const total = Math.floor(seconds / 60);
  if (total < 1) return 'under a minute';
  const h = Math.floor(total / 60);
  const m = total % 60;
  return h ? `${h} hr${m ? ` ${m} min` : ''}` : `${m} min`;
}

/** "Under a minute today", "12 min today". */
export function spentToday(seconds: number): string {
  const spent = formatSpent(seconds);
  return `${spent.charAt(0).toUpperCase()}${spent.slice(1)} today`;
}

/** What a limit does, in a few words: "Pause before opening", "30 minutes a day", "Blocked". */
export function describeLimit(limit: Pick<SiteLimit, 'mode' | 'minutes'>): string {
  if (limit.mode === 'pause') return 'Pause before opening';
  if (limit.mode === 'daily') return `${formatMinutes(limit.minutes)} a day`;
  return 'Blocked';
}

/**
 * The choices a site's limit menu offers, as one value each: 'none',
 * 'pause', 'block', or 'daily:<minutes>'.
 */
export type LimitChoice = 'none' | 'pause' | 'block' | `daily:${number}`;

export const LIMIT_CHOICES: LimitChoice[] = [
  'none',
  'pause',
  'daily:15',
  'daily:30',
  'daily:60',
  'block',
];

export function choiceOf(limit: Pick<SiteLimit, 'mode' | 'minutes'> | null): LimitChoice {
  if (!limit) return 'none';
  return limit.mode === 'daily' ? `daily:${limit.minutes}` : limit.mode;
}

export function limitOfChoice(choice: string): { mode: SiteLimitMode; minutes?: number } | null {
  if (choice === 'pause' || choice === 'block') return { mode: choice };
  const daily = /^daily:(\d+)$/.exec(choice);
  return daily ? { mode: 'daily', minutes: Number(daily[1]) } : null;
}

export function describeChoice(choice: LimitChoice): string {
  if (choice === 'none') return 'No limit';
  const limit = limitOfChoice(choice);
  return limit ? describeLimit({ minutes: 0, ...limit }) : 'No limit';
}
