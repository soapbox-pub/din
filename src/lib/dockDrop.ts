/**
 * Files dropped on an app's Dock tile open in that app, as on macOS: a
 * folder on Terminal opens a shell there, a spreadsheet on Spreadsheet opens
 * it. A tile only takes what its app can open.
 */
import {
  appForFile,
  designAppFor,
  fileCategory,
  isCadFile,
  isDelimitedText,
  isMediaPlayerFile,
  isPhotoEditable,
  isPlayableVideo,
  isTextFile,
  isVectorEditable,
  isViewableImage,
  officeAppFor,
} from '@/lib/fileTypes';

export interface DroppedItem {
  path: string;
  folder: boolean;
}

function basename(path: string): string {
  return path.slice(path.lastIndexOf('/') + 1);
}

function dirname(path: string): string {
  return path.slice(0, path.lastIndexOf('/')) || '/';
}

/** Whether APP_ID opens this file (or folder) when it's dropped on its tile. */
function opens(appId: string, { path, folder }: DroppedItem): boolean {
  if (appId === 'file-browser' || appId === 'terminal') return true;
  if (folder) return appId === 'text-editor' || appId === 'media-player';
  const name = basename(path);
  switch (appId) {
    case 'text-editor':
      return isTextFile(name);
    case 'spreadsheet':
      return officeAppFor(name) === 'spreadsheet' || isDelimitedText(name);
    case 'word-processor':
    case 'slides':
      return officeAppFor(name) === appId;
    case 'media-player':
      return isMediaPlayerFile(name) || isPlayableVideo(name);
    case 'preview':
      return ['image', 'video', 'audio', 'pdf'].includes(fileCategory(name, 'file'));
    case 'paint':
      return isViewableImage(name);
    case 'photo-editor':
      return isPhotoEditable(name);
    case 'vector-editor':
      return isVectorEditable(name) || designAppFor(name) === 'vector-editor';
    case 'publisher':
      return designAppFor(name) === 'publisher';
    case 'cad':
      return isCadFile(name);
    default:
      return appForFile(name) === appId;
  }
}

/** Whether APP_ID's tile takes a drop of these. */
export function dockTakes(appId: string, items: DroppedItem[]): boolean {
  return items.length > 0 && items.every((item) => opens(appId, item));
}

/**
 * Open dropped ITEMS in APP_ID, with OPEN the window manager's: in one
 * window where the app takes a list (Media Player's playlist, Text Editor's
 * tabs), else a window each.
 */
export function openDropped(
  open: (appId: string, params?: Record<string, unknown>) => void,
  appId: string,
  items: DroppedItem[],
): void {
  if (appId === 'terminal') {
    // A shell in each folder, or in the folder a file is in.
    for (const cwd of new Set(items.map((i) => (i.folder ? i.path : dirname(i.path))))) open(appId, { cwd });
    return;
  }
  if (appId === 'file-browser') {
    // Folders open; files are shown selected in theirs, once per folder.
    const seen = new Set<string>();
    for (const item of items) {
      const where = item.folder ? item.path : dirname(item.path);
      if (seen.has(where)) continue;
      seen.add(where);
      open(appId, { path: item.path });
    }
    return;
  }
  const paths = items.map((i) => i.path);
  if (appId === 'media-player') open(appId, { paths, at: Date.now() });
  else if (appId === 'text-editor') open(appId, paths.length === 1 ? { path: paths[0] } : { paths });
  else for (const path of paths) open(appId, { path });
}
