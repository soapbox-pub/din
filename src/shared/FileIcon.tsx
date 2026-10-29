import { useEffect, useState } from 'react';
import {
  AppWindow,
  Disc,
  File,
  FileArchive,
  FileAudio,
  FileCode,
  FileImage,
  FileText,
  FileVideo,
  Folder,
  Link as LinkIcon,
} from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import { cn } from '@/lib/utils';
import type { FsEntryKind } from '@/lib/fs';
import { fileCategory, hasThumbnail } from '@/lib/fileTypes';
import type { FileCategory } from '@/lib/fileTypes';
import { getThumbnail } from '@/lib/thumbnails';
import { FILE_ICON_NAMES, themeIcon, useThemeIcons } from '@/shared/themeIcons';

const CATEGORY_ICON: Record<FileCategory, LucideIcon> = {
  folder: Folder,
  image: FileImage,
  video: FileVideo,
  audio: FileAudio,
  text: FileText,
  code: FileCode,
  archive: FileArchive,
  pdf: FileText,
  document: FileText,
  program: AppWindow,
  disk: Disc,
  other: File,
};

/** Tints that tell kinds apart at a glance, legible on light and dark. */
const CATEGORY_TINT: Partial<Record<FileCategory, string>> = {
  folder: 'text-primary',
  image: 'text-fuchsia-500',
  video: 'text-rose-500',
  audio: 'text-amber-500',
  archive: 'text-orange-500',
  pdf: 'text-red-500',
  code: 'text-sky-500',
  program: 'text-indigo-500',
  disk: 'text-teal-500',
};

export interface FileIconProps {
  path: string;
  name: string;
  kind: FsEntryKind;
  size: number | null;
  mtimeMs: number | null;
  symlink?: boolean;
  /** Box edge in px; icons are drawn at about 3/4 of it. */
  px: number;
  /** Whether to try a thumbnail (images, video). */
  thumbnail?: boolean;
  className?: string;
}

/** A file's icon (the icon theme's, else Din's), or its thumbnail when there's one to show. */
export function FileIcon({
  path,
  name,
  kind,
  size,
  mtimeMs,
  symlink,
  px,
  thumbnail = true,
  className,
}: FileIconProps) {
  const category = fileCategory(name, kind);
  const wantsThumb = thumbnail && kind === 'file' && hasThumbnail(name);
  const [thumb, setThumb] = useState<{ key: string; url: string | null } | null>(null);
  const key = `${path}\0${mtimeMs}\0${size}`;

  useEffect(() => {
    if (!wantsThumb) return;
    let alive = true;
    void getThumbnail({ path, size, mtimeMs }, () => alive).then((url) => {
      if (alive) setThumb({ key, url });
    });
    return () => {
      alive = false;
    };
  }, [wantsThumb, path, size, mtimeMs, key]);

  const url = thumb?.key === key ? thumb.url : null;
  const themed = themeIcon(useThemeIcons(), FILE_ICON_NAMES[category]);
  const Icon = CATEGORY_ICON[category];
  const iconPx = Math.round(px * (px <= 20 ? 1 : 0.75));
  // Theme icons come with their own margins.
  const themedPx = Math.round(px * (px <= 20 ? 1 : 0.9));

  return (
    <span
      className={cn('relative grid shrink-0 place-items-center', className)}
      style={{ width: px, height: px }}
      aria-hidden
    >
      {url ? (
        <img
          src={url}
          alt=""
          draggable={false}
          className={cn(
            'max-h-full max-w-full rounded-sm object-contain shadow-sm',
            px > 24 && 'ring-1 ring-foreground/10',
            'motion-safe:animate-in motion-safe:fade-in-0',
          )}
        />
      ) : themed ? (
        <img
          src={themed}
          alt=""
          draggable={false}
          className="object-contain"
          style={{ width: themedPx, height: themedPx }}
        />
      ) : (
        <Icon
          className={cn(CATEGORY_TINT[category] ?? 'text-muted-foreground')}
          style={{ width: iconPx, height: iconPx }}
          strokeWidth={px > 40 ? 1.25 : 1.75}
          fill={category === 'folder' ? 'currentColor' : 'none'}
          fillOpacity={category === 'folder' ? 0.18 : undefined}
        />
      )}
      {symlink && (
        <span className="absolute -bottom-0.5 -left-0.5 grid size-3.5 place-items-center rounded-full bg-background shadow-sm ring-1 ring-border">
          <LinkIcon className="size-2.5 text-muted-foreground" />
        </span>
      )}
    </span>
  );
}
