import { cn } from '@/lib/utils';

/**
 * The look of a title-bar tab strip, Safari-style: tabs are softly recessed
 * into the bar, and the active one is raised. Shared by the apps' TabStrip
 * and the Web Browser's own strips so every tab looks alike.
 */

/**
 * The tablist, 40px tall: the padding gives the tabs air in a title bar, and
 * room for the raised tab's shadow, which the scrolling strip would clip.
 */
export const tabListClass = 'flex min-w-0 flex-1 items-center gap-1 overflow-x-auto px-0.5 py-1.5 [scrollbar-width:none]';

/** The raised look of the active tab (and of one being dragged). */
export const tabRaisedClass =
  'bg-background text-foreground shadow-[0_0.5px_1px_rgb(0_0_0/0.07),0_0_0_0.5px_rgb(0_0_0/0.09)] dark:bg-foreground/[0.12] dark:shadow-[0_0.5px_1px_rgb(0_0_0/0.25)]';

/** A tab. */
export function tabClass({ active, dragging }: { active: boolean; dragging?: boolean }) {
  return cn(
    'group relative flex h-7 cursor-default select-none items-center justify-center rounded-md text-xs transition-[background-color,color] duration-150',
    'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
    active
      ? tabRaisedClass
      : 'bg-foreground/[0.05] text-muted-foreground hover:bg-foreground/[0.09] hover:text-foreground',
    dragging && cn(tabRaisedClass, 'shadow-md'),
  );
}

/**
 * A tab's icon and title, inset clear of the close button. Wrapped in their
 * own element so a narrow tab (an `@container`) can drop the inset.
 */
export const tabContentClass = 'flex min-w-0 flex-1 items-center justify-center gap-1.5 px-6 @max-[3.25rem]:px-0';

/**
 * A tab's icon. Once the tab is too narrow for its title it shows just the
 * icon, which gives way to the close button while hovered.
 */
export const tabIconClass = 'grid shrink-0 place-items-center @max-[3.25rem]:group-hover:invisible';

/** A tab's title, centered with its icon; hidden on a narrow tab that has an icon. */
export function tabTitleClass(hasIcon: boolean) {
  return cn('min-w-0 truncate', hasIcon && '@max-[3.25rem]:hidden');
}

/** The close button: at the tab's trailing edge, shown while it's hovered. */
export const tabCloseClass = cn(
  'absolute right-1 top-1/2 grid size-5 -translate-y-1/2 place-items-center rounded-full text-foreground/60',
  'opacity-0 transition-opacity hover:bg-foreground/10 hover:text-foreground group-hover:opacity-100',
  '@max-[3.25rem]:left-1/2 @max-[3.25rem]:-translate-x-1/2',
  'focus-visible:opacity-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
);

/** The new-tab button after the last tab. */
export const newTabButtonClass = cn(
  'ml-1 grid size-7 shrink-0 place-items-center rounded-md text-foreground/70',
  'hover:bg-foreground/[0.08] hover:text-foreground',
  'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
);
