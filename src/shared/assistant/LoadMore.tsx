import { useEffect, useRef, type RefObject } from 'react';
import { Loader2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';

/**
 * The end of a list that has more: they load as it nears the view of
 * `scrollRef` from the `edge` it's at, or when it's clicked. It looks again
 * each time `loaded` changes, in case what came didn't fill the view. After
 * a `failed` load, or with `auto` off, only a click loads them.
 */
export function LoadMore({
  scrollRef,
  edge,
  loaded,
  loading,
  failed = false,
  auto = true,
  onLoad,
  label,
  loadingLabel,
  className,
}: {
  scrollRef: RefObject<HTMLElement | null>;
  edge: 'top' | 'bottom';
  /** How many are loaded so far. */
  loaded: number;
  loading: boolean;
  failed?: boolean;
  auto?: boolean;
  onLoad: () => void;
  label: string;
  loadingLabel: string;
  className?: string;
}) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = ref.current;
    const root = scrollRef.current;
    if (!el || !root || loading || failed || !auto) return;
    const observer = new IntersectionObserver((entries) => entries.some((e) => e.isIntersecting) && onLoad(), {
      root,
      rootMargin: edge === 'top' ? '800px 0px 0px 0px' : '0px 0px 400px 0px',
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, [scrollRef, edge, loaded, loading, failed, auto, onLoad]);

  return (
    <div ref={ref} className={cn('flex justify-center', className)}>
      {loading ? (
        <span className="flex h-8 items-center gap-2 text-xs text-muted-foreground" role="status">
          <Loader2 className="size-3.5 animate-spin" aria-hidden /> {loadingLabel}
        </span>
      ) : (
        <Button variant="ghost" size="sm" className="text-xs text-muted-foreground" onClick={() => onLoad()}>
          {label}
        </Button>
      )}
    </div>
  );
}
