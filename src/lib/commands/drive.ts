import { formatBytes } from '@/lib/fs';
import { describeDrive, getDriveBridge } from '@/lib/drive';
import { CommandError, type Area } from './types';
import { call, command, need, pick } from './util';

/**
 * `din drive`: Din Drive, the encrypted drive on Nostr and Blossom mounted
 * at ~/Drive (electron/drive.mts), as Settings → Drive shows it: its state,
 * setting it up, and its trash.
 */

const drive = () => need(getDriveBridge(), 'Din Drive');

export const driveArea: Area = {
  name: 'drive',
  summary: 'Din Drive, the encrypted drive at ~/Drive: its state, setting it up, and its trash',
  commands: [
    command('drive', 'status', 'Whether the drive is set up and mounted, and whether it’s in sync', [], async () => {
      const state = await call(drive().state());
      if (!state.available) return { data: state, text: 'Din Drive isn’t on this computer' };
      const s = state.status;
      if (!s) return { data: state, text: 'Not running: set it up with din drive setup' };
      return {
        data: state,
        text: [
          `${describeDrive(s)}`,
          `Mounted at\t${s.mountpoint}`,
          `Items\t${s.items}`,
          `Relays\t${s.connected_relays} of ${s.relays.length} connected (${s.relays.join(', ')})`,
          `Servers\t${s.servers.join(', ')}`,
          ...(s.last_error ? [`Problem\t${s.last_error}`] : []),
        ].join('\n'),
      };
    }),
    command('drive', 'setup', 'Find your drive, or create one, and mount it at ~/Drive', [], async () => {
      const s = await call(drive().setUp());
      return { data: s, text: `Mounted at ${s.mountpoint}` };
    }),
    command('drive', 'trash', 'What’s in the drive’s trash, newest first', [], async () => {
      const items = await call(drive().trash());
      return {
        data: items,
        text: items.length
          ? items
              .map((i) => `${i.id}\t${i.name}${i.dir ? '/' : `\t${formatBytes(i.size)}`}\t${new Date(i.trashed * 1000).toLocaleString()}`)
              .join('\n')
          : 'The trash is empty',
      };
    }),
    command(
      'drive',
      'restore',
      'Put something from the trash back where it was',
      [{ name: 'item', type: 'string', positional: true, help: 'The item, by name or id (din drive trash lists them)' }],
      async (args) => {
        const items = await call(drive().trash());
        const item = pick(items, args.string('item'), (i) => [i.id, i.name], 'item in the trash');
        await call(drive().restore(item.id));
        return { data: { id: item.id, restored: true }, text: `Restored “${item.name}”` };
      },
    ),
    command('drive', 'empty-trash', 'Delete everything in the drive’s trash for good (asks on screen first)', [], async (_args, ctx) => {
      const ok = await ctx.confirm({
        title: 'Empty the Drive’s trash?',
        description: 'Everything in it is deleted for good, from every device and from your Blossom servers.',
        action: 'Empty Trash',
        destructive: true,
      });
      if (!ok) throw new CommandError('You didn’t allow it');
      const count = await call(drive().emptyTrash());
      return { data: { deleted: count }, text: `Deleted ${count} ${count === 1 ? 'item' : 'items'}` };
    }),
  ],
};
