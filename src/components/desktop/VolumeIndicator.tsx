import { useState } from 'react';
import {
  AppWindow,
  Check,
  Globe,
  Headphones,
  Mic,
  Music,
  Pause,
  Play,
  Settings2,
  SkipBack,
  SkipForward,
  Speaker,
  Volume1,
  Volume2,
  VolumeX,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { OverdriveSlider, type OverdriveSliderProps } from '@/components/ui/overdrive-slider';
import { PopoverClose } from '@/components/ui/popover';
import { cn } from '@/lib/utils';
import { useAudioDeviceMutations, useAudioDevices, useAudioMutations, useAudioStatus } from '@/hooks/useAudio';
import { MAX_VOLUME, volumeText, type AudioDevice } from '@/lib/audio';
import { useWindowActions } from '@/contexts/WindowManagerContext';
import { artworkSrc, controlMedia, useNowPlaying, type MediaSource } from '@/lib/nowPlaying';

/** How many sources the popover lists at most. */
const MAX_NOW_PLAYING = 3;

/**
 * Speaker glyph reflecting volume and mute state. Shared by the menu-bar item
 * and the volume OSD.
 */
export function VolumeGlyph({
  volume,
  muted,
  className,
}: {
  volume: number | null;
  muted: boolean;
  className?: string;
}) {
  const Icon =
    muted || volume === 0
      ? VolumeX
      : volume === null
        ? Volume2
        : volume < 50
          ? Volume1
          : Volume2;
  return <Icon className={className} aria-hidden />;
}

/**
 * A 0-100 volume slider that can be pushed on to MAX_VOLUME, where PipeWire
 * amplifies past the device's full volume.
 */
export function VolumeSlider(
  props: Omit<OverdriveSliderProps, 'min' | 'max' | 'overMax' | 'underMin' | 'step'>,
) {
  return <OverdriveSlider min={0} max={100} overMax={MAX_VOLUME} getValueText={volumeText} {...props} />;
}

/** Popover content: a volume slider, mute toggle, and settings link. */
export function VolumePopoverBody() {
  const status = useAudioStatus();
  const { setVolume, setMuted } = useAudioMutations();
  const { open } = useWindowActions();

  const serverVolume = status.data?.volume ?? 0;
  const muted = status.data?.muted ?? false;

  // Local value for a smooth drag; committed to wpctl on release. Re-syncs to
  // the server value (media keys, external wpctl) by adjusting state during
  // render rather than in an effect.
  const [value, setValue] = useState(serverVolume);
  const [lastServer, setLastServer] = useState(serverVolume);
  if (serverVolume !== lastServer) {
    setLastServer(serverVolume);
    setValue(serverVolume);
  }

  return (
    <div className="flex flex-col">
      <header className="flex items-center justify-between gap-2 border-b border-border/60 px-3 py-2">
        <h2 className="text-sm font-medium text-foreground">Sound</h2>
        <span className="text-xs tabular-nums text-muted-foreground">
          {muted ? 'Muted' : `${value}%`}
        </span>
      </header>

      <NowPlaying />

      <div className="flex items-center gap-2.5 px-3 py-3">
        <Button
          variant="ghost"
          size="icon"
          aria-label={muted ? 'Unmute' : 'Mute'}
          title={muted ? 'Unmute' : 'Mute'}
          className="size-8 shrink-0 text-foreground/90 hover:bg-foreground/10 hover:text-foreground"
          onClick={() => setMuted.mutate(!muted)}
        >
          <VolumeGlyph
            volume={value}
            muted={muted}
            className={cn('size-5', muted && 'text-muted-foreground')}
          />
        </Button>
        <VolumeSlider
          aria-label="Volume"
          value={muted ? 0 : value}
          className="flex-1"
          onValueChange={(v) => {
            if (muted) setMuted.mutate(false);
            setValue(v);
          }}
          onValueCommit={(v) => setVolume.mutate(v)}
        />
      </div>

      <DeviceChoices />

      <footer className="border-t border-border/60 p-1.5">
        <PopoverClose asChild>
          <Button
            variant="ghost"
            size="sm"
            className="w-full justify-start text-muted-foreground hover:text-foreground"
            onClick={() => open('settings', { section: 'sound' })}
          >
            <Settings2 aria-hidden />
            Sound settings
          </Button>
        </PopoverClose>
      </footer>
    </div>
  );
}

/**
 * Where sound goes and comes from, one click to change, as a Mac's Sound
 * menu has it. A list shows only when there's a choice to make.
 */
function DeviceChoices() {
  const devices = useAudioDevices();
  const { setDefault } = useAudioDeviceMutations();
  const sinks = devices.data?.sinks ?? [];
  const sources = devices.data?.sources ?? [];
  const lists = [
    { label: 'Output', devices: sinks, kind: 'output' as const },
    { label: 'Input', devices: sources, kind: 'input' as const },
  ].filter((list) => list.devices.length > 1);
  if (lists.length === 0) return null;
  return (
    <div className="flex flex-col gap-1 border-t border-border/60 px-1.5 py-1.5">
      {lists.map((list) => (
        <div key={list.kind} role="radiogroup" aria-label={`${list.label} device`}>
          <p className="px-1.5 pb-0.5 pt-1 text-xs font-medium text-muted-foreground">{list.label}</p>
          {list.devices.map((device) => (
            <DeviceChoice
              key={device.id}
              device={device}
              kind={list.kind}
              onSelect={() => {
                if (!device.isDefault) setDefault.mutate(device.id);
              }}
            />
          ))}
        </div>
      ))}
    </div>
  );
}

function DeviceChoice({
  device,
  kind,
  onSelect,
}: {
  device: AudioDevice;
  kind: 'output' | 'input';
  onSelect: () => void;
}) {
  const Icon = /head(set|phone)/.test(device.icon ?? '') ? Headphones : kind === 'input' ? Mic : Speaker;
  return (
    <button
      type="button"
      role="radio"
      aria-checked={device.isDefault}
      onClick={onSelect}
      className={cn(
        'flex w-full items-center gap-2.5 rounded-md px-1.5 py-1.5 text-left text-sm text-foreground',
        'hover:bg-foreground/10 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
      )}
    >
      <span
        className={cn(
          'grid size-7 shrink-0 place-items-center rounded-full',
          device.isDefault ? 'bg-primary text-primary-foreground' : 'bg-muted text-muted-foreground',
        )}
      >
        <Icon className="size-4" aria-hidden />
      </span>
      <span className="min-w-0 flex-1">
        <span className="block truncate" title={device.name}>
          {device.name}
        </span>
        {device.callQuality && (
          <span className="block truncate text-xs text-muted-foreground">Call quality while an app uses the mic</span>
        )}
      </span>
      {device.isDefault && <Check className="size-4 shrink-0 text-muted-foreground" aria-hidden />}
    </button>
  );
}

/** Media controls for whatever is playing, or was until paused. */
function NowPlaying() {
  const sources = useNowPlaying();
  if (sources.length === 0) return null;
  return (
    <ul aria-label="Now playing" className="flex flex-col gap-1 border-b border-border/60 px-1.5 py-1.5">
      {sources.slice(0, MAX_NOW_PLAYING).map((source) => (
        <NowPlayingItem key={source.id} source={source} />
      ))}
    </ul>
  );
}

function NowPlayingItem({ source }: { source: MediaSource }) {
  const skippable = source.canPrevious || source.canNext;
  const buttonClass = 'size-8 shrink-0 text-foreground/90 hover:bg-foreground/10 hover:text-foreground';
  return (
    <li className="flex items-center gap-2.5 rounded-md px-1.5 py-1.5">
      <Artwork source={source} />
      <div className="min-w-0 flex-1">
        <p className="truncate text-sm font-medium text-foreground" title={source.title}>
          {source.title}
        </p>
        {source.subtitle && (
          <p className="truncate text-xs text-muted-foreground" title={source.subtitle}>
            {source.subtitle}
          </p>
        )}
      </div>
      <div className="flex shrink-0 items-center">
        {skippable && (
          <Button
            variant="ghost"
            size="icon"
            aria-label="Previous"
            title="Previous"
            disabled={!source.canPrevious}
            className={buttonClass}
            onClick={() => controlMedia(source.id, 'previoustrack')}
          >
            <SkipBack aria-hidden className="fill-current" />
          </Button>
        )}
        {source.playing ? (
          <Button
            variant="ghost"
            size="icon"
            aria-label={`Pause ${source.title}`}
            title="Pause"
            className={buttonClass}
            onClick={() => controlMedia(source.id, 'pause')}
          >
            <Pause aria-hidden className="fill-current" />
          </Button>
        ) : (
          <Button
            variant="ghost"
            size="icon"
            aria-label={`Play ${source.title}`}
            title="Play"
            disabled={!source.canPlay}
            className={buttonClass}
            onClick={() => controlMedia(source.id, 'play')}
          >
            <Play aria-hidden className="fill-current" />
          </Button>
        )}
        {skippable && (
          <Button
            variant="ghost"
            size="icon"
            aria-label="Next"
            title="Next"
            disabled={!source.canNext}
            className={buttonClass}
            onClick={() => controlMedia(source.id, 'nexttrack')}
          >
            <SkipForward aria-hidden className="fill-current" />
          </Button>
        )}
      </div>
    </li>
  );
}

/** The source's cover art, or an icon for what kind of source it is. */
function Artwork({ source }: { source: MediaSource }) {
  const src = artworkSrc(source.artwork);
  const [failed, setFailed] = useState<string | null>(null);
  const Icon = source.kind === 'web' ? Globe : source.kind === 'app' ? AppWindow : Music;
  return (
    <div className="grid size-10 shrink-0 place-items-center overflow-hidden rounded-md bg-muted text-muted-foreground">
      {src && failed !== src ? (
        <img src={src} alt="" className="size-full object-cover" onError={() => setFailed(src)} />
      ) : (
        <Icon aria-hidden className="size-5" />
      )}
    </div>
  );
}
