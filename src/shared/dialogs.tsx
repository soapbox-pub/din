import { useEffect, useRef } from 'react';
import { cn } from '@/lib/utils';

/**
 * A dialog over its window's content (not the whole desktop): Escape closes,
 * clicking the backdrop closes, focus starts inside.
 */
export function Overlay({
  label,
  onClose,
  children,
  className,
}: {
  label: string;
  onClose: () => void;
  children: React.ReactNode;
  className?: string;
}) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = ref.current;
    if (el && !el.contains(document.activeElement)) {
      (el.querySelector<HTMLElement>('[autofocus], input, button') ?? el).focus();
    }
  }, []);
  return (
    <div
      className="absolute inset-0 z-30 grid place-items-center bg-black/40 p-4 motion-safe:animate-in motion-safe:fade-in-0"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        ref={ref}
        role="dialog"
        aria-modal="true"
        aria-label={label}
        tabIndex={-1}
        onKeyDown={(e) => {
          e.stopPropagation();
          if (e.key === 'Escape') onClose();
        }}
        className={cn(
          'flex max-h-full w-full max-w-md flex-col overflow-hidden rounded-xl border border-border/60 bg-popover text-popover-foreground shadow-2xl outline-none',
          'motion-safe:animate-in motion-safe:zoom-in-95',
          className,
        )}
      >
        {children}
      </div>
    </div>
  );
}

export function DialogButton({
  variant = 'secondary',
  className,
  ...props
}: React.ComponentProps<'button'> & { variant?: 'primary' | 'secondary' | 'destructive' }) {
  return (
    <button
      type="button"
      className={cn(
        'h-8 rounded-md px-3 text-sm font-medium focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50',
        variant === 'primary' && 'bg-primary text-primary-foreground hover:bg-primary/90',
        variant === 'secondary' && 'text-foreground/80 hover:bg-foreground/10 hover:text-foreground',
        variant === 'destructive' && 'bg-destructive text-white hover:bg-destructive/90',
        className,
      )}
      {...props}
    />
  );
}
