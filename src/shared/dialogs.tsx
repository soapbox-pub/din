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
          'flex max-h-full w-full max-w-md flex-col overflow-hidden rounded-xl border border-foreground/10 bg-popover text-popover-foreground shadow-2xl outline-none',
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
        'h-8 rounded-full px-4 text-sm font-medium focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/60 disabled:opacity-50',
        variant === 'primary' && 'bg-pigment text-primary-foreground clay-pigment hover:brightness-110',
        variant === 'secondary' && 'bg-secondary text-foreground clay hover:bg-secondary/80',
        variant === 'destructive' && 'bg-destructive text-white clay hover:bg-destructive/90',
        className,
      )}
      {...props}
    />
  );
}
