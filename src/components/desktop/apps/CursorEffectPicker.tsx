import { useEffect, useRef, useState, type KeyboardEvent, type RefObject } from 'react';
import { Check, ChevronLeft, ChevronRight, MoreHorizontal, Play, Trash2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuTrigger,
} from '@/components/ui/context-menu';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Label } from '@/components/ui/label';
import { Skeleton } from '@/components/ui/skeleton';
import { Switch } from '@/components/ui/switch';
import { useAppContext } from '@/hooks/useAppContext';
import { useCursorEffectPackages, useRemoveCursorEffectPackage } from '@/hooks/useSystemCursor';
import { useToast } from '@/hooks/useToast';
import {
  CLICK_EFFECTS,
  PACKAGE_PREFIX,
  TRAIL_EFFECTS,
  cursorEffectThumbnail,
  cursorEffects,
  forgetPackage,
  forgetThumbnails,
  type PreviewKind,
  type ThumbnailKind,
} from '@/lib/cursorEffects';
import type { Rgb } from '@/lib/cursorEffects/sprites';
import type { CursorEffectPackageInfo } from '@/lib/systemCursor';
import { useCursorEffectTint } from '@/components/desktop/useCursorEffectTint';
import { cn } from '@/lib/utils';

interface Choice {
  id: string;
  name: string;
  /** The imported package it comes from, which can be removed. */
  pkg?: CursorEffectPackageInfo;
}

/** Long enough for a context menu to fade out before a preview starts under it. */
const MENU_FADE_MS = 200;

function choicesFor(kind: 'trail' | 'click', packages: CursorEffectPackageInfo[]): Choice[] {
  const builtIn = kind === 'trail' ? TRAIL_EFFECTS : CLICK_EFFECTS;
  return [
    { id: 'none', name: 'None' },
    ...builtIn.map((e) => ({ id: e.id, name: e.name })),
    ...packages
      .filter((p) => (kind === 'trail' ? p.trail : p.effects.length > 0))
      .map((p) => ({ id: `${PACKAGE_PREFIX}${p.id}`, name: p.name, pkg: p })),
  ];
}

/** Show an effect off over `ref`'s element. */
function previewOver(ref: RefObject<HTMLElement | null>, kind: PreviewKind, id: string): void {
  const rect = ref.current?.getBoundingClientRect();
  if (rect && id !== 'none') cursorEffects.preview(kind, id, { x: rect.left, y: rect.top, width: rect.width, height: rect.height });
}

/**
 * Cursor effects, for Settings → Cursors: a carousel of trails and one of
 * click effects (built in, and any imported with a CursorFX file), then
 * Compiz's Show Mouse, Fire Paint and Water to switch on. Choosing an effect
 * plays it over the picker.
 */
export function CursorEffectsSettings() {
  const { config, updateConfig } = useAppContext();
  const packages = useCursorEffectPackages();
  const removePackage = useRemoveCursorEffectPackage();
  const { toast } = useToast();

  const remove = (pkg: CursorEffectPackageInfo) => {
    const choice = `${PACKAGE_PREFIX}${pkg.id}`;
    removePackage.mutate(pkg.id, {
      onSuccess: () => {
        forgetPackage(choice);
        forgetThumbnails(choice);
        updateConfig((current) => ({
          ...current,
          cursorTrail: current.cursorTrail === choice ? 'none' : current.cursorTrail,
          cursorClick: current.cursorClick === choice ? 'none' : current.cursorClick,
        }));
      },
      onError: (error) => {
        toast({
          title: `Couldn’t remove ${pkg.name}`,
          description: error instanceof Error ? error.message : undefined,
          variant: 'destructive',
        });
      },
    });
  };

  const imported = packages.data ?? [];
  const tint = useCursorEffectTint(config.cursorThemeColor);
  return (
    <div className="flex flex-col gap-3">
      <EffectCarousel
        kind="trail"
        label="Trail"
        description="What the pointer leaves behind as it moves."
        choices={choicesFor('trail', imported)}
        value={config.cursorTrail}
        tint={tint}
        onChange={(cursorTrail) => updateConfig((current) => ({ ...current, cursorTrail }))}
        onRemove={remove}
      />
      <EffectCarousel
        kind="click"
        label="Click effect"
        description="What a click sets off where it lands."
        choices={choicesFor('click', imported)}
        value={config.cursorClick}
        tint={tint}
        onChange={(cursorClick) => updateConfig((current) => ({ ...current, cursorClick }))}
        onRemove={remove}
      />
      <div className="flex items-center gap-3 rounded-md border bg-muted/20 p-3">
        <div className="min-w-0 flex-1">
          <Label htmlFor="cursor-theme-color" className="cursor-pointer text-sm">
            Match theme color
          </Label>
          <p className="text-xs text-muted-foreground">
            Trails, click effects, Show Mouse and Fire Paint take on your theme’s color. Imported effects keep their own.
          </p>
        </div>
        <Switch
          id="cursor-theme-color"
          checked={config.cursorThemeColor}
          onCheckedChange={(cursorThemeColor) => updateConfig((current) => ({ ...current, cursorThemeColor }))}
        />
      </div>
      <div className="flex items-center gap-3 rounded-md border bg-muted/20 p-3">
        <div className="min-w-0 flex-1">
          <Label htmlFor="cursor-shake-to-find" className="cursor-pointer text-sm">
            Shake to find the pointer
          </Label>
          <p className="text-xs text-muted-foreground">
            Shake the mouse and the pointer grows for a moment, the bigger the harder you shake, so you can spot it.
          </p>
        </div>
        <Switch
          id="cursor-shake-to-find"
          checked={config.cursorShakeToFind}
          onCheckedChange={(cursorShakeToFind) => updateConfig((current) => ({ ...current, cursorShakeToFind }))}
        />
      </div>
      <PluginRow
        kind="show-mouse"
        title="Show Mouse"
        description="Press Super+Shift+K, or shake the mouse, to ring the pointer with light."
        checked={config.cursorShowMouse}
        tint={tint}
        onCheckedChange={(cursorShowMouse) => updateConfig((current) => ({ ...current, cursorShowMouse }))}
      />
      <PluginRow
        kind="fire-paint"
        title="Fire Paint"
        description="Hold Super+Shift and drag to draw in fire. Super+Shift+C puts it out."
        checked={config.cursorFirePaint}
        tint={tint}
        onCheckedChange={(cursorFirePaint) => updateConfig((current) => ({ ...current, cursorFirePaint }))}
      />
      <PluginRow
        kind="water"
        title="Water"
        description="Hold Super+Ctrl and move the mouse to stir the screen like a pond."
        checked={config.cursorWater}
        tint={null}
        onCheckedChange={(cursorWater) => updateConfig((current) => ({ ...current, cursorWater }))}
      />
      <p className="text-xs text-muted-foreground">
        Import a CursorFX theme or effects package with “Import file…” above to add its trail and click effect here.
        Effects are off while your system asks for reduced motion.
      </p>
    </div>
  );
}

function EffectCarousel({
  kind,
  label,
  description,
  choices,
  value,
  tint,
  onChange,
  onRemove,
}: {
  kind: 'trail' | 'click';
  label: string;
  description: string;
  choices: Choice[];
  value: string;
  /** The theme's color the pictures show effects in, or null for their own. */
  tint: Rgb | null;
  onChange: (value: string) => void;
  onRemove: (pkg: CursorEffectPackageInfo) => void;
}) {
  const card = useRef<HTMLDivElement>(null);
  const scroller = useRef<HTMLDivElement>(null);
  const [edges, setEdges] = useState({ start: true, end: false });
  const labelId = `cursor-${kind}-label`;
  const tabbable = choices.some((c) => c.id === value) ? value : choices[0].id;

  const updateEdges = () => {
    const el = scroller.current;
    if (!el) return;
    setEdges({ start: el.scrollLeft <= 1, end: el.scrollLeft + el.clientWidth >= el.scrollWidth - 1 });
  };

  useEffect(() => {
    const el = scroller.current;
    el?.querySelector<HTMLElement>('[aria-checked="true"]')?.scrollIntoView({ block: 'nearest', inline: 'center' });
    updateEdges();
    if (!el) return;
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
    previewOver(card, kind, id);
  };
  const later = (fn: () => void) => window.setTimeout(fn, MENU_FADE_MS);

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
    tiles[next].scrollIntoView({ block: 'nearest', inline: 'nearest', behavior: 'smooth' });
  };

  return (
    <div ref={card} className="flex flex-col gap-3 rounded-md border bg-muted/20 p-3">
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
            kind={kind}
            choice={choice}
            selected={choice.id === value}
            tabbable={choice.id === tabbable}
            tint={choice.pkg ? null : tint}
            onChoose={() => choose(choice.id)}
            onUse={() => {
              onChange(choice.id);
              later(() => previewOver(card, kind, choice.id));
            }}
            onPreview={() => later(() => previewOver(card, kind, choice.id))}
            onRemove={choice.pkg ? () => onRemove(choice.pkg!) : undefined}
          />
        ))}
      </div>
    </div>
  );
}

function EffectTile({
  kind,
  choice,
  selected,
  tabbable,
  tint,
  onChoose,
  onUse,
  onPreview,
  onRemove,
}: {
  kind: 'trail' | 'click';
  choice: Choice;
  selected: boolean;
  tabbable: boolean;
  tint: Rgb | null;
  onChoose: () => void;
  onUse: () => void;
  onPreview: () => void;
  onRemove?: () => void;
}) {
  const canPreview = choice.id !== 'none';
  return (
    <ContextMenu>
      <ContextMenuTrigger asChild>
        <div className="relative shrink-0 snap-start">
          <button
            type="button"
            role="radio"
            aria-checked={selected}
            title={choice.name}
            tabIndex={tabbable ? 0 : -1}
            onClick={onChoose}
            className={cn(
              'group flex w-36 flex-col gap-2 rounded-xl border p-2 text-left',
              'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
              'motion-safe:transition-colors',
              selected
                ? 'border-primary bg-primary/10 text-foreground'
                : 'border-border/60 text-muted-foreground hover:bg-foreground/5 hover:text-foreground',
            )}
          >
            <div className="relative aspect-[8/5] w-full overflow-hidden rounded-lg bg-muted">
              {choice.id === 'none' ? (
                <div className="size-full bg-gradient-to-br from-indigo-950 via-indigo-900 to-slate-900" aria-hidden />
              ) : (
                <EffectPicture kind={kind} id={choice.id} tint={tint} />
              )}
              {selected && (
                <span className="absolute right-1 top-1 flex size-5 items-center justify-center rounded-full bg-primary text-primary-foreground shadow-sm">
                  <Check className="size-3.5" aria-hidden />
                </span>
              )}
            </div>
            <span className={cn('w-full truncate px-1 text-sm', onRemove && 'pr-7')}>{choice.name}</span>
          </button>
          {onRemove && (
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  tabIndex={tabbable ? 0 : -1}
                  className="absolute bottom-1 right-1 size-7 text-muted-foreground"
                  aria-label={`More for ${choice.name}`}
                >
                  <MoreHorizontal aria-hidden />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end">
                <DropdownMenuItem disabled={selected} onSelect={onUse}>
                  <Check aria-hidden />
                  Use this effect
                </DropdownMenuItem>
                <DropdownMenuItem onSelect={onPreview}>
                  <Play aria-hidden />
                  Preview
                </DropdownMenuItem>
                <DropdownMenuSeparator />
                <DropdownMenuItem variant="destructive" onSelect={onRemove}>
                  <Trash2 aria-hidden />
                  Remove
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          )}
        </div>
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
        {onRemove && (
          <>
            <ContextMenuSeparator />
            <ContextMenuItem variant="destructive" onSelect={onRemove}>
              <Trash2 aria-hidden />
              Remove
            </ContextMenuItem>
          </>
        )}
      </ContextMenuContent>
    </ContextMenu>
  );
}

/** A picture of an effect (cursorEffectThumbnail), with a skeleton while it's drawn. */
export function EffectPicture({ kind, id, tint }: { kind: ThumbnailKind; id: string; tint: Rgb | null }) {
  const [url, setUrl] = useState<string | null | undefined>(undefined);
  useEffect(() => {
    let live = true;
    cursorEffectThumbnail(kind, id, tint).then((u) => {
      if (live) setUrl(u);
    });
    return () => {
      live = false;
    };
  }, [kind, id, tint]);
  if (url === undefined) return <Skeleton className="size-full rounded-none" aria-hidden />;
  if (url === null) return <div className="size-full bg-gradient-to-br from-indigo-950 via-indigo-900 to-slate-900" aria-hidden />;
  return <img src={url} alt="" draggable={false} className="size-full object-cover" />;
}

/** One of Compiz's plugins: its picture (click to see it), what it does, and its switch. */
function PluginRow({
  kind,
  title,
  description,
  checked,
  tint,
  onCheckedChange,
}: {
  kind: 'show-mouse' | 'fire-paint' | 'water';
  title: string;
  description: string;
  checked: boolean;
  tint: Rgb | null;
  onCheckedChange: (checked: boolean) => void;
}) {
  const row = useRef<HTMLDivElement>(null);
  const id = `cursor-${kind}`;
  return (
    <div ref={row} className="flex items-center gap-3 rounded-md border bg-muted/20 p-3">
      <button
        type="button"
        onClick={() => previewOver(row, kind, kind)}
        aria-label={`Preview ${title}`}
        className="aspect-[8/5] w-24 shrink-0 overflow-hidden rounded-lg bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
      >
        <EffectPicture kind={kind} id={kind} tint={tint} />
      </button>
      <div className="min-w-0 flex-1">
        <Label htmlFor={id} className="cursor-pointer text-sm">
          {title}
        </Label>
        <p className="text-xs text-muted-foreground">{description}</p>
      </div>
      <Switch
        id={id}
        checked={checked}
        onCheckedChange={(on) => {
          onCheckedChange(on);
          if (on) previewOver(row, kind, kind);
        }}
      />
    </div>
  );
}
