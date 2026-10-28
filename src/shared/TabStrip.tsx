import { useEffect, useRef, useState, type ReactNode } from 'react';
import { Plus, X } from 'lucide-react';
import { useDragReorder, type WindowMoveGesture } from '@/hooks/useDragReorder';
import { TabContextMenu, type TabTransfer } from '@/shared/TabContextMenu';
import { cn } from '@/lib/utils';

/**
 * The minimal shape a tab needs to render in the strip. Apps store whatever
 * additional per-tab state they like alongside these fields.
 */
export interface TabDescriptor {
  id: string;
  /** Text shown on the tab. */
  title: string;
  /** Leading icon (favicon, app glyph, …). */
  icon?: ReactNode;
}

/**
 * A generic, closable/addable tab strip, meant for a window's title bar (the
 * desktop's, via `useWindowTitlebar`, or an app's own header in a `custom`
 * frame) so tabs sit on the same line as the window controls (Chrome-style).
 * The surrounding title bar is the window drag handle; tab buttons and the
 * new-tab button handle their own clicks, so dragging empty space still moves
 * the window, while dragging a tab moves the tab along the strip (or, with
 * `moveWindow`, the window: give it for a window's only tab). With
 * `transfer`, a tab dragged off the strip moves to another window of the app
 * (the desktop's useTabTransfer), and its context menu offers the same. The context menu also opens a new tab and closes the tabs
 * around one. Past their minimum width, tabs collapse to just their icon and
 * the strip scrolls.
 *
 * Used by the Terminal, Files and Assistant apps; the Web Browser has its own richer
 * variant (favicons, loading state) but the same interaction model.
 */
export function TabStrip({
  tabs,
  activeId,
  label,
  newTabLabel = 'New tab',
  onActivate,
  onClose,
  onNew,
  newTabMenuLabel = 'New tab',
  onMove,
  transfer,
  moveWindow,
  tabMenuItems,
  onReopen,
  onTabMenuCloseAutoFocus,
  editing,
}: {
  tabs: TabDescriptor[];
  activeId: string;
  /** Accessible label for the tablist (e.g. "Terminal tabs"). */
  label: string;
  /** Accessible label / tooltip for the new-tab button. */
  newTabLabel?: string;
  /** The new-tab item in a tab's right-click menu. */
  newTabMenuLabel?: string;
  onActivate: (id: string) => void;
  onClose: (id: string) => void;
  onNew: () => void;
  /** Move a tab to a new index; tabs are dragged to reorder them. */
  onMove: (id: string, toIndex: number) => void;
  /** Let tabs move between the app's windows. */
  transfer?: TabTransfer;
  /** Dragging a tab moves the window instead (pass it for a window's only tab). */
  moveWindow?: WindowMoveGesture;
  /** App-specific items for a tab's right-click menu. */
  tabMenuItems?: (id: string) => ReactNode;
  /** Reopen the tab closed last, offered in a tab's right-click menu. */
  onReopen?: () => void;
  /** Passed to a tab's right-click menu (see TabContextMenu). */
  onTabMenuCloseAutoFocus?: (event: Event) => void;
  /** A tab whose title is being edited, and the field to show in its place. */
  editing?: { id: string; editor: ReactNode } | null;
}) {
  const reorder = useDragReorder({
    ids: tabs.map((t) => t.id),
    onMove,
    tearOff: transfer?.tearOff,
    moveWindow,
  });
  // Tabs shrink to fit the strip, like Chrome's. Closing one with the mouse
  // holds the others at their current width until the pointer leaves the
  // strip, so the next tab's close button slides under the cursor.
  const [lockedWidth, setLockedWidth] = useState<number | null>(null);
  const listRef = useRef<HTMLDivElement | null>(null);
  // Past the minimum tab width the strip scrolls; keep the active tab in view.
  // (By hand: scrollIntoView would also scroll the desktop's clipped ancestors.)
  useEffect(() => {
    const list = listRef.current;
    const tab = list?.querySelector<HTMLElement>('[role="tab"][aria-selected="true"]');
    if (!list || !tab) return;
    const start = tab.getBoundingClientRect().left - list.getBoundingClientRect().left + list.scrollLeft;
    const end = start + tab.offsetWidth;
    if (start < list.scrollLeft) list.scrollLeft = start;
    else if (end > list.scrollLeft + list.clientWidth) list.scrollLeft = end - list.clientWidth;
  }, [activeId, tabs.length]);
  return (
    <div
      ref={(el) => {
        listRef.current = el;
        transfer?.setList(el);
      }}
      role="tablist"
      aria-label={label}
      onPointerLeave={() => setLockedWidth(null)}
      onWheel={(e) => {
        // There's no scrollbar, so the wheel scrolls the tabs sideways.
        if (e.deltaY !== 0 && e.deltaX === 0) e.currentTarget.scrollLeft += e.deltaY;
      }}
      className="flex min-w-0 flex-1 items-center gap-1 overflow-x-auto [scrollbar-width:none]"
    >
      {tabs.map((tab, index) => (
        <TabContextMenu
          key={tab.id}
          tabId={tab.id}
          transfer={transfer}
          onClose={() => onClose(tab.id)}
          onNew={onNew}
          newLabel={newTabMenuLabel}
          onCloseOthers={() => tabs.filter((t) => t.id !== tab.id).forEach((t) => onClose(t.id))}
          canCloseOthers={tabs.length > 1}
          onCloseToRight={() => tabs.slice(index + 1).forEach((t) => onClose(t.id))}
          canCloseToRight={index < tabs.length - 1}
          items={tabMenuItems?.(tab.id)}
          onReopen={onReopen}
          onCloseAutoFocus={onTabMenuCloseAutoFocus}
          disabled={editing?.id === tab.id}
        >
          <TabButton
            tab={tab}
            editor={editing?.id === tab.id ? editing.editor : undefined}
            active={tab.id === activeId}
            dragging={reorder.draggingId === tab.id}
            lockedWidth={lockedWidth}
            ref={(el) => reorder.register(tab.id, el)}
            onPointerDown={(e) => reorder.onPointerDown(tab.id, e)}
            onActivate={() => onActivate(tab.id)}
            onClose={(width) => {
              if (width !== undefined) setLockedWidth(width);
              onClose(tab.id);
            }}
          />
        </TabContextMenu>
      ))}
      <button
        type="button"
        aria-label={newTabLabel}
        title={newTabLabel}
        onClick={onNew}
        className={cn(
          'grid size-7 shrink-0 place-items-center rounded-md text-foreground/70',
          'hover:bg-foreground/10 hover:text-foreground',
          'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
        )}
      >
        <Plus className="size-4" />
      </button>
    </div>
  );
}

/** A tab's icon classes, for when it gets too narrow for its title. */
function narrowIcon(active: boolean) {
  return active ? '@max-[3.25rem]:hidden' : '@max-[3.25rem]:mx-auto';
}

/**
 * A single tab in the strip. Every tab is closable — including a lone one:
 * apps close the whole window when their last tab closes.
 */
function TabButton({
  tab,
  editor,
  active,
  dragging,
  lockedWidth = null,
  ref,
  onPointerDown,
  onActivate,
  onClose,
  ...props
}: {
  tab: TabDescriptor;
  /** Shown instead of the title while it's being edited. */
  editor?: ReactNode;
  active: boolean;
  dragging: boolean;
  /** Hold the tab at this width instead of fitting it to the strip. */
  lockedWidth?: number | null;
  ref: React.Ref<HTMLDivElement>;
  onPointerDown: (e: React.PointerEvent<HTMLDivElement>) => void;
  onActivate: () => void;
  /** Close the tab; given the tab's width when the mouse closed it. */
  onClose: (width?: number) => void;
} & Omit<React.ComponentProps<'div'>, 'onPointerDown'>) {
  const widthOf = (el: Element) => el.closest('[role="tab"]')?.getBoundingClientRect().width;
  return (
    <div
      {...props}
      ref={ref}
      onPointerDown={onPointerDown}
      role="tab"
      aria-selected={active}
      aria-label={tab.title}
      tabIndex={0}
      onClick={onActivate}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          onActivate();
        }
      }}
      onAuxClick={(e) => {
        // Middle-click closes, like every browser.
        if (e.button === 1) onClose(widthOf(e.currentTarget));
      }}
      onMouseUp={(e) => {
        // Linux pastes the primary selection on middle-button release, into
        // whatever has focus by then - the next tab's composer, once this one
        // has closed.
        if (e.button === 1) e.preventDefault();
      }}
      title={tab.title}
      style={lockedWidth !== null ? { flex: `0 0 ${lockedWidth}px` } : undefined}
      className={cn(
        // Tabs shrink from 11rem as the strip fills, and are containers so
        // their contents can collapse once they get narrow.
        '@container group relative flex h-7 basis-44 shrink cursor-default select-none items-center gap-2 rounded-md border px-2.5 text-xs',
        active ? 'min-w-10' : 'min-w-9',
        'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
        active
          ? 'border-border/60 bg-background text-foreground shadow-sm'
          : 'border-transparent bg-transparent text-muted-foreground hover:bg-foreground/5 hover:text-foreground',
        dragging && 'border-border/60 bg-background shadow-md',
      )}
    >
      {/* Too narrow for everything, a tab shows just its icon - or, if it's
          the active one, just its close button - like Chrome's. */}
      {tab.icon && (
        <span className={cn('grid shrink-0 place-items-center opacity-80 empty:hidden', narrowIcon(active))}>
          {tab.icon}
        </span>
      )}
      {editor ? (
        // The field's clicks, drags and keys are its own, not the tab's.
        <span
          className="min-w-0 flex-1"
          onPointerDown={(e) => e.stopPropagation()}
          onClick={(e) => e.stopPropagation()}
          onKeyDown={(e) => e.stopPropagation()}
        >
          {editor}
        </span>
      ) : (
        <span className={cn('min-w-0 flex-1 truncate', tab.icon && '@max-[3.25rem]:hidden')}>{tab.title}</span>
      )}
      <button
        type="button"
        aria-label={`Close ${tab.title}`}
        onClick={(e) => {
          e.stopPropagation();
          onClose(e.detail > 0 ? widthOf(e.currentTarget) : undefined);
        }}
        className={cn(
          'grid size-5 shrink-0 place-items-center rounded-full text-foreground/60',
          'opacity-0 hover:bg-foreground/10 hover:text-foreground group-hover:opacity-100',
          active ? 'opacity-100 @max-[3.25rem]:mx-auto' : '@max-[3.25rem]:hidden',
          'focus-visible:opacity-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
        )}
      >
        <X className="size-3" />
      </button>
    </div>
  );
}
