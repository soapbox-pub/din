import { useState, type MouseEvent } from 'react';

/** Space between the menu and what it opens above, in px. */
const GAP = 4;

/**
 * Opens a context menu above what was right-clicked, rather than at the
 * pointer, where it would run into the bottom of the screen and rest on it.
 * For the Dock's and taskbar's menus. Spread `trigger` onto the
 * `ContextMenuTrigger` and `content` onto its `ContextMenuContent`.
 *
 * Radix pins a context menu's top to the pointer, so the menu is kept out of
 * the strip below the trigger's top edge by padding that edge's collisions,
 * and `sticky="always"` lets it shift up past the pointer to get there.
 * `anchor`, if given, picks the element whose top it opens above instead.
 */
export function useMenuAbove(anchor?: () => Element | null) {
  const [bottom, setBottom] = useState(0);
  return {
    trigger: {
      onContextMenu: (e: MouseEvent<HTMLElement>) => {
        const el = anchor?.() ?? e.currentTarget;
        setBottom(window.innerHeight - el.getBoundingClientRect().top + GAP);
      },
    },
    content: {
      collisionPadding: { bottom },
      sticky: 'always',
    },
  } as const;
}

export type MenuAboveContentProps = ReturnType<typeof useMenuAbove>['content'];
