import {
  DropdownMenu, DropdownMenuCheckboxItem, DropdownMenuContent, DropdownMenuItem, DropdownMenuRadioGroup, DropdownMenuRadioItem, DropdownMenuSeparator,
  DropdownMenuShortcut, DropdownMenuSub, DropdownMenuSubContent, DropdownMenuSubTrigger, DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { MenuBarMenus } from '@/components/desktop/MenuBarMenus';
import { MENU_BAR_TRIGGER_CLASS } from '@/lib/menuBarSlot';
import { player, usePlayer } from '../engine';
import { setPrefs, setWinampPrefs, TABS, usePrefs, type DinTab } from '../prefs';
import { VISUALIZATIONS } from '../visualizations';
import type { Commands } from '../useCommands';

/** WMP's View > Choose Color, as a handful of hues (null: Din's theme). */
const COLORS: [string, number | null][] = [
  ['Match Din', null], ['Blue', 212], ['Teal', 185], ['Emerald', 150], ['Olive', 90], ['Amber', 38], ['Crimson', 352], ['Orchid', 300], ['Violet', 262],
];

function Menu({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger className={MENU_BAR_TRIGGER_CLASS}>{label}</DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="w-60">
        {children}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

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
  return (
    <MenuBarMenus>
      <Menu label="File">
        <DropdownMenuItem onSelect={() => void commands.openFiles('play')}>Open…<DropdownMenuShortcut>Ctrl+O</DropdownMenuShortcut></DropdownMenuItem>
        <DropdownMenuItem onSelect={() => void commands.openUrl()}>Open URL…<DropdownMenuShortcut>Ctrl+U</DropdownMenuShortcut></DropdownMenuItem>
        <DropdownMenuItem onSelect={() => void commands.openFiles('enqueue')}>Add Files to Now Playing…</DropdownMenuItem>
        <DropdownMenuItem onSelect={() => void commands.openFolder('enqueue')}>Add Folder to Now Playing…</DropdownMenuItem>
        <DropdownMenuSeparator />
        <DropdownMenuItem onSelect={() => void commands.savePlaylist()}>Save Now Playing List As…</DropdownMenuItem>
        <DropdownMenuItem onSelect={() => void commands.addLibraryFolder()}>Add Folder to Library…</DropdownMenuItem>
        <DropdownMenuSeparator />
        <DropdownMenuItem onSelect={commands.close}>Close<DropdownMenuShortcut>Ctrl+W</DropdownMenuShortcut></DropdownMenuItem>
      </Menu>
      <Menu label="View">
        <DropdownMenuRadioGroup
          value={din && !prefs.mini ? prefs.tab : ''}
          onValueChange={(tab) => setPrefs({ tab: tab as DinTab, mini: false, skin: { kind: 'din' } })}
        >
          {TABS.map((t) => (
            <DropdownMenuRadioItem key={t.id} value={t.id}>{t.label}</DropdownMenuRadioItem>
          ))}
        </DropdownMenuRadioGroup>
        <DropdownMenuSeparator />
        <DropdownMenuCheckboxItem checked={din && prefs.mini} onCheckedChange={(v) => setPrefs({ mini: v, skin: { kind: 'din' } })}>
          Mini Player
        </DropdownMenuCheckboxItem>
        {din && !prefs.mini && (
          <>
            <DropdownMenuCheckboxItem checked={prefs.showList} onCheckedChange={(v) => setPrefs({ showList: v })}>List Pane</DropdownMenuCheckboxItem>
            <DropdownMenuCheckboxItem checked={prefs.showEnhancements} onCheckedChange={(v) => setPrefs({ showEnhancements: v })}>Enhancements</DropdownMenuCheckboxItem>
            <DropdownMenuCheckboxItem checked={prefs.lyrics} onCheckedChange={(v) => setPrefs({ lyrics: v })}>Lyrics</DropdownMenuCheckboxItem>
          </>
        )}
        <DropdownMenuSub>
          <DropdownMenuSubTrigger>Visualizations</DropdownMenuSubTrigger>
          <DropdownMenuSubContent>
            <DropdownMenuRadioGroup value={prefs.vis} onValueChange={(vis) => setPrefs({ vis })}>
              <DropdownMenuRadioItem value="art">Album Art</DropdownMenuRadioItem>
              {VISUALIZATIONS.map((v) => (
                <DropdownMenuRadioItem key={v.id} value={v.id}>{v.group}: {v.name}</DropdownMenuRadioItem>
              ))}
            </DropdownMenuRadioGroup>
          </DropdownMenuSubContent>
        </DropdownMenuSub>
        <DropdownMenuSub>
          <DropdownMenuSubTrigger>Choose Color</DropdownMenuSubTrigger>
          <DropdownMenuSubContent>
            <DropdownMenuRadioGroup value={String(prefs.hue)} onValueChange={(h) => setPrefs({ hue: h === 'null' ? null : Number(h) })}>
              {COLORS.map(([name, hue]) => (
                <DropdownMenuRadioItem key={name} value={String(hue)}>
                  <span
                    className="mr-2 inline-block size-3 rounded-full ring-1 ring-foreground/20"
                    style={{ background: hue === null ? 'var(--primary)' : `hsl(${hue} 80% 48%)` }}
                    aria-hidden
                  />
                  {name}
                </DropdownMenuRadioItem>
              ))}
            </DropdownMenuRadioGroup>
          </DropdownMenuSubContent>
        </DropdownMenuSub>
        <DropdownMenuSeparator />
        <DropdownMenuSub>
          <DropdownMenuSubTrigger>Skin</DropdownMenuSubTrigger>
          <DropdownMenuSubContent className="w-56">
            <DropdownMenuItem onSelect={() => setPrefs({ skin: { kind: 'din' } })}>
              Din’s Own Skin<DropdownMenuShortcut>Ctrl+1</DropdownMenuShortcut>
            </DropdownMenuItem>
            <DropdownMenuItem onSelect={() => setPrefs({ skin: { kind: 'winamp', path: '' } })}>Din Classic</DropdownMenuItem>
            <DropdownMenuItem onSelect={() => setPrefs({ skin: { kind: 'din' }, tab: 'skins', mini: false })}>Skin Chooser…</DropdownMenuItem>
            <DropdownMenuItem onSelect={() => void commands.loadSkin()}>Apply a Skin File…</DropdownMenuItem>
            {prefs.skin.kind === 'winamp' && (
              <>
                <DropdownMenuSeparator />
                <DropdownMenuCheckboxItem checked={prefs.winamp.eq} onCheckedChange={(v) => setWinampPrefs({ eq: v })}>Equalizer</DropdownMenuCheckboxItem>
                <DropdownMenuCheckboxItem checked={prefs.winamp.playlist} onCheckedChange={(v) => setWinampPrefs({ playlist: v })}>Playlist Editor</DropdownMenuCheckboxItem>
                <DropdownMenuCheckboxItem checked={prefs.winamp.double} onCheckedChange={(v) => setWinampPrefs({ double: v })}>Double Size</DropdownMenuCheckboxItem>
              </>
            )}
          </DropdownMenuSubContent>
        </DropdownMenuSub>
      </Menu>
      <Menu label="Play">
        <DropdownMenuItem onSelect={() => player.toggle()}>{playing ? 'Pause' : 'Play'}<DropdownMenuShortcut>Ctrl+P</DropdownMenuShortcut></DropdownMenuItem>
        <DropdownMenuItem onSelect={() => player.stop()}>Stop<DropdownMenuShortcut>Ctrl+S</DropdownMenuShortcut></DropdownMenuItem>
        <DropdownMenuItem onSelect={() => player.previous()}>Previous<DropdownMenuShortcut>Ctrl+B</DropdownMenuShortcut></DropdownMenuItem>
        <DropdownMenuItem onSelect={() => player.next()}>Next<DropdownMenuShortcut>Ctrl+F</DropdownMenuShortcut></DropdownMenuItem>
        <DropdownMenuItem onSelect={() => player.rewind()}>Rewind<DropdownMenuShortcut>Ctrl+Shift+B</DropdownMenuShortcut></DropdownMenuItem>
        <DropdownMenuItem onSelect={() => player.fastForward()}>Fast Forward<DropdownMenuShortcut>Ctrl+Shift+F</DropdownMenuShortcut></DropdownMenuItem>
        <DropdownMenuSeparator />
        <DropdownMenuCheckboxItem checked={shuffle} onCheckedChange={(v) => player.setShuffle(v)}>Shuffle<DropdownMenuShortcut>Ctrl+H</DropdownMenuShortcut></DropdownMenuCheckboxItem>
        <DropdownMenuSub>
          <DropdownMenuSubTrigger>Repeat</DropdownMenuSubTrigger>
          <DropdownMenuSubContent>
            <DropdownMenuRadioGroup value={repeat} onValueChange={(r) => player.setRepeat(r as 'off' | 'all' | 'one')}>
              <DropdownMenuRadioItem value="off">Off</DropdownMenuRadioItem>
              <DropdownMenuRadioItem value="all">Repeat All</DropdownMenuRadioItem>
              <DropdownMenuRadioItem value="one">Repeat One</DropdownMenuRadioItem>
            </DropdownMenuRadioGroup>
          </DropdownMenuSubContent>
        </DropdownMenuSub>
        <DropdownMenuSeparator />
        <DropdownMenuItem onSelect={() => player.setVolume(player.getState().volume + 0.05)}>Volume Up<DropdownMenuShortcut>F9</DropdownMenuShortcut></DropdownMenuItem>
        <DropdownMenuItem onSelect={() => player.setVolume(player.getState().volume - 0.05)}>Volume Down<DropdownMenuShortcut>F8</DropdownMenuShortcut></DropdownMenuItem>
        <DropdownMenuCheckboxItem checked={muted} onCheckedChange={(v) => player.setMuted(v)}>Mute<DropdownMenuShortcut>F7</DropdownMenuShortcut></DropdownMenuCheckboxItem>
      </Menu>
    </MenuBarMenus>
  );
}
