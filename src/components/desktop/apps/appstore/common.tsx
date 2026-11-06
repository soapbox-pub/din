import { useEffect, useRef, useState } from 'react';
import { RefreshCw, Store } from 'lucide-react';

/** Pieces the App Store's categories share. */

/**
 * The bottom of the list: loads the next page while it is on screen, once
 * the last one has been fetched and checked.
 */
export function MoreSentinel({ onReached, paused }: { onReached: () => void; paused: boolean }) {
  const ref = useRef<HTMLDivElement>(null);
  const [visible, setVisible] = useState(false);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const observer = new IntersectionObserver(
      (entries) => setVisible(entries.some((entry) => entry.isIntersecting)),
      { rootMargin: '400px' },
    );
    observer.observe(el);
    return () => observer.disconnect();
  }, []);
  useEffect(() => {
    if (visible && !paused) onReached();
  }, [visible, paused, onReached]);
  return (
    <div ref={ref} aria-hidden className="flex justify-center py-2">
      {paused && <RefreshCw className="size-4 animate-spin text-muted-foreground" />}
    </div>
  );
}

export function SectionHeader({ title, subtitle }: { title: string; subtitle?: string }) {
  return (
    <div>
      <h2 className="text-xl font-bold tracking-tight">{title}</h2>
      {subtitle && (
        <p className="mt-1 line-clamp-2 text-sm text-muted-foreground">{subtitle}</p>
      )}
    </div>
  );
}

export function EmptyState({ message }: { message: string }) {
  return (
    <div className="grid place-items-center py-8">
      <div className="max-w-sm rounded-xl px-8 py-12 text-center">
        <Store className="mx-auto mb-3 size-8 text-muted-foreground" aria-hidden />
        <p className="text-sm text-muted-foreground">{message}</p>
      </div>
    </div>
  );
}
