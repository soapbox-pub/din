import { cn } from '@/lib/utils';
import { focusRing } from '@/shared/appChromeStyles';

/*
 * The parts of the menu bar's tray panels (Wi-Fi, Sound, Bluetooth, Display,
 * Battery), in the material of the rest of Din: a heading in the theme's
 * title font, rooms of content parted by inset hairlines in the theme's
 * border color rather than ruled edge to edge, rows with room in them, and
 * a clay token for each device, in the theme's primary when it's the one
 * in use.
 */

/** A panel's heading: its name, and a switch or a reading beside it. */
export const trayHeader = 'flex items-center justify-between gap-3 px-4 pt-4 pb-2';

/** The name in a panel's heading. */
export const trayTitle = 'font-[family-name:var(--font-title)] text-[15px] font-semibold text-foreground';

/** An inset hairline above a part of the panel. */
export const trayRuleTop = 'relative before:absolute before:inset-x-4 before:top-0 before:h-px before:bg-border/70';

/** An inset hairline below a part of the panel. */
export const trayRuleBottom = 'relative after:absolute after:inset-x-4 after:bottom-0 after:h-px after:bg-border/70';

/** A list of rows in a panel. */
export const trayList = 'flex flex-col gap-0.5 p-2';

/** A row of a panel: a network, a device; `active` when it's the one in use. */
export function trayRowClass(active = false) {
  return cn(
    'flex w-full items-center gap-3 rounded-lg px-2.5 py-2 text-left text-sm text-foreground transition-colors',
    focusRing,
    active ? 'bg-selected' : 'hover:bg-foreground/[0.07]',
  );
}

/** A device's round token in a row: a clay lump, of the primary when it's in use. */
export function trayTokenClass(active: boolean) {
  return cn(
    'grid size-8 shrink-0 place-items-center rounded-full',
    active ? 'bg-pigment text-primary-foreground clay-pigment' : 'bg-foreground/10 text-foreground/75 clay',
  );
}

/** The panel's foot: the way to its section of Settings. */
export const trayFooter = cn(trayRuleTop, 'p-2');

/** The Settings link at a panel's foot, as a row. */
export const trayFooterButton = 'h-9 w-full justify-start gap-3 rounded-lg px-2.5 text-muted-foreground hover:text-foreground';

/** The line between two parts of a panel, inset to the panel's content. */
export const traySeparator = 'mx-4 my-1 h-px shrink-0 bg-border/70';
