import type { ComponentProps } from 'react';
import { Maximize2, Minimize2, Minus, X } from 'lucide-react';
import { WindowContextMenu } from '@/components/desktop/WindowContextMenu';
import { useWindowFrame } from '@/contexts/WindowFrameContext';
import { cn } from '@/lib/utils';

const FIELD = 'input, textarea, [contenteditable]:not([contenteditable="false"])';

/**
 * A stretch of title bar: dragging its empty space moves the window,
 * double-clicking maximizes it and right-clicking opens the window menu.
 * Controls inside (buttons, tabs, fields) keep their own clicks, and fields
 * their native menu. Outside a Window it's a plain div.
 */
export function WindowDragRegion({ className, children, ...props }: ComponentProps<'div'>) {
  const frame = useWindowFrame();
  if (!frame) {
    return (
      <div {...props} className={className}>
        {children}
      </div>
    );
  }
  return (
    <WindowContextMenu win={frame.win} onMinimize={frame.minimize} onToggleMaximize={frame.toggleMaximize}>
      <div
        {...props}
        data-din-region="drag"
        onPointerDown={frame.onPointerDown}
        onPointerMove={frame.onPointerMove}
        onPointerUp={frame.onPointerUp}
        onPointerCancel={frame.onPointerUp}
        onContextMenu={(e) => {
          // From a menu its content portals elsewhere, not the title bar
          // itself: preventing it keeps the window menu shut.
          if (!e.currentTarget.contains(e.target as Node)) e.preventDefault();
        }}
        onDoubleClick={(e) => {
          if (!e.currentTarget.contains(e.target as Node) || (e.target as HTMLElement).closest(FIELD)) return;
          frame.toggleMaximize();
        }}
        className={cn('touch-none select-none', className)}
      >
        {/* Its fields keep their native menu; its own menus (a tab's)
            already claim the event, which the window menu then leaves be. */}
        <div
          className="contents"
          onContextMenu={(e) => {
            if ((e.target as HTMLElement).closest(FIELD)) e.stopPropagation();
          }}
        >
          {children}
        </div>
      </div>
    </WindowContextMenu>
  );
}

/** The window's minimize, maximize and close buttons. Nothing outside a Window. */
export function WindowControls({ className }: { className?: string }) {
  const frame = useWindowFrame();
  if (!frame) return null;
  const button = 'grid size-6 place-items-center rounded-md focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring';
  return (
    <div className={cn('flex shrink-0 items-center gap-2', className)}>
      <button type="button" aria-label="Minimize window" onClick={frame.minimize} className={cn(button, frame.muted, frame.hover)}>
        <Minus className="size-4" />
      </button>
      <button
        type="button"
        aria-label={frame.win.maximized ? 'Restore window' : 'Maximize window'}
        onClick={frame.toggleMaximize}
        className={cn(button, frame.muted, frame.hover)}
      >
        {frame.win.maximized ? <Minimize2 className="size-3.5" /> : <Maximize2 className="size-3.5" />}
      </button>
      <button
        type="button"
        aria-label="Close window"
        onClick={frame.close}
        className={cn(button, 'hover:bg-destructive/80 hover:text-destructive-foreground', frame.muted)}
      >
        <X className="size-4" />
      </button>
    </div>
  );
}
