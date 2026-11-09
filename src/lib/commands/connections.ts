import { getWifiBridge, signalLabel, bandLabel } from '@/lib/wifi';
import { getBluetoothBridge, describeDevice, deviceKind, sortDevices, type BluetoothDevice } from '@/lib/bluetooth';
import { getVpnBridge } from '@/lib/vpn';
import { getTorBridge, torState } from '@/lib/tor';
import { CommandError, type Area, type Param } from './types';
import { call, command, need, pick } from './util';

/** `din wifi`, `din bluetooth`, `din vpn`, `din tor`: what Settings → Wi-Fi and Bluetooth and the menu bar's network menus do. */

const wifi = () => need(getWifiBridge(), 'Wi-Fi');
const bluetooth = () => need(getBluetoothBridge(), 'Bluetooth');
const ON: Param = { name: 'on', type: 'boolean', positional: true, help: 'on or off' };

async function savedNetwork(query: string) {
  const saved = await call(wifi().saved());
  return pick(saved, query, (n) => [n.uuid, n.ssid, n.name], 'saved network');
}

export const wifiArea: Area = {
  name: 'wifi',
  summary: 'Wi-Fi networks: scan, join, forget, turn the radio on or off',
  commands: [
    command('wifi', 'status', 'The adapter, and the network it’s on', [], async () => {
      const status = await call(wifi().status());
      return {
        data: status,
        text: !status.available
          ? 'Wi-Fi isn’t available'
          : [
              `radio: ${status.radioEnabled ? 'on' : 'off'}`,
              `wifi: ${status.device ? `${status.device.iface}, ${status.device.connection ?? status.device.state}` : 'no adapter'}`,
              status.ethernet ? `ethernet: ${status.ethernet.iface}, ${status.ethernet.connection ?? status.ethernet.state}` : '',
            ].filter(Boolean).join('\n'),
      };
    }),
    command('wifi', 'list', 'Networks in range', [
      { name: 'rescan', type: 'boolean', optional: true, help: 'Scan afresh first' },
    ], async (args) => {
      const networks = await call(wifi().networks(args.optBool('rescan') ?? false));
      return {
        data: networks,
        text: networks.length === 0 ? '(none)' : networks
          .map((n) => `${n.inUse ? '*' : ' '} ${n.ssid}  ${n.signal}% ${signalLabel(n.signal)}, ${bandLabel(n.freqMhz)}${n.security ? `, ${n.security}` : ', open'}`)
          .join('\n'),
      };
    }),
    command('wifi', 'saved', 'Networks this computer remembers', [], async () => {
      const saved = await call(wifi().saved());
      return { data: saved.map(({ uuid, ssid, name, active, autoconnect, hidden, security }) => ({ ssid, name, active, autoconnect, hidden, security, uuid })) };
    }),
    command('wifi', 'connect', 'Join a network (a saved one by its name, or a new one)', [
      { name: 'ssid', type: 'string', positional: true, help: 'The network’s name, or a saved network’s id' },
      { name: 'password', type: 'string', optional: true, help: 'Its password, if it needs one and isn’t saved' },
    ], async (args) => {
      const query = args.string('ssid');
      const password = args.optString('password');
      const saved = await call(wifi().saved());
      const known = saved.find((n) => n.uuid === query || (!password && n.ssid === query));
      if (known) await call(wifi().activate(known.uuid));
      else await call(wifi().connect(query, password));
      return { text: `Joined ${known?.ssid ?? query}` };
    }),
    command('wifi', 'disconnect', 'Leave the current network', [], async () => {
      await call(wifi().disconnect());
    }),
    command('wifi', 'forget', 'Forget a saved network', [
      { name: 'network', type: 'string', positional: true, help: 'Its name or id' },
    ], async (args) => {
      const network = await savedNetwork(args.string('network'));
      await call(wifi().forget(network.uuid));
      return { text: `Forgot ${network.ssid}` };
    }),
    command('wifi', 'autoconnect', 'Whether a saved network is joined by itself', [
      { name: 'network', type: 'string', positional: true, help: 'Its name or id' },
      ON,
    ], async (args) => {
      const network = await savedNetwork(args.string('network'));
      await call(wifi().update(network.uuid, { autoconnect: args.bool('on') }));
    }),
    command('wifi', 'radio', 'Turn Wi-Fi on or off', [ON], async (args) => {
      await call(wifi().setRadio(args.bool('on')));
    }),
  ],
};

async function device(query: string): Promise<BluetoothDevice> {
  const state = await call(bluetooth().state());
  return pick(state.devices, query, (d) => [d.address, d.name, d.path], 'Bluetooth device');
}

export const bluetoothArea: Area = {
  name: 'bluetooth',
  summary: 'Bluetooth devices: pair, connect, forget, turn it on or off',
  commands: [
    command('bluetooth', 'list', 'Devices paired and nearby', [], async () => {
      const state = await call(bluetooth().state());
      if (!state.available) return { data: null, text: 'Bluetooth isn’t available' };
      const devices = sortDevices(state.devices).map((d) => ({
        name: d.name, address: d.address, paired: d.paired, connected: d.connected, battery: d.battery, type: deviceKind(d), status: describeDevice(d),
      }));
      return { data: { adapter: state.adapter, devices }, text: [`powered: ${state.adapter?.powered ? 'on' : 'off'}${state.adapter?.discovering ? ', looking for devices' : ''}`, '', ...devices.map((d) => `${d.connected ? '*' : ' '} ${d.name}  ${d.address}  ${d.status}`)].join('\n') };
    }),
    command('bluetooth', 'power', 'Turn Bluetooth on or off', [ON], async (args) => {
      await call(bluetooth().setPowered(args.bool('on')));
    }),
    command('bluetooth', 'scan', 'Look for devices nearby (or stop looking)', [
      { name: 'on', type: 'boolean', positional: true, optional: true, help: 'off stops looking (default: on)' },
    ], async (args) => {
      await call(bluetooth().discover(args.optBool('on') ?? true));
    }),
    command('bluetooth', 'pair', 'Pair with a device, then connect to it (a code to confirm shows on screen)', [
      { name: 'device', type: 'string', positional: true, help: 'Its name or address' },
    ], async (args) => {
      const d = await device(args.string('device'));
      await call(bluetooth().pair(d.path));
      return { text: `Paired with ${d.name}` };
    }),
    command('bluetooth', 'connect', 'Connect a paired device', [
      { name: 'device', type: 'string', positional: true, help: 'Its name or address' },
    ], async (args) => {
      const d = await device(args.string('device'));
      await call(bluetooth().connect(d.path));
    }),
    command('bluetooth', 'disconnect', 'Disconnect a device', [
      { name: 'device', type: 'string', positional: true, help: 'Its name or address' },
    ], async (args) => {
      const d = await device(args.string('device'));
      await call(bluetooth().disconnect(d.path));
    }),
    command('bluetooth', 'forget', 'Remove a device and its pairing', [
      { name: 'device', type: 'string', positional: true, help: 'Its name or address' },
    ], async (args) => {
      const d = await device(args.string('device'));
      await call(bluetooth().forget(d.path));
    }),
  ],
};

export const vpnArea: Area = {
  name: 'vpn',
  summary: 'VPN and WireGuard connections',
  commands: [
    command('vpn', 'list', 'Saved VPN connections', [], async () => ({
      data: await call(need(getVpnBridge(), 'VPN').list()),
    })),
    command('vpn', 'connect', 'Bring a VPN up', [
      { name: 'name', type: 'string', positional: true, help: 'The connection’s name' },
    ], async (args) => {
      await call(need(getVpnBridge(), 'VPN').connect(args.string('name')));
    }),
    command('vpn', 'disconnect', 'Bring a VPN down', [
      { name: 'name', type: 'string', positional: true, help: 'The connection’s name' },
    ], async (args) => {
      await call(need(getVpnBridge(), 'VPN').disconnect(args.string('name')));
    }),
  ],
};

export const torArea: Area = {
  name: 'tor',
  summary: 'Tor, for .onion sites',
  commands: [
    command('tor', 'status', 'Whether Tor is on and connected', [], async () => {
      const status = await call(need(getTorBridge(), 'Tor').status());
      return { data: { ...status, state: torState(status) }, text: `${torState(status)}${status.summary ? ` (${status.summary})` : ''}` };
    }),
    command('tor', 'enable', 'Turn Tor on or off', [ON], async (args) => {
      const status = await call(need(getTorBridge(), 'Tor').setEnabled(args.bool('on')));
      return { data: status, text: torState(status) };
    }),
    command('tor', 'setup', 'Set up a Tor of Din’s own where the system has none, as Settings → Wi-Fi’s Set Up Tor does (asking on screen first)', [], async (_args, ctx) => {
      const bridge = need(getTorBridge(), 'Tor');
      const current = await call(bridge.status());
      if (!current.canInstall) throw new CommandError('Din can’t set up Tor here: DinOS has its own, or this computer isn’t one the Tor Project builds for');
      if (!current.installed) {
        const ok = await ctx.confirm({
          title: 'Set up Tor?',
          description: 'Din downloads Tor from the Tor Project into ~/.local/share/din/tor, runs it for onion sites while it’s on, and keeps it up to date.',
          action: 'Set Up',
        });
        if (!ok) throw new CommandError('You didn’t allow it');
        ctx.progress?.({ text: 'Downloading Tor' });
      }
      const status = await call(bridge.install());
      return { data: status, text: `Tor ${status.installed ?? ''}: ${torState(status)}` };
    }),
  ],
};
