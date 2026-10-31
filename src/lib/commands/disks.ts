import { getVolumesBridge, type Volume } from '@/lib/volumes';
import { type Area, type Param } from './types';
import { call, command, need, pick } from './util';

/**
 * `din disks`: the USB sticks, SD cards and other removable disks in Files'
 * sidebar (electron/volumes.mts): opening, unlocking and ejecting them.
 */

const volumes = () => need(getVolumesBridge(), 'Removable disks');
const DISK: Param = { name: 'disk', type: 'string', positional: true, help: 'The disk, by name or device (e.g. /dev/sdb1)' };

async function disk(query: string): Promise<Volume> {
  const { volumes: list } = await call(volumes().state());
  return pick(list, query, (v) => [v.id, v.device, v.name], 'disk');
}

function describe(v: Volume): string {
  if (v.busy) return v.busy;
  if (v.locked) return 'locked';
  return v.mountPoint ?? 'not mounted';
}

export const disksArea: Area = {
  name: 'disks',
  summary: 'Removable disks: list, open, unlock and eject',
  commands: [
    command('disks', 'list', 'The removable disks plugged in, and where each is mounted', [], async () => {
      const { volumes: list } = await call(volumes().state());
      return {
        data: list,
        text: list.length ? list.map((v) => `${v.name}\t${v.device}\t${describe(v)}`).join('\n') : 'No removable disks',
      };
    }),
    command('disks', 'mount', 'Mount a disk that isn’t; prints where', [DISK], async (args) => {
      const v = await disk(args.string('disk'));
      const mountPoint = await call(volumes().mount(v.id));
      return { data: { mountPoint }, text: mountPoint };
    }),
    command(
      'disks',
      'unlock',
      'Unlock an encrypted disk and mount what’s in it; prints where',
      [DISK, { name: 'passphrase', type: 'string', help: 'Its passphrase' }],
      async (args) => {
        const v = await disk(args.string('disk'));
        const mountPoint = await call(volumes().unlock(v.id, args.string('passphrase')));
        return { data: { mountPoint }, text: mountPoint };
      },
    ),
    command('disks', 'eject', 'Unmount a disk, lock it if it was unlocked, and power it off to unplug', [DISK], async (args) => {
      const v = await disk(args.string('disk'));
      await call(volumes().eject(v.id));
      return { text: `“${v.name}” can be removed` };
    }),
  ],
};
