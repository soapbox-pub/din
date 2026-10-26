import { useState } from 'react';
import {
  Minimize2, Pause, Play, Repeat, Repeat1, Shuffle, SkipBack, SkipForward, SlidersHorizontal, Square, Volume1, Volume2, VolumeX,
} from 'lucide-react';
import { cn } from '@/lib/utils';
import { displayTitle, formatTime, player, usePlaybackTime, usePlayer } from '../engine';
import { setPrefs, usePrefs } from '../prefs';
import { IconButton, Marquee, Range } from './common';

export function SeekBar({ className }: { className?: string }) {
  const { position, duration } = usePlaybackTime();
  const stopped = usePlayer((s) => s.status === 'stopped' && s.current === -1);
  const [drag, setDrag] = useState<number | null>(null);
  const seekable = duration > 0 && Number.isFinite(duration);
  return (
    <Range
      label="Seek"
      min={0}
      max={seekable ? duration : 1}
      value={drag ?? (seekable ? Math.min(position, duration) : 0)}
      disabled={!seekable || stopped}
      onValue={(v) => setDrag(v)}
      onPointerUp={() => {
        if (drag !== null) player.seek(drag);
        setDrag(null);
      }}
      onKeyUp={() => {
        if (drag !== null) player.seek(drag);
        setDrag(null);
      }}
      aria-valuetext={`${formatTime(drag ?? position)} of ${formatTime(duration)}`}
      className={cn('h-3 w-full', className)}
    />
  );
}

export function VolumeControl({ compact }: { compact?: boolean }) {
  const volume = usePlayer((s) => s.volume);
  const muted = usePlayer((s) => s.muted);
  const Icon = muted || volume === 0 ? VolumeX : volume < 0.5 ? Volume1 : Volume2;
  return (
    <div className="flex items-center gap-1">
      <IconButton label={muted ? 'Unmute (F7)' : 'Mute (F7)'} aria-pressed={muted} onClick={() => player.setMuted(!muted)} className="size-8">
        <Icon className="size-4" />
      </IconButton>
      <Range
        label="Volume"
        min={0}
        max={1}
        value={muted ? 0 : volume}
        onValue={(v) => player.setVolume(v)}
        aria-valuetext={`${Math.round((muted ? 0 : volume) * 100)}%`}
        thumb="always"
        className={cn('h-3', compact ? 'w-16' : 'w-24')}
      />
    </div>
  );
}

export function PlayButton({ size = 'lg' }: { size?: 'lg' | 'sm' }) {
  const playing = usePlayer((s) => s.status === 'playing');
  const empty = usePlayer((s) => s.queue.length === 0);
  return (
    <button
      type="button"
      aria-label={playing ? 'Pause (Ctrl+P)' : 'Play (Ctrl+P)'}
      title={playing ? 'Pause' : 'Play'}
      disabled={empty}
      onClick={() => player.toggle()}
      className={cn(
        'mp-orb shrink-0 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-60',
        size === 'lg' ? 'size-12' : 'size-9',
      )}
    >
      {playing ? (
        <Pause className={cn('fill-current drop-shadow', size === 'lg' ? 'size-5' : 'size-4')} />
      ) : (
        <Play className={cn('translate-x-px fill-current drop-shadow', size === 'lg' ? 'size-5' : 'size-4')} />
      )}
    </button>
  );
}

export function ShuffleRepeat() {
  const shuffle = usePlayer((s) => s.shuffle);
  const repeat = usePlayer((s) => s.repeat);
  return (
    <>
      <IconButton label="Shuffle (Ctrl+H)" aria-pressed={shuffle} onClick={() => player.setShuffle(!shuffle)} className="size-8">
        <Shuffle className="size-4" />
      </IconButton>
      <IconButton
        label={repeat === 'one' ? 'Repeat one (Ctrl+T)' : repeat === 'all' ? 'Repeat all (Ctrl+T)' : 'Repeat (Ctrl+T)'}
        aria-pressed={repeat !== 'off'}
        onClick={() => player.cycleRepeat()}
        className="size-8"
      >
        {repeat === 'one' ? <Repeat1 className="size-4" /> : <Repeat className="size-4" />}
      </IconButton>
    </>
  );
}

function Status() {
  const track = usePlayer((s) => s.queue[s.current] ?? null);
  const status = usePlayer((s) => s.status);
  const waiting = usePlayer((s) => s.waiting);
  const scan = usePlayer((s) => s.scan);
  const { position, duration } = usePlaybackTime();
  const verb = waiting && status === 'playing'
    ? 'Buffering'
    : scan === 'ffwd' ? 'Fast forwarding' : scan === 'rew' ? 'Rewinding'
      : status === 'playing' ? 'Playing' : status === 'paused' ? 'Paused' : 'Stopped';
  return (
    <div className="flex min-w-0 flex-1 flex-col justify-center leading-tight">
      <Marquee text={track ? `${verb}: ${displayTitle(track)}` : 'Ready'} className="font-medium text-[var(--mp-ink)]" />
      <span className="mp-lcd text-xs">
        {track ? `${formatTime(position)} / ${formatTime(duration || track.duration)}` : '0:00'}
      </span>
    </div>
  );
}

/** The transport bar along the bottom of the full player. */
export function Transport() {
  const empty = usePlayer((s) => s.queue.length === 0);
  const stopped = usePlayer((s) => s.status === 'stopped');
  const enhancements = usePrefs((p) => p.showEnhancements);
  return (
    <div className="mp-gloss shrink-0 border-t border-[var(--mp-line)]">
      <div className="px-3 pt-1">
        <SeekBar />
      </div>
      <div className="grid grid-cols-[1fr_auto_1fr] items-center gap-3 px-3 pb-2">
        <Status />
        <div className="flex items-center gap-1">
          <ShuffleRepeat />
          <span className="mx-1 h-5 w-px bg-[var(--mp-line)]" aria-hidden />
          <IconButton label="Stop (Ctrl+S)" disabled={empty || stopped} onClick={() => player.stop()} className="size-8">
            <Square className="size-3.5 fill-current" />
          </IconButton>
          <IconButton label="Previous (Ctrl+B)" disabled={empty} onClick={() => player.previous()} className="size-8">
            <SkipBack className="size-4 fill-current" />
          </IconButton>
          <PlayButton />
          <IconButton label="Next (Ctrl+F)" disabled={empty} onClick={() => player.next()} className="size-8">
            <SkipForward className="size-4 fill-current" />
          </IconButton>
          <span className="mx-1 h-5 w-px bg-[var(--mp-line)]" aria-hidden />
          <VolumeControl />
        </div>
        <div className="flex items-center justify-end gap-1">
          <IconButton
            label="Enhancements"
            aria-pressed={enhancements}
            onClick={() => setPrefs({ showEnhancements: !enhancements })}
            className="size-8"
          >
            <SlidersHorizontal className="size-4" />
          </IconButton>
          <IconButton label="Switch to Mini Player" onClick={() => setPrefs({ mini: true })} className="size-8">
            <Minimize2 className="size-4" />
          </IconButton>
        </div>
      </div>
    </div>
  );
}
