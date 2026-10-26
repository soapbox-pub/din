import { useEffect, type CSSProperties } from 'react';
import { PanelRight, X } from 'lucide-react';
import { AppIcon } from '@/components/desktop/AppIcon';
import { useWindowTitlebar } from '@/contexts/WindowTitlebarContext';
import { player, usePlayer } from '../engine';
import { setPrefs, TABS, usePrefs, type DinTab } from '../prefs';
import type { Commands } from '../useCommands';
import { IconButton } from './common';
import { LibraryView } from './LibraryView';
import { MiniPlayer } from './MiniPlayer';
import { NowPlaying } from './NowPlaying';
import { RadioView } from './RadioView';
import { SkinChooser } from './SkinChooser';
import { Transport } from './Transport';
import { useTintVars } from './useThemeTint';

/** Now Playing, Library, Radio and Skins, in the window's title bar like a browser's tabs. */
function TitlebarTabs({ tab, showList, style }: { tab: DinTab; showList: boolean; style: CSSProperties }) {
  return (
    <div className="mp-theme flex min-w-0 flex-1 items-center gap-1 self-stretch" style={style}>
      <AppIcon icon="/icons/apps/music-player.png" className="mx-1 size-4 shrink-0" />
      <div role="tablist" aria-label="Music Player" className="flex min-w-0 items-center gap-0.5 overflow-x-auto">
        {TABS.map((t) => (
          <button
            key={t.id}
            type="button"
            role="tab"
            aria-selected={tab === t.id}
            data-active={tab === t.id}
            onClick={() => setPrefs({ tab: t.id })}
            className="mp-tab shrink-0 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            {t.label}
          </button>
        ))}
      </div>
      <span className="flex-1" />
      {tab === 'now-playing' && (
        <IconButton label={showList ? 'Hide list pane' : 'Show list pane'} aria-pressed={showList} onClick={() => setPrefs({ showList: !showList })} className="size-6 rounded-md">
          <PanelRight className="size-4" />
        </IconButton>
      )}
    </div>
  );
}

/**
 * Din's own skin: Windows Media Player 10's layout in a Din window, its
 * tabs in the title bar and its menus in the menu bar, in Din's colors.
 */
export function DinSkin({ commands }: { commands: Commands }) {
  const tab = usePrefs((p) => p.tab);
  const hue = usePrefs((p) => p.hue);
  const mini = usePrefs((p) => p.mini);
  const showList = usePrefs((p) => p.showList);
  const error = usePlayer((s) => s.error);
  const tint = useTintVars(hue);
  const style = tint as CSSProperties;
  const setTitlebar = useWindowTitlebar();
  const tintKey = JSON.stringify(tint);

  useEffect(() => {
    if (mini) return;
    setTitlebar(<TitlebarTabs tab={tab} showList={showList} style={JSON.parse(tintKey) as CSSProperties} />);
    return () => setTitlebar(null);
  }, [setTitlebar, mini, tab, showList, tintKey]);

  if (mini) {
    return (
      <div className="mp-theme mp-root size-full select-none" style={style}>
        <MiniPlayer />
      </div>
    );
  }

  const notice = error ?? commands.message;
  return (
    <div className="mp-theme mp-root flex size-full flex-col select-none" style={style}>
      {notice && (
        <div role="alert" className="flex shrink-0 items-center gap-2 border-b border-amber-500/30 bg-amber-500/15 px-3 py-1.5 text-amber-900 dark:text-amber-100">
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
