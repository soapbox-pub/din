import { Download, FileText, Image, Monitor, Music, Video } from 'lucide-react';
import type { LucideIcon } from 'lucide-react';

/** The XDG user folders, shown under Home when they exist (Files, the file picker). */
export const USER_DIRS: { name: string; icon: LucideIcon }[] = [
  { name: 'Desktop', icon: Monitor },
  { name: 'Documents', icon: FileText },
  { name: 'Downloads', icon: Download },
  { name: 'Music', icon: Music },
  { name: 'Pictures', icon: Image },
  { name: 'Videos', icon: Video },
];
