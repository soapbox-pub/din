import { useRef } from 'react';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import { useAppContext } from '@/hooks/useAppContext';
import { previewPowerMode } from '@/lib/powerMode';

/** Power mode, for Settings → Appearance: its switch, and whether it shakes windows. */
export function PowerModeSettings() {
  const { config, updateConfig } = useAppContext();
  const row = useRef<HTMLDivElement>(null);

  const preview = () => {
    const el = row.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    previewPowerMode({ x: rect.left, y: rect.top, width: rect.width, height: rect.height }, getComputedStyle(el).color);
  };

  return (
    <div className="flex flex-col gap-3">
      <div ref={row} className="flex items-center gap-3 rounded-md border bg-muted/20 p-3">
        <div className="min-w-0 flex-1">
          <Label htmlFor="power-mode" className="cursor-pointer text-sm">
            Power mode
          </Label>
          <p className="text-xs text-muted-foreground">
            Type for a while without stopping, and every keystroke throws sparks from the caret. A pause of ten seconds
            ends it. Works in Din and its apps, not in web pages.
          </p>
        </div>
        <Switch
          id="power-mode"
          checked={config.powerMode}
          onCheckedChange={(powerMode) => {
            updateConfig((current) => ({ ...current, powerMode }));
            if (powerMode) preview();
          }}
        />
      </div>
      <div className="flex items-center gap-3 rounded-md border bg-muted/20 p-3">
        <div className="min-w-0 flex-1">
          <Label htmlFor="power-mode-shake" className="cursor-pointer text-sm">
            Shake the window
          </Label>
          <p className="text-xs text-muted-foreground">Each keystroke in power mode gives the window a little knock.</p>
        </div>
        <Switch
          id="power-mode-shake"
          checked={config.powerModeShake}
          disabled={!config.powerMode}
          onCheckedChange={(powerModeShake) => updateConfig((current) => ({ ...current, powerModeShake }))}
        />
      </div>
      <p className="text-xs text-muted-foreground">Power mode is off while your system asks for reduced motion.</p>
    </div>
  );
}
