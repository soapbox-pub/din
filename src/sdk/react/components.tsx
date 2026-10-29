/**
 * The title-bar pieces an app lays out in a `custom` frame, looking and
 * acting like the desktop's own, and the provider the hooks read.
 */
import type { ComponentProps, ReactNode } from 'react';
import { Maximize2, Minimize2, Minus, X } from 'lucide-react';
import { cn } from '@/lib/utils';
import type { Din } from '@/sdk/din';
import { DinContext, frameControlClasses, useDin, useFrameStyle, useWindowState } from '@/sdk/react/hooks';

export function DinProvider({ din, children }: { din: Din; children: ReactNode }) {
  return <DinContext.Provider value={din}>{children}</DinContext.Provider>;
}

const INTERACTIVE = 'button, input, textarea, select, a[href], [role="tab"], [data-window-no-drag]';
const FIELD = 'input, textarea, [contenteditable]:not([contenteditable="false"])';

/**
 * A stretch of title bar in a `custom` frame: pressing its empty space moves
 * the window, double-clicking maximizes it and right-clicking opens Din's
 * window menu. Buttons, tabs, fields and `[data-window-no-drag]` inside keep
 * their own clicks, and fields their native menu.
 */
export function WindowDragRegion({ className, children, onPointerDown, onDoubleClick, onContextMenu, ...props }: ComponentProps<'div'>) {
  const din = useDin();
  return (
    <div
      {...props}
      data-din-region="drag"
      onPointerDown={(e) => {
        onPointerDown?.(e);
        if (e.defaultPrevented || e.button !== 0) return;
        if ((e.target as HTMLElement).closest(INTERACTIVE)) return;
        if (!e.currentTarget.contains(e.target as Node)) return;
        e.preventDefault();
        // The move is handed to the desktop only once the pointer has moved
        // a little: the desktop then takes the whole gesture, and a click or
        // double-click would never come back here.
        const down = e.nativeEvent;
        const move = (m: PointerEvent) => {
          if (Math.hypot(m.clientX - down.clientX, m.clientY - down.clientY) < 3) return;
          stop();
          din.window.beginMove(down);
        };
        const stop = () => {
          window.removeEventListener('pointermove', move);
          window.removeEventListener('pointerup', stop);
          window.removeEventListener('pointercancel', stop);
        };
        window.addEventListener('pointermove', move);
        window.addEventListener('pointerup', stop);
        window.addEventListener('pointercancel', stop);
      }}
      onDoubleClick={(e) => {
        onDoubleClick?.(e);
        if (e.defaultPrevented || !e.currentTarget.contains(e.target as Node)) return;
        if ((e.target as HTMLElement).closest(`${INTERACTIVE}, ${FIELD}`)) return;
        din.window.toggleMaximize();
      }}
      onContextMenu={(e) => {
        onContextMenu?.(e);
        if (e.defaultPrevented || !e.currentTarget.contains(e.target as Node)) return;
        if ((e.target as HTMLElement).closest(FIELD)) return;
        e.preventDefault();
        din.window.showWindowMenu({ x: e.clientX, y: e.clientY });
      }}
      className={cn('touch-none select-none', className)}
    >
      {children}
    </div>
  );
}

/** Minimize, maximize and close, in the title bar's colors. */
export function WindowControls({ className }: { className?: string }) {
  const din = useDin();
  const state = useWindowState();
  const { muted, hover } = frameControlClasses(useFrameStyle());
  const button = 'grid size-6 place-items-center rounded-md focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring';
  return (
    <div className={cn('flex shrink-0 items-center gap-2', className)} data-window-no-drag>
      <button type="button" aria-label="Minimize window" onClick={() => din.window.minimize()} className={cn(button, muted, hover)}>
        <Minus className="size-4" />
      </button>
      <button
        type="button"
        aria-label={state.maximized ? 'Restore window' : 'Maximize window'}
        onClick={() => din.window.toggleMaximize()}
        className={cn(button, muted, hover)}
      >
        {state.maximized ? <Minimize2 className="size-3.5" /> : <Maximize2 className="size-3.5" />}
      </button>
      <button
        type="button"
        aria-label="Close window"
        onClick={() => din.window.requestClose()}
        className={cn(button, 'hover:bg-destructive/80 hover:text-destructive-foreground', muted)}
      >
        <X className="size-4" />
      </button>
    </div>
  );
}
