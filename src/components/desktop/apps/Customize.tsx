import { useEffect, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { ArrowLeft, Check, Settings as SettingsIcon, Store } from 'lucide-react';
import type { AppComponentProps } from '@/lib/apps';
import { cn } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { useWindowActions } from '@/contexts/WindowManagerContext';
import { useAuthor } from '@/hooks/useAuthor';
import { useDesktopThemeEditor, type ThemeSnapshot } from '@/hooks/useDesktopTheme';
import { useThemeActions, useThemeCatalog } from '@/hooks/useThemes';
import { useToast } from '@/hooks/useToast';
import { PRESET_THEME_COLORS, sameThemeLook, type DesktopTheme } from '@/lib/profileTheme';
import { themeCoordinate, type ThemeDefinition } from '@/lib/themeDefinition';
import { bundledIconProps } from '@/shared/iconSizes';
import { settingsChoiceClass } from '@/shared/settingsChromeStyles';
import { useSeen } from '@/shared/store/useSeen';
import { ThemeSwatch } from '@/shared/ThemeSwatch';
import { SettingsSubHeading } from '@/shared/settingsSection';
import {
  GlassPicker,
  LayoutPicker,
  MotionGate,
  MotionSwitch,
  WindowEffectPickers,
  WobblyWindowsRow,
} from '@/components/desktop/apps/appearanceControls';

/**
 * Customize: a few choices to make Din one's own, a step at a time, opened
 * once when someone first uses Din (CustomizeAutoOpen) and from the Dock,
 * beside Settings, after. Each step is the same control Settings has
 * (appearanceControls.tsx), so what's chosen here is what Settings shows.
 */

const CUSTOMIZE_ICON = '/icons/apps/customize.png';

const STEPS = ['welcome', 'theme', 'layout', 'effects', 'done'] as const;
type Step = (typeof STEPS)[number];

export function Customize({ windowId }: AppComponentProps) {
  const [step, setStep] = useState<Step>('welcome');
  const { open, close } = useWindowActions();
  const index = STEPS.indexOf(step);
  const back = index > 0 ? () => setStep(STEPS[index - 1]) : undefined;
  const next = () => setStep(STEPS[Math.min(index + 1, STEPS.length - 1)]);

  if (step === 'welcome') {
    return (
      <Hero
        title="Make Din yours"
        body="Pick a theme, how the desktop is laid out, and how much it moves. It takes a minute, and everything here is in Settings too, to change any time."
      >
        <Button size="lg" onClick={next}>
          Get started
        </Button>
        <Button variant="ghost" onClick={() => close(windowId)}>
          Not now
        </Button>
      </Hero>
    );
  }

  if (step === 'done') {
    return (
      <Hero
        title="You’re all set"
        body="Customize stays in the Dock, beside Settings, for whenever you want a change. Settings has the rest: fonts and colors, cursors, icons, the Dock’s size and more."
        onBack={back}
      >
        <Button size="lg" onClick={() => close(windowId)}>
          Done
        </Button>
        <Button
          variant="ghost"
          onClick={() => {
            open('settings');
            close(windowId);
          }}
        >
          <SettingsIcon className="size-4.5" aria-hidden />
          Open Settings
        </Button>
      </Hero>
    );
  }

  return (
    <Page
      step={index}
      title={step === 'theme' ? 'Choose a look' : step === 'layout' ? 'Lay out the desktop' : 'Motion and effects'}
      description={
        step === 'theme'
          ? 'Light, dark, or a theme someone made: colors, fonts and a picture for your desktop. Click one to wear it.'
          : step === 'layout'
            ? 'A menu bar across the top and a Dock of apps below, or one taskbar holding both.'
            : 'Windows can wobble as you drag them and play an effect as they minimize and close. Turn it all off for a calmer desktop.'
      }
      onBack={back}
      onNext={next}
    >
      {step === 'theme' ? <ThemeStep /> : step === 'layout' ? <LayoutPicker /> : <EffectsStep windowId={windowId} />}
    </Page>
  );
}

/** A built-in theme, drawn as ThemeSwatch draws a named one. */
const BUILT_IN: { mode: 'light' | 'dark'; name: string; theme: DesktopTheme }[] = [
  { mode: 'light', name: 'Light', theme: { colors: PRESET_THEME_COLORS.light, fonts: {} } },
  { mode: 'dark', name: 'Dark', theme: { colors: PRESET_THEME_COLORS.dark, fonts: {} } },
];

/**
 * Light, Dark, and the named themes the App Store lists (useThemeCatalog),
 * as cards to click. A named theme is worn at once but held from the
 * profile theme until leaving the step, so clicking around publishes
 * nothing; the one chosen is then sent, and added to the user's themes, as
 * the App Store's Use does. Choosing Light or Dark after one puts back what
 * was worn first, so what was only tried never goes out.
 */
function ThemeStep() {
  const editor = useDesktopThemeEditor();
  const themeActions = useThemeActions();
  const catalog = useThemeCatalog();
  const { open } = useWindowActions();
  const { toast } = useToast();
  // What was worn before the first named theme, and the one chosen now.
  const [chosen, setChosen] = useState<{ theme: ThemeDefinition; previous: ThemeSnapshot } | null>(null);

  const live = useRef({ chosen, editor, themeActions });
  useEffect(() => {
    live.current = { chosen, editor, themeActions };
  });
  useEffect(() => () => {
    const { chosen: c, editor: e, themeActions: t } = live.current;
    if (!c) return;
    e.commit();
    if (!t.isAdded(c.theme)) t.add(c.theme);
  }, []);

  const isWorn = (theme: ThemeDefinition) =>
    !!editor.theme &&
    editor.theme.source?.pubkey === theme.pubkey &&
    editor.theme.source.identifier === theme.identifier &&
    sameThemeLook(editor.theme, theme.theme);

  const wearBuiltIn = (mode: 'light' | 'dark') => {
    if (chosen) {
      editor.restore(chosen.previous);
      setChosen(null);
    }
    editor.setMode(mode);
  };

  const wear = (theme: ThemeDefinition) => {
    if (isWorn(theme)) return;
    try {
      const previous = chosen?.previous ?? editor.snapshot();
      editor.apply(theme.theme, { hold: 'until-commit' });
      setChosen({ theme, previous });
    } catch (error) {
      toast({ title: 'Couldn’t use this theme', description: error instanceof Error ? error.message : String(error), variant: 'destructive' });
    }
  };

  const themes = catalog.data ?? [];
  return (
    <>
      <div role="radiogroup" aria-label="Theme" className="grid grid-cols-[repeat(auto-fill,minmax(10.5rem,1fr))] gap-3">
        {BUILT_IN.map((option) => (
          <ThemeCard
            key={option.mode}
            name={option.name}
            byline="Din"
            theme={option.theme}
            selected={!editor.theme && editor.mode === option.mode}
            onSelect={() => wearBuiltIn(option.mode)}
          />
        ))}
        {themes.map((theme) => (
          <ThemeCard
            key={themeCoordinate(theme)}
            name={theme.title}
            pubkey={theme.pubkey}
            theme={theme.theme}
            selected={isWorn(theme)}
            onSelect={() => wear(theme)}
          />
        ))}
        {catalog.isPending &&
          Array.from({ length: 4 }, (_, i) => (
            <div key={i} className="flex flex-col gap-2 rounded-xl p-2" aria-hidden>
              <Skeleton className="aspect-video w-full rounded-lg" />
              <Skeleton className="h-4 w-2/3" />
            </div>
          ))}
      </div>
      {catalog.isError && !themes.length && (
        <p className="text-xs text-muted-foreground">
          Themes from Din’s publishers and the people you follow couldn’t load. Check your connection, or find them in the App Store later.
        </p>
      )}
      <div className="flex flex-wrap items-center gap-3">
        <Button variant="outline" onClick={() => open('app-store', { tab: 'themes' })}>
          <Store className="size-4.5" aria-hidden />
          More in the App Store
        </Button>
        <p className="min-w-0 flex-1 text-xs text-muted-foreground">
          Settings → Themes makes one of your own, from colors, fonts and a picture.
        </p>
      </div>
      <SettingsSubHeading className="px-0">Glass</SettingsSubHeading>
      <GlassPicker />
    </>
  );
}

/** A theme to choose, as the App Store's cards show one: its swatch, its name, and who made it. */
function ThemeCard({
  name,
  byline,
  pubkey,
  theme,
  selected,
  onSelect,
}: {
  name: string;
  byline?: string;
  pubkey?: string;
  theme: DesktopTheme;
  selected: boolean;
  onSelect: () => void;
}) {
  const [ref, seen] = useSeen<HTMLButtonElement>();
  const author = useAuthor(seen ? pubkey : undefined);
  const metadata = author.data?.metadata;
  const by = byline ?? ((metadata?.display_name || metadata?.name)?.trim() || null);
  return (
    <button
      ref={ref}
      type="button"
      role="radio"
      aria-checked={selected}
      onClick={onSelect}
      className={cn(settingsChoiceClass(selected), 'relative flex min-w-0 flex-col gap-2 p-2 text-left')}
    >
      {seen ? (
        <ThemeSwatch theme={theme} className="rounded-lg border border-border" />
      ) : (
        <Skeleton className="aspect-video w-full rounded-lg" />
      )}
      {selected && (
        <span className="absolute top-3 right-3 flex size-5 items-center justify-center rounded-full bg-primary text-primary-foreground shadow">
          <Check className="size-3.5" strokeWidth={2.5} aria-hidden />
        </span>
      )}
      <span className="min-w-0 px-1">
        <span className="block truncate text-sm font-medium text-foreground" title={name}>{name}</span>
        <span className="block truncate text-xs text-muted-foreground">{by ? `by ${by}` : 'Theme'}</span>
      </span>
    </button>
  );
}

function EffectsStep({ windowId }: { windowId: string }) {
  return (
    <>
      <MotionSwitch />
      <MotionGate>
        <WobblyWindowsRow />
        <WindowEffectPickers windowId={windowId} />
      </MotionGate>
      <p className="text-xs text-muted-foreground">
        Cursor trails, click effects and sparks as you type are in Settings → Effects.
      </p>
    </>
  );
}

/** The welcome and the end: the app's icon, a heading, a line, and what to do next. */
function Hero({
  title,
  body,
  onBack,
  children,
}: {
  title: string;
  body: string;
  onBack?: () => void;
  children: ReactNode;
}) {
  return (
    <div className="@container relative flex h-full flex-col items-center justify-center gap-6 overflow-y-auto bg-background p-8 text-center">
      {onBack && (
        <Button variant="ghost" size="icon" onClick={onBack} aria-label="Back" className="absolute top-4 left-4">
          <ArrowLeft className="size-4.5" />
        </Button>
      )}
      <img {...bundledIconProps(CUSTOMIZE_ICON)} alt="" className="size-28 shrink-0 motion-safe:animate-in motion-safe:zoom-in-90 motion-safe:fade-in" />
      <div className="max-w-md space-y-3">
        <h1 className="font-[family-name:var(--font-title)] text-3xl font-semibold tracking-tight text-foreground @lg:text-4xl">
          {title}
        </h1>
        <p className="text-base text-muted-foreground">{body}</p>
      </div>
      <div className="flex flex-col items-center gap-2">{children}</div>
    </div>
  );
}

/** A step's page: its heading, the choices, and a footer with where it is in the flow, Back and Next. */
function Page({
  step,
  title,
  description,
  onBack,
  onNext,
  children,
}: {
  step: number;
  title: string;
  description: string;
  onBack?: () => void;
  onNext: () => void;
  children: ReactNode;
}) {
  return (
    <div className="flex h-full flex-col bg-background">
      <div className="min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto flex max-w-2xl flex-col gap-4 p-6 [&>*]:shrink-0">
          <div className="space-y-1">
            <h1 className="font-[family-name:var(--font-title)] text-2xl font-semibold tracking-tight text-foreground">{title}</h1>
            <p className="text-sm text-muted-foreground">{description}</p>
          </div>
          {children}
        </div>
      </div>
      <div className="flex items-center gap-2 border-t border-border/60 px-6 py-4">
        <StepDots current={step} />
        <div className="flex-1" />
        {onBack && (
          <Button variant="ghost" onClick={onBack}>
            Back
          </Button>
        )}
        <Button onClick={onNext}>Next</Button>
      </div>
    </div>
  );
}

/** Where a step is among the ones with choices (the welcome and the end aren't counted). */
function StepDots({ current }: { current: number }) {
  const total = STEPS.length - 2;
  return (
    <span className="flex items-center gap-1.5" role="img" aria-label={`Step ${current} of ${total}`}>
      {Array.from({ length: total }, (_, i) => (
        <span
          key={i}
          className={cn(
            'h-2 rounded-full transition-[width,background-color] motion-reduce:transition-none',
            i + 1 === current ? 'w-6 bg-primary' : 'w-2 bg-foreground/20',
          )}
        />
      ))}
    </span>
  );
}
