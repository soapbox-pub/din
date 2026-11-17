import { useState } from 'react';
import type { ReactNode } from 'react';
import { ArrowLeft, ImageUp, Settings as SettingsIcon } from 'lucide-react';
import type { AppComponentProps } from '@/lib/apps';
import { cn } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import { useWindowActions } from '@/contexts/WindowManagerContext';
import { useDesktopBackground } from '@/contexts/DesktopBackgroundContext';
import { useDesktopThemeEditor, type AppearanceMode } from '@/hooks/useDesktopTheme';
import { bundledIconProps } from '@/shared/iconSizes';
import { SettingsSubHeading } from '@/shared/settingsSection';
import {
  GlassPicker,
  LayoutPicker,
  MotionGate,
  MotionSwitch,
  PicturedChoices,
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
          ? 'Light or dark, or a theme of your own colors and a picture of your choosing.'
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

const THEME_CHOICES: { value: AppearanceMode; name: string }[] = [
  { value: 'light', name: 'Light' },
  { value: 'dark', name: 'Dark' },
  { value: 'custom', name: 'Custom' },
];

/** A window in a light or dark theme, or in the theme worn (Custom), over the miniature wallpaper. */
function ThemePreview({ mode }: { mode: AppearanceMode }) {
  const surface =
    mode === 'light' ? 'bg-white' : mode === 'dark' ? 'bg-neutral-900' : 'bg-background';
  const line = mode === 'light' ? 'bg-neutral-900/50' : mode === 'dark' ? 'bg-white/60' : 'bg-foreground/50';
  // Custom is a theme of one's own colors: a spread of them, whatever is worn.
  const accent = mode === 'custom' ? 'bg-linear-to-r from-amber-400 via-pink-500 to-sky-500' : mode === 'light' ? 'bg-sky-500' : 'bg-sky-400';
  return (
    <span className={cn('absolute inset-x-4 top-2.5 bottom-0 flex flex-col gap-1 rounded-t-md p-2 shadow', surface)}>
      <span className={cn('h-1.5 w-1/3 rounded-full', accent)} />
      <span className={cn('h-1 w-3/4 rounded-full', line)} />
      <span className={cn('h-1 w-1/2 rounded-full', line)} />
    </span>
  );
}

function ThemeStep() {
  const editor = useDesktopThemeEditor();
  const { chooseBackground } = useDesktopBackground();
  return (
    <>
      <PicturedChoices
        label="Theme"
        options={THEME_CHOICES}
        value={editor.mode}
        onChange={editor.setMode}
        preview={(mode) => <ThemePreview mode={mode} />}
      />
      <div className="flex flex-wrap items-center gap-3">
        <Button variant="outline" onClick={() => void chooseBackground()}>
          <ImageUp className="size-4.5" aria-hidden />
          Choose a background picture…
        </Button>
        <p className="min-w-0 flex-1 text-xs text-muted-foreground">
          A picture makes a custom theme from what you’re wearing. Settings → Themes edits its colors and fonts.
        </p>
      </div>
      <SettingsSubHeading className="px-0">Glass</SettingsSubHeading>
      <GlassPicker />
    </>
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
