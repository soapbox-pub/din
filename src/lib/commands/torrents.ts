import { getTorrentsBridge, isMagnetUrl, type Torrent, type TorrentSettings, type TorrentSource, type TorrentsBridge } from '@/lib/torrents';
import { activityLine, formatBytes, formatPercent, formatRate, formatRatio, progressLine, stateLabel } from '@/shared/torrentFormat';
import { resolvePath } from './parse';
import { CommandError, type Area, type CommandContext } from './types';
import { call, command, need, pick } from './util';

/**
 * `din torrents`: Torrents (electron/torrents.mts), BitTorrent transfers by
 * Din's own Transmission, as the Torrents app shows and changes them: the
 * same bridge, the same settings.
 */

const torrents = () => need(getTorrentsBridge(), 'Torrents');

/** Transmission running, or why it can't. */
async function ready(): Promise<TorrentsBridge> {
  const bridge = torrents();
  const status = await call(bridge.status());
  if (!status.available) throw new CommandError(status.reason ?? 'Torrents can’t run here');
  return bridge;
}

function describe(t: Torrent): string {
  const rates = t.state !== 'stopped' && (t.rateDown || t.rateUp) ? `↓ ${formatRate(t.rateDown)} ↑ ${formatRate(t.rateUp)}` : '';
  return [String(t.id), stateLabel(t), formatPercent(t.progress), t.name, rates].filter(Boolean).join('\t');
}

/** The transfers named by id, hash or name, or every one for “all”. */
async function targets(bridge: TorrentsBridge, names: string[]): Promise<Torrent[]> {
  if (names.length === 0) throw new CommandError('Name the transfers (by id, hash or name), or “all”', 'usage');
  const list = await call(bridge.list());
  if (names.length === 1 && names[0].toLowerCase() === 'all') return list;
  return names.map((name) => pick(list, name, (t) => [t.id, t.hash, t.name], 'transfer'));
}

const ids = (list: Torrent[]) => list.map((t) => t.id);

const SETTING_KEYS = [
  'download-dir',
  'start-when-added',
  'queue',
  'download-limit',
  'upload-limit',
  'turtle',
  'turtle-down',
  'turtle-up',
  'ratio',
  'encryption',
  'port-forwarding',
] as const;
type SettingKey = (typeof SETTING_KEYS)[number];

const onOff = (enabled: boolean, value: string) => (enabled ? value : 'off');

function settingsText(s: TorrentSettings): string {
  return [
    `download-dir\t${s.downloadDir}`,
    `start-when-added\t${s.startWhenAdded ? 'on' : 'off'}`,
    `queue\t${onOff(s.downloadQueue.enabled, String(s.downloadQueue.size))}`,
    `download-limit\t${onOff(s.downloadLimit.enabled, `${s.downloadLimit.kBps} KB/s`)}`,
    `upload-limit\t${onOff(s.uploadLimit.enabled, `${s.uploadLimit.kBps} KB/s`)}`,
    `turtle\t${s.altSpeed.enabled ? 'on' : 'off'}`,
    `turtle-down\t${s.altSpeed.downKBps} KB/s`,
    `turtle-up\t${s.altSpeed.upKBps} KB/s`,
    `ratio\t${onOff(s.seedRatio.enabled, String(s.seedRatio.ratio))}`,
    `encryption\t${s.encryption}`,
    `port-forwarding\t${s.portForwarding ? 'on' : 'off'}`,
    `peer-port\t${s.peerPort}`,
  ].join('\n');
}

function parseBool(value: string, key: string): boolean {
  if (/^(on|yes|true|1)$/i.test(value)) return true;
  if (/^(off|no|false|0)$/i.test(value)) return false;
  throw new CommandError(`${key} is on or off`, 'usage');
}

function parseNumber(value: string, key: string, min: number): number {
  const n = Number(value);
  if (!Number.isFinite(n) || n < min) throw new CommandError(`${key} is a number from ${min}, or off`, 'usage');
  return n;
}

/** A setting as `din torrents set` takes it, as the bridge's patch. */
function settingPatch(key: SettingKey, value: string, current: TorrentSettings, ctx: CommandContext): Parameters<TorrentsBridge['setSettings']>[0] {
  const off = /^(off|no|false)$/i.test(value);
  switch (key) {
    case 'download-dir':
      return { downloadDir: resolvePath(value, ctx.cwd) };
    case 'start-when-added':
      return { startWhenAdded: parseBool(value, key) };
    case 'queue':
      return off ? { downloadQueue: { ...current.downloadQueue, enabled: false } } : { downloadQueue: { enabled: true, size: Math.round(parseNumber(value, key, 1)) } };
    case 'download-limit':
      return off ? { downloadLimit: { ...current.downloadLimit, enabled: false } } : { downloadLimit: { enabled: true, kBps: Math.round(parseNumber(value, key, 1)) } };
    case 'upload-limit':
      return off ? { uploadLimit: { ...current.uploadLimit, enabled: false } } : { uploadLimit: { enabled: true, kBps: Math.round(parseNumber(value, key, 1)) } };
    case 'turtle':
      return { altSpeed: { ...current.altSpeed, enabled: parseBool(value, key) } };
    case 'turtle-down':
      return { altSpeed: { ...current.altSpeed, downKBps: Math.round(parseNumber(value, key, 1)) } };
    case 'turtle-up':
      return { altSpeed: { ...current.altSpeed, upKBps: Math.round(parseNumber(value, key, 1)) } };
    case 'ratio':
      return off ? { seedRatio: { ...current.seedRatio, enabled: false } } : { seedRatio: { enabled: true, ratio: parseNumber(value, key, 0.1) } };
    case 'encryption':
      if (value !== 'preferred' && value !== 'required' && value !== 'allowed') throw new CommandError('encryption is preferred, required or allowed', 'usage');
      return { encryption: value };
    case 'port-forwarding':
      return { portForwarding: parseBool(value, key) };
  }
}

const which = { name: 'transfers', type: 'string', positional: true, rest: true, help: 'Transfers by id, hash or name (from din torrents list), or “all”' } as const;

export const torrentsArea: Area = {
  name: 'torrents',
  summary: 'Torrents: download and share with BitTorrent, from torrent files and magnet links',
  commands: [
    command('torrents', 'list', 'The transfers: id, what each is doing, how far it’s got, its name and speeds', [], async () => {
      const bridge = await ready();
      const list = await call(bridge.list());
      return { data: list, text: list.length ? list.map(describe).join('\n') : 'No transfers' };
    }),
    command('torrents', 'show', 'Everything about a transfer: how it’s going, its files, peers and trackers', [
      { name: 'transfer', type: 'string', positional: true, help: 'By id, hash or name' },
    ], async (args) => {
      const bridge = await ready();
      const [t] = await targets(bridge, [args.string('transfer')]);
      const d = await call(bridge.detail(t.id));
      const lines = [
        d.torrent.name,
        `${stateLabel(d.torrent)}: ${progressLine(d.torrent)}`,
        activityLine(d.torrent),
        `In ${d.torrent.downloadDir}`,
        `Downloaded ${formatBytes(d.torrent.downloadedBytes)}, uploaded ${formatBytes(d.torrent.uploadedBytes)} (ratio ${formatRatio(d.torrent.ratio)})`,
        `Hash ${d.torrent.hash}`,
        d.files.length ? `Files:\n${d.files.map((f) => `  ${f.wanted ? '' : '(skipped) '}${f.path}\t${formatBytes(f.bytes)}\t${formatPercent(f.bytes ? f.doneBytes / f.bytes : 1)}`).join('\n')}` : '',
        d.trackers.length ? `Trackers:\n${d.trackers.map((tr) => `  ${tr.host}\t${tr.lastAnnounce ? (tr.lastAnnounce.ok ? `${tr.lastAnnounce.peers} peers` : tr.lastAnnounce.result) : 'not asked yet'}`).join('\n')}` : '',
      ];
      return { data: d, text: lines.filter(Boolean).join('\n') };
    }),
    command('torrents', 'add', 'Add a magnet link or a .torrent file, as the Add window does', [
      { name: 'source', type: 'string', positional: true, help: 'A magnet: link, or a .torrent file' },
      { name: 'to', type: 'path', optional: true, help: 'The folder to download into (else the one in settings)' },
      { name: 'paused', type: 'boolean', optional: true, help: 'Add it paused' },
    ], async (args, ctx) => {
      const bridge = await ready();
      const raw = args.string('source');
      const source: TorrentSource = isMagnetUrl(raw) ? { magnet: raw.trim() } : { path: resolvePath(raw, ctx.cwd) };
      const to = args.optString('to');
      const added = await call(bridge.add(source, { downloadDir: to ? resolvePath(to, ctx.cwd) : undefined, paused: args.optBool('paused') }));
      return { data: added, text: added.duplicate ? `${added.name} is already in Torrents (${added.id})` : `Added ${added.name} (${added.id})` };
    }),
    command('torrents', 'pause', 'Pause transfers', [which], async (args) => {
      const bridge = await ready();
      const list = await targets(bridge, args.list('transfers'));
      if (list.length) await call(bridge.stop(ids(list)));
      return { data: { paused: ids(list) }, text: list.length ? `Paused ${list.length === 1 ? list[0].name : `${list.length} transfers`}` : 'No transfers' };
    }),
    command('torrents', 'resume', 'Resume transfers', [
      which,
      { name: 'now', type: 'boolean', optional: true, help: 'Skip the queue' },
    ], async (args) => {
      const bridge = await ready();
      const list = await targets(bridge, args.list('transfers'));
      if (list.length) await call(bridge.start(ids(list), args.optBool('now') === true));
      return { data: { resumed: ids(list) }, text: list.length ? `Resumed ${list.length === 1 ? list[0].name : `${list.length} transfers`}` : 'No transfers' };
    }),
    command('torrents', 'verify', 'Check what transfers downloaded against their hashes', [which], async (args) => {
      const bridge = await ready();
      const list = await targets(bridge, args.list('transfers'));
      if (list.length) await call(bridge.verify(ids(list)));
      return { data: { verifying: ids(list) }, text: `Checking ${list.length === 1 ? list[0].name : `${list.length} transfers`}` };
    }),
    command('torrents', 'remove', 'Take transfers off the list; with --trash, what they downloaded goes to the Trash (asks on screen first)', [
      which,
      { name: 'trash', type: 'boolean', optional: true, help: 'Move what they downloaded to the Trash' },
    ], async (args, ctx) => {
      const bridge = await ready();
      const list = await targets(bridge, args.list('transfers'));
      if (list.length === 0) return { data: { removed: [] }, text: 'No transfers' };
      const trash = args.optBool('trash') === true;
      if (trash) {
        const what = list.length === 1 ? `“${list[0].name}”` : `${list.length} transfers`;
        const ok = await ctx.confirm({
          title: `Remove ${what} and move its data to the Trash?`,
          description: `A command asked to remove ${what} from Torrents and move what ${list.length === 1 ? 'it' : 'they'} downloaded to the Trash.`,
          action: 'Move to Trash',
          destructive: true,
        });
        if (!ok) throw new CommandError('You didn’t allow it');
      }
      await call(bridge.remove(ids(list), { trash }));
      return { data: { removed: ids(list), trash }, text: `Removed ${list.length === 1 ? list[0].name : `${list.length} transfers`}${trash ? ', and moved the data to the Trash' : ''}` };
    }),
    command('torrents', 'move', 'Move what transfers downloaded to another folder, where they go on', [
      { name: 'folder', type: 'path', positional: true, help: 'Where to' },
      which,
    ], async (args, ctx) => {
      const bridge = await ready();
      const list = await targets(bridge, args.list('transfers'));
      const folder = resolvePath(args.string('folder'), ctx.cwd);
      if (list.length) await call(bridge.setLocation(ids(list), folder, true));
      return { data: { moved: ids(list), folder }, text: `Moving ${list.length === 1 ? list[0].name : `${list.length} transfers`} to ${folder}` };
    }),
    command('torrents', 'turtle', 'Turtle speed: the slower limits from settings, on or off (toggles without one)', [
      { name: 'state', type: 'string', positional: true, optional: true, choices: ['on', 'off'], help: 'on or off' },
    ], async (args) => {
      const bridge = await ready();
      const { settings } = await call(bridge.status());
      if (!settings) throw new CommandError('Torrents isn’t running');
      const raw = args.optString('state');
      const enabled = raw ? raw === 'on' : !settings.altSpeed.enabled;
      const next = await call(bridge.setSettings({ altSpeed: { ...settings.altSpeed, enabled } }));
      return { data: next.altSpeed, text: `Turtle speed is ${enabled ? `on (↓ ${next.altSpeed.downKBps} KB/s, ↑ ${next.altSpeed.upKBps} KB/s)` : 'off'}` };
    }),
    command('torrents', 'settings', 'Torrents’ settings, as its Settings window has them', [], async () => {
      const bridge = await ready();
      const { settings } = await call(bridge.status());
      if (!settings) throw new CommandError('Torrents isn’t running');
      return { data: settings, text: settingsText(settings) };
    }),
    command('torrents', 'set', 'Change a setting: a speed limit or queue size (or off), a ratio (or off), on/off, encryption, or the download folder', [
      { name: 'key', type: 'string', positional: true, choices: SETTING_KEYS, help: 'Which setting (from din torrents settings)' },
      { name: 'value', type: 'string', positional: true, help: 'Its value: KB/s, a count, a ratio, on/off, preferred/required/allowed, or a folder' },
    ], async (args, ctx) => {
      const bridge = await ready();
      const { settings } = await call(bridge.status());
      if (!settings) throw new CommandError('Torrents isn’t running');
      const key = args.string('key') as SettingKey;
      const next = await call(bridge.setSettings(settingPatch(key, args.string('value'), settings, ctx)));
      return { data: next, text: settingsText(next).split('\n').find((line) => line.startsWith(`${key}\t`)) ?? 'Changed' };
    }),
  ],
};
