import {
  driveProblem,
  flashRunning,
  formatDriveSize,
  getFlasherBridge,
  PHASE_LABELS,
  type FlashDrive,
  type FlashSource,
  type FlashState,
} from '@/lib/flasher';
import { resolvePath } from './parse';
import { CommandError, type Area } from './types';
import { call, command, need, pick } from './util';

/**
 * `din flasher`: USB Flasher (electron/usb-flasher.mts), writing a disk
 * image, or DinOS built from the commit running, to a USB drive or memory
 * card, as the app's Erase and Write does.
 */

const flasher = () => need(getFlasherBridge(), 'USB Flasher');

function describeDrive(d: FlashDrive): string {
  return [d.path, d.name, formatDriveSize(d.sizeBytes), d.labels.length ? `has ${d.labels.join(', ')}` : ''].filter(Boolean).join('\t');
}

function describeJob(s: FlashState): string {
  const what = [s.sourceName, s.drive && `to ${s.drive.name} (${s.drive.path})`].filter(Boolean).join(' ');
  const percent = s.progress !== null && flashRunning(s) ? ` ${Math.floor(s.progress * 100)}%` : '';
  return `${PHASE_LABELS[s.phase]}${percent}${what ? `: ${what}` : ''}${s.error ? ` (${s.error})` : ''}`;
}

export const flasherArea: Area = {
  name: 'flasher',
  summary: 'USB Flasher: write a disk image, or DinOS, to a USB drive or memory card',
  commands: [
    command('flasher', 'status', 'The drives an image can be written to, whether DinOS can be made here, and what’s being written', [], async () => {
      const status = await call(flasher().status());
      if (!status.available) return { data: status, text: status.reason ?? 'Drives can’t be written here' };
      return {
        data: status,
        text: [
          status.drives.length ? status.drives.map(describeDrive).join('\n') : 'No USB drives or memory cards plugged in',
          status.dinos.available
            ? `DinOS: can be made (${[status.dinos.version, status.dinos.commit?.slice(0, 7)].filter(Boolean).join(', ')})`
            : `DinOS: ${status.dinos.reason}`,
          status.state.phase !== 'idle' ? describeJob(status.state) : '',
        ]
          .filter(Boolean)
          .join('\n'),
      };
    }),
    command(
      'flasher',
      'write',
      'Erase a drive and write an image to it, then check it and eject it (asks on screen first); waits until it’s done',
      [
        { name: 'image', type: 'string', positional: true, help: 'The image file (.iso, .img, or compressed with xz, gzip, zstd or bzip2), or “dinos” for DinOS made from this computer’s' },
        { name: 'drive', type: 'string', positional: true, help: 'The drive, by device (/dev/sdb) or name, from din flasher status' },
      ],
      async (args, ctx) => {
        const bridge = flasher();
        const status = await call(bridge.status());
        if (!status.available) throw new CommandError(status.reason ?? 'Drives can’t be written here');
        if (flashRunning(status.state)) throw new CommandError('A drive is being written already');
        const drive = pick(status.drives, args.string('drive'), (d) => [d.path, d.path.replace('/dev/', ''), d.name], 'USB drive');

        const raw = args.string('image');
        let source: FlashSource;
        let name: string;
        let size: number | null;
        let imagePath: string | undefined;
        if (raw.toLowerCase() === 'dinos') {
          if (!status.dinos.available) throw new CommandError(status.dinos.reason ?? 'DinOS can’t be made here');
          source = { kind: 'dinos' };
          name = `DinOS${status.dinos.version ? ` ${status.dinos.version}` : ''}`;
          size = status.dinos.imageBytes;
        } else {
          const image = await call(bridge.inspect(resolvePath(raw, ctx.cwd)));
          source = { kind: 'file', path: image.path };
          name = image.name;
          size = image.imageBytes;
          imagePath = image.path;
        }
        const problem = driveProblem(drive, size, imagePath);
        if (problem) throw new CommandError(`${drive.name}: ${problem}`);

        const ok = await ctx.confirm({
          title: `Erase ${drive.name}?`,
          description: `A command asked to erase this ${formatDriveSize(drive.sizeBytes)} drive (${drive.path}${drive.labels.length ? `, ${drive.labels.join(', ')}` : ''}) and write ${name} to it. Everything on it is permanently deleted.`,
          action: 'Erase and Write',
          destructive: true,
        });
        if (!ok) throw new CommandError('You didn’t allow it');

        const finished = new Promise<FlashState>((resolve) => {
          const stop = bridge.onChanged(({ state }) => {
            if (state.phase === 'done' || state.phase === 'failed' || state.phase === 'cancelled') {
              stop();
              resolve(state);
            } else if (flashRunning(state)) {
              const percent = state.progress !== null ? Math.floor(state.progress * 100) : undefined;
              const text = state.phase === 'building' && state.detail ? `${PHASE_LABELS.building}: ${state.detail}` : PHASE_LABELS[state.phase];
              ctx.progress?.(percent !== undefined && (state.phase === 'writing' || state.phase === 'verifying') ? { text, percent } : { text });
            }
          });
        });
        await call(bridge.flash(source, drive.path));
        const state = await finished;
        if (state.phase === 'failed') throw new CommandError(state.error ?? 'The drive wasn’t written');
        if (state.phase === 'cancelled') throw new CommandError('Stopped: the drive was only partly written');
        return {
          data: state,
          text: `${name} was written to ${drive.name} and checked.${state.ejected ? ' You can unplug it.' : ''}`,
        };
      },
    ),
    command('flasher', 'stop', 'Stop what’s being written (or DinOS being made); the drive won’t work until it’s written again', [], async () => {
      const bridge = flasher();
      const { state } = await call(bridge.status());
      if (!flashRunning(state)) return { data: state, text: 'Nothing is being written' };
      await call(bridge.cancel());
      return { data: { stopped: true }, text: 'Stopped' };
    }),
  ],
};
