import { useState, type ReactNode } from 'react';
import { cn } from '@/lib/utils';

/** A project's favicon (see useProjectIcons), or `fallback` when it has none or it doesn't load. */
export function ProjectIcon({
  src,
  fallback = null,
  className,
}: {
  src: string | undefined;
  fallback?: ReactNode;
  className?: string;
}) {
  const [failed, setFailed] = useState<string | null>(null);
  if (!src || failed === src) return fallback;
  return (
    <img
      src={src}
      alt=""
      aria-hidden
      draggable={false}
      onError={() => setFailed(src)}
      className={cn('size-3.5 shrink-0 rounded-sm object-contain', className)}
    />
  );
}
