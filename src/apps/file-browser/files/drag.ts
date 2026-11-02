/**
 * Drag and drop of files in and out of a Files window, through the desktop
 * (`din.drag`): between its folders, tabs and sidebar, to other Files
 * windows, and to and from other apps.
 *
 * A drag's data can't be read until the drop, and drop targets want to know
 * sooner (a folder can't take itself, a favorite can only be a folder). A
 * drag started in this window keeps its paths here for the duration (and
 * tells the other Files windows, files/windows.ts); one from elsewhere is known by what the desktop says of it (`din.drag.current`)
 * until it's dropped and its files arrive as handles.
 */

import { DRAG_MIME } from '@/sdk';
import { droppedHandles } from '@/shared/fileHandles';
import { broadcastDrag, otherWindowDrag } from './windows';

interface LocalDrag {
  paths: string[];
  /** Which of them are folders (only those can become favorites). */
  folders: Set<string>;
}

let local: LocalDrag | null = null;

/** What's being dragged over a target: paths when the drag is this window's own. */
export interface DraggedFiles {
  /** Null until the drop, for a drag from another window or app. */
  paths: string[] | null;
  /** Whether everything dragged is a folder. */
  allFolders: boolean;
  /** Whether any of it is a folder (for adding favorites). */
  anyFolder: boolean;
}

/** Start dragging files from this window, to it, other windows or other apps. */
export function startFilesDrag(e: React.DragEvent, paths: string[], folders: Set<string>, label: string): void {
  local = { paths, folders };
  broadcastDrag({ paths, folders: [...folders] });
  const din = window.din;
  if (din) {
    din.drag.startPaths(e.nativeEvent, paths, label);
  } else {
    e.dataTransfer.setData('text/plain', paths.join('\n'));
    e.dataTransfer.effectAllowed = 'copyMove';
  }
}

export function endFilesDrag(): void {
  if (local) broadcastDrag(null);
  local = null;
}

/** The files being dragged over this window, if it's a drag of files. */
export function draggedFiles(e: React.DragEvent): DraggedFiles | null {
  if (local) {
    const folders = local.folders;
    return {
      paths: local.paths,
      allFolders: local.paths.length > 0 && local.paths.every((p) => folders.has(p)),
      anyFolder: folders.size > 0,
    };
  }
  if (!e.dataTransfer.types.includes(DRAG_MIME)) return null;
  const current = window.din?.drag.current;
  if (current?.kind !== 'files') return null;
  // Another Files window said what it's dragging.
  const other = otherWindowDrag();
  if (other && current.source === 'file-browser' && current.count === other.paths.length) {
    return {
      paths: other.paths,
      allFolders: current.folders,
      anyFolder: other.folders.length > 0,
    };
  }
  // Whether some of a mixed drag are folders isn't known until the drop.
  return { paths: null, allFolders: current.folders, anyFolder: current.folders };
}

/** What a drop brought: paths, and which are folders. */
export interface DroppedFiles {
  paths: string[];
  folders: string[];
  /** Copy, unless the desktop allowed a move. */
  copy: boolean;
}

/**
 * Take a drop of files. Call from `drop` (it reads the event at once);
 * resolves with the files, or null if it wasn't a drag of files.
 */
export async function takeDrop(e: React.DragEvent, copy: boolean): Promise<DroppedFiles | null> {
  if (local) {
    const { paths, folders } = local;
    return { paths, folders: paths.filter((p) => folders.has(p)), copy };
  }
  const din = window.din;
  if (!din || !e.dataTransfer.types.includes(DRAG_MIME)) return null;
  const files = await droppedHandles(e.nativeEvent);
  if (files.length === 0) return null;
  return {
    paths: files.map((f) => din.files.path(f)),
    folders: files.filter((f) => f.kind === 'directory').map((f) => din.files.path(f)),
    copy,
  };
}

/** Whether a drop should copy (Ctrl held) rather than move. */
export function dropCopies(e: React.DragEvent): boolean {
  return e.ctrlKey;
}

/** Whether moving `paths` into `target` makes sense: not into themselves, nor where they are already. */
export function canDropInto(paths: string[] | null, target: string, copy: boolean): boolean {
  if (paths === null) return true;
  if (paths.some((p) => target === p || target.startsWith(`${p}/`))) return false;
  if (!copy && paths.every((p) => (p.slice(0, p.lastIndexOf('/')) || '/') === target)) return false;
  return true;
}
