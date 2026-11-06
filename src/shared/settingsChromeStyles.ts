import { cn } from '@/lib/utils';
import { focusRing } from './appChromeStyles';

/*
 * The parts of a settings page (Settings, and an app's own settings), made
 * the way the menu bar's panels are: a quiet surface with no border, rows
 * on it parted by inset hairlines rather than boxed, each row's icon in a
 * round clay token (the theme's primary when it's on), and nothing boxed
 * inside anything else. What's chosen is tinted with the theme's primary
 * (bg-selected) and what's merely hovered stays neutral; what's empty is
 * said in plain text, never in a dashed box. RadioMark and SettingsToken,
 * the parts that are components, are in settingsChrome.tsx.
 */

/**
 * A surface of settings on the content pane: 12px of soft clay, no border.
 * Padding is the caller's. It never shrinks in a flex column: a short window
 * scrolls it rather than squeezing it.
 */
export const settingsCard = 'shrink-0 rounded-xl bg-card clay';

/**
 * A surface holding rows, parted by inset hairlines: each child is a row,
 * whatever it is. It clips, so a row's hover tint keeps its corners; a row
 * that's a button wants its focus ring inset (`settingsRowButton`). Text
 * fields in its rows are clear until they're pointed at or typed in.
 */
export const settingsGroup = cn(
  settingsCard,
  'flex flex-col overflow-hidden [&>*]:relative [&>*]:shrink-0',
  '[&>*+*]:before:pointer-events-none [&>*+*]:before:absolute [&>*+*]:before:inset-x-4 [&>*+*]:before:top-0 [&>*+*]:before:h-px [&>*+*]:before:bg-border/70',
  // A field in a row is the row's, not a box inside it: clear until it's pointed at or typed in.
  '[&_[data-slot=input]]:bg-transparent [&_[data-slot=input]:hover]:bg-foreground/[0.04] [&_[data-slot=input]:focus-visible]:bg-foreground/[0.06]',
);

/** A row of a `settingsGroup` that's a button the width of it. */
export const settingsRowButton = cn(
  'flex w-full items-center gap-3 px-4 py-2.5 text-left hover:bg-foreground/5 disabled:cursor-default disabled:hover:bg-transparent',
  'outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring/60',
);

/**
 * Something to pick among a few that's a picture (a layout, an effect, a
 * theme): no surface of its own, as a panel's row has none, a hover tinting
 * it neutral and the chosen one tinted with the primary.
 */
export function settingsChoiceClass(active: boolean) {
  return cn(
    'rounded-xl transition-colors disabled:cursor-not-allowed disabled:opacity-60',
    focusRing,
    active ? 'bg-selected text-foreground' : 'text-muted-foreground hover:bg-foreground/5 hover:text-foreground',
  );
}

/** A row's icon in a round clay token, the theme's primary when what it's for is on, as the menu bar's panels have them. */
export function settingsTokenClass(active = false) {
  return cn(
    'grid size-8 shrink-0 place-items-center rounded-full [&_svg]:size-4',
    active ? 'bg-pigment text-primary-foreground clay-pigment' : 'bg-foreground/10 text-foreground/75 clay',
  );
}

/** A preview picture in a choice: rounded, no frame. */
export const settingsPreview = 'relative overflow-hidden rounded-lg';

/** What a list says when it has nothing in it: plain, centered, small. */
export const settingsEmpty = 'px-4 py-6 text-center text-sm text-muted-foreground';

/** A notice in a section: something waiting on the user, in the theme's pigment. */
export const settingsNotice = 'rounded-xl bg-selected';

/** A notice that something went wrong. */
export const settingsAlert = 'rounded-xl bg-destructive/10';
