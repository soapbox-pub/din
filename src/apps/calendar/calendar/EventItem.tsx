import type { CSSProperties, ReactNode } from 'react';
import { ContextMenu, ContextMenuContent, ContextMenuTrigger } from '@/components/ui/context-menu';
import { cn } from '@/lib/utils';
import { eventMenu, type Shown } from './menu';
import { ContextEntries } from './MenuEntries';
import { answerClasses, colorStyle, tentativeStyle, useViewActions } from './model';

/**
 * One event in a view: clicking shows its details, double-clicking edits
 * the user's own, and right-clicking offers what its details' ⋯ menu does.
 */
export function EventItem({ shown, className, style, children, label }: { shown: Shown; className?: string; style?: CSSProperties; children: ReactNode; label: string }) {
  const actions = useViewActions();
  const selected = actions.selected === shown.e.coord;
  return (
    <ContextMenu>
      <ContextMenuTrigger asChild>
        <button
          type="button"
          data-event={shown.e.coord}
          data-selected={selected || undefined}
          aria-label={label}
          aria-haspopup="dialog"
          aria-expanded={selected}
          onClick={(e) => {
            e.stopPropagation();
            actions.select(shown, e.currentTarget);
          }}
          onDoubleClick={(e) => {
            e.stopPropagation();
            actions.act(shown, shown.mine ? 'edit' : 'open', e.currentTarget);
          }}
          onPointerDown={(e) => e.stopPropagation()}
          className={cn(
            'group/event min-w-0 text-left outline-none focus-visible:ring-2 focus-visible:ring-ring/70',
            answerClasses(shown),
            className,
          )}
          style={colorStyle(shown.color, { ...tentativeStyle(shown), ...style })}
        >
          {children}
        </button>
      </ContextMenuTrigger>
      <ContextMenuContent className="w-52">
        <ContextEntries
          entries={eventMenu(shown)}
          onPick={(a) => actions.act(shown, a, document.querySelector<HTMLElement>(`[data-event="${CSS.escape(shown.e.coord)}"]`) ?? undefined)}
        />
      </ContextMenuContent>
    </ContextMenu>
  );
}
