import { useState } from 'react';
import { Moon, Settings2, Sun, SunDim, SunMedium } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Slider } from '@/components/ui/slider';
import { Switch } from '@/components/ui/switch';
import { PopoverClose } from '@/components/ui/popover';
import { cn } from '@/lib/utils';
import { useBrightnessMutations, useBrightnessStatus } from '@/hooks/useBrightness';
import { MAX_TEMPERATURE, MIN_TEMPERATURE } from '@/lib/brightness';
import { useWindowActions } from '@/contexts/WindowManagerContext';

/**
 * Sun glyph reflecting the backlight level. Shared by the menu-bar item and
 * the brightness OSD.
 */
export function BrightnessGlyph({
  brightness,
  className,
}: {
  brightness: number | null;
  className?: string;
}) {
  const Icon =
    brightness === null
      ? Sun
      : brightness < 34
        ? SunDim
        : brightness < 67
          ? SunMedium
          : Sun;
  return <Icon className={className} aria-hidden />;
}

/**
 * Popover content: a backlight slider plus a night-light (red shift) toggle
 * and warmth slider. Each half renders only when its half of the bridge is
 * available.
 */
export function BrightnessPopoverBody() {
  const status = useBrightnessStatus();
  const { setBrightness, setNightLight, setTemperature } = useBrightnessMutations();
  const { open } = useWindowActions();

  const backlightAvailable = status.data?.available ?? false;
  const serverBrightness = status.data?.brightness ?? 0;
  const nightLight = status.data?.nightLight;

  // Local values for smooth drags; committed to the bridge on release, then
  // re-synced to the server value (media keys, external tools) by adjusting
  // state during render rather than in an effect.
  const [value, setValue] = useState(serverBrightness);
  const [lastServer, setLastServer] = useState(serverBrightness);
  if (serverBrightness !== lastServer) {
    setLastServer(serverBrightness);
    setValue(serverBrightness);
  }

  const serverTemp = nightLight?.temperature ?? MAX_TEMPERATURE;
  const [temp, setTemp] = useState(serverTemp);
  const [lastTemp, setLastTemp] = useState(serverTemp);
  if (serverTemp !== lastTemp) {
    setLastTemp(serverTemp);
    setTemp(serverTemp);
  }

  return (
    <div className="flex flex-col">
      <header className="flex items-center justify-between gap-2 border-b border-border/60 px-3 py-2">
        <h2 className="text-sm font-medium text-foreground">Display</h2>
        {backlightAvailable && (
          <span className="text-xs tabular-nums text-muted-foreground">{value}%</span>
        )}
      </header>

      {backlightAvailable && (
        <div className="flex items-center gap-2.5 px-3 py-3">
          <SunDim className="size-5 shrink-0 text-muted-foreground" aria-hidden />
          <Slider
            aria-label="Brightness"
            value={[value]}
            min={0}
            max={100}
            step={1}
            className="flex-1"
            onValueChange={([v]) => setValue(v)}
            onValueCommit={([v]) => setBrightness.mutate(v)}
          />
          <Sun className="size-5 shrink-0 text-foreground" aria-hidden />
        </div>
      )}

      {nightLight?.available && (
        <div className={cn('flex flex-col gap-3 px-3 py-3', backlightAvailable && 'border-t border-border/60')}>
          <div className="flex items-center gap-2.5">
            <Moon
              className={cn('size-5 shrink-0', nightLight.enabled ? 'text-foreground' : 'text-muted-foreground')}
              aria-hidden
            />
            <span className="flex-1 text-sm text-foreground">Night Light</span>
            <Switch
              aria-label="Night Light"
              checked={nightLight.enabled}
              onCheckedChange={(checked) => setNightLight.mutate(checked)}
            />
          </div>
          {nightLight.enabled && (
            <div className="flex items-center gap-2.5">
              <span className="text-xs text-muted-foreground">Cooler</span>
              {/* Invert the axis so dragging right warms the screen. */}
              <Slider
                aria-label="Color temperature"
                value={[MIN_TEMPERATURE + MAX_TEMPERATURE - temp]}
                min={MIN_TEMPERATURE}
                max={MAX_TEMPERATURE}
                step={100}
                className="flex-1"
                onValueChange={([v]) => setTemp(MIN_TEMPERATURE + MAX_TEMPERATURE - v)}
                onValueCommit={() => setTemperature.mutate(temp)}
              />
              <span className="text-xs text-muted-foreground">Warmer</span>
            </div>
          )}
        </div>
      )}

      <footer className="border-t border-border/60 p-1.5">
        <PopoverClose asChild>
          <Button
            variant="ghost"
            size="sm"
            className="w-full justify-start text-muted-foreground hover:text-foreground"
            onClick={() => open('settings')}
          >
            <Settings2 aria-hidden />
            Display settings
          </Button>
        </PopoverClose>
      </footer>
    </div>
  );
}
