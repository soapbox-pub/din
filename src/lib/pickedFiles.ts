/**
 * Files handed out by the file picker (opened, uploaded, saved), so they
 * show in its Recent list even when they live outside the folders Recent
 * looks through. Kept on this device only.
 */

const KEY = 'din:filepicker:picked';
const MAX_PICKED = 100;

/** `[path, ms]` pairs, latest first. */
export function readPickedFiles(): [string, number][] {
  try {
    const value: unknown = JSON.parse(localStorage.getItem(KEY) ?? '[]');
    if (!Array.isArray(value)) return [];
    return value.filter(
      (item): item is [string, number] =>
        Array.isArray(item) && typeof item[0] === 'string' && typeof item[1] === 'number',
    );
  } catch {
    return [];
  }
}

export function recordPickedFiles(paths: string[]): void {
  const now = Date.now();
  const picked = new Set(paths);
  const next = [
    ...paths.map((p): [string, number] => [p, now]),
    ...readPickedFiles().filter(([p]) => !picked.has(p)),
  ].slice(0, MAX_PICKED);
  try {
    localStorage.setItem(KEY, JSON.stringify(next));
  } catch {
    // Storage full or unavailable; Recent just won't list these.
  }
}
