import { useEffect, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Check, Loader2, MousePointer2 } from 'lucide-react';
import { cn } from '@/lib/utils';
import { fileUrl } from '@/lib/fs';
import { ImportError, convertCursors } from '@/lib/cursorImport/convert';
import { chromiumDecoder } from '@/lib/cursorImport/decoder';
import { frameUrl, framesNear } from '@/shared/cursorFrames';
import { Skeleton } from '@/components/ui/skeleton';
import { prefersReducedMotion } from '@/shared/reducedMotion';

/** The nominal sizes the cursors are shown at, and tried at, for themes with several. */
const SHOW_SIZE = 48;
const TRY_SIZE = 32;
/** Frames of an animation the preview plays; the rest are left out. */
const MAX_PREVIEW_FRAMES = 64;

/** What each cursor is for, in the order Windows' Mouse settings list them. */
const LABELS: [string, string][] = [
  ['left_ptr', 'Normal select'],
  ['help', 'Help select'],
  ['progress', 'Working in background'],
  ['wait', 'Busy'],
  ['crosshair', 'Precision select'],
  ['text', 'Text select'],
  ['pencil', 'Handwriting'],
  ['not-allowed', 'Unavailable'],
  ['ns-resize', 'Vertical resize'],
  ['n-resize', 'Vertical resize'],
  ['s-resize', 'Resize down'],
  ['ew-resize', 'Horizontal resize'],
  ['w-resize', 'Horizontal resize'],
  ['e-resize', 'Resize right'],
  ['nwse-resize', 'Diagonal resize'],
  ['nw-resize', 'Diagonal resize'],
  ['se-resize', 'Resize down right'],
  ['nesw-resize', 'Diagonal resize'],
  ['ne-resize', 'Diagonal resize'],
  ['sw-resize', 'Resize down left'],
  ['move', 'Move'],
  ['up_arrow', 'Alternate select'],
  ['pointer', 'Link select'],
  ['grab', 'Grab'],
  ['grabbing', 'Grabbing'],
  ['copy', 'Copy'],
  ['alias', 'Shortcut'],
  ['context-menu', 'Menu'],
  ['cell', 'Cell'],
  ['vertical-text', 'Vertical text'],
  ['zoom-in', 'Zoom in'],
  ['zoom-out', 'Zoom out'],
];
const ORDER = new Map(LABELS.map(([name], i) => [name, i]));
const LABEL = new Map(LABELS);

interface PreviewImage {
  src: string;
  width: number;
  height: number;
  delay: number;
}

interface PreviewCursor {
  name: string;
  label: string;
  frames: PreviewImage[];
  /** The first frame at the pointer's size, as a CSS cursor. */
  css: string;
}

interface PreviewTheme {
  name: string;
  cursors: PreviewCursor[];
  /** Further themes in the file, which are installed too. */
  more: number;
}

function prettyName(name: string): string {
  const words = name.replace(/[-_]+/g, ' ').trim();
  return words.charAt(0).toUpperCase() + words.slice(1);
}

async function readTheme(path: string): Promise<PreviewTheme> {
  const response = await fetch(await fileUrl(path));
  if (!response.ok) throw new Error('Couldn’t read the file.');
  const data = new Uint8Array(await response.arrayBuffer());
  const name = path.slice(path.lastIndexOf('/') + 1);
  const [theme, ...more] = await convertCursors({ name, entries: [{ path: name, data }] }, chromiumDecoder);
  const cursors = [...theme.cursors]
    .sort((a, b) => (ORDER.get(a.name) ?? Infinity) - (ORDER.get(b.name) ?? Infinity))
    .map((cursor): PreviewCursor => {
      const shown = framesNear(cursor.frames, SHOW_SIZE).slice(0, MAX_PREVIEW_FRAMES);
      const [tried] = framesNear(cursor.frames, TRY_SIZE);
      return {
        name: cursor.name,
        label: LABEL.get(cursor.name) ?? prettyName(cursor.name),
        frames: shown.map((frame) => ({
          src: frameUrl(frame),
          width: frame.width,
          height: frame.height,
          delay: frame.delay,
        })),
        css: `url(${frameUrl(tried)}) ${tried.hotX} ${tried.hotY}, auto`,
      };
    });
  return { name: theme.name, cursors, more: more.length };
}

export interface CursorThemeViewProps {
  path: string;
  mtimeMs?: number | null;
  /** Install the theme and make it the pointer; without it there's no button. */
  onUse?: () => Promise<void>;
}

/**
 * A cursor theme file (.CurXPTheme, .CursorFX, .cape): every cursor in
 * it, animated ones playing, and each one tried on by pointing at it. Read
 * with the same converter Settings' import runs (src/lib/cursorImport),
 * here in the app's own process.
 */
export function CursorThemeView({ path, mtimeMs = null, onUse }: CursorThemeViewProps) {
  const theme = useQuery({
    queryKey: ['cursorTheme', path, mtimeMs],
    queryFn: () => readTheme(path),
    retry: false,
    staleTime: Infinity,
  });
  const [use, setUse] = useState<{ state: 'idle' | 'pending' | 'done' } | { state: 'error'; message: string }>({ state: 'idle' });

  const run = async () => {
    if (!onUse || use.state === 'pending') return;
    setUse({ state: 'pending' });
    try {
      await onUse();
      setUse({ state: 'done' });
    } catch (error) {
      setUse({ state: 'error', message: error instanceof Error ? error.message : String(error) });
    }
  };

  const arrow = theme.data?.cursors[0];

  return (
    <div className="flex h-full flex-col">
      <div className="flex shrink-0 items-center gap-3 border-b border-border/60 px-4 py-3">
        <div className="grid size-12 shrink-0 place-items-center rounded-lg bg-muted/60">
          {arrow ? (
            <img src={arrow.frames[0].src} alt="" className="max-h-10 max-w-10 object-contain" />
          ) : (
            <MousePointer2 className="size-6 text-muted-foreground" aria-hidden />
          )}
        </div>
        <div className="min-w-0 flex-1">
          <p className="truncate text-sm font-medium text-foreground">
            {theme.data?.name ?? path.slice(path.lastIndexOf('/') + 1)}
          </p>
          <p className="text-xs text-muted-foreground">
            {theme.data
              ? `${theme.data.cursors.length} cursor${theme.data.cursors.length === 1 ? '' : 's'}${
                  theme.data.more ? ` · and ${theme.data.more} more style${theme.data.more === 1 ? '' : 's'}` : ''
                } · Point at one to try it`
              : theme.isError
                ? 'Can’t read this cursor theme'
                : 'Reading…'}
          </p>
        </div>
        {onUse && theme.data && (
          <button
            type="button"
            onClick={() => void run()}
            disabled={use.state === 'pending' || use.state === 'done'}
            className={cn(
              'inline-flex h-8 shrink-0 items-center gap-1.5 rounded-md px-3 text-sm font-medium',
              'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
              use.state === 'done'
                ? 'bg-muted text-foreground'
                : 'bg-pigment text-primary-foreground clay-pigment hover:brightness-110 disabled:opacity-60',
            )}
          >
            {use.state === 'pending' && <Loader2 className="size-4 animate-spin" aria-hidden />}
            {use.state === 'done' && <Check className="size-4" aria-hidden />}
            {use.state === 'pending' ? 'Installing…' : use.state === 'done' ? 'In Use' : 'Use This Cursor'}
          </button>
        )}
      </div>
      {use.state === 'error' && (
        <p role="alert" className="shrink-0 border-b border-border/60 px-4 py-1.5 text-xs text-destructive">
          Couldn’t use this cursor: {use.message}
        </p>
      )}
      <div className="min-h-0 flex-1 overflow-auto p-4">
        {theme.isLoading ? (
          <div className="grid grid-cols-[repeat(auto-fill,minmax(7.5rem,1fr))] gap-2" aria-hidden>
            {Array.from({ length: 12 }, (_, i) => (
              <Skeleton key={i} className="h-28 bg-foreground/10" />
            ))}
          </div>
        ) : theme.isError ? (
          <p className="text-sm text-muted-foreground">
            {theme.error instanceof ImportError ? theme.error.message : 'The file is damaged or not in a format Din can read.'}
          </p>
        ) : (
          <ul className="grid grid-cols-[repeat(auto-fill,minmax(7.5rem,1fr))] gap-2" aria-label="Cursors">
            {theme.data!.cursors.map((cursor) => (
              <li
                key={cursor.name}
                title={cursor.name}
                style={{ cursor: cursor.css }}
                className="flex h-28 flex-col items-center justify-center gap-2 rounded-xl bg-card clay p-2 hover:bg-foreground/5"
              >
                <div className="grid size-16 place-items-center">
                  <CursorImage frames={cursor.frames} />
                </div>
                <span className="w-full truncate text-center text-xs text-muted-foreground">{cursor.label}</span>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}

/** A cursor's frames, played in turn unless the user prefers less motion. */
function CursorImage({ frames }: { frames: PreviewImage[] }) {
  const [index, setIndex] = useState(0);
  const animated = frames.length > 1;

  useEffect(() => {
    if (!animated || prefersReducedMotion()) return;
    const timer = window.setTimeout(
      () => setIndex((i) => (i + 1) % frames.length),
      Math.max(frames[index % frames.length].delay, 16),
    );
    return () => window.clearTimeout(timer);
  }, [animated, frames, index]);

  const frame = frames[index % frames.length];
  return (
    <img
      src={frame.src}
      alt=""
      draggable={false}
      style={{ width: frame.width, height: frame.height }}
      className="max-h-16 max-w-16 object-contain"
    />
  );
}
