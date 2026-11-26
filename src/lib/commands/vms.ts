import { getVmsBridge, type VmInfo, type VmInstallerId } from '@/lib/vms';
import { CommandError, type Area, type Param } from './types';
import { call, command, need, pick } from './util';

/**
 * `din vms`: the Virtual Machines app's machines (electron/vms.mts), and
 * installing a system on a new one, as its gallery does.
 */

const vms = () => need(getVmsBridge(), 'Virtual machines');
const SYSTEMS: readonly VmInstallerId[] = ['windows', 'macos', 'ubuntu', 'fedora'];
const MACHINE: Param = { name: 'machine', type: 'string', positional: true, help: 'The machine, by name' };

async function machine(query: string): Promise<VmInfo> {
  return pick(await call(vms().list()), query, (vm) => [vm.id, vm.config.name], 'machine');
}

function describe(vm: VmInfo): string {
  const install = vm.install;
  if (!install) return vm.state;
  if (install.phase === 'downloading' && install.totalBytes) return `downloading ${Math.round((install.receivedBytes / install.totalBytes) * 100)}%`;
  if (install.phase === 'installing') return `installing ${Math.round(install.progress * 100)}%`;
  if (install.phase === 'failed') return `couldn’t install: ${install.error ?? ''}`;
  return install.phase;
}

export const vmsArea: Area = {
  name: 'vms',
  summary: 'Virtual machines: list, install a system, start and stop',
  commands: [
    command('vms', 'list', 'The machines, and what each is doing', [], async () => {
      const list = await call(vms().list());
      return {
        data: list,
        text: list.length ? list.map((vm) => `${vm.config.name}\t${describe(vm)}`).join('\n') : 'No virtual machines',
      };
    }),
    command(
      'vms',
      'install',
      'A new machine with a system on it, downloaded and set up by itself',
      [
        { name: 'system', type: 'string', positional: true, choices: SYSTEMS, help: 'What to install' },
        { name: 'iso', type: 'path', optional: true, help: 'Install from this disc image instead of downloading' },
        { name: 'name', type: 'string', optional: true, help: 'The machine’s name' },
      ],
      async (args) => {
        const vm = await call(
          vms().install(args.string('system') as VmInstallerId, { iso: args.optString('iso'), name: args.optString('name') }),
        );
        return { data: vm, text: `Installing on “${vm.config.name}”; din vms list shows how far along it is` };
      },
    ),
    command('vms', 'start', 'Turn a machine on', [MACHINE], async (args) => {
      await call(vms().start((await machine(args.string('machine'))).id));
    }),
    command(
      'vms',
      'stop',
      'Shut a machine down, as its power button does',
      [MACHINE, { name: 'force', type: 'boolean', optional: true, help: 'Pull the plug instead' }],
      async (args) => {
        const vm = await machine(args.string('machine'));
        await call(args.optBool('force') ? vms().forceStop(vm.id) : vms().shutdown(vm.id));
      },
    ),
    command(
      'vms',
      'set',
      'Change a machine’s settings, as its Settings window does; hardware changes take effect when it next starts',
      [
        MACHINE,
        { name: 'gpu', type: 'string', optional: true, choices: ['on', 'off'], help: 'macOS: drawn on this computer’s GPU, or on QEMU’s display' },
      ],
      async (args) => {
        const vm = await machine(args.string('machine'));
        const gpu = args.optString('gpu');
        if (gpu === undefined) throw new CommandError('Say what to change: --gpu on or off');
        if (vm.config.os !== 'macos') throw new CommandError('Graphics acceleration is for macOS machines');
        const saved = await call(vms().update(vm.id, { gpu: gpu === 'on' }));
        const pending = saved.state !== 'stopped' ? ', from its next start' : '';
        return { data: saved, text: `${saved.config.name} is drawn on ${saved.config.gpu ? 'this computer’s GPU' : 'QEMU’s display'}${pending}` };
      },
    ),
    command('vms', 'cancel-install', 'Stop installing a machine’s system and throw the machine away', [MACHINE], async (args, ctx) => {
      const vm = await machine(args.string('machine'));
      const ok = await ctx.confirm({
        title: `Stop installing “${vm.config.name}”?`,
        description: 'The machine is thrown away. Nothing’s on it yet.',
        action: 'Stop and Throw Away',
        destructive: true,
      });
      if (!ok) throw new CommandError('You didn’t allow it');
      await call(vms().cancelInstall(vm.id));
    }),
  ],
};
