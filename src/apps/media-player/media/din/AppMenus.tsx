import type { Menu, MenuItem } from '@/sdk';
import { useMenuBar } from '@/sdk/react';
import { player, usePlayer } from '../engine';
import { setPrefs, setWinampPrefs, TABS, usePrefs, type DinTab } from '../prefs';
import { VISUALIZATIONS } from '../visualizations';
import { BUILTIN_WMP_SKINS } from '../wmp/builtin';
import type { Commands } from '../useCommands';

/** WMP's View > Choose Color, as a handful of hues (null: Din's theme). */
const COLORS: [string, number | null][] = [
  ['Match Din', null], ['Blue', 212], ['Teal', 185], ['Emerald', 150], ['Olive', 90], ['Amber', 38], ['Crimson', 352], ['Orchid', 300], ['Violet', 262],
];

const SEPARATOR: MenuItem = { type: 'separator' };

/**
 * File, View and Play, in Din's menu bar while the player is focused, in
 * every skin: so a skin that hides its own menus (or breaks) never leaves
 * the player without a way back.
 */
export function AppMenus({ commands }: { commands: Commands }) {
  const prefs = usePrefs((p) => p);
  const shuffle = usePlayer((s) => s.shuffle);
  const repeat = usePlayer((s) => s.repeat);
  const muted = usePlayer((s) => s.muted);
  const playing = usePlayer((s) => s.status === 'playing');
  const din = prefs.skin.kind === 'din';

  const menus: Menu[] = [
    {
      label: 'File',
      items: [
        { id: 'open', label: 'Open…', accelerator: 'Ctrl+O' },
        { id: 'open-url', label: 'Open URL…', accelerator: 'Ctrl+U' },
        { id: 'add-files', label: 'Add Files to Now Playing…' },
        { id: 'add-folder', label: 'Add Folder to Now Playing…' },
        SEPARATOR,
        { id: 'save-playlist', label: 'Save Now Playing List As…' },
        { id: 'add-library-folder', label: 'Add Folder to Library…' },
        SEPARATOR,
        { id: 'close', label: 'Close', accelerator: 'Ctrl+W' },
      ],
    },
    {
      label: 'View',
      items: [
        ...TABS.map((t): MenuItem => ({ id: `tab:${t.id}`, label: t.label, type: 'radio', group: 'tab', checked: din && !prefs.mini && prefs.tab === t.id })),
        SEPARATOR,
        { id: 'mini', label: 'Mini Player', type: 'checkbox', checked: din && prefs.mini },
        ...(din && !prefs.mini
          ? [
            { id: 'list-pane', label: 'List Pane', type: 'checkbox', checked: prefs.showList },
            { id: 'enhancements', label: 'Enhancements', type: 'checkbox', checked: prefs.showEnhancements },
            { id: 'lyrics', label: 'Lyrics', type: 'checkbox', checked: prefs.lyrics },
          ] satisfies MenuItem[]
          : []),
        {
          id: 'visualizations',
          label: 'Visualizations',
          type: 'submenu',
          items: [
            { id: 'vis:art', label: 'Album Art', type: 'radio', group: 'vis', checked: prefs.vis === 'art' },
            ...VISUALIZATIONS.map((v): MenuItem => ({ id: `vis:${v.id}`, label: `${v.group}: ${v.name}`, type: 'radio', group: 'vis', checked: prefs.vis === v.id })),
          ],
        },
        {
          id: 'color',
          label: 'Choose Color',
          type: 'submenu',
          items: COLORS.map(([name, hue]): MenuItem => ({ id: `hue:${hue}`, label: name, type: 'radio', group: 'hue', checked: prefs.hue === hue })),
        },
        SEPARATOR,
        {
          id: 'skin',
          label: 'Skin',
          type: 'submenu',
          items: [
            { id: 'skin:din', label: 'Din’s Own Skin', accelerator: 'Ctrl+1' },
            { id: 'skin:classic', label: 'Din Classic' },
            ...BUILTIN_WMP_SKINS.map((s): MenuItem => ({ id: `skin:wmp:${s.id}`, label: s.name })),
            { id: 'skin:chooser', label: 'Skin Chooser…' },
            { id: 'skin:file', label: 'Apply a Skin File…' },
            ...(prefs.skin.kind === 'winamp'
              ? [
                SEPARATOR,
                { id: 'winamp:eq', label: 'Equalizer', type: 'checkbox', checked: prefs.winamp.eq },
                { id: 'winamp:playlist', label: 'Playlist Editor', type: 'checkbox', checked: prefs.winamp.playlist },
                { id: 'winamp:double', label: 'Double Size', type: 'checkbox', checked: prefs.winamp.double },
              ] satisfies MenuItem[]
              : []),
          ],
        },
      ],
    },
    {
      label: 'Play',
      items: [
        { id: 'toggle', label: playing ? 'Pause' : 'Play', accelerator: 'Ctrl+P' },
        { id: 'stop', label: 'Stop', accelerator: 'Ctrl+S' },
        { id: 'previous', label: 'Previous', accelerator: 'Ctrl+B' },
        { id: 'next', label: 'Next', accelerator: 'Ctrl+F' },
        { id: 'rewind', label: 'Rewind', accelerator: 'Ctrl+Shift+B' },
        { id: 'fast-forward', label: 'Fast Forward', accelerator: 'Ctrl+Shift+F' },
        SEPARATOR,
        { id: 'shuffle', label: 'Shuffle', type: 'checkbox', checked: shuffle, accelerator: 'Ctrl+H' },
        {
          id: 'repeat',
          label: 'Repeat',
          type: 'submenu',
          items: [
            { id: 'repeat:off', label: 'Off', type: 'radio', group: 'repeat', checked: repeat === 'off' },
            { id: 'repeat:all', label: 'Repeat All', type: 'radio', group: 'repeat', checked: repeat === 'all' },
            { id: 'repeat:one', label: 'Repeat One', type: 'radio', group: 'repeat', checked: repeat === 'one' },
          ],
        },
        SEPARATOR,
        { id: 'volume-up', label: 'Volume Up', accelerator: 'F9' },
        { id: 'volume-down', label: 'Volume Down', accelerator: 'F8' },
        { id: 'mute', label: 'Mute', type: 'checkbox', checked: muted, accelerator: 'F7' },
      ],
    },
  ];

  // As before it moved, the player's keys are left to a focused text field
  // (the library's search, Open URL).
  useMenuBar(menus.map((m) => ({ ...m, items: leaveFields(m.items) })), (id) => {
    const [head, ...rest] = id.split(':');
    const arg = rest.join(':');
    const p = prefs;
    switch (head) {
      case 'open': return void commands.openFiles('play');
      case 'open-url': return void commands.openUrl();
      case 'add-files': return void commands.openFiles('enqueue');
      case 'add-folder': return void commands.openFolder('enqueue');
      case 'save-playlist': return void commands.savePlaylist();
      case 'add-library-folder': return void commands.addLibraryFolder();
      case 'close': return commands.close();
      case 'tab': return setPrefs({ tab: arg as DinTab, mini: false, skin: { kind: 'din' } });
      case 'mini': return setPrefs({ mini: !(din && p.mini), skin: { kind: 'din' } });
      case 'list-pane': return setPrefs({ showList: !p.showList });
      case 'enhancements': return setPrefs({ showEnhancements: !p.showEnhancements });
      case 'lyrics': return setPrefs({ lyrics: !p.lyrics });
      case 'vis': return setPrefs({ vis: arg });
      case 'hue': return setPrefs({ hue: arg === 'null' ? null : Number(arg) });
      case 'skin': {
        if (arg === 'din') return setPrefs({ skin: { kind: 'din' } });
        if (arg === 'classic') return setPrefs({ skin: { kind: 'winamp', path: '' } });
        if (arg === 'chooser') return setPrefs({ skin: { kind: 'din' }, tab: 'skins', mini: false });
        if (arg === 'file') return void commands.loadSkin();
        const wmp = BUILTIN_WMP_SKINS.find((s) => `wmp:${s.id}` === arg);
        if (wmp) setPrefs({ skin: { kind: 'wmp', path: wmp.path } });
        return;
      }
      case 'winamp':
        if (arg === 'eq') setWinampPrefs({ eq: !p.winamp.eq });
        else if (arg === 'playlist') setWinampPrefs({ playlist: !p.winamp.playlist });
        else if (arg === 'double') setWinampPrefs({ double: !p.winamp.double });
        return;
      case 'toggle': return player.toggle();
      case 'stop': return player.stop();
      case 'previous': return player.previous();
      case 'next': return player.next();
      case 'rewind': return player.rewind();
      case 'fast-forward': return player.fastForward();
      case 'shuffle': return player.setShuffle(!shuffle);
      case 'repeat': return player.setRepeat(arg as 'off' | 'all' | 'one');
      case 'volume-up': return player.setVolume(player.getState().volume + 0.05);
      case 'volume-down': return player.setVolume(player.getState().volume - 0.05);
      case 'mute': return player.setMuted(!muted);
    }
  });
  return null;
}

function leaveFields(items: MenuItem[]): MenuItem[] {
  return items.map((item) => {
    if (item.type === 'separator' || item.type === 'label') return item;
    if (item.type === 'submenu') return { ...item, items: leaveFields(item.items) };
    return item.accelerator ? { ...item, notInFields: true } : item;
  });
}
