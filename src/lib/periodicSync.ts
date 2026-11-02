/**
 * What apps, nsites and installed web apps have scheduled to do while
 * they're closed: their service workers' periodic sync tags
 * (`registration.periodicSync`), kept and run by electron/periodic-sync.mts.
 * Typed access to `window.dinos.periodicSync`, for Settings → Background
 * Activity and `din background`. Absent outside the Electron shell.
 */
import type { InstalledAppsManager } from '@/contexts/InstalledAppsContext';
import type { AppDefinition } from '@/lib/apps';
import { nsiteAppId } from '@/lib/nsiteApps';

/** Which runtime wakes a site's worker: a Din app, an installed nsite, a web app. */
export type BackgroundKind = 'app' | 'nsite' | 'web';

/** How a run went: its handlers ran, they threw or took too long, or there was no worker. */
export type BackgroundOutcome = 'handled' | 'failed' | 'no-worker';

export interface BackgroundTag {
  tag: string;
  /** At least this long between runs, in ms. */
  minInterval: number;
  nextRun: number;
  lastRun: number | null;
  outcome: BackgroundOutcome | null;
  /** How long the last run took. */
  ms: number | null;
}

export interface BackgroundSite {
  /** din://<id>, din+file://<host>, nsite://<host> or https://<host>. */
  origin: string;
  kind: BackgroundKind;
  paused: boolean;
  /** Whether it may still be woken: false once its permission is gone, or the app is. */
  allowed: boolean;
  tags: BackgroundTag[];
}

export interface BackgroundStatus {
  /** The global switch. */
  enabled: boolean;
  sites: BackgroundSite[];
}

export interface PeriodicSyncBridge {
  status(): Promise<BackgroundStatus>;
  setEnabled(enabled: boolean): Promise<void>;
  setPaused(origin: string, paused: boolean): Promise<void>;
  /** Run one tag, or all of a site's, now; paused or not. */
  run(origin: string, tag?: string): Promise<Record<string, BackgroundOutcome | null>>;
  /** Drop a site's schedule; a site that asked the user asks again. */
  remove(origin: string): Promise<void>;
  /** Drop a site's schedule as its app is uninstalled. */
  forget(origin: string): Promise<void>;
  onChanged(callback: () => void): () => void;
}

declare global {
  interface Dinos {
    /** Present only inside the Electron shell. */
    periodicSync?: PeriodicSyncBridge;
  }
}

export function getPeriodicSyncBridge(): PeriodicSyncBridge | undefined {
  if (typeof window === 'undefined') return undefined;
  return window.dinos?.periodicSync;
}

/**
 * The desktop's app id for a site's origin, when that's fixed by the origin
 * (a Din app, an installed nsite); a web app is found by URL instead.
 */
export function backgroundAppId(origin: string): string | null {
  const match = /^(din|din\+file|nsite):\/\/([^/]+)$/.exec(origin);
  if (!match) return null;
  if (match[1] === 'din') return match[2];
  if (match[1] === 'din+file') return `file-${match[2]}`;
  return nsiteAppId(match[2]);
}

/** The installed app a site's schedule is, if Din has it, and what to call it. */
export function backgroundApp(
  site: Pick<BackgroundSite, 'origin'>,
  apps: Pick<InstalledAppsManager, 'getApp' | 'findAppIdForUrl'>,
): { app: AppDefinition | undefined; name: string } {
  const appId = backgroundAppId(site.origin) ?? apps.findAppIdForUrl(`${site.origin}/`);
  const app = appId ? apps.getApp(appId) : undefined;
  if (app) return { app, name: app.name };
  const host = site.origin.replace(/^[a-z+]+:\/\//, '');
  return { app, name: host.length > 24 ? `${host.slice(0, 12)}…` : host };
}

/** "5 minutes ago", "in 2 hours", "just now". */
export function whenLabel(ms: number, now = Date.now()): string {
  const diff = ms - now;
  const abs = Math.abs(diff);
  if (abs < 60_000) return diff <= 0 ? 'just now' : 'in a moment';
  const format = new Intl.RelativeTimeFormat(undefined, { numeric: 'auto' });
  if (abs < 3_600_000) return format.format(Math.round(diff / 60_000), 'minute');
  if (abs < 86_400_000) return format.format(Math.round(diff / 3_600_000), 'hour');
  return format.format(Math.round(diff / 86_400_000), 'day');
}

/** One tag in words: how often, how its last run went, when the next is. */
export function tagSummary(tag: BackgroundTag, site: Pick<BackgroundSite, 'paused' | 'allowed'>, enabled: boolean): string {
  const parts = [intervalLabel(tag.minInterval)];
  if (tag.lastRun !== null) {
    parts.push(tag.outcome ? `${OUTCOME_LABELS[tag.outcome]} ${whenLabel(tag.lastRun)}` : `started ${whenLabel(tag.lastRun)}`);
  } else {
    parts.push('hasn’t run yet');
  }
  if (enabled && !site.paused && site.allowed) parts.push(`next ${tag.nextRun <= Date.now() ? 'soon' : whenLabel(tag.nextRun)}`);
  return parts.join(' · ');
}

/** "every 15 minutes", "every 2 hours", "every day". */
export function intervalLabel(ms: number): string {
  const minutes = Math.round(ms / 60_000);
  if (minutes < 60) return `every ${minutes} minutes`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return hours === 1 ? 'every hour' : `every ${hours} hours`;
  const days = Math.round(hours / 24);
  return days === 1 ? 'every day' : `every ${days} days`;
}

export const OUTCOME_LABELS: Record<BackgroundOutcome, string> = {
  handled: 'ran',
  failed: 'failed',
  'no-worker': 'found no service worker',
};
