import {
  describeRule,
  FIREWALL_PROTOCOLS,
  getFirewallBridge,
  parsePorts,
  type FirewallProtocol,
  type FirewallRuleKey,
} from '@/lib/firewall';
import { CommandError, type Area, type Args, type Param } from './types';
import { call, command, need } from './util';

/** `din firewall`: what Settings → Firewall does. */

const firewall = () => need(getFirewallBridge(), 'The firewall');

const PORTS: Param = { name: 'ports', type: 'string', positional: true, help: 'A port, like 25565, or a range, like 27000-27015' };
const PROTOCOL: Param = { name: 'protocol', type: 'string', optional: true, choices: FIREWALL_PROTOCOLS, help: 'tcp (the default), udp, or both' };

function ruleKey(args: Args): FirewallRuleKey {
  const range = parsePorts(args.string('ports'));
  if ('error' in range) throw new CommandError(range.error, 'usage');
  return { protocol: (args.optString('protocol') ?? 'tcp') as FirewallProtocol, ...range };
}

export const firewallArea: Area = {
  name: 'firewall',
  summary: 'The ports other devices may connect to (DinOS)',
  commands: [
    command('firewall', 'status', 'Whether the firewall is on, and the ports let in', [], async () => {
      const status = await call(firewall().status());
      return {
        data: status,
        text: [
          !status.canChange ? 'Din doesn’t manage this computer’s firewall' : status.active === false ? 'firewall: off' : 'firewall: on',
          ...status.rules.map((r) => `${describeRule(r)}${r.name ? `  ${r.name}` : ''}`),
        ].join('\n'),
      };
    }),
    command('firewall', 'allow', 'Let other devices connect to a port, as Settings’ Allow does (asks on screen first)', [
      PORTS,
      PROTOCOL,
      { name: 'name', type: 'string', optional: true, help: 'What it’s for, like “Minecraft server”' },
    ], async (args, ctx) => {
      const key = ruleKey(args);
      const name = args.optString('name')?.trim() ?? '';
      const what = describeRule(key);
      const ok = await ctx.confirm({
        title: `Let other devices connect to ${what}?`,
        description: `${name ? `For ${name}. ` : ''}Anything on your network, or on the internet if this computer is reachable from it, can then reach whatever listens on it.`,
        action: 'Allow',
      });
      if (!ok) throw new CommandError('You didn’t allow it');
      const status = await call(firewall().allow({ ...key, name }));
      return { data: status, text: `${what} is let in` };
    }),
    command('firewall', 'remove', 'Stop letting other devices connect to a port', [PORTS, PROTOCOL], async (args) => {
      const key = ruleKey(args);
      const status = await call(firewall().status());
      if (!status.rules.some((r) => r.protocol === key.protocol && r.from === key.from && r.to === key.to)) {
        throw new CommandError(`${describeRule(key)} isn’t one of the ports let in; din firewall status lists them`);
      }
      return { data: await call(firewall().remove(key)), text: `${describeRule(key)} is shut` };
    }),
  ],
};
