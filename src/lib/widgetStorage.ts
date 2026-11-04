/**
 * NAP-STORAGE for widgets: string key-value pairs the desktop keeps for each
 * widget, in its own localStorage. "Shared" storage belongs to the widget
 * (every copy of it on the desktop), "instance" storage to one copy.
 */

const PREFIX = 'din:widget-storage:';

/** What one area may hold, keys and values together (NAP-STORAGE's 512 KB). */
const QUOTA_BYTES = 512 * 1024;

function read(area: string): Record<string, string> {
  try {
    const parsed: unknown = JSON.parse(localStorage.getItem(PREFIX + area) ?? '{}');
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return {};
    return Object.fromEntries(Object.entries(parsed).filter((e): e is [string, string] => typeof e[1] === 'string'));
  } catch {
    return {};
  }
}

function write(area: string, items: Record<string, string>): void {
  if (Object.keys(items).length === 0) localStorage.removeItem(PREFIX + area);
  else localStorage.setItem(PREFIX + area, JSON.stringify(items));
}

/** The storage area for a widget (`identity`), or one copy of it. */
export function storageArea(identity: string, instance?: string): string {
  return instance ? `${identity}#${instance}` : identity;
}

export function storageGet(area: string, key: string): string | null {
  const items = read(area);
  // Own keys only: `toString` or `constructor` would find Object.prototype's.
  return Object.hasOwn(items, key) ? items[key] : null;
}

/** Throws if the area would go over its quota. */
export function storageSet(area: string, key: string, value: string): void {
  const items = { ...read(area), [key]: value };
  const size = Object.entries(items).reduce((n, [k, v]) => n + (k.length + v.length) * 2, 0);
  if (size > QUOTA_BYTES) throw new Error('quota exceeded');
  write(area, items);
}

export function storageRemove(area: string, key: string): void {
  const items = read(area);
  if (!Object.hasOwn(items, key)) return;
  delete items[key];
  write(area, items);
}

export function storageKeys(area: string): string[] {
  return Object.keys(read(area));
}

/** Forget everything in an area (a copy of a widget that was removed). */
export function storageClear(area: string): void {
  localStorage.removeItem(PREFIX + area);
}
