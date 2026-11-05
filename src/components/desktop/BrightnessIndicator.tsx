import { useEffect, useState } from 'react';
import { Moon, Settings2, Sun, SunDim, SunMedium } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Slider } from '@/components/ui/slider';
import { OverdriveSlider, type OverdriveSliderProps } from '@/components/ui/overdrive-slider';
import { Switch } from '@/components/ui/switch';
import { PopoverClose } from '@/components/ui/popover';
import { cn } from '@/lib/utils';
import { trayFooter, trayFooterButton, trayHeader, trayRuleTop, trayTitle } from './trayPanel';
import {
  setBrightnessPreview,
  useBrightnessMutations,
  useBrightnessStatus,
} from '@/hooks/useBrightness';
import {
  MAX_TEMPERATURE,
  MIN_BRIGHTNESS,
  MIN_TEMPERATURE,
  brightnessText,
  brightnessValueText,
  nightLightCaption,
} from '@/lib/brightness';
import { timeFormatOptions } from '@/lib/datetime';
import { useAppContext } from '@/hooks/useAppContext';
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
 * A 0-100 backlight slider that can be pushed on down to MIN_BRIGHTNESS,
 * where the screen is dimmed in software. Drags preview the dimming live.
 */
export function BrightnessSlider({
  onValueChange,
  ...props
}: Omit<OverdriveSliderProps, 'min' | 'max' | 'overMax' | 'underMin' | 'step'>) {
  // Don't leave a preview behind if the popover closes mid-drag.
  useEffect(() => () => setBrightnessPreview(null), []);
  return (
    <OverdriveSlider
      min={0}
      max={100}
      underMin={MIN_BRIGHTNESS}
      getValueText={brightnessValueText}
      onValueChange={(v) => {
        setBrightnessPreview(v);
        onValueChange?.(v);
      }}
      {...props}
    />
  );
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
  const { config } = useAppContext();

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

  const caption = nightLight && nightLightCaption(nightLight, timeFormatOptions(config.clockFormat));

  return (
    <div className="flex flex-col">
      <header className={trayHeader}>
        <h2 className={trayTitle}>Display</h2>
        {backlightAvailable && (
          <span className="text-xs tabular-nums text-muted-foreground">{brightnessText(value)}</span>
        )}
      </header>

      {backlightAvailable && (
        <div className="flex items-center gap-3 px-4 py-3">
          <SunDim className="size-5 shrink-0 text-muted-foreground" aria-hidden />
          <BrightnessSlider
            aria-label="Brightness"
            value={value}
            className="flex-1"
            onValueChange={setValue}
            onValueCommit={(v) => setBrightness.mutate(v)}
          />
          <Sun className="size-5 shrink-0 text-foreground" aria-hidden />
        </div>
      )}

      {nightLight?.available && (
        <div className={cn('flex flex-col gap-3 px-4 py-3', backlightAvailable && trayRuleTop)}>
          <div className="flex items-center gap-2.5">
            <Moon
              className={cn('size-5 shrink-0', nightLight.active ? 'text-foreground' : 'text-muted-foreground')}
              aria-hidden
            />
            <div className="flex min-w-0 flex-1 flex-col">
              <span className="text-sm text-foreground">Night Light</span>
              {caption && <span className="text-xs text-muted-foreground">{caption}</span>}
            </div>
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

      <footer className={trayFooter}>
        <PopoverClose asChild>
          <Button
            variant="ghost"
            size="sm"
            className={trayFooterButton}
            onClick={() => open('settings', { section: 'display' })}
          >
            <Settings2 aria-hidden />
            Display settings
          </Button>
        </PopoverClose>
      </footer>
    </div>
  );
}
