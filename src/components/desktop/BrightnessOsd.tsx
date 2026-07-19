import { useEffect, useRef, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { cn } from '@/lib/utils';
import { getBrightnessBridge } from '@/lib/brightness';
import type { BrightnessStatus } from '@/lib/brightness';
import { BrightnessGlyph } from '@/components/desktop/BrightnessIndicator';

/** How long the OSD stays on screen after the last brightness change. */
const OSD_VISIBLE_MS = 1500;

/**
 * On-screen brightness display. Listens for media-key brightness changes
 * pushed from the main process (window.brightness.onOsd) and shows a transient
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

  useEffect(() => {
    const brightness = getBrightnessBridge();
    if (!brightness) return;

    const unsubscribe = brightness.onOsd((next) => {
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
      <div className="flex items-center gap-3 rounded-2xl border border-border/60 bg-background/80 px-4 py-3 shadow-lg backdrop-blur-md">
        <BrightnessGlyph
          brightness={status.brightness}
          className="size-6 shrink-0 text-foreground"
        />
        <div className="h-2 w-40 overflow-hidden rounded-full bg-foreground/15">
          <div
            className="h-full rounded-full bg-primary transition-[width] duration-150 motion-reduce:transition-none"
            style={{ width: `${level}%` }}
          />
        </div>
        <span className="w-9 text-right text-sm font-medium tabular-nums text-foreground">
          {`${level}%`}
        </span>
      </div>
    </div>
  );
}
