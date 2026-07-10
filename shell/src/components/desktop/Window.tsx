import { useCallback, useRef } from 'react';
import { Minus, X } from 'lucide-react';
import { cn } from '@/lib/utils';
import { getApp } from '@/lib/apps';
import { useWindowManager } from '@/contexts/WindowManagerContext';
import type { WindowState } from '@/hooks/useWindows';

/** A single draggable, focusable application window on the desktop. */
export function Window({ window: win, isTop }: { window: WindowState; isTop: boolean }) {
  const { close, minimize, focus, move } = useWindowManager();
  const app = getApp(win.appId);
  const dragOrigin = useRef<{ px: number; py: number; wx: number; wy: number } | null>(null);

  const onPointerDown = useCallback(
    (e: React.PointerEvent) => {
      // Ignore drags initiated on the control buttons.
      if ((e.target as HTMLElement).closest('button')) return;
      focus(win.id);
      dragOrigin.current = { px: e.clientX, py: e.clientY, wx: win.x, wy: win.y };
      (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    },
    [focus, win.id, win.x, win.y],
  );

  const onPointerMove = useCallback(
    (e: React.PointerEvent) => {
      const origin = dragOrigin.current;
      if (!origin) return;
      const nextX = origin.wx + (e.clientX - origin.px);
      const nextY = Math.max(0, origin.wy + (e.clientY - origin.py));
      move(win.id, nextX, nextY);
    },
    [move, win.id],
  );

  const onPointerUp = useCallback((e: React.PointerEvent) => {
    dragOrigin.current = null;
    (e.currentTarget as HTMLElement).releasePointerCapture(e.pointerId);
  }, []);

  if (!app || win.minimized) return null;

  const AppComponent = app.component;

  return (
    <section
      aria-label={app.name}
      onPointerDown={() => focus(win.id)}
      style={{ left: win.x, top: win.y, width: win.width, height: win.height, zIndex: win.z }}
      className={cn(
        'absolute flex flex-col overflow-hidden rounded-xl border border-white/10 bg-neutral-900 shadow-2xl',
        'ring-1 ring-black/40 transition-shadow',
        isTop && 'ring-white/20',
      )}
    >
      <header
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        className="flex h-9 shrink-0 cursor-grab touch-none select-none items-center gap-2 border-b border-white/10 bg-black/40 px-3 active:cursor-grabbing"
      >
        <app.icon className="size-4 shrink-0 text-white/70" aria-hidden />
        <span className="flex-1 truncate text-sm font-medium text-white/90">
          {app.name}
        </span>
        <button
          type="button"
          aria-label="Minimize window"
          onClick={() => minimize(win.id)}
          className="grid size-6 place-items-center rounded-md text-white/70 hover:bg-white/10 hover:text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/40"
        >
          <Minus className="size-4" />
        </button>
        <button
          type="button"
          aria-label="Close window"
          onClick={() => close(win.id)}
          className="grid size-6 place-items-center rounded-md text-white/70 hover:bg-red-500/80 hover:text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/40"
        >
          <X className="size-4" />
        </button>
      </header>

      <div className="relative flex-1 overflow-hidden bg-white">
        <AppComponent windowId={win.id} />
      </div>
    </section>
  );
}
