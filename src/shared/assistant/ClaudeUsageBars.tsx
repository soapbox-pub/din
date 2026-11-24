import { RefreshCw } from 'lucide-react';
import { useQueryClient } from '@tanstack/react-query';
import { Skeleton } from '@/components/ui/skeleton';
import { cleanAssistantError, getAssistantBridge, type ClaudeUsageLimit } from '@/lib/assistant';
import { cn } from '@/lib/utils';
import { claudeUsageKey, formatMoney, limitTone, resetWording, useClaudeUsage } from '@/shared/assistant/claudeUsage';

const BAR_TONE = { normal: 'bg-ink-accent', warning: 'bg-warning', critical: 'bg-destructive' } as const;

function LimitBar({ limit }: { limit: ClaudeUsageLimit }) {
  const percent = Math.max(0, Math.min(100, Math.round(limit.percent)));
  const tone = limitTone(limit);
  const reset = resetWording(limit.resetsAt);
  return (
    <div className="space-y-1">
      <div className="flex items-baseline justify-between gap-2 text-xs">
        <span className="truncate font-medium text-foreground/90">{limit.label}</span>
        <span className={cn('shrink-0 tabular-nums', tone === 'normal' ? 'text-muted-foreground' : tone === 'warning' ? 'text-warning' : 'text-destructive')}>
          {percent}% used
        </span>
      </div>
      <div
        role="progressbar"
        aria-label={`${limit.label}: ${percent}% used`}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={percent}
        className="h-1.5 overflow-hidden rounded-full bg-foreground/10"
      >
        <div className={cn('h-full rounded-full motion-safe:transition-[width]', BAR_TONE[tone])} style={{ width: `${percent}%` }} />
      </div>
      {reset && <p className="text-xs text-muted-foreground">{reset}</p>}
    </div>
  );
}

/**
 * The Claude plan's usage (claudeUsage.ts): a bar for each of its limits,
 * with when it resets, and any extra usage past them. Shown while Claude
 * is connected.
 */
export function ClaudeUsageBars({ className, refreshable = true }: { className?: string; refreshable?: boolean }) {
  const { data, error, isLoading, isFetching } = useClaudeUsage(true);
  const queryClient = useQueryClient();
  if (!getAssistantBridge()) return null;

  const refresh = async () => {
    const bridge = getAssistantBridge();
    if (!bridge) return;
    await queryClient.fetchQuery({ queryKey: claudeUsageKey, queryFn: () => bridge.claudeUsage(true), staleTime: 0 }).catch(() => {});
  };

  return (
    <section className={cn('space-y-2.5', className)} aria-label="Claude plan usage" aria-busy={isFetching}>
      <div className="flex items-center justify-between gap-2">
        <h4 className="text-xs font-semibold text-muted-foreground">Plan usage</h4>
        {refreshable && (
          <button
            type="button"
            onClick={() => void refresh()}
            disabled={isFetching}
            aria-label="Check usage again"
            title="Check again"
            className="grid size-6 place-items-center rounded-full text-muted-foreground hover:bg-foreground/[0.07] hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/60 focus-visible:outline-none disabled:opacity-50"
          >
            <RefreshCw className={cn('size-3.5', isFetching && 'motion-safe:animate-spin')} strokeWidth={1.75} aria-hidden />
          </button>
        )}
      </div>
      {isLoading ? (
        <div className="space-y-2">
          <Skeleton className="h-3 w-2/3" />
          <Skeleton className="h-1.5 w-full rounded-full" />
          <Skeleton className="h-3 w-1/3" />
        </div>
      ) : error && !data ? (
        <p className="text-xs text-muted-foreground">{cleanAssistantError(error)}</p>
      ) : data && data.limits.length === 0 ? (
        <p className="text-xs text-muted-foreground">Anthropic reports no limits for this plan.</p>
      ) : (
        data && (
          <>
            {data.limits.map((limit) => (
              <LimitBar key={limit.label} limit={limit} />
            ))}
            {data.extra && (
              <p className="text-xs text-muted-foreground">
                Extra usage: {formatMoney(data.extra.used, data.extra.currency)}
                {data.extra.limit !== null && ` of ${formatMoney(data.extra.limit, data.extra.currency)}`}
              </p>
            )}
          </>
        )
      )}
    </section>
  );
}
