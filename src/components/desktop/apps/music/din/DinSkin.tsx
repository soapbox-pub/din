import type { CSSProperties } from 'react';
import { Menu, PanelRight, X } from 'lucide-react';
import {
  DropdownMenu, DropdownMenuCheckboxItem, DropdownMenuContent, DropdownMenuItem, DropdownMenuRadioGroup, DropdownMenuRadioItem, DropdownMenuSeparator,
  DropdownMenuShortcut, DropdownMenuSub, DropdownMenuSubContent, DropdownMenuSubTrigger, DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { player, usePlayer } from '../engine';
import { setPrefs, usePrefs, type DinTab } from '../prefs';
import { VISUALIZATIONS } from '../visualizations';
import type { Commands } from '../useCommands';
import { IconButton } from './common';
import { LibraryView } from './LibraryView';
import { MiniPlayer } from './MiniPlayer';
import { NowPlaying } from './NowPlaying';
import { RadioView } from './RadioView';
import { SkinChooser } from './SkinChooser';
import { Transport } from './Transport';

const TABS: { id: DinTab; label: string }[] = [
  { id: 'now-playing', label: 'Now Playing' },
  { id: 'library', label: 'Library' },
  { id: 'radio', label: 'Radio' },
  { id: 'skins', label: 'Skins' },
];

/** WMP's View > Choose Color, as a handful of hues. */
const COLORS: [string, number][] = [
  ['Midnight Blue', 212], ['Teal', 185], ['Emerald', 150], ['Olive', 90], ['Amber', 38], ['Crimson', 352], ['Orchid', 300], ['Violet', 262],
];

function PlayerMenu({ commands }: { commands: Commands }) {
  const prefs = usePrefs((p) => p);
  const shuffle = usePlayer((s) => s.shuffle);
  const repeat = usePlayer((s) => s.repeat);
  const muted = usePlayer((s) => s.muted);
  const playing = usePlayer((s) => s.status === 'playing');
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <IconButton label="Menu" className="size-7">
          <Menu className="size-4" />
        </IconButton>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="w-60">
        <DropdownMenuSub>
          <DropdownMenuSubTrigger>File</DropdownMenuSubTrigger>
          <DropdownMenuSubContent className="w-60">
            <DropdownMenuItem onSelect={() => void commands.openFiles('play')}>Open…<DropdownMenuShortcut>Ctrl+O</DropdownMenuShortcut></DropdownMenuItem>
            <DropdownMenuItem onSelect={() => void commands.openUrl()}>Open URL…<DropdownMenuShortcut>Ctrl+U</DropdownMenuShortcut></DropdownMenuItem>
            <DropdownMenuItem onSelect={() => void commands.openFiles('enqueue')}>Add Files to Now Playing…</DropdownMenuItem>
            <DropdownMenuItem onSelect={() => void commands.openFolder('enqueue')}>Add Folder to Now Playing…</DropdownMenuItem>
            <DropdownMenuSeparator />
            <DropdownMenuItem onSelect={() => void commands.savePlaylist()}>Save Now Playing List As…</DropdownMenuItem>
            <DropdownMenuItem onSelect={() => void commands.addLibraryFolder()}>Add Folder to Library…</DropdownMenuItem>
            <DropdownMenuSeparator />
            <DropdownMenuItem onSelect={commands.close}>Close<DropdownMenuShortcut>Ctrl+W</DropdownMenuShortcut></DropdownMenuItem>
          </DropdownMenuSubContent>
        </DropdownMenuSub>
        <DropdownMenuSub>
          <DropdownMenuSubTrigger>View</DropdownMenuSubTrigger>
          <DropdownMenuSubContent className="w-60">
            <DropdownMenuRadioGroup value={prefs.tab} onValueChange={(tab) => setPrefs({ tab: tab as DinTab, mini: false })}>
              {TABS.map((t) => (
                <DropdownMenuRadioItem key={t.id} value={t.id}>{t.label}</DropdownMenuRadioItem>
              ))}
            </DropdownMenuRadioGroup>
            <DropdownMenuSeparator />
            <DropdownMenuItem onSelect={() => setPrefs({ mini: true })}>Mini Player</DropdownMenuItem>
            <DropdownMenuCheckboxItem checked={prefs.showList} onCheckedChange={(v) => setPrefs({ showList: v })}>List Pane</DropdownMenuCheckboxItem>
            <DropdownMenuCheckboxItem checked={prefs.showEnhancements} onCheckedChange={(v) => setPrefs({ showEnhancements: v })}>Enhancements</DropdownMenuCheckboxItem>
            <DropdownMenuCheckboxItem checked={prefs.lyrics} onCheckedChange={(v) => setPrefs({ lyrics: v })}>Lyrics</DropdownMenuCheckboxItem>
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
                <DropdownMenuRadioGroup value={String(prefs.hue)} onValueChange={(h) => setPrefs({ hue: Number(h) })}>
                  {COLORS.map(([name, hue]) => (
                    <DropdownMenuRadioItem key={hue} value={String(hue)}>
                      <span className="mr-2 inline-block size-3 rounded-full" style={{ background: `hsl(${hue} 80% 50%)` }} aria-hidden />
                      {name}
                    </DropdownMenuRadioItem>
                  ))}
                </DropdownMenuRadioGroup>
              </DropdownMenuSubContent>
            </DropdownMenuSub>
            <DropdownMenuSeparator />
            <DropdownMenuItem onSelect={() => void commands.loadSkin()}>Apply a Skin File…</DropdownMenuItem>
          </DropdownMenuSubContent>
        </DropdownMenuSub>
        <DropdownMenuSub>
          <DropdownMenuSubTrigger>Play</DropdownMenuSubTrigger>
          <DropdownMenuSubContent className="w-60">
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
          </DropdownMenuSubContent>
        </DropdownMenuSub>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/** Din's own skin: Windows Media Player 10's layout, in Din's window. */
export function DinSkin({ commands }: { commands: Commands }) {
  const tab = usePrefs((p) => p.tab);
  const hue = usePrefs((p) => p.hue);
  const mini = usePrefs((p) => p.mini);
  const showList = usePrefs((p) => p.showList);
  const error = usePlayer((s) => s.error);
  const style = { '--mp-hue': hue } as CSSProperties;

  if (mini) {
    return (
      <div className="mp-root size-full select-none" style={style}>
        <MiniPlayer />
      </div>
    );
  }

  const notice = error ?? commands.message;
  return (
    <div className="mp-root flex size-full flex-col select-none" style={style}>
      <div className="mp-gloss mp-taskbar flex shrink-0 items-center gap-1 px-2 py-1.5">
        <PlayerMenu commands={commands} />
        <div role="tablist" aria-label="Music Player" className="flex min-w-0 items-center gap-1 overflow-x-auto">
          {TABS.map((t) => (
            <button
              key={t.id}
              type="button"
              role="tab"
              aria-selected={tab === t.id}
              data-active={tab === t.id}
              onClick={() => setPrefs({ tab: t.id })}
              className="mp-tab shrink-0 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--mp-accent)]"
            >
              {t.label}
            </button>
          ))}
        </div>
        <span className="flex-1" />
        {tab === 'now-playing' && (
          <IconButton label={showList ? 'Hide list pane' : 'Show list pane'} aria-pressed={showList} onClick={() => setPrefs({ showList: !showList })} className="size-7">
            <PanelRight className="size-4" />
          </IconButton>
        )}
      </div>
      {notice && (
        <div role="alert" className="flex shrink-0 items-center gap-2 border-b border-amber-400/30 bg-amber-500/15 px-3 py-1.5 text-amber-100">
          <span className="min-w-0 flex-1 truncate">{notice}</span>
          <IconButton
            label="Dismiss"
            onClick={() => {
              player.dismissError();
              commands.clearMessage();
            }}
            className="size-6"
          >
            <X className="size-3.5" />
          </IconButton>
        </div>
      )}
      <div className="flex min-h-0 flex-1 flex-col" role="tabpanel">
        {tab === 'now-playing' && <NowPlaying />}
        {tab === 'library' && <LibraryView />}
        {tab === 'radio' && <RadioView />}
        {tab === 'skins' && <SkinChooser commands={commands} />}
      </div>
      <Transport />
    </div>
  );
}
