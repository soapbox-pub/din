import type { ReactNode } from 'react';
import { Plus, X } from 'lucide-react';
import { useDragReorder } from '@/hooks/useDragReorder';
import { useTabTransfer, type TabTransfer, type TabTransferOptions } from '@/hooks/useTabTransfer';
import { TabContextMenu } from '@/components/desktop/TabContextMenu';
import { useWindowChrome } from '@/contexts/WindowChromeContext';
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
 * A generic, closable/addable tab strip, meant to be published into a
 * window's title bar via `useWindowTitlebar` so tabs sit on the same line as
 * the window controls (Chrome-style). The surrounding <header> is the window
 * drag handle; tab buttons and the new-tab button handle their own clicks, so
 * dragging empty space still moves the window, while dragging a tab moves the
 * tab along the strip (or, for a window's only tab, the window). With `transfer`, a tab dragged off the strip moves to
 * another window of the app (see useTabTransfer), and its context menu
 * offers the same.
 *
 * Used by the Terminal and Files apps; the Web Browser has its own richer
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
  onMove,
  transfer,
}: {
  tabs: TabDescriptor[];
  activeId: string;
  /** Accessible label for the tablist (e.g. "Terminal tabs"). */
  label: string;
  /** Accessible label / tooltip for the new-tab button. */
  newTabLabel?: string;
  onActivate: (id: string) => void;
  onClose: (id: string) => void;
  onNew: () => void;
  /** Move a tab to a new index; tabs are dragged to reorder them. */
  onMove: (id: string, toIndex: number) => void;
  /** Let tabs move between the app's windows. */
  transfer?: TabTransferOptions;
}) {
  const tabTransfer = useTabTransfer(transfer, tabs.length);
  const chrome = useWindowChrome();
  const reorder = useDragReorder({
    ids: tabs.map((t) => t.id),
    onMove,
    tearOff: tabTransfer.tearOff,
    // A window's only tab moves the window, like Chrome's.
    moveWindow: tabs.length === 1 ? chrome : undefined,
  });
  return (
    <div
      ref={(el) => tabTransfer.setList(el)}
      role="tablist"
      aria-label={label}
      // When tabs overflow they shrink to fit (Chrome-style) rather than
      // scrolling; overflow-hidden is just a guard for the minimum-width case.
      className="flex min-w-0 flex-1 items-center gap-1 overflow-hidden"
    >
      {tabs.map((tab) => (
        <TabButton
          key={tab.id}
          tab={tab}
          active={tab.id === activeId}
          dragging={reorder.draggingId === tab.id}
          transfer={tabTransfer}
          ref={(el) => reorder.register(tab.id, el)}
          onPointerDown={(e) => reorder.onPointerDown(tab.id, e)}
          onActivate={() => onActivate(tab.id)}
          onClose={() => onClose(tab.id)}
        />
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

/**
 * A single tab in the strip. Every tab is closable — including a lone one:
 * apps close the whole window when their last tab closes.
 */
function TabButton({
  tab,
  active,
  dragging,
  transfer,
  ref,
  onPointerDown,
  onActivate,
  onClose,
}: {
  tab: TabDescriptor;
  active: boolean;
  dragging: boolean;
  transfer: TabTransfer;
  ref: React.Ref<HTMLDivElement>;
  onPointerDown: (e: React.PointerEvent<HTMLDivElement>) => void;
  onActivate: () => void;
  onClose: () => void;
}) {
  return (
    <TabContextMenu tabId={tab.id} transfer={transfer} onClose={onClose}>
      <div
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
          if (e.button === 1) onClose();
        }}
        title={tab.title}
        className={cn(
          'group relative flex h-7 w-44 min-w-9 shrink cursor-default select-none items-center gap-2 rounded-md border px-2.5 text-xs',
          'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
          active
            ? 'border-border/60 bg-background text-foreground shadow-sm'
            : 'border-transparent bg-transparent text-muted-foreground hover:bg-foreground/5 hover:text-foreground',
          dragging && 'border-border/60 bg-background shadow-md',
        )}
      >
        {tab.icon && <span className="shrink-0 opacity-80">{tab.icon}</span>}
        <span className="min-w-0 flex-1 truncate">{tab.title}</span>
        <button
          type="button"
          aria-label={`Close ${tab.title}`}
          onClick={(e) => {
            e.stopPropagation();
            onClose();
          }}
          className={cn(
            'grid size-5 shrink-0 place-items-center rounded-full text-foreground/60',
            'opacity-0 hover:bg-foreground/10 hover:text-foreground group-hover:opacity-100',
            active && 'opacity-100',
            'focus-visible:opacity-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
          )}
        >
          <X className="size-3" />
        </button>
      </div>
    </TabContextMenu>
  );
}
