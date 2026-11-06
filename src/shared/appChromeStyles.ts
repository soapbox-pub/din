import { cn } from '@/lib/utils';

/** The classes behind the controls in appChrome.tsx, for what builds its own. */

/** The ring every hand-built control shows when focused from the keyboard. */
export const focusRing = 'outline-none focus-visible:ring-2 focus-visible:ring-ring/60';

/** A borderless icon button's look, whatever its size (appChrome's ToolButton). */
export const toolButtonBase = cn(
  'grid shrink-0 place-items-center text-muted-foreground',
  'hover:bg-foreground/[0.07] hover:text-foreground data-[state=open]:bg-foreground/[0.07] data-[state=open]:text-foreground',
  // Dimmed by its color rather than opacity, which renders a thin glyph soft.
  'disabled:pointer-events-none disabled:text-muted-foreground/45',
  focusRing,
);

/** A toolbar's icon button (appChrome's ToolButton at its toolbar size), for buttons that are built some other way. */
export const toolButtonClass = cn(toolButtonBase, 'size-9 rounded-full');

/** The icon size and stroke a toolbar button's glyph takes (`size-4.5`, stroke 1.75). */
export const toolIcon = { className: 'size-4.5', strokeWidth: 1.75 } as const;

/** A sidebar row's look: 32px, 14px text, a neutral tint when selected. */
export function sidebarRowClass(selected: boolean) {
  return cn(
    'flex h-8 w-full min-w-0 shrink-0 items-center gap-2.5 rounded-md px-2.5 text-left text-sm',
    focusRing,
    selected ? 'bg-selected font-medium' : 'hover:bg-foreground/5',
  );
}

/**
 * The row a sidebar's or list's search sits in: 48px, as a toolbar is, so
 * the field is centered in the same band under the title bar as a toolbar's
 * address bar or location (the window's grid: 48px title bar, 48px toolbar).
 */
export const searchRow = 'flex h-12 shrink-0 items-center px-2';

/** A sidebar's width, one in every app: 256px, room for the app's name and two buttons beside it; where it can be dragged wider or narrower, where it starts and goes back to. */
export const SIDEBAR_WIDTH = 256;
export const sidebarWidthClass = 'w-64';

/** A search in the title bar: one width in every app (288px), giving way only when the bar runs out of room. */
export const titleSearch = 'w-72 min-w-32 shrink';

/** A sidebar heading's look: 12px semibold in the secondary color, as written, with room above it. */
export const sidebarHeadingClass = 'flex h-8 shrink-0 items-end gap-1 px-2.5 pb-1.5 text-xs font-semibold text-muted-foreground';

/**
 * A row of a list in an app's content: the accent's tint when selected,
 * and a neutral one once the list's window or pane isn't the one in use
 * (`inactive`), as a Mac's lists do.
 */
export function listRowClass({ selected, inactive }: { selected: boolean; inactive?: boolean }) {
  if (selected) return inactive ? 'bg-foreground/10' : 'bg-selected';
  return 'hover:bg-foreground/[0.04]';
}

/**
 * An inset content panel against the screen (see ContentPane): along an edge
 * of its window that's the screen's (`data-screen-right`, `data-screen-bottom`
 * on the window), it runs to the edge, square there; where it meets the
 * sidebar, the title bar or another window, it keeps its inset and its
 * rounded corners. No line anywhere: its solid surface against the window's
 * frosted one sets it apart.
 */
export const flushPane = cn(
  '[[data-screen-right]_&]:mr-0 [[data-screen-right]_&]:rounded-tr-none [[data-screen-right]_&]:rounded-br-none',
  '[[data-screen-bottom]_&]:mb-0 [[data-screen-bottom]_&]:rounded-bl-none [[data-screen-bottom]_&]:rounded-br-none',
);

/**
 * Liquid glass over the desktop, for what floats over everything for a
 * moment: notifications, toasts, the volume and brightness readouts.
 */
export const glassPanel = 'rounded-2xl glass-surface';

/** What's chosen among cards, chips or tiles in an app's content: tinted with the theme, never outlined in it. */
export const chosenClass = 'bg-selected text-foreground';

/** Something being dragged over a place it can be dropped: a ring, not a fill of the primary. */
export const dropTargetClass = 'bg-selected ring-2 ring-ring/60';

/** What an empty list or pane says: plain and centered, never in a dashed box. */
export const emptyStateClass = 'flex shrink-0 flex-col items-center px-6 py-12 text-center text-sm text-muted-foreground';
