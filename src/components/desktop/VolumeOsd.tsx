import { useEffect, useRef, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { cn } from '@/lib/utils';
import { MAX_VOLUME, getAudioBridge } from '@/lib/audio';
import type { AudioStatus } from '@/lib/audio';
import { VolumeGlyph } from '@/components/desktop/VolumeIndicator';
import { OverdriveMeter } from '@/components/ui/overdrive-slider';
import { knockAnimation } from '@/lib/overdrive';

/** How long the OSD stays on screen after the last volume change. */
const OSD_VISIBLE_MS = 1500;

/**
 * On-screen volume display. Listens for media-key volume changes pushed from
 * the main process (window.audio.onOsd) and shows a transient overlay with the
 * new level, GNOME/macOS style. Also primes the audio status cache so the
 * menu-bar control reflects the change immediately.
 *
 * Renders nothing (and registers no listener) outside the Electron shell.
 */
export function VolumeOsd() {
  const queryClient = useQueryClient();
  const [status, setStatus] = useState<AudioStatus | null>(null);
  const [visible, setVisible] = useState(false);
  const hideTimer = useRef<number | undefined>(undefined);
  const meterRef = useRef<HTMLDivElement>(null);
  const last = useRef<AudioStatus | null>(null);

  useEffect(() => {
    const audio = getAudioBridge();
    if (!audio) return;

    const unsubscribe = audio.onOsd((next) => {
      // The volume keys stop at 100 and knock once before going past it.
      if (next.volume === 100 && last.current?.volume === 100 && last.current.muted === next.muted) {
        knockAnimation(meterRef.current, 1);
      }
      last.current = next;
      setStatus(next);
      setVisible(true);
      queryClient.setQueryData(['audio', 'status'], next);
      window.clearTimeout(hideTimer.current);
      hideTimer.current = window.setTimeout(() => setVisible(false), OSD_VISIBLE_MS);
    });

    return () => {
      unsubscribe();
      window.clearTimeout(hideTimer.current);
    };
  }, [queryClient]);

  if (!status) return null;

  const muted = status.muted || status.volume === 0;
  const level = muted ? 0 : status.volume ?? 0;

  return (
    <div
      aria-hidden
      className={cn(
        'pointer-events-none fixed inset-x-0 bottom-24 z-[9998] flex justify-center',
        'transition-opacity duration-200 motion-reduce:transition-none',
        visible ? 'opacity-100' : 'opacity-0',
      )}
    >
      <div className="flex items-center gap-3 rounded-2xl border border-border/60 bg-background/80 px-4 py-3 shadow-lg backdrop-blur-md">
        <VolumeGlyph
          volume={status.volume}
          muted={status.muted}
          className={cn('size-6 shrink-0', muted ? 'text-muted-foreground' : 'text-foreground')}
        />
        <OverdriveMeter
          ref={meterRef}
          value={level}
          min={0}
          max={100}
          overMax={MAX_VOLUME}
          muted={muted}
          width={160}
          makeRoom
        />
        <span className="w-11 text-right text-sm font-medium tabular-nums text-foreground">
          {muted ? '—' : `${level}%`}
        </span>
      </div>
    </div>
  );
}
