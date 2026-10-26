import { Maximize2, SkipBack, SkipForward, Square } from 'lucide-react';
import { player, usePlayer, usePlaybackTime, formatTime } from '../engine';
import { setPrefs } from '../prefs';
import { Cover, IconButton, Marquee } from './common';
import { PlayButton, SeekBar, VolumeControl } from './Transport';

/** WMP's Mini Player: cover, title and the transport, in a sliver of a window. */
export function MiniPlayer() {
  const track = usePlayer((s) => s.queue[s.current] ?? null);
  const empty = usePlayer((s) => s.queue.length === 0);
  const { position, duration } = usePlaybackTime();
  return (
    <div className="mp-gloss flex size-full flex-col justify-center gap-1 px-3 py-2">
      <div className="flex min-w-0 items-center gap-3">
        <Cover location={track?.location} className="size-12 shadow-md ring-1 ring-white/10" />
        <div className="min-w-0 flex-1 leading-tight">
          <Marquee text={track?.title ?? 'Nothing playing'} className="font-semibold" />
          <p className="truncate text-xs text-[var(--mp-ink-dim)]">{track?.artist || track?.album || ' '}</p>
          <p className="mp-lcd text-xs">{track ? `${formatTime(position)} / ${formatTime(duration || track.duration)}` : ''}</p>
        </div>
        <div className="flex items-center gap-0.5">
          <IconButton label="Stop" disabled={empty} onClick={() => player.stop()} className="size-7">
            <Square className="size-3 fill-current" />
          </IconButton>
          <IconButton label="Previous" disabled={empty} onClick={() => player.previous()} className="size-7">
            <SkipBack className="size-4 fill-current" />
          </IconButton>
          <PlayButton size="sm" />
          <IconButton label="Next" disabled={empty} onClick={() => player.next()} className="size-7">
            <SkipForward className="size-4 fill-current" />
          </IconButton>
          <span className="max-[420px]:hidden">
            <VolumeControl compact />
          </span>
          <IconButton label="Switch to Full Mode" onClick={() => setPrefs({ mini: false })} className="size-7">
            <Maximize2 className="size-4" />
          </IconButton>
        </div>
      </div>
      <SeekBar />
    </div>
  );
}
