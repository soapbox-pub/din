import { formatDiskSize, getInstallerBridge, type InstallMode, type InstallState, type InstallStep } from '@/lib/installer';
import { CommandError, type Area } from './types';
import { call, command, need } from './util';

/** `din installer`: the Installer app, on DinOS running from a USB stick. */

const installer = () => need(getInstallerBridge(), 'Installing DinOS');

const STEP_LABELS: Record<InstallStep, string> = {
  partition: 'Preparing the disk',
  format: 'Creating file systems',
  copy: 'Copying DinOS',
  boot: 'Making it bootable',
};

/** What each mode does to the disk, for the question asked on screen. */
const MODE_ACTIONS: Record<InstallMode, string> = {
  wipe: 'erase it and install DinOS, unencrypted, with this session’s account, Wi-Fi networks and files',
  free: 'install DinOS, unencrypted, in its free space, with this session’s account, Wi-Fi networks and files',
  keep: 'reinstall the DinOS on it, keeping its files',
  oem: 'erase it and set DinOS up for someone else, with nothing from this session',
};

const MODES = Object.keys(MODE_ACTIONS) as InstallMode[];

export const installerArea: Area = {
  name: 'installer',
  summary: 'Install DinOS from a USB stick onto this computer’s disk, or set it up for someone else',
  commands: [
    command('installer', 'status', 'Whether DinOS is running from a USB stick, the disks it could go on, and any install', [], async () => {
      const bridge = installer();
      const [status, state] = await Promise.all([call(bridge.status()), call(bridge.state())]);
      if (!status.available) return { data: { status, state }, text: 'Installing isn’t available here' };
      return {
        data: { status, state },
        text: [
          status.live ? `running from: ${status.bootDisk}` : 'not running from a USB stick',
          `needs: ${formatDiskSize(status.requiredBytes)}`,
          ...status.disks.map((d) => `${d.path}: ${[d.model, formatDiskSize(d.sizeBytes), d.existingInstall ? `DinOS${d.existingInstall.encrypted ? ', encrypted' : ''}` : '', d.inUse ? 'in use' : ''].filter(Boolean).join(', ')}`),
          state.phase !== 'idle' ? `install: ${state.phase}${state.mode ? ` (${state.mode} ${state.disk})` : ''}${state.error ? `: ${state.error}` : ''}` : '',
        ].filter(Boolean).join('\n'),
      };
    }),
    command('installer', 'install', 'Install DinOS on a disk, as the Installer does (asks on screen first); oem sets it up for someone else, and encrypting it with a passphrase is only done in the Installer', [
      { name: 'disk', type: 'string', positional: true, help: 'The disk, e.g. /dev/nvme0n1, from din installer status' },
      { name: 'mode', type: 'string', choices: MODES, optional: true, help: 'oem (default): erase it and leave it for its owner to set up; wipe, free, keep: as the Installer' },
    ], async (args, ctx) => {
      const bridge = installer();
      const status = await call(bridge.status());
      if (!status.available || !status.live) throw new CommandError('DinOS can only be installed while running from a USB stick');
      const disk = status.disks.find((d) => d.path === args.string('disk'));
      if (!disk) throw new CommandError(`${args.string('disk')} isn’t a disk DinOS can go on`);
      const mode = (args.optString('mode') ?? 'oem') as InstallMode;
      if (mode === 'keep' && disk.existingInstall?.encrypted) {
        throw new CommandError('That DinOS is encrypted; reinstall it in the Installer, with its passphrase');
      }
      const ok = await ctx.confirm({
        title: mode === 'oem' ? 'Set up DinOS for someone else?' : 'Install DinOS?',
        description: `A command asked to ${MODE_ACTIONS[mode]} on ${disk.model || disk.path} (${formatDiskSize(disk.sizeBytes)}).${mode === 'wipe' || mode === 'oem' ? ' Everything on it is deleted.' : ''}`,
        action: mode === 'oem' ? 'Erase and set up' : 'Install',
        destructive: mode === 'wipe' || mode === 'oem',
      });
      if (!ok) throw new CommandError('You didn’t allow it');

      const finished = new Promise<InstallState>((resolve) => {
        const stop = bridge.onProgress((state) => {
          if (state.phase === 'done' || state.phase === 'failed') {
            stop();
            resolve(state);
          } else if (state.step) {
            ctx.progress?.(state.step === 'copy' ? { text: STEP_LABELS.copy, percent: state.percent } : { text: STEP_LABELS[state.step] });
          }
        });
      });
      await call(bridge.install(disk.path, mode, null));
      const state = await finished;
      if (state.phase === 'failed') throw new CommandError(state.error ?? 'The install didn’t finish');
      return {
        data: state,
        text: mode === 'oem'
          ? 'Done. Shut down (din power off) and remove the USB stick; it asks its new owner for a password when it starts.'
          : 'Done. Restart (din power restart) and remove the USB stick.',
      };
    }),
  ],
};
