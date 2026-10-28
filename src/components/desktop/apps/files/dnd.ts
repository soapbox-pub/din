/**
 * Drag and drop of files between Files windows, tabs, and the sidebar, and
 * out of Files into native apps and web pages.
 *
 * The paths ride in the DataTransfer under a private type, but a drag's
 * data can't be read until the drop, and drop targets need to know sooner
 * (a folder can't take itself, a favorite can only be a folder). Every drag
 * starts and ends in this document, so what's being dragged is also kept
 * here for the duration.
 */

import { DRAG_MIME, currentDrag, finishDrag, registerDrag } from '@/lib/dinDrag';

export const FILES_MIME = 'application/x-din-files';

export interface ActiveDrag {
  paths: string[];
  /** Which of them are folders (only those can become favorites). */
  folders: Set<string>;
}

let active: ActiveDrag | null = null;
const listeners = new Set<() => void>();

function setActive(drag: ActiveDrag | null): void {
  active = drag;
  for (const listener of listeners) listener();
}

/** Hear when a drag of files starts or ends (for useSyncExternalStore). */
export function subscribeFileDrag(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** Whether files are being dragged anywhere in the shell right now. */
export function fileDragActive(): boolean {
  return active !== null;
}

/** The token of the drag this document started, for apps to take it by (src/lib/dinDrag.ts). */
let token: string | null = null;

export function startFileDrag(e: React.DragEvent, drag: ActiveDrag, label: string): void {
  setActive(drag);
  token = crypto.randomUUID();
  registerDrag({
    token,
    kind: 'files',
    source: 'din',
    paths: drag.paths,
    folders: drag.paths.length > 0 && drag.paths.every((p) => drag.folders.has(p)),
  });
  e.dataTransfer.setData(DRAG_MIME, token);
  e.dataTransfer.setData(FILES_MIME, JSON.stringify(drag.paths));
  e.dataTransfer.setData('text/plain', drag.paths.join('\n'));
  e.dataTransfer.effectAllowed = 'copyMove';

  // A compact drag image: "3 items" rather than a ghost of the row.
  const ghost = document.createElement('div');
  ghost.textContent = label;
  ghost.style.cssText =
    'position:fixed;top:-100px;left:-100px;padding:4px 10px;border-radius:8px;' +
    'font:500 13px system-ui,sans-serif;background:var(--primary);color:var(--primary-foreground);' +
    'box-shadow:0 4px 12px rgb(0 0 0 / .25);white-space:nowrap;max-width:280px;overflow:hidden;text-overflow:ellipsis';
  document.body.appendChild(ghost);
  e.dataTransfer.setDragImage(ghost, -12, -12);
  requestAnimationFrame(() => ghost.remove());
}

export function endFileDrag(e?: React.DragEvent): void {
  setActive(null);
  if (token) finishDrag(token, e?.dataTransfer.dropEffect ?? 'none');
  token = null;
}

/**
 * The files being dragged right now, if the drag is one of ours: from this
 * document, or files an app is dragging (which the desktop knows by token).
 */
export function activeFileDrag(e: React.DragEvent): ActiveDrag | null {
  if (e.dataTransfer.types.includes(FILES_MIME)) return active;
  const app = e.dataTransfer.types.includes(DRAG_MIME) ? currentDrag() : null;
  if (app?.kind !== 'files' || app.source === 'din') return null;
  return { paths: app.paths, folders: new Set(app.folders ? app.paths : []) };
}

/** Whether a drop should copy (Ctrl held) rather than move. */
export function dropCopies(e: React.DragEvent): boolean {
  return e.ctrlKey;
}
