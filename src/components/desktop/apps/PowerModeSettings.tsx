import { useRef } from 'react';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import { EffectPicture } from '@/components/desktop/apps/CursorEffectPicker';
import { useAppContext } from '@/hooks/useAppContext';
import { previewPowerMode } from '@/lib/powerMode';

/** Power mode, for Settings → Effects: its switch, and whether it shakes windows. */
export function PowerModeSettings() {
  const { config, updateConfig } = useAppContext();
  return (
    <div className="flex flex-col gap-3">
      <PowerModeRow
        kind="power-mode"
        title="Power mode"
        description="Type for a while without stopping, and every keystroke throws sparks from the caret. A pause of a second ends it."
        checked={config.powerMode}
        onCheckedChange={(powerMode) => updateConfig((current) => ({ ...current, powerMode }))}
      />
      <PowerModeRow
        kind="power-mode-shake"
        title="Shake the window"
        description="Each keystroke in power mode gives the window a little knock."
        checked={config.powerModeShake}
        disabled={!config.powerMode}
        onCheckedChange={(powerModeShake) => updateConfig((current) => ({ ...current, powerModeShake }))}
      />
      <p className="text-xs text-muted-foreground">Power mode is off while your system asks for reduced motion.</p>
    </div>
  );
}

/** A row like Settings' cursor plugins: its picture (click to see it), what it does, and its switch. */
function PowerModeRow({
  kind,
  title,
  description,
  checked,
  disabled,
  onCheckedChange,
}: {
  kind: 'power-mode' | 'power-mode-shake';
  title: string;
  description: string;
  checked: boolean;
  disabled?: boolean;
  onCheckedChange: (checked: boolean) => void;
}) {
  const row = useRef<HTMLDivElement>(null);
  const preview = () => {
    const el = row.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    const win = kind === 'power-mode-shake' ? el.closest<HTMLElement>('[data-window-id]') : null;
    previewPowerMode({ x: rect.left, y: rect.top, width: rect.width, height: rect.height }, getComputedStyle(el).color, win);
  };
  return (
    <div ref={row} className="flex items-center gap-3 rounded-md border bg-muted/20 p-3">
      <button
        type="button"
        onClick={preview}
        aria-label={`Preview ${title}`}
        className="aspect-[8/5] w-24 shrink-0 overflow-hidden rounded-lg bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
      >
        <EffectPicture kind={kind} id={kind} tint={null} />
      </button>
      <div className="min-w-0 flex-1">
        <Label htmlFor={kind} className="cursor-pointer text-sm">
          {title}
        </Label>
        <p className="text-xs text-muted-foreground">{description}</p>
      </div>
      <Switch
        id={kind}
        checked={checked}
        disabled={disabled}
        onCheckedChange={(on) => {
          onCheckedChange(on);
          if (on) preview();
        }}
      />
    </div>
  );
}
