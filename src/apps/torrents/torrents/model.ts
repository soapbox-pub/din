import type { ComponentType } from 'react';
import {
  AlertTriangle,
  ArrowDownToLine,
  ArrowUpFromLine,
  CircleCheck,
  CirclePause,
  Copy,
  FolderInput,
  FolderSearch,
  Layers,
  Megaphone,
  Pause,
  Play,
  RefreshCw,
  SkipForward,
  SquareArrowOutUpRight,
  Trash2,
  X,
} from 'lucide-react';
import type { MenuItem } from '@/sdk';
import type { Torrent } from '@/lib/torrents';

export type Filter = 'all' | 'downloading' | 'seeding' | 'paused' | 'finished' | 'errors';

export const FILTERS: { id: Filter; label: string; icon: ComponentType<{ className?: string; strokeWidth?: number }>; test: (t: Torrent) => boolean }[] = [
  { id: 'all', label: 'All Transfers', icon: Layers, test: () => true },
  { id: 'downloading', label: 'Downloading', icon: ArrowDownToLine, test: (t) => t.state !== 'stopped' && !t.finished },
  { id: 'seeding', label: 'Seeding', icon: ArrowUpFromLine, test: (t) => t.state === 'seeding' },
  { id: 'paused', label: 'Paused', icon: CirclePause, test: (t) => t.state === 'stopped' && !t.finished },
  { id: 'finished', label: 'Finished', icon: CircleCheck, test: (t) => t.finished },
  { id: 'errors', label: 'Errors', icon: AlertTriangle, test: (t) => t.errorKind === 'local' || t.errorKind === 'tracker-error' },
];

export function filterLabel(filter: Filter): string {
  return FILTERS.find((f) => f.id === filter)?.label ?? 'All Transfers';
}

/** What can be done to transfers: the same in the ⋯ menu, the right-click menu and the menu bar. */
export type TransferAction =
  | 'resume'
  | 'resumeNow'
  | 'pause'
  | 'open'
  | 'reveal'
  | 'copyMagnet'
  | 'verify'
  | 'reannounce'
  | 'move'
  | 'remove'
  | 'trash';

interface ActionItem {
  id: TransferAction;
  label: string;
  icon: ComponentType<{ className?: string }>;
  enabled: boolean;
  destructive?: boolean;
  accelerator?: string;
}

/** The actions for these transfers (one, or a selection), in groups. */
export function transferActions(targets: Torrent[]): ActionItem[][] {
  const one = targets.length === 1 ? targets[0] : null;
  const any = targets.length > 0;
  const paused = targets.some((t) => t.state === 'stopped');
  const running = targets.some((t) => t.state !== 'stopped');
  const queued = targets.some((t) => t.waiting || t.state === 'stopped');
  const many = targets.length > 1 ? ` ${targets.length} Transfers` : '';
  return [
    [
      { id: 'resume', label: `Resume${many}`, icon: Play, enabled: paused },
      { id: 'resumeNow', label: 'Resume Now', icon: SkipForward, enabled: queued },
      { id: 'pause', label: `Pause${many}`, icon: Pause, enabled: running },
    ],
    [
      { id: 'open', label: 'Open', icon: SquareArrowOutUpRight, enabled: !!one && one.haveBytes > 0 },
      { id: 'reveal', label: 'Show in Files', icon: FolderSearch, enabled: !!one && one.haveBytes > 0 },
      { id: 'copyMagnet', label: 'Copy Magnet Link', icon: Copy, enabled: !!one },
    ],
    [
      { id: 'move', label: 'Move Data To…', icon: FolderInput, enabled: any },
      { id: 'verify', label: 'Verify Local Data', icon: RefreshCw, enabled: any && targets.some((t) => t.metadataProgress === null) },
      { id: 'reannounce', label: 'Ask Trackers for More Peers', icon: Megaphone, enabled: running && targets.some((t) => !t.waiting) },
    ],
    [
      { id: 'remove', label: 'Remove from List', icon: X, enabled: any, accelerator: 'Delete' },
      { id: 'trash', label: 'Remove and Trash Data', icon: Trash2, enabled: any, destructive: true, accelerator: 'Shift+Delete' },
    ],
  ];
}

/** The same actions for the menu bar's Transfers menu, as `transfer:<action>`. */
export function transferMenuItems(targets: Torrent[]): MenuItem[] {
  const items: MenuItem[] = [];
  transferActions(targets).forEach((group, i) => {
    if (i > 0) items.push({ type: 'separator' });
    for (const a of group) {
      items.push({ id: `transfer:${a.id}`, label: a.label, enabled: a.enabled, destructive: a.destructive, accelerator: a.accelerator, notInFields: true });
    }
  });
  return items;
}
