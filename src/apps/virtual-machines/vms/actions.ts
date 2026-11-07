import type { ComponentType } from 'react';
import { Ban, Camera, FolderOpen, Pause, Play, Power, PowerOff, RotateCcw, Settings, Trash2 } from 'lucide-react';
import type { VmInfo } from '@/lib/vms';
import type { MenuItem } from '@/sdk';

export type VmAction = 'start' | 'shutdown' | 'pause' | 'resume' | 'reset' | 'forceStop' | 'snapshot' | 'settings' | 'showInFiles' | 'delete' | 'cancelInstall';

export interface ActionItem {
  id: VmAction;
  label: string;
  icon: ComponentType<{ className?: string }>;
  enabled: boolean;
  destructive?: boolean;
}

/** What the power button's right-click menu offers. */
export const POWER_ACTIONS: readonly VmAction[] = ['shutdown', 'reset', 'forceStop'];

/** What can be done to a machine as it is now, in groups. */
export function vmActions(vm: VmInfo): ActionItem[][] {
  const off = vm.state === 'stopped';
  const up = vm.state === 'running' || vm.state === 'paused';
  // Its installer can be started again; a download can't be started at all.
  const startable = !vm.install || vm.install.phase === 'installing';
  return [
    [
      off
        ? { id: 'start', label: 'Start', icon: Play, enabled: startable }
        : { id: 'shutdown', label: 'Shut Down', icon: Power, enabled: up },
      vm.state === 'paused'
        ? { id: 'resume', label: 'Resume', icon: Play, enabled: true }
        : { id: 'pause', label: 'Pause', icon: Pause, enabled: vm.state === 'running' },
      { id: 'reset', label: 'Restart', icon: RotateCcw, enabled: up },
      { id: 'forceStop', label: 'Force Off', icon: PowerOff, enabled: !off, destructive: true },
    ],
    [
      { id: 'snapshot', label: 'Take Snapshot…', icon: Camera, enabled: !vm.install && (off || up) },
      { id: 'settings', label: 'Settings…', icon: Settings, enabled: true },
      { id: 'showInFiles', label: 'Show in Files', icon: FolderOpen, enabled: true },
    ],
    [
      vm.install
        ? { id: 'cancelInstall', label: 'Cancel Install…', icon: Ban, enabled: true, destructive: true }
        : { id: 'delete', label: 'Move to Trash…', icon: Trash2, enabled: off, destructive: true },
    ],
  ];
}

/** The same actions for Din's menu bar, their ids prefixed `vm:`. */
export function vmMenuItems(vm: VmInfo | null): MenuItem[] {
  if (!vm) return [];
  const items: MenuItem[] = [];
  vmActions(vm).forEach((group, i) => {
    if (i > 0) items.push({ type: 'separator' });
    for (const { id, label, enabled, destructive } of group) items.push({ id: `vm:${id}`, label, enabled, destructive });
  });
  return items;
}
