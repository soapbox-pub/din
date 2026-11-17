import { formatBytes } from '@/lib/fs';
import { getNetworkMonitorBridge } from '@/lib/networkMonitor';
import { getSystemMonitorBridge, type NetworkTotals } from '@/lib/systemMonitor';
import { CommandError, type Area } from './types';
import { call, command, need } from './util';

/**
 * `din network`: the System Monitor's Network graph and its Connections list:
 * how fast the computer is sending and receiving, and every program's open
 * connections. (What pages fetch is recorded only while the Network view
 * watches, so it has no command.)
 */

/** How long to wait for the System Monitor's first measured snapshot. */
const SNAPSHOT_TIMEOUT_MS = 10_000;

function rate(bytesPerSecond: number): string {
  return `${formatBytes(Math.round(bytesPerSecond))}/s`;
}

/** One measured snapshot's network totals (the first comes about half a second after subscribing). */
function measure(): Promise<NetworkTotals | null> {
  const bridge = need(getSystemMonitorBridge(), 'The System Monitor');
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      stop();
      reject(new CommandError('The System Monitor didn’t answer'));
    }, SNAPSHOT_TIMEOUT_MS);
    const stop = bridge.subscribe((snapshot) => {
      clearTimeout(timer);
      // Unsubscribing inside the callback would run before it returns.
      queueMicrotask(stop);
      resolve(snapshot.network);
    });
  });
}

export const networkArea: Area = {
  name: 'network',
  summary: 'Network traffic, as System Monitor’s Network graph shows it, and every program’s open connections',
  commands: [
    command('network', 'usage', 'How fast the computer is receiving and sending now, every network adapter together', [], async () => {
      const network = await measure();
      if (!network) throw new CommandError('This computer has no network adapter to measure');
      return {
        data: network,
        text: [
          `down\t${rate(network.receiveRate)}`,
          `up\t${rate(network.sendRate)}`,
          `received\t${formatBytes(network.received)} since startup`,
          `sent\t${formatBytes(network.sent)} since startup`,
        ].join('\n'),
      };
    }),
    command('network', 'connections', 'Every program’s open connections to other computers, with the bytes each has carried', [], async () => {
      const result = await call(need(getNetworkMonitorBridge(), 'Connections').connections());
      if (!result.available) throw new CommandError('Listing connections needs ss (iproute2), which isn’t installed');
      const list = [...result.connections].sort(
        (a, b) => (b.received ?? 0) + (b.sent ?? 0) - ((a.received ?? 0) + (a.sent ?? 0)),
      );
      return {
        data: list,
        text: list.length
          ? list
              .map((c) => {
                const who = c.program ? `${c.program} (${c.pid})` : 'system';
                const where = `${c.remoteHost ?? c.remoteAddress}:${c.remotePort}`;
                const bytes = c.received === null ? '' : `\t↓ ${formatBytes(c.received)} ↑ ${formatBytes(c.sent ?? 0)}`;
                return `${who}\t${c.protocol}\t${where}${bytes}`;
              })
              .join('\n')
          : 'Nothing is connected to another computer',
      };
    }),
  ],
};
