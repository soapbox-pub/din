/**
 * The title-bar pieces an app lays out in a `custom` frame, looking and
 * acting like the desktop's own, and the provider the hooks read.
 */
import type { ComponentProps, ReactNode } from 'react';
import { Maximize2, Minimize2, Minus, X } from 'lucide-react';
import { cn } from '@/lib/utils';
import type { Din } from '@/sdk/din';
import { DinContext, frameControlClasses, useDin, useFormFactor, useFrameStyle, useMediaQuery } from '@/sdk/react/hooks';

export function DinProvider({ din, children }: { din: Din; children: ReactNode }) {
  return <DinContext.Provider value={din}>{children}</DinContext.Provider>;
}

const MAXIMIZED = '(display-state: maximized)';

/**
 * A stretch of title bar in a `custom` frame: CSS `app-region: drag`, so
 * pressing its empty space moves the window, double-clicking maximizes it
 * and right-clicking opens Din's window menu (the runtime does each).
 * Buttons, tabs, fields and `[data-window-no-drag]` inside keep their own
 * clicks, and fields their native menu. On a phone there's no window to
 * move, and it's just the bar.
 */
export function WindowDragRegion({ className, ...props }: ComponentProps<'div'>) {
  const phone = useFormFactor() === 'phone';
  return <div {...props} className={cn(phone ? 'select-none' : 'touch-none select-none [app-region:drag]', className)} />;
}

/**
 * Minimize, maximize and close, in the title bar's colors. Nothing on a
 * phone, where the phone's own navigation does all three.
 */
export function WindowControls({ className }: { className?: string }) {
  return useFormFactor() === 'phone' ? null : <DesktopWindowControls className={className} />;
}

function DesktopWindowControls({ className }: { className?: string }) {
  const din = useDin();
  const maximized = useMediaQuery(MAXIMIZED);
  const { muted, hover } = frameControlClasses(useFrameStyle());
  const button = 'grid size-6 place-items-center rounded-md focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring';
  return (
    <div className={cn('flex shrink-0 items-center gap-2', className)} data-window-no-drag>
      <button type="button" aria-label="Minimize window" onClick={() => void window.minimize()} className={cn(button, muted, hover)}>
        <Minus className="size-4" />
      </button>
      <button
        type="button"
        aria-label={maximized ? 'Restore window' : 'Maximize window'}
        onClick={() => void (maximized ? window.restore() : window.maximize())}
        className={cn(button, muted, hover)}
      >
        {maximized ? <Minimize2 className="size-3.5" /> : <Maximize2 className="size-3.5" />}
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
