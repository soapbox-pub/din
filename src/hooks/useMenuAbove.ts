import { useState, type CSSProperties, type MouseEvent } from 'react';
import { useTaskbarEdge } from '@/contexts/BarSideContext';

/** Space between the menu and what it opens above, in px. */
const GAP = 4;
/** How far right of the pointer Radix opens a context menu, in px. */
const RADIX_SIDE_OFFSET = 2;

/**
 * Opens a context menu above what was right-clicked, rather than at the
 * pointer, where it would run into the bottom of the screen and rest on it.
 * For the Dock's and taskbar's menus. Spread `trigger` onto the
 * `ContextMenuTrigger` and `content` onto its `ContextMenuContent`. In a
 * taskbar along the top or down the left (BarSideContext), it opens below
 * what was clicked, or right of it, instead.
 *
 * Radix pins a context menu's top to the pointer, so the menu is kept out of
 * the strip below the trigger's top edge (or above its bottom edge) by
 * padding that edge's collisions, and `sticky="always"` lets it shift past
 * the pointer to get there. Radix opens it right of the pointer and won't
 * shift it sideways, so off a bar on the left it's nudged over by `translate`
 * instead. `anchor`, if given, picks the element it opens clear of instead.
 */
export function useMenuAbove(anchor?: () => Element | null) {
  const edge = useTaskbarEdge();
  const [padding, setPadding] = useState<{ top?: number; bottom?: number }>({});
  const [nudge, setNudge] = useState(0);
  return {
    trigger: {
      onContextMenu: (e: MouseEvent<HTMLElement>) => {
        const rect = (anchor?.() ?? e.currentTarget).getBoundingClientRect();
        if (edge === 'left') {
          setPadding({});
          setNudge(Math.max(0, rect.right + GAP - e.clientX - RADIX_SIDE_OFFSET));
        } else {
          setPadding(edge === 'top' ? { top: rect.bottom + GAP } : { bottom: window.innerHeight - rect.top + GAP });
          setNudge(0);
        }
      },
    },
    content: {
      collisionPadding: padding,
      sticky: 'always',
      style: (nudge ? { translate: `${nudge}px 0` } : undefined) as CSSProperties | undefined,
    },
  } as const;
}

export type MenuAboveContentProps = ReturnType<typeof useMenuAbove>['content'];
