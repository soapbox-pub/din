/**
 * The Virtual Machines app's view of din.system.vms: queries over the
 * machines and their snapshots, kept current by main's `vms:changed`, and
 * what the app derives from them (labels, sizes, a name for a disc image).
 */
import { useEffect } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useDin } from '@/sdk/react';
import type { VmInfo, VmInstallerId, VmOs, VmsBridge, VmState } from '@/lib/vms';

const KEY = ['vms'] as const;

export function useBridge(): VmsBridge | undefined {
  return useDin().system.vms;
}

/** The machines, replaced whenever main says one changed. */
export function useVms() {
  const bridge = useBridge();
  const queryClient = useQueryClient();
  useEffect(
    () =>
      bridge?.onChanged((vms) => {
        queryClient.setQueryData([...KEY, 'list'], vms);
        // Snapshots change with them (taken, restored, deleted).
        void queryClient.invalidateQueries({ queryKey: [...KEY, 'snapshots'] });
      }),
    [bridge, queryClient],
  );
  return useQuery({
    queryKey: [...KEY, 'list'],
    queryFn: () => bridge!.list(),
    enabled: !!bridge,
    staleTime: Infinity,
  });
}

export function useVmsStatus() {
  const bridge = useBridge();
  return useQuery({
    queryKey: [...KEY, 'status'],
    queryFn: () => bridge!.status(),
    enabled: !!bridge,
    staleTime: Infinity,
  });
}

export function useSnapshots(id: string | null) {
  const bridge = useBridge();
  return useQuery({
    queryKey: [...KEY, 'snapshots', id],
    queryFn: () => bridge!.snapshots(id!),
    enabled: !!bridge && !!id,
    staleTime: Infinity,
  });
}

/**
 * Pick a disc image with Din's file picker; resolves with its path, or null.
 * For installing macOS (`system`), it's a recovery image: Apple's BaseSystem.dmg.
 */
export function usePickDiscImage(): (system?: VmInstallerId | null) => Promise<{ path: string; name: string } | null> {
  const din = useDin();
  return async (system) => {
    const [file] = await din.files.open({
      title: system === 'macos' ? 'Choose a macOS Recovery Image' : 'Choose a Disc Image',
      types:
        system === 'macos'
          ? [{ description: 'Recovery images', extensions: ['.dmg', '.img'] }]
          : [{ description: 'Disc images', extensions: ['.iso', '.img'] }],
      writable: false,
      startIn: 'downloads',
      confirmLabel: 'Choose',
    });
    return file ? { path: file.path, name: file.name } : null;
  };
}

export const STATE_LABELS: Record<VmState, string> = {
  stopped: 'Off',
  starting: 'Starting…',
  running: 'Running',
  paused: 'Paused',
  stopping: 'Shutting down…',
};

export const OS_LABELS: Record<VmOs, string> = {
  windows: 'Windows',
  macos: 'macOS',
  linux: 'Linux',
  other: 'Other',
};

/** Whether QEMU is up for it (its screen can be shown). */
export function isOn(vm: VmInfo): boolean {
  return vm.state !== 'stopped';
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024 ** 2) return `${Math.max(1, Math.round(bytes / 1024))} KB`;
  if (bytes < 1024 ** 3) return `${Math.round(bytes / 1024 ** 2)} MB`;
  const gb = bytes / 1024 ** 3;
  return `${gb < 10 ? gb.toFixed(1).replace(/\.0$/, '') : Math.round(gb)} GB`;
}

export function formatMemory(mib: number): string {
  return mib >= 1024 ? `${(mib / 1024).toFixed(mib % 1024 ? 1 : 0)} GB` : `${mib} MB`;
}

const LINUX = /ubuntu|kubuntu|xubuntu|fedora|debian|arch|manjaro|mint|nixos|opensuse|suse|pop[-_]?os|elementary|kali|zorin|alpine|centos|rocky|alma|endeavour|gentoo|void|mx[-_]|linux|deepin|bazzite|garuda/i;

/** What's probably on a disc image, from its name. */
export function guessOs(fileName: string): VmOs {
  if (/^win|windows|\bwin(7|8|10|11|xp)\b|_win|-win/i.test(fileName)) return 'windows';
  if (LINUX.test(fileName)) return 'linux';
  return 'other';
}

/** A name for a machine installed from a disc image: "Windows 11", "Ubuntu 24.04". */
export function guessName(fileName: string): string {
  const stem = fileName.replace(/\.(iso|img)$/i, '');
  const windows = /win(?:dows)?[\s_-]*(11|10|8\.1|8|7|xp|server[\s_-]*\d{4})/i.exec(stem);
  if (windows) return `Windows ${windows[1].replace(/[\s_-]+/g, ' ').replace(/^server/i, 'Server')}`;
  const words = stem.split(/[\s_-]+/).filter(Boolean);
  if (!words.length) return 'Virtual Machine';
  const first = words[0].charAt(0).toUpperCase() + words[0].slice(1);
  const version = words.slice(1).find((w) => /^\d+(\.\d+)*$/.test(w));
  return version ? `${first} ${version}` : first;
}
