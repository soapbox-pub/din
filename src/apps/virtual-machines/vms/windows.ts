import { useEffect } from 'react';
import type { VmInstallerId } from '@/lib/vms';
import { appLink } from '@/shared/launch';

/**
 * The windows Virtual Machines opens beside its own, by their `window`
 * launch param: a new machine (`system`, Custom Install of one, `other`, the
 * form for any disc image), and a machine's settings (`vm`, its id). They
 * tell the main window what came of them over a BroadcastChannel.
 */
export type VmWindow = { window: 'new'; system?: VmInstallerId; other?: boolean } | { window: 'settings'; vm: string };

export function openVmWindow(kind: VmWindow): void {
  const size = kind.window === 'settings' ? { width: 560, height: 680 } : { width: 640, height: 640 };
  void window.open(appLink(null, { ...kind, floating: true, ...size }));
}

/** What a window tells the main one: a machine made or renamed, to choose. */
export type VmWindowMessage = { type: 'created'; id: string } | { type: 'renamed'; id: string };

const CHANNEL = 'virtual-machines';

export function announce(message: VmWindowMessage): void {
  const channel = new BroadcastChannel(CHANNEL);
  channel.postMessage(message);
  channel.close();
}

export function useVmWindowMessages(onMessage: (message: VmWindowMessage) => void): void {
  useEffect(() => {
    const channel = new BroadcastChannel(CHANNEL);
    channel.onmessage = (e: MessageEvent<VmWindowMessage>) => onMessage(e.data);
    return () => channel.close();
  }, [onMessage]);
}
