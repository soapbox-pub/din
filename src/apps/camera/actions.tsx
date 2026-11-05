import type { ReactNode } from 'react';
import { Copy, ExternalLink, FolderOpen, Pencil, Trash2 } from 'lucide-react';
import type { CameraItem } from './library';

export type ItemAction = 'open' | 'edit' | 'show' | 'copy' | 'trash';

export interface Entry {
  id: ItemAction;
  label: string;
  icon: ReactNode;
  destructive?: boolean;
  separated?: boolean;
}

/** What can be done with a photo or video: the ⋯ menu, the right-click menu and the menu bar's. */
export function itemEntries(item: CameraItem): Entry[] {
  const photo = item.kind === 'photo';
  return [
    { id: 'open', label: photo ? 'Open in Preview' : 'Open', icon: <ExternalLink className="size-4" /> },
    ...(photo ? [{ id: 'edit' as const, label: 'Edit in Photo Editor', icon: <Pencil className="size-4" /> }] : []),
    { id: 'show', label: 'Show in Files', icon: <FolderOpen className="size-4" /> },
    ...(photo ? [{ id: 'copy' as const, label: 'Copy', icon: <Copy className="size-4" />, separated: true }] : []),
    { id: 'trash', label: 'Move to Trash', icon: <Trash2 className="size-4" />, destructive: true, separated: true },
  ];
}

