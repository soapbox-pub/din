import { use, useId } from 'react';
import { Sparkles, Waves } from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import { cn } from '@/lib/utils';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import { WindowEffectPicker } from '@/components/desktop/apps/WindowEffectPicker';
import { useAppContext } from '@/hooks/useAppContext';
import type { DesktopLayout } from '@/contexts/AppContext';
import { useReducedMotion } from '@/shared/reducedMotion';
import { SettingsToken } from '@/shared/settingsChrome';
import { PREVIEW_APPS, PREVIEW_WALLPAPER, settingsCard, settingsChoiceClass } from '@/shared/settingsChromeStyles';
import { SettingsGroupContext } from '@/shared/settingsContexts';

/**
 * The controls for how Din looks and moves that Settings and Customize both
 * offer: one component in both places, so they always say the same thing.
 */

/**
 * A labelled toggle row matching the rest of Settings' switch controls. Add a
 * new row's label to its section's `search` in SECTIONS (src/lib/settingsSections.ts) so search finds it.
 */
export function SettingSwitchRow({
  id,
  icon: Icon,
  label,
  description,
  checked,
  disabled,
  onCheckedChange,
}: {
  id: string;
  icon?: LucideIcon;
  label: string;
  description: string;
  checked: boolean;
  disabled?: boolean;
  onCheckedChange: (checked: boolean) => void;
}) {
  const inGroup = use(SettingsGroupContext);
  return (
    <div className={cn(!inGroup && settingsCard, 'flex items-center justify-between gap-4 px-4 py-3')}>
      <div className="flex min-w-0 items-center gap-3">
        {Icon && <SettingsToken icon={Icon} active={checked} />}
        <div className="min-w-0">
          <Label htmlFor={id} className="cursor-pointer text-sm">
            {label}
          </Label>
          <p className="text-xs text-muted-foreground">{description}</p>
        </div>
      </div>
      <Switch id={id} checked={checked} disabled={disabled} onCheckedChange={onCheckedChange} />
    </div>
  );
}

/** A radio group of pictured choices, as the Dock's and taskbar's options are offered. */
export function PicturedChoices<T extends string>({
  label,
  options,
  value,
  onChange,
  preview,
}: {
  label: string;
  options: { value: T; name: string }[];
  value: T;
  onChange: (value: T) => void;
  preview: (value: T) => React.ReactNode;
}) {
  return (
    <div className={cn('grid gap-2', options.length === 4 ? 'grid-cols-4' : options.length % 3 === 0 ? 'grid-cols-3' : 'grid-cols-2')} role="radiogroup" aria-label={label}>
      {options.map((option) => {
        const active = value === option.value;
        return (
          <button
            key={option.value}
            type="button"
            role="radio"
            aria-checked={active}
            onClick={() => onChange(option.value)}
            className={cn(
              settingsChoiceClass(active),
              'flex min-w-0 flex-col items-center gap-2 p-2',
            )}
          >
            <span aria-hidden className={cn('relative flex h-16 w-full flex-col justify-end overflow-hidden rounded-lg', PREVIEW_WALLPAPER)}>
              {preview(option.value)}
            </span>
            <span className="text-center text-xs">{option.name}</span>
          </button>
        );
      })}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Glass
// ---------------------------------------------------------------------------

type GlassChoice = 'liquid' | 'frosted' | 'solid';

const GLASS_CHOICES: { value: GlassChoice; name: string }[] = [
  { value: 'liquid', name: 'Liquid' },
  { value: 'frosted', name: 'Frosted' },
  { value: 'solid', name: 'Solid' },
];

/** A menu of the given glass over shapes for it to blur and bend; the wrapper names the material, so it shows whatever's chosen. */
function GlassPreview({ material }: { material: GlassChoice }) {
  return (
    <span className="absolute inset-0" style={{ '--glass-material': material } as React.CSSProperties}>
      <span className="absolute top-1 left-2 size-8 rounded-full bg-amber-300" />
      <span className="absolute right-3 bottom-1 h-6 w-12 rotate-12 rounded-md bg-emerald-300" />
      <span className="absolute top-5 left-1/2 h-1.5 w-full -translate-x-1/2 -rotate-6 bg-white/70" />
      <span className="glass-surface absolute inset-x-5 top-2.5 bottom-2.5 flex flex-col justify-center gap-1 rounded-lg px-2">
        <span className="h-1 w-3/4 rounded-full bg-foreground/60" />
        <span className="h-1 w-1/2 rounded-full bg-foreground/40" />
        <span className="h-1 w-2/3 rounded-full bg-foreground/40" />
      </span>
    </span>
  );
}

/** What menus, panels and windows' frames are made of: liquid, frosted, or solid (Accessibility's Reduce transparency). */
export function GlassPicker() {
  const { config, updateConfig } = useAppContext();
  // Solid is Accessibility's Reduce transparency, which Increase contrast implies.
  const material: GlassChoice = config.reduceTransparency || config.increaseContrast ? 'solid' : config.glass;
  return (
    <div>
      <PicturedChoices
        label="Glass"
        options={GLASS_CHOICES}
        value={material}
        onChange={(value) =>
          updateConfig((current) =>
            value === 'solid' ? { ...current, reduceTransparency: true } : { ...current, reduceTransparency: false, glass: value },
          )
        }
        preview={(value) => <GlassPreview material={value} />}
      />
      <p className="mt-2 text-xs text-muted-foreground">
        What menus, popovers, notifications, the menu bar’s panels and windows’ frames are made of.
        {config.increaseContrast && ' Solid while Increase contrast is on, in Accessibility.'}
      </p>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Layout
// ---------------------------------------------------------------------------

/** The desktop's layouts. */
const DESKTOP_LAYOUTS: { value: DesktopLayout; name: string }[] = [
  { value: 'dock', name: 'Menu bar and Dock' },
  { value: 'taskbar', name: 'Taskbar' },
];

/** A small picture of a desktop layout over a wallpaper, for its choice in the picker. */
function LayoutPreview({ layout }: { layout: DesktopLayout }) {
  return (
    <span aria-hidden className={cn('relative flex h-20 w-full flex-col overflow-hidden rounded-lg', PREVIEW_WALLPAPER)}>
      {layout === 'dock' && <span className="h-2 w-full shrink-0 bg-linear-to-b from-black/30 to-transparent" />}
      <span className="relative flex-1">
        <span className="absolute top-3 left-1/4 h-8 w-1/2 rounded-sm bg-white/80 shadow" />
      </span>
      {layout === 'dock' ? (
        <span className="mx-auto mb-1 flex gap-1 rounded-md bg-white/30 px-1.5 py-1 backdrop-blur">
          {PREVIEW_APPS.map((color) => (
            <span key={color} className={cn('size-3 rounded-[3px]', color)} />
          ))}
        </span>
      ) : (
        <span className="flex h-4 w-full shrink-0 items-center gap-1 bg-black/45 px-1">
          <span className="size-3 rounded-full bg-card ring-1 ring-white/40" />
          {PREVIEW_APPS.map((color) => (
            <span key={color} className={cn('size-2.5 rounded-[2px]', color)} />
          ))}
          <span className="ml-auto h-1.5 w-4 rounded-full bg-white/60" />
        </span>
      )}
    </span>
  );
}

/** The menu bar and Dock, or a taskbar. */
export function LayoutPicker() {
  const { config, updateConfig } = useAppContext();
  return (
    <>
      <div className="grid grid-cols-2 gap-2" role="radiogroup" aria-label="Desktop layout">
        {DESKTOP_LAYOUTS.map((option) => {
          const active = config.desktopLayout === option.value;
          return (
            <button
              key={option.value}
              type="button"
              role="radio"
              aria-checked={active}
              onClick={() => updateConfig((current) => ({ ...current, desktopLayout: option.value }))}
              className={cn(
                settingsChoiceClass(active),
                'flex min-w-0 flex-col items-center gap-2 p-2',
              )}
            >
              <LayoutPreview layout={option.value} />
              <span className="text-xs">{option.name}</span>
            </button>
          );
        })}
      </div>
      <p className="text-xs text-muted-foreground">
        The taskbar puts the Start menu, your apps and windows, and the status icons and clock in one bar along an edge of the screen, Windows style. It keeps the Dock’s pinned apps, and apps’ menus move into their windows.
      </p>
    </>
  );
}

// ---------------------------------------------------------------------------
// Motion and effects
// ---------------------------------------------------------------------------

/**
 * Whether motion and effects are on: Accessibility's Reduce motion, the
 * other way round, which Effects leads with as its master switch. The
 * system's preference counts too (src/shared/reducedMotion.ts); on DinOS it's
 * Din's own setting, so it only differs in a browser, where Din can't
 * overrule it.
 */
function useMotion() {
  const { config, updateConfig } = useAppContext();
  const reduced = useReducedMotion();
  return {
    /** Din's own setting allows motion. */
    on: !config.reduceMotion,
    /** Motion is held back, by Din's setting or the system's. */
    held: reduced || config.reduceMotion,
    /** The system asks for reduced motion though Din's setting doesn't. */
    bySystem: reduced && !config.reduceMotion,
    set: (on: boolean) => updateConfig((current) => ({ ...current, reduceMotion: !on })),
  };
}

/** The master switch: Motion and effects. */
export function MotionSwitch() {
  const motion = useMotion();
  const id = `motion-effects-${useId()}`;
  return (
    <SettingSwitchRow
      id={id}
      icon={Sparkles}
      label="Motion and effects"
      description={
        motion.bySystem
          ? 'The system asks for reduced motion, so windows, the Dock and menus don’t animate and the effects below stay still.'
          : 'Windows, the Dock and menus animate, and the effects below play. Off is Reduce motion, in Accessibility, and apps are asked to keep still too.'
      }
      checked={motion.on}
      onCheckedChange={motion.set}
    />
  );
}

/** Dims and disables effects while motion is held back. */
export function MotionGate({ children }: { children: React.ReactNode }) {
  const { held } = useMotion();
  return (
    <fieldset disabled={held} className={cn('m-0 flex min-w-0 flex-col gap-3 border-0 p-0', held && 'opacity-50')}>
      {children}
    </fieldset>
  );
}

/** Why a window's effects are off, under them, while they are. */
export function MotionHeldNote() {
  const { held, bySystem } = useMotion();
  if (!held) return null;
  return (
    <p className="text-xs text-muted-foreground">
      {bySystem
        ? 'Off because the system asks for reduced motion.'
        : 'Off while Motion and effects is off, in Effects (Reduce motion, in Accessibility).'}
    </p>
  );
}

/** Wobbly windows, in Effects and in Windows: one setting in two places. */
export function WobblyWindowsRow() {
  const { config, updateConfig } = useAppContext();
  // Unique, as Settings search can show Effects and Windows at once.
  const id = `wobbly-windows-${useId()}`;
  return (
    <SettingSwitchRow
      id={id}
      icon={Waves}
      label="Wobbly windows"
      description="Windows wriggle like jelly while you drag them, Compiz style."
      checked={config.wobblyWindows}
      onCheckedChange={(checked) => updateConfig((current) => ({ ...current, wobblyWindows: checked }))}
    />
  );
}

/** How windows minimize and close, in Effects and in Windows. */
export function WindowEffectPickers({ windowId }: { windowId: string }) {
  const { config, updateConfig } = useAppContext();
  return (
    <>
      <WindowEffectPicker
        event="minimize"
        label="Minimize effect"
        description="How a window goes into the Dock. It plays backwards when the window comes back."
        windowId={windowId}
        value={config.minimizeEffect}
        onChange={(minimizeEffect) => updateConfig((current) => ({ ...current, minimizeEffect }))}
      />
      <WindowEffectPicker
        event="close"
        label="Close effect"
        description="How a window leaves when it closes."
        windowId={windowId}
        value={config.closeEffect}
        onChange={(closeEffect) => updateConfig((current) => ({ ...current, closeEffect }))}
      />
    </>
  );
}
