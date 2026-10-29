/**
 * Helpers for apps on window.din (docs/din/README.md). Din itself provides
 * window.din in every app it hosts (src/sdk/runtime.ts); this module only
 * reads it: `connect()` waits for `din.ready` and returns it.
 */
import type { Din } from '@/sdk/din';

export type * from '@/sdk/din';

/**
 * What `window.din` rejects with when the app calls something its manifest
 * didn't ask for. The runtime throws its own class, so `instanceof` goes by
 * the error's name.
 */
export class DinPermissionError extends Error {
  readonly permission: string;
  constructor(permission: string, message = `This app doesn't have the ${permission} permission`) {
    super(message);
    this.name = 'DinPermissionError';
    this.permission = permission;
  }
  static [Symbol.hasInstance](value: unknown): boolean {
    return value instanceof Error && value.name === 'DinPermissionError';
  }
}

/**
 * File types as the desktop's `FileFilter` lists name them (`{ name,
 * patterns: ['*.png'] }`), for apps that already have such lists.
 */
export function typesFromFilters(filters: readonly { name: string; patterns: readonly string[] }[]): { description: string; extensions: string[] }[] {
  return filters.map((f) => ({
    description: f.name,
    extensions: f.patterns.filter((p) => p.startsWith('*.')).map((p) => p.slice(1)),
  }));
}

/** The MIME type a Din drag carries its token under. */
export const DRAG_MIME = 'application/x-din-drag';

/**
 * window.din once the desktop has said hello: the launch, theme and
 * permissions in, granted bridges ready. Rejects where Din isn't hosting the page.
 */
export function connect(): Promise<Din> {
  const din = window.din;
  if (!din) return Promise.reject(new Error('window.din is missing: this page isn’t running as a Din app'));
  return din.ready.then(() => din);
}
