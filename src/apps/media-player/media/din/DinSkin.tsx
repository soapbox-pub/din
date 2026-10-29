import type { CSSProperties } from 'react';
import { PanelRight, X } from 'lucide-react';
import { WindowControls, WindowDragRegion } from '@/sdk/react';
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
function TitlebarTabs({ tab, showList }: { tab: DinTab; showList: boolean }) {
  return (
    <WindowDragRegion className="flex h-9 shrink-0 items-center gap-1 pr-3 pl-2">
      <img src="/icons/apps/media-player.png" alt="" draggable={false} className="mx-1 size-4 shrink-0" />
      <div role="tablist" aria-label="Media Player" className="flex min-w-0 items-center gap-0.5 overflow-x-auto">
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
      <WindowControls className="ml-2" />
    </WindowDragRegion>
  );
}

/**
 * Din's own skin: Windows Media Player 10's layout in a Din window, its
 * tabs in the title bar (a `custom` frame, but for the Mini Player's
 * standard one) and its menus in the menu bar, in Din's colors.
 */
export function DinSkin({ commands }: { commands: Commands }) {
  const tab = usePrefs((p) => p.tab);
  const hue = usePrefs((p) => p.hue);
  const mini = usePrefs((p) => p.mini);
  const showList = usePrefs((p) => p.showList);
  const error = usePlayer((s) => s.error);
  const tint = useTintVars(hue);
  const style = tint as CSSProperties;

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
      <TitlebarTabs tab={tab} showList={showList} />
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
