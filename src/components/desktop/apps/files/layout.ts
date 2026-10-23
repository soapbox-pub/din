import { Download, FileText, Image, Monitor, Music, Video } from 'lucide-react';
import type { LucideIcon } from 'lucide-react';

/** List view row height (px). */
export const ROW_HEIGHT = 32;

/** Grid zoom levels: tile width and icon size (px). */
export const GRID_ZOOMS = [
  { tile: 96, icon: 48 },
  { tile: 120, icon: 64 },
  { tile: 152, icon: 96 },
  { tile: 200, icon: 144 },
] as const;

/** The XDG user folders, shown under Home when they exist. */
export const USER_DIRS: { name: string; icon: LucideIcon }[] = [
  { name: 'Desktop', icon: Monitor },
  { name: 'Documents', icon: FileText },
  { name: 'Downloads', icon: Download },
  { name: 'Music', icon: Music },
  { name: 'Pictures', icon: Image },
  { name: 'Videos', icon: Video },
];
