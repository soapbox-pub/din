import { getVmsBridge, type VmInfo, type VmInstallerId, type VmPointerAction, type VmPortForward } from '@/lib/vms';
import { CommandError, type Area, type Param } from './types';
import { call, command, need, pick } from './util';

/**
 * `din vms`: the Virtual Machines app's machines (electron/vms.mts), and
 * installing a system on a new one, as its gallery does; their settings and
 * snapshots, as their Settings window does; and seeing and driving one as a
 * person at its window would (its screen, keyboard and pointer), or over
 * SSH where Din set that up (`din vms ssh`, which the din client runs
 * itself, with the terminal: electron/din-cli.mts).
 */

const vms = () => need(getVmsBridge(), 'Virtual machines');
const SYSTEMS: readonly VmInstallerId[] = ['windows', 'macos', 'ubuntu', 'fedora'];
const MACHINE: Param = { name: 'machine', type: 'string', positional: true, help: 'The machine, by name' };
const X: Param = { name: 'x', type: 'integer', positional: true, min: 0, help: 'Pixels from the left of its screenshot' };
const Y: Param = { name: 'y', type: 'integer', positional: true, min: 0, help: 'Pixels from the top of its screenshot' };
const SNAPSHOT: Param = { name: 'name', type: 'string', positional: true, help: 'The snapshot, by name' };

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

/** An argument as a POSIX shell reads it back. */
function shellWord(word: string): string {
  return /^[\w@%+=:,./-]+$/.test(word) ? word : `'${word.replace(/'/g, `'\\''`)}'`;
}

const forwardText = (f: VmPortForward) => `127.0.0.1:${f.host} → its ${f.guest}${f.protocol === 'udp' ? '/udp' : ''}`;

async function act(query: string, action: VmPointerAction): Promise<void> {
  await call(vms().pointer((await machine(query)).id, action));
}

export const vmsArea: Area = {
  name: 'vms',
  summary: 'Virtual machines: install a system, start and stop, see and drive one (screen, keys, pointer, SSH)',
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
      'A new machine with a system on it, downloaded and set up by itself, signed in to its account (and on macOS, Ubuntu and Fedora, reachable with din vms ssh)',
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
        { name: 'memory', type: 'number', optional: true, min: 0.5, help: 'Its memory, in GiB' },
        { name: 'cpus', type: 'integer', optional: true, min: 1, max: 256, help: 'How many processors it has' },
        { name: 'gpu', type: 'string', optional: true, choices: ['on', 'off'], help: 'macOS: drawn on this computer’s GPU, or on QEMU’s display' },
      ],
      async (args) => {
        const vm = await machine(args.string('machine'));
        const gpu = args.optString('gpu');
        const memory = args.has('memory') ? Math.round(args.number('memory') * 1024) : undefined;
        const cpus = args.has('cpus') ? args.number('cpus') : undefined;
        if (gpu === undefined && memory === undefined && cpus === undefined) throw new CommandError('Say what to change: --memory, --cpus or --gpu');
        if (gpu !== undefined && vm.config.os !== 'macos') throw new CommandError('Graphics acceleration is for macOS machines');
        const saved = await call(
          vms().update(vm.id, {
            ...(gpu !== undefined ? { gpu: gpu === 'on' } : {}),
            ...(memory !== undefined ? { memoryMiB: memory } : {}),
            ...(cpus !== undefined ? { cpus } : {}),
          }),
        );
        const c = saved.config;
        const pending = saved.state !== 'stopped' ? ' (from its next start)' : '';
        const graphics = c.os === 'macos' ? `, drawn on ${c.gpu ? 'this computer’s GPU' : 'QEMU’s display'}` : '';
        return { data: saved, text: `${c.name}: ${c.memoryMiB / 1024} GiB, ${c.cpus} processors${graphics}${pending}` };
      },
    ),
    command(
      'vms',
      'forward',
      'Forward a port on this computer (127.0.0.1 alone) to one in the machine, from its next start',
      [
        MACHINE,
        { name: 'host', type: 'integer', positional: true, min: 1, max: 65535, help: 'The port on this computer' },
        { name: 'guest', type: 'integer', positional: true, optional: true, min: 1, max: 65535, help: 'The port in the machine (default: the same)' },
        { name: 'udp', type: 'boolean', optional: true, help: 'UDP instead of TCP' },
      ],
      async (args) => {
        const vm = await machine(args.string('machine'));
        const forward: VmPortForward = {
          protocol: args.optBool('udp') ? 'udp' : 'tcp',
          host: args.number('host'),
          guest: args.has('guest') ? args.number('guest') : args.number('host'),
        };
        const all = await call(vms().list());
        const taken = all.find((other) => other.config.forwards.some((f) => f.host === forward.host && f.protocol === forward.protocol));
        if (taken) throw new CommandError(`${taken.config.name} already forwards port ${forward.host}`);
        const saved = await call(vms().update(vm.id, { forwards: [...vm.config.forwards, forward] }));
        const pending = saved.state !== 'stopped' ? ', from its next start' : '';
        return { data: saved.config.forwards, text: `${forwardText(forward)}${pending}` };
      },
    ),
    command(
      'vms',
      'unforward',
      'Stop forwarding a port to the machine, from its next start',
      [MACHINE, { name: 'host', type: 'integer', positional: true, min: 1, max: 65535, help: 'The port on this computer' }],
      async (args) => {
        const vm = await machine(args.string('machine'));
        const host = args.number('host');
        const forwards = vm.config.forwards.filter((f) => f.host !== host);
        if (forwards.length === vm.config.forwards.length) throw new CommandError(`${vm.config.name} doesn’t forward port ${host}`);
        await call(vms().update(vm.id, { forwards }));
      },
    ),
    command('vms', 'snapshots', 'A machine’s snapshots', [MACHINE], async (args) => {
      const list = await call(vms().snapshots((await machine(args.string('machine'))).id));
      return {
        data: list,
        text: list.length
          ? list.map((s) => `${s.name}\t${new Date(s.date).toLocaleString()}\t${s.stateBytes ? 'running' : 'off'}`).join('\n')
          : 'No snapshots',
      };
    }),
    command(
      'vms',
      'snapshot',
      'Save a machine as it is now, running or off (a Mac on the GPU only while off)',
      [MACHINE, SNAPSHOT],
      async (args) => {
        await call(vms().takeSnapshot((await machine(args.string('machine'))).id, args.string('name')));
      },
    ),
    command('vms', 'restore', 'Take a machine back to a snapshot, losing what’s changed since', [MACHINE, SNAPSHOT], async (args, ctx) => {
      const vm = await machine(args.string('machine'));
      const name = args.string('name');
      const ok = await ctx.confirm({
        title: `Go back to “${name}”?`,
        description: `What’s changed on “${vm.config.name}” since it was taken is lost.`,
        action: 'Go Back',
        destructive: true,
      });
      if (!ok) throw new CommandError('You didn’t allow it');
      await call(vms().restoreSnapshot(vm.id, name));
    }),
    command('vms', 'delete-snapshot', 'Delete one of a machine’s snapshots', [MACHINE, SNAPSHOT], async (args, ctx) => {
      const vm = await machine(args.string('machine'));
      const name = args.string('name');
      const ok = await ctx.confirm({
        title: `Delete the snapshot “${name}”?`,
        description: `“${vm.config.name}” can’t go back to it afterwards.`,
        action: 'Delete',
        destructive: true,
      });
      if (!ok) throw new CommandError('You didn’t allow it');
      await call(vms().deleteSnapshot(vm.id, name));
    }),
    command('vms', 'remove', 'Move a machine, its disk and snapshots to the Trash; it has to be off', [MACHINE], async (args, ctx) => {
      const vm = await machine(args.string('machine'));
      const ok = await ctx.confirm({
        title: `Move “${vm.config.name}” to the Trash?`,
        description: 'Its disk, its snapshots and everything on it go with it.',
        action: 'Move to Trash',
        destructive: true,
      });
      if (!ok) throw new CommandError('You didn’t allow it');
      await call(vms().remove(vm.id));
    }),
    command(
      'vms',
      'shot',
      'Save a running machine’s screen as a PNG, and print where; its pixels are the points click, drag and scroll take',
      [MACHINE, { name: 'file', type: 'path', positional: true, optional: true, help: 'Where to save it (default: a file for the machine in the temporary folder)' }],
      async (args) => {
        const shot = await call(vms().screenshot((await machine(args.string('machine'))).id, args.optString('file')));
        return { data: shot, text: `${shot.path}\t${shot.width}×${shot.height}` };
      },
    ),
    command(
      'vms',
      'key',
      'Press keys on a running machine, a combination at a time: cmd+space, ctrl+alt+delete, return, esc, tab, f5, up, shift+tab (cmd is the Windows key on a PC; backspace is a Mac’s delete)',
      [MACHINE, { name: 'keys', type: 'string', positional: true, rest: true, help: 'The combinations, in turn' }],
      async (args) => {
        const keys = args.list('keys');
        if (keys.length === 0) throw new CommandError('Say which keys to press', 'usage');
        await call(vms().pressKeys((await machine(args.string('machine'))).id, keys));
      },
    ),
    command(
      'vms',
      'type',
      'Type text into a running machine, on its US keyboard (ASCII alone; \\n is return)',
      [MACHINE, { name: 'text', type: 'string', positional: true, rest: true, help: 'What to type (words are joined with spaces)' }],
      async (args) => {
        const text = args.list('text').join(' ').replace(/\\n/g, '\n').replace(/\\t/g, '\t');
        if (!text) throw new CommandError('Say what to type', 'usage');
        await call(vms().typeText((await machine(args.string('machine'))).id, text));
      },
    ),
    command(
      'vms',
      'click',
      'Click at a point of a running machine’s screen',
      [
        MACHINE, X, Y,
        { name: 'button', type: 'string', optional: true, choices: ['left', 'right', 'middle'], help: 'Which button (default: left)' },
        { name: 'double', type: 'boolean', optional: true, help: 'A double click' },
      ],
      async (args) => {
        await act(args.string('machine'), {
          kind: 'click',
          x: args.number('x'),
          y: args.number('y'),
          button: (args.optString('button') ?? 'left') as VmPointerAction['button'],
          count: args.optBool('double') ? 2 : 1,
        });
      },
    ),
    command('vms', 'move', 'Move a running machine’s pointer to a point, as hovering does', [MACHINE, X, Y], async (args) => {
      await act(args.string('machine'), { kind: 'move', x: args.number('x'), y: args.number('y') });
    }),
    command(
      'vms',
      'drag',
      'Drag with a running machine’s pointer, from one point to another',
      [
        MACHINE, X, Y,
        { name: 'to-x', type: 'integer', positional: true, min: 0, help: 'Where to let go, from the left' },
        { name: 'to-y', type: 'integer', positional: true, min: 0, help: 'Where to let go, from the top' },
      ],
      async (args) => {
        await act(args.string('machine'), { kind: 'drag', x: args.number('x'), y: args.number('y'), toX: args.number('to-x'), toY: args.number('to-y') });
      },
    ),
    command(
      'vms',
      'scroll',
      'Scroll a running machine’s screen at a point',
      [MACHINE, X, Y, { name: 'amount', type: 'integer', positional: true, min: -100, max: 100, help: 'Notches of the wheel: down when positive, up when negative' }],
      async (args) => {
        await act(args.string('machine'), { kind: 'scroll', x: args.number('x'), y: args.number('y'), amount: args.number('amount') });
      },
    ),
    command(
      'vms',
      'ssh',
      'Sign in to a running machine over SSH with Din’s key for it, or run a command there (after --); from a terminal it runs ssh, elsewhere it gives the command line',
      [MACHINE, { name: 'command', type: 'string', positional: true, rest: true, help: 'What to run there (after --), instead of a shell' }],
      async (args) => {
        const ssh = await call(vms().ssh((await machine(args.string('machine'))).id));
        const remote = args.list('command');
        const argv = remote.length ? [...ssh.argv, '--', ...remote] : ssh.argv;
        return { data: { ...ssh, argv }, text: argv.map(shellWord).join(' ') };
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
