import { useState } from 'react';
import { Settings2, Volume1, Volume2, VolumeX } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Slider } from '@/components/ui/slider';
import { PopoverClose } from '@/components/ui/popover';
import { cn } from '@/lib/utils';
import { useAudioMutations, useAudioStatus } from '@/hooks/useAudio';
import { useWindowActions } from '@/contexts/WindowManagerContext';

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
        <Slider
          aria-label="Volume"
          value={[muted ? 0 : value]}
          min={0}
          max={100}
          step={1}
          className="flex-1"
          onValueChange={([v]) => {
            if (muted) setMuted.mutate(false);
            setValue(v);
          }}
          onValueCommit={([v]) => setVolume.mutate(v)}
        />
      </div>

      <footer className="border-t border-border/60 p-1.5">
        <PopoverClose asChild>
          <Button
            variant="ghost"
            size="sm"
            className="w-full justify-start text-muted-foreground hover:text-foreground"
            onClick={() => open('settings')}
          >
            <Settings2 aria-hidden />
            Sound settings
          </Button>
        </PopoverClose>
      </footer>
    </div>
  );
}
