import { useEffect, useRef, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { cn } from '@/lib/utils';
import { glassPanel } from '@/shared/appChromeStyles';
import { MIN_BRIGHTNESS, brightnessText, getBrightnessBridge } from '@/lib/brightness';
import type { BrightnessStatus } from '@/lib/brightness';
import { BrightnessGlyph } from '@/components/desktop/BrightnessIndicator';
import { OverdriveMeter } from '@/components/ui/overdrive-slider';
import { knockAnimation } from '@/lib/overdrive';
import { announce } from '@/lib/announce';

/** How long the OSD stays on screen after the last brightness change. */
const OSD_VISIBLE_MS = 1500;

/**
 * On-screen brightness display. Listens for media-key brightness changes
 * pushed from the main process (window.dinos.brightness.onOsd) and shows a transient
 * overlay with the new level, GNOME/macOS style. Also primes the brightness
 * status cache so the menu-bar control reflects the change immediately.
 *
 * Renders nothing (and registers no listener) outside the Electron shell.
 */
export function BrightnessOsd() {
  const queryClient = useQueryClient();
  const [status, setStatus] = useState<BrightnessStatus | null>(null);
  const [visible, setVisible] = useState(false);
  const hideTimer = useRef<number | undefined>(undefined);
  const meterRef = useRef<HTMLDivElement>(null);
  const lastLevel = useRef<number | null>(null);

  useEffect(() => {
    const brightness = getBrightnessBridge();
    if (!brightness) return;

    const unsubscribe = brightness.onOsd((next) => {
      // The brightness keys stop at 0 and knock once before dimming past it.
      if (next.brightness === 0 && lastLevel.current === 0) knockAnimation(meterRef.current, -1);
      lastLevel.current = next.brightness;
      announce(`Brightness ${brightnessText(next.brightness ?? 0)}`);
      setStatus(next);
      setVisible(true);
      queryClient.setQueryData(['brightness', 'status'], next);
      window.clearTimeout(hideTimer.current);
      hideTimer.current = window.setTimeout(() => setVisible(false), OSD_VISIBLE_MS);
    });

    return () => {
      unsubscribe();
      window.clearTimeout(hideTimer.current);
    };
  }, [queryClient]);

  if (!status) return null;

  const level = status.brightness ?? 0;

  return (
    <div
      aria-hidden
      className={cn(
        'pointer-events-none fixed inset-x-0 bottom-24 z-[9998] flex justify-center',
        'transition-opacity duration-200 motion-reduce:transition-none',
        visible ? 'opacity-100' : 'opacity-0',
      )}
    >
      <div className={cn('flex items-center gap-3 px-4 py-3', glassPanel)}>
        <BrightnessGlyph
          brightness={status.brightness}
          className="size-6 shrink-0 text-foreground"
        />
        <OverdriveMeter
          ref={meterRef}
          value={level}
          min={0}
          max={100}
          underMin={MIN_BRIGHTNESS}
          width={160}
          makeRoom
        />
        <span className="w-11 text-right text-sm font-medium tabular-nums text-foreground">
          {brightnessText(level)}
        </span>
      </div>
    </div>
  );
}
