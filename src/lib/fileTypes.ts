import { isWindowsProgram } from '@/lib/nativeApps';
import type { FsEntryKind } from '@/lib/fs';

/**
 * What kind of thing a file is, by its name - for icons, thumbnails, the
 * Type column, and what opening it does. Din has no MIME database, so
 * extensions are all there is to go on.
 */
export type FileCategory =
  | 'folder'
  | 'image'
  | 'video'
  | 'audio'
  | 'text'
  | 'code'
  | 'archive'
  | 'pdf'
  | 'document'
  | 'program'
  | 'disk'
  | 'other';

const IMAGE = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp', 'avif', 'bmp', 'ico', 'svg', 'heic', 'jxl', 'tif', 'tiff', 'psd']);
/** Images Chromium can decode (and so thumbnail and show). */
const VIEWABLE_IMAGE = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp', 'avif', 'bmp', 'ico', 'svg']);
const VIDEO = new Set(['mp4', 'm4v', 'webm', 'mkv', 'mov', 'ogv', 'avi']);
/** Video Chromium can play. */
const PLAYABLE_VIDEO = new Set(['mp4', 'm4v', 'webm', 'mkv', 'mov', 'ogv']);
const AUDIO = new Set(['mp3', 'm4a', 'aac', 'ogg', 'oga', 'opus', 'flac', 'wav']);
const TEXT = new Set(['txt', 'md', 'markdown', 'log', 'csv', 'tsv', 'ini', 'conf', 'cfg', 'env', 'rst', 'org', 'srt', 'vtt']);
const CODE = new Set([
  'js', 'cjs', 'mjs', 'ts', 'tsx', 'jsx', 'mts', 'cts', 'json', 'jsonc', 'css', 'scss', 'html', 'htm', 'xml',
  'sh', 'bash', 'zsh', 'fish', 'py', 'rb', 'rs', 'go', 'c', 'h', 'cc', 'cpp', 'hpp', 'java', 'kt', 'swift',
  'lua', 'pl', 'php', 'sql', 'nix', 'toml', 'yaml', 'yml', 'lock', 'diff', 'patch', 'svelte', 'vue',
]);
const ARCHIVE = new Set([
  'zip', 'tar', 'tgz', 'tbz', 'tbz2', 'txz', 'tzst', 'gz', 'xz', 'bz2', 'zst', '7z', 'rar', 'jar',
  'cpio', 'cab', 'deb', 'rpm', 'apk',
]);
const DISK = new Set(['iso', 'img', 'qcow2', 'vmdk', 'vdi', 'dmg']);
const DOCUMENT = new Set(['doc', 'docx', 'docm', 'dotx', 'odt', 'rtf', 'xls', 'xlsx', 'xlsm', 'xltx', 'ods', 'ppt', 'pptx', 'pptm', 'potx', 'ppsx', 'odp', 'epub']);
/** Names that are text whatever their extension. */
const TEXT_NAMES = new Set(['readme', 'license', 'copying', 'makefile', 'dockerfile', 'changelog', 'authors', '.gitignore', '.bashrc', '.zshrc', '.profile']);

/** Lower-cased extension without the dot ('' for none, or a dotfile). */
export function extensionOf(name: string): string {
  const idx = name.lastIndexOf('.');
  return idx > 0 ? name.slice(idx + 1).toLowerCase() : '';
}

export function fileCategory(name: string, kind: FsEntryKind): FileCategory {
  if (kind === 'directory') return 'folder';
  const ext = extensionOf(name);
  if (IMAGE.has(ext)) return 'image';
  if (VIDEO.has(ext)) return 'video';
  if (AUDIO.has(ext)) return 'audio';
  if (ext === 'pdf') return 'pdf';
  if (CODE.has(ext)) return 'code';
  if (TEXT.has(ext) || TEXT_NAMES.has(name.toLowerCase())) return 'text';
  if (ARCHIVE.has(ext)) return 'archive';
  if (DISK.has(ext)) return 'disk';
  if (DOCUMENT.has(ext)) return 'document';
  if (isWindowsProgram(name)) return 'program';
  return 'other';
}

/** Text and code, which open in the Text Editor. */
export function isTextFile(name: string): boolean {
  const category = fileCategory(name, 'file');
  return category === 'text' || category === 'code';
}

/** Whether Din can draw a picture of this file for its icon. */
export function hasThumbnail(name: string): boolean {
  const ext = extensionOf(name);
  return VIEWABLE_IMAGE.has(ext) || PLAYABLE_VIDEO.has(ext);
}

export function isViewableImage(name: string): boolean {
  return VIEWABLE_IMAGE.has(extensionOf(name));
}

/** Photoshop documents, which open in Photo Editor. */
export function isPhotoshopFile(name: string): boolean {
  return extensionOf(name) === 'psd';
}

const WORD = new Set(['docx', 'docm', 'dotx', 'doc']);
const EXCEL = new Set(['xlsx', 'xlsm', 'xltx', 'xls']);
const POWERPOINT = new Set(['pptx', 'pptm', 'potx', 'ppsx', 'ppt']);

/** The built-in Office app for a Word, Excel or PowerPoint file, if it is one. */
export function officeAppFor(name: string): 'word-processor' | 'spreadsheet' | 'slides' | null {
  const ext = extensionOf(name);
  if (WORD.has(ext)) return 'word-processor';
  if (EXCEL.has(ext)) return 'spreadsheet';
  if (POWERPOINT.has(ext)) return 'slides';
  return null;
}

/** Tables in text that Spreadsheet opens too. */
export function isDelimitedText(name: string): boolean {
  const ext = extensionOf(name);
  return ext === 'csv' || ext === 'tsv';
}

/** Pictures Photo Editor opens: Photoshop documents and whatever Chromium can decode. */
export function isPhotoEditable(name: string): boolean {
  return isPhotoshopFile(name) || isViewableImage(name);
}

export function isPlayableVideo(name: string): boolean {
  return PLAYABLE_VIDEO.has(extensionOf(name));
}

export function isPlayableAudio(name: string): boolean {
  return AUDIO.has(extensionOf(name));
}

/** Whether "Extract Here" applies (electron/files.mts can unpack it). */
export function isExtractable(name: string): boolean {
  const ext = extensionOf(name);
  return ARCHIVE.has(ext) || ext === 'iso';
}

const CATEGORY_LABEL: Record<FileCategory, string> = {
  folder: 'Folder',
  image: 'Image',
  video: 'Video',
  audio: 'Audio',
  text: 'Text',
  code: 'Source code',
  archive: 'Archive',
  pdf: 'PDF document',
  document: 'Document',
  program: 'Windows program',
  disk: 'Disk image',
  other: 'File',
};

/** What the Type column says: "PNG image", "Folder", "ZIP archive". */
export function typeLabel(name: string, kind: FsEntryKind): string {
  if (kind === 'other') return 'Special file';
  const category = fileCategory(name, kind);
  const ext = extensionOf(name);
  if (category === 'folder' || category === 'pdf' || category === 'program' || !ext) {
    return CATEGORY_LABEL[category];
  }
  const label = CATEGORY_LABEL[category];
  return `${ext.toUpperCase()} ${category === 'other' ? 'file' : label.toLowerCase()}`;
}
