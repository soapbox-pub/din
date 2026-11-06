import { useEffect, useRef, useState, type KeyboardEvent } from 'react';
import { Check, ChevronLeft, ChevronRight, Play, Shuffle } from 'lucide-react';
import { Button } from '@/components/ui/button';
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuTrigger,
} from '@/components/ui/context-menu';
import { Skeleton } from '@/components/ui/skeleton';
import { effectsFor, type EffectEvent } from '@/lib/effects';
import { previewEffect } from '@/lib/effects/preview';
import { effectThumbnail, type ThumbnailSubject } from '@/lib/effects/thumbnail';
import { getScreenshotBridge } from '@/lib/screenshot';
import { revealInCarousel } from '@/lib/carousel';
import { cn } from '@/lib/utils';
import { settingsCard, settingsChoiceClass } from '@/shared/settingsChromeStyles';

interface EffectChoice {
  id: string;
  name: string;
  /** What its picture shows; Random shows a few of the others. */
  subject: ThumbnailSubject | 'random';
}

/** The effects Random's picture shows, where offered. */
const RANDOM_SAMPLE = ['burn', 'explode', 'magic-lamp', 'airplane', 'helix', 'shatter'];

/** Long enough for a context menu to fade out before the window is snapshotted. */
const MENU_FADE_MS = 200;

function choicesFor(event: EffectEvent): EffectChoice[] {
  return [
    { id: 'none', name: 'None', subject: 'none' },
    ...(event === 'close' ? [{ id: 'pop', name: 'Pop', subject: 'pop' } as const] : []),
    { id: 'random', name: 'Random', subject: 'random' },
    ...effectsFor(event).map((e) => ({ id: e.id, name: e.name, subject: e })),
  ];
}

/**
 * Choose a window effect for one event, from the Compiz animation plugins'
 * (src/lib/effects): a carousel of tiles, each with a picture of its effect
 * mid-flight. Choosing one plays it on the Settings window. Effects other
 * than the genie and the pop need the shell's screen capture, so outside it
 * windows fall back to those.
 */
export function WindowEffectPicker({
  event,
  label,
  description,
  windowId,
  value,
  onChange,
}: {
  event: EffectEvent;
  label: string;
  description: string;
  windowId: string;
  value: string;
  onChange: (value: string) => void;
}) {
  const choices = choicesFor(event);
  const canCapture = !!getScreenshotBridge()?.captureRegion;
  const scroller = useRef<HTMLDivElement>(null);
  const [edges, setEdges] = useState({ start: true, end: false });
  const labelId = `${event}-effect-label`;
  // An unknown choice (a setting from a newer Din) leaves the first tile tabbable.
  const tabbable = choices.some((c) => c.id === value) ? value : choices[0].id;

  const updateEdges = () => {
    const el = scroller.current;
    if (!el) return;
    setEdges({
      start: el.scrollLeft <= 1,
      end: el.scrollLeft + el.clientWidth >= el.scrollWidth - 1,
    });
  };

  // Open on the page with the current choice.
  useEffect(() => {
    const el = scroller.current;
    if (!el) return;
    revealInCarousel(el, el.querySelector<HTMLElement>('[aria-checked="true"]'), { center: true });
    updateEdges();
    const observer = new ResizeObserver(updateEdges);
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  const page = (direction: 1 | -1) => {
    const el = scroller.current;
    if (el) el.scrollBy({ left: direction * el.clientWidth, behavior: 'smooth' });
  };

  const choose = (id: string) => {
    onChange(id);
    previewEffect(windowId, event, id);
  };
  // From the context menu, once it has faded out of the snapshot.
  const previewLater = (id: string) =>
    window.setTimeout(() => previewEffect(windowId, event, id), MENU_FADE_MS);

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    const tiles = Array.from(e.currentTarget.querySelectorAll<HTMLElement>('[role="radio"]'));
    const at = tiles.indexOf(document.activeElement as HTMLElement);
    if (at < 0) return;
    const next =
      e.key === 'ArrowRight' ? Math.min(at + 1, tiles.length - 1)
      : e.key === 'ArrowLeft' ? Math.max(at - 1, 0)
      : e.key === 'Home' ? 0
      : e.key === 'End' ? tiles.length - 1
      : -1;
    if (next < 0) return;
    e.preventDefault();
    tiles[next].focus({ preventScroll: true });
    if (scroller.current) revealInCarousel(scroller.current, tiles[next], { smooth: true });
  };

  return (
    <div className={cn(settingsCard, 'flex flex-col gap-3 px-4 py-3')}>
      <div className="flex items-start gap-2">
        <div className="min-w-0 flex-1">
          <p id={labelId} className="text-sm font-medium">{label}</p>
          <p className="text-xs text-muted-foreground">{description}</p>
        </div>
        <Button
          variant="outline"
          size="icon"
          className="size-8 shrink-0"
          disabled={edges.start}
          onClick={() => page(-1)}
          aria-label={`Previous ${label.toLowerCase()}s`}
        >
          <ChevronLeft aria-hidden />
        </Button>
        <Button
          variant="outline"
          size="icon"
          className="size-8 shrink-0"
          disabled={edges.end}
          onClick={() => page(1)}
          aria-label={`More ${label.toLowerCase()}s`}
        >
          <ChevronRight aria-hidden />
        </Button>
      </div>
      <div
        ref={scroller}
        role="radiogroup"
        aria-labelledby={labelId}
        onScroll={updateEdges}
        onKeyDown={onKeyDown}
        className="-mx-1 flex snap-x snap-mandatory scroll-px-1 gap-2 overflow-x-auto px-1 pb-2 pt-1 motion-safe:scroll-smooth"
      >
        {choices.map((choice) => (
          <EffectTile
            key={choice.id}
            choice={choice}
            event={event}
            offered={choices}
            selected={choice.id === value}
            tabbable={choice.id === tabbable}
            onChoose={() => choose(choice.id)}
            onUse={() => {
              onChange(choice.id);
              previewLater(choice.id);
            }}
            onPreview={() => previewLater(choice.id)}
          />
        ))}
      </div>
      {!canCapture && (
        <p className="text-xs text-muted-foreground">
          In a browser, windows use the {event === 'close' ? 'pop' : 'genie'} whatever you choose.
        </p>
      )}
    </div>
  );
}

function EffectTile({
  choice,
  event,
  offered,
  selected,
  tabbable,
  onChoose,
  onUse,
  onPreview,
}: {
  choice: EffectChoice;
  event: EffectEvent;
  offered: EffectChoice[];
  selected: boolean;
  tabbable: boolean;
  onChoose: () => void;
  onUse: () => void;
  onPreview: () => void;
}) {
  const canPreview = choice.id !== 'none';
  return (
    <ContextMenu>
      <ContextMenuTrigger asChild>
        <button
          type="button"
          role="radio"
          aria-checked={selected}
          title={choice.name}
          tabIndex={tabbable ? 0 : -1}
          onClick={onChoose}
          className={cn(
            settingsChoiceClass(selected),
            'group flex w-36 shrink-0 snap-start flex-col gap-2 p-2 text-left',
            'motion-safe:transition-colors',
          )}
        >
          <div className="relative aspect-[8/5] w-full overflow-hidden rounded-lg bg-muted">
            {choice.subject === 'random' ? (
              <RandomPicture event={event} offered={offered} />
            ) : (
              <EffectPicture subject={choice.subject} event={event} />
            )}
            {selected && (
              <span className="absolute right-1 top-1 flex size-5 items-center justify-center rounded-full bg-pigment text-primary-foreground clay-pigment">
                <Check className="size-3.5" aria-hidden />
              </span>
            )}
          </div>
          <span className="w-full truncate px-1 text-sm">{choice.name}</span>
        </button>
      </ContextMenuTrigger>
      <ContextMenuContent>
        <ContextMenuItem disabled={selected} onSelect={onUse}>
          <Check aria-hidden />
          Use this effect
        </ContextMenuItem>
        <ContextMenuItem disabled={!canPreview} onSelect={onPreview}>
          <Play aria-hidden />
          Preview
        </ContextMenuItem>
      </ContextMenuContent>
    </ContextMenu>
  );
}

function useThumbnail(subject: ThumbnailSubject, event: EffectEvent): string | null | undefined {
  const [url, setUrl] = useState<string | null | undefined>(undefined);
  useEffect(() => {
    let live = true;
    effectThumbnail(subject, event).then((u) => {
      if (live) setUrl(u);
    });
    return () => {
      live = false;
    };
  }, [subject, event]);
  return url;
}

function EffectPicture({ subject, event, className }: { subject: ThumbnailSubject; event: EffectEvent; className?: string }) {
  const url = useThumbnail(subject, event);
  if (url === undefined) return <Skeleton className={cn('size-full rounded-none', className)} aria-hidden />;
  if (url === null) return <div className={cn('size-full bg-muted', className)} aria-hidden />;
  return <img src={url} alt="" draggable={false} className={cn('size-full object-cover', className)} />;
}

/** A mosaic of a few effects, under a shuffle badge. */
function RandomPicture({ event, offered }: { event: EffectEvent; offered: EffectChoice[] }) {
  const sample = RANDOM_SAMPLE.flatMap((id) => {
    const subject = offered.find((c) => c.id === id)?.subject;
    return subject && subject !== 'random' ? [subject] : [];
  }).slice(0, 4);
  return (
    <>
      <div className="grid size-full grid-cols-2 grid-rows-2">
        {sample.map((subject) => (
          <EffectPicture key={typeof subject === 'string' ? subject : subject.id} subject={subject} event={event} />
        ))}
      </div>
      <span className="absolute inset-0 flex items-center justify-center">
        <span className="flex size-9 items-center justify-center rounded-full bg-background/85 text-foreground shadow-md">
          <Shuffle className="size-4.5" strokeWidth={1.75} aria-hidden />
        </span>
      </span>
    </>
  );
}
