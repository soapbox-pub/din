import type { ReactNode } from 'react';
import { Plus, X } from 'lucide-react';
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
 * dragging empty space still moves the window.
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
}) {
  return (
    <div
      role="tablist"
      aria-label={label}
      className="flex min-w-0 flex-1 items-center gap-1 overflow-x-auto"
    >
      {tabs.map((tab) => (
        <TabButton
          key={tab.id}
          tab={tab}
          active={tab.id === activeId}
          // A lone tab has no close affordance: closing it would leave the
          // window empty (apps close the window when the last tab closes, but
          // hiding the button keeps the common case unambiguous).
          showClose={tabs.length > 1}
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

/** A single tab in the strip. */
function TabButton({
  tab,
  active,
  showClose,
  onActivate,
  onClose,
}: {
  tab: TabDescriptor;
  active: boolean;
  showClose: boolean;
  onActivate: () => void;
  onClose: () => void;
}) {
  return (
    <div
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
        if (e.button === 1 && showClose) onClose();
      }}
      title={tab.title}
      className={cn(
        'group flex h-7 w-44 min-w-0 shrink-0 cursor-default items-center gap-2 rounded-md border px-2.5 text-xs',
        'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
        active
          ? 'border-border/60 bg-background text-foreground shadow-sm'
          : 'border-transparent bg-transparent text-muted-foreground hover:bg-foreground/5 hover:text-foreground',
      )}
    >
      {tab.icon && <span className="shrink-0 opacity-80">{tab.icon}</span>}
      <span className="min-w-0 flex-1 truncate">{tab.title}</span>
      {showClose && (
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
      )}
    </div>
  );
}
