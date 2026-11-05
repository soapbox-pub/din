import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { Toast as ToastPrimitive } from 'radix-ui';
import { X } from 'lucide-react';
import { cn } from '@/lib/utils';
import { glassPanel } from './appChromeStyles';
import { onToast, type ToastMessage } from '@/shared/toast';

/** The window's toasts (src/shared/toast.ts), and where they're placed. */
const SlotContext = createContext<((el: HTMLElement | null) => void) | null>(null);

/** Where the app's toasts appear, while it's mounted: an element in the app's own layout, which `className` places. */
export function ToastViewport({ className }: { className?: string }) {
  const setSlot = useContext(SlotContext);
  // Outside a Toaster (shared code on the desktop) there's nothing to place.
  if (!setSlot) return null;
  return <div ref={setSlot} className={cn('pointer-events-none z-[100] flex justify-center', className)} />;
}

export function Toaster({ children }: { children: ReactNode }) {
  const [current, setCurrent] = useState<(ToastMessage & { open: boolean }) | null>(null);
  const [slots, setSlots] = useState<HTMLElement[]>([]);

  useEffect(() => {
    return onToast((message) => setCurrent({ ...message, open: true }));
  }, []);

  const setSlot = useCallback((el: HTMLElement | null) => {
    if (!el) return;
    setSlots((s) => [...s, el]);
    return () => setSlots((s) => s.filter((x) => x !== el));
  }, []);

  // The latest placed viewport, else the window's bottom centre.
  const slot = slots.at(-1);
  const viewport = (
    <ToastPrimitive.Viewport
      label="Alerts ({hotkey})"
      className="pointer-events-none flex w-full max-w-[420px] list-none flex-col items-center outline-none"
    />
  );

  return (
    <SlotContext value={setSlot}>
      <ToastPrimitive.Provider swipeDirection="down" label="Alert">
        {children}
        {current && (
          <ToastPrimitive.Root
            key={current.id}
            open={current.open}
            onOpenChange={(open) => setCurrent((c) => (c && c.id === current.id ? { ...c, open } : c))}
            type={current.destructive ? 'foreground' : 'background'}
            duration={current.destructive ? 8000 : 4000}
            className={cn(
              'group pointer-events-auto relative flex w-max max-w-full items-start gap-3 py-3 pr-3 pl-4',
              current.destructive
                ? 'rounded-2xl border border-destructive bg-destructive text-destructive-foreground shadow-lg'
                : cn(glassPanel, 'text-foreground'),
              'data-[state=open]:animate-in data-[state=open]:fade-in-0 motion-safe:data-[state=open]:slide-in-from-bottom-2',
              'data-[state=closed]:animate-out data-[state=closed]:fade-out-0',
              'data-[swipe=move]:translate-y-(--radix-toast-swipe-move-y) data-[swipe=cancel]:translate-y-0 motion-safe:data-[swipe=cancel]:transition-transform',
              'data-[swipe=end]:animate-out data-[swipe=end]:fade-out-0',
            )}
          >
            <div className="min-w-0 flex-1 py-0.5">
              <ToastPrimitive.Title className="text-sm font-medium">{current.title}</ToastPrimitive.Title>
              {current.body && (
                <ToastPrimitive.Description className={cn('mt-0.5 text-sm', current.destructive ? 'opacity-90' : 'text-muted-foreground')}>
                  {current.body}
                </ToastPrimitive.Description>
              )}
            </div>
            <ToastPrimitive.Close
              aria-label="Dismiss"
              className="grid size-7 shrink-0 place-items-center rounded-md opacity-70 transition-opacity hover:opacity-100 focus-visible:opacity-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring motion-reduce:transition-none"
            >
              <X className="size-4" aria-hidden />
            </ToastPrimitive.Close>
          </ToastPrimitive.Root>
        )}
        {slot
          ? createPortal(viewport, slot)
          : createPortal(
              <div className="pointer-events-none fixed inset-x-0 bottom-4 z-[100] flex justify-center px-4">{viewport}</div>,
              document.body,
            )}
      </ToastPrimitive.Provider>
    </SlotContext>
  );
}
