import type { ComponentType } from 'react';
import { AppWindow, Disc3, FileArchive, FileText, Film, Folder, Image, Magnet, Music, Package } from 'lucide-react';
import { cn } from '@/lib/utils';

interface Kind {
  icon: ComponentType<{ className?: string; strokeWidth?: number }>;
  /** The tile's tint and the glyph's color, readable in either scheme. */
  tone: string;
}

const KINDS: Record<string, Kind> = {
  magnet: { icon: Magnet, tone: 'bg-rose-500/15 text-rose-700 dark:text-rose-300' },
  video: { icon: Film, tone: 'bg-violet-500/15 text-violet-700 dark:text-violet-300' },
  audio: { icon: Music, tone: 'bg-pink-500/15 text-pink-700 dark:text-pink-300' },
  image: { icon: Image, tone: 'bg-teal-500/15 text-teal-700 dark:text-teal-300' },
  archive: { icon: FileArchive, tone: 'bg-amber-500/15 text-amber-700 dark:text-amber-300' },
  disc: { icon: Disc3, tone: 'bg-slate-500/15 text-slate-700 dark:text-slate-300' },
  app: { icon: Package, tone: 'bg-blue-500/15 text-blue-700 dark:text-blue-300' },
  program: { icon: AppWindow, tone: 'bg-blue-500/15 text-blue-700 dark:text-blue-300' },
  document: { icon: FileText, tone: 'bg-sky-500/15 text-sky-700 dark:text-sky-300' },
  folder: { icon: Folder, tone: 'bg-sky-500/15 text-sky-700 dark:text-sky-300' },
};

/** What kind of thing a torrent mostly is, from its main file's type or name. */
function kindOf(mimeType: string | null, name: string, fileCount: number, hasMetadata = true): Kind {
  if (!hasMetadata) return KINDS.magnet;
  const mime = mimeType ?? '';
  const ext = /\.([a-z0-9]+)$/i.exec(name)?.[1]?.toLowerCase() ?? '';
  if (mime.startsWith('video/') || ['mkv', 'mp4', 'avi', 'mov', 'webm'].includes(ext)) return KINDS.video;
  if (mime.startsWith('audio/') || ['flac', 'mp3', 'ogg', 'm4a', 'wav', 'opus'].includes(ext)) return KINDS.audio;
  if (mime.startsWith('image/') && !/iso|cd-image|disk/.test(mime)) return KINDS.image;
  if (/iso9660|cd-image|disk-image|raw-disk/.test(mime) || ['iso', 'img'].includes(ext)) return KINDS.disc;
  if (/zip|x-7z|rar|tar|gzip|bzip|xz|zstd|compressed/.test(mime) || ['zip', '7z', 'rar', 'tar', 'gz', 'xz', 'zst'].includes(ext)) return KINDS.archive;
  if (/debian|rpm|appimage|flatpak|apple-diskimage/.test(mime) || ['deb', 'rpm', 'appimage', 'flatpak', 'dmg', 'pkg'].includes(ext)) return KINDS.app;
  if (/msdownload|executable|msi/.test(mime) || ['exe', 'msi'].includes(ext)) return KINDS.program;
  if (mime.startsWith('text/') || /pdf|epub|document|msword/.test(mime) || ['pdf', 'epub', 'txt', 'docx'].includes(ext)) return KINDS.document;
  return fileCount > 1 ? KINDS.folder : KINDS.document;
}

/** A torrent's tile: its kind's glyph on a rounded clay square. */
export function TorrentIcon({
  mimeType,
  name,
  fileCount,
  hasMetadata,
  size = 'md',
  className,
}: {
  mimeType: string | null;
  name: string;
  fileCount: number;
  hasMetadata: boolean;
  size?: 'md' | 'lg' | 'xl';
  className?: string;
}) {
  const { icon: Icon, tone } = kindOf(mimeType, name, fileCount, hasMetadata);
  return (
    <span
      aria-hidden
      className={cn(
        'grid shrink-0 place-items-center clay',
        tone,
        size === 'md' && 'size-10 rounded-xl',
        size === 'lg' && 'size-12 rounded-xl',
        size === 'xl' && 'size-16 rounded-2xl',
        className,
      )}
    >
      <Icon className={size === 'xl' ? 'size-8' : size === 'lg' ? 'size-6' : 'size-5'} strokeWidth={1.75} />
    </span>
  );
}
