import { useId, useState, type ReactNode } from 'react';
import { ChevronDown } from 'lucide-react';
import { cn } from '@/lib/utils';
import { Button } from '@/components/ui/button';

/**
 * The layout every full-surface browser interstitial shares (a failed load, an
 * untrusted certificate, a limited site): a clay icon, a large headline, a
 * plain-language explanation with what to try, the actions, and the technical
 * details (address, Chromium's error code) folded away behind Details.
 */
export function Interstitial({
  icon,
  tone = 'neutral',
  title,
  children,
  actions,
  details,
}: {
  icon: ReactNode;
  tone?: 'neutral' | 'danger';
  title: ReactNode;
  children: ReactNode;
  actions: ReactNode;
  /** `[label, value]` rows shown under Details, in a monospace face. */
  details: [string, string][];
}) {
  const [showDetails, setShowDetails] = useState(false);
  const detailsId = useId();
  return (
    <div className="@container absolute inset-0 z-20 overflow-auto bg-background">
      <div className="flex min-h-full items-center justify-center px-6 py-12 @2xl:px-12">
        <div className="w-full max-w-xl motion-safe:animate-in motion-safe:fade-in-0 motion-safe:slide-in-from-bottom-2 motion-safe:duration-300">
          <div
            className={cn(
              'mb-8 flex size-16 items-center justify-center rounded-2xl clay',
              tone === 'danger' ? 'bg-destructive/12 text-destructive' : 'bg-card text-ink-accent',
            )}
          >
            {icon}
          </div>
          <h2 className="font-[family-name:var(--font-title)] text-3xl font-semibold leading-tight tracking-tight text-balance @lg:text-4xl">
            {title}
          </h2>
          <div className="mt-4 space-y-4 text-lg leading-relaxed text-pretty text-muted-foreground">{children}</div>
          <div className="mt-8 flex flex-wrap items-center gap-3">
            {actions}
            {details.length > 0 && (
              <Button
                size="lg"
                variant="ghost"
                className="text-muted-foreground"
                aria-expanded={showDetails}
                aria-controls={detailsId}
                onClick={() => setShowDetails((v) => !v)}
              >
                Details
                <ChevronDown
                  className={cn('size-4.5 motion-safe:transition-transform', showDetails && 'rotate-180')}
                  strokeWidth={1.75}
                />
              </Button>
            )}
          </div>
          {showDetails && (
            <dl id={detailsId} className="mt-6 space-y-3 rounded-xl bg-foreground/[0.04] p-4 text-sm">
              {details.map(([label, value]) => (
                <div key={label} className="space-y-0.5">
                  <dt className="text-muted-foreground">{label}</dt>
                  <dd className="font-mono break-all select-text">{value}</dd>
                </div>
              ))}
            </dl>
          )}
        </div>
      </div>
    </div>
  );
}

/** A host named in an interstitial's explanation, set off from the prose. */
export function Host({ children }: { children: ReactNode }) {
  return <span className="font-medium break-all text-foreground">{children}</span>;
}
