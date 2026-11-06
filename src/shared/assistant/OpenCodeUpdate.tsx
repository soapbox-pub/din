import { useMutation } from '@tanstack/react-query';
import { ArrowUpCircle, Loader2, X } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { useAssistantHost } from '@/shared/assistant/host';
import { useAssistantStatus } from '@/hooks/useAssistant';
import { useLocalStorage } from '@/hooks/useLocalStorage';
import { cleanAssistantError, getAssistantBridge } from '@/lib/assistant';
import { cn } from '@/lib/utils';

/**
 * A newer OpenCode is out, as OpenCode's TUI says: update to it (which
 * restarts its server), or not now, until the one after. Nothing while
 * OpenCode is current.
 */
export function OpenCodeUpdate({ className }: { className?: string }) {
  const { data: status } = useAssistantStatus();
  const host = useAssistantHost();
  const [skipped, setSkipped] = useLocalStorage<string | null>('din.assistant.skippedUpdate', null);
  const upgrade = useMutation({ mutationFn: () => getAssistantBridge()!.upgrade() });

  const updating = status?.updating || upgrade.isPending;
  if (!status?.update || (status.update === skipped && !updating)) return null;

  const run = () =>
    upgrade.mutate(undefined, {
      onSuccess: () => host.notify({ title: `OpenCode is up to date` }),
      onError: (error) => host.notify({ title: 'Couldn’t update OpenCode', description: cleanAssistantError(error), destructive: true }),
    });

  return (
    <div role="status" className={cn('flex items-start gap-2 rounded-lg border bg-background p-2.5 text-xs shadow-sm', className)}>
      {updating ? (
        <Loader2 className="mt-0.5 size-4 shrink-0 animate-spin text-muted-foreground" aria-hidden />
      ) : (
        <ArrowUpCircle className="mt-0.5 size-4 shrink-0 text-ink-accent" aria-hidden />
      )}
      <div className="min-w-0 flex-1">
        <p className="font-medium text-foreground">{updating ? 'Updating OpenCode…' : `OpenCode ${status.update} is out`}</p>
        <p className="mt-0.5 text-muted-foreground">
          {updating ? 'It restarts when it’s done.' : `This computer has ${status.version}. Updating restarts it, stopping what it’s doing.`}
        </p>
        {!updating && (
          <Button size="sm" className="mt-2 h-7 px-2.5 text-xs" onClick={run}>
            Update
          </Button>
        )}
      </div>
      {!updating && (
        <Button
          variant="ghost"
          size="icon"
          className="-mr-1 -mt-1 size-6 shrink-0 text-muted-foreground"
          aria-label="Not now"
          title="Not now"
          onClick={() => setSkipped(status.update)}
        >
          <X className="size-3.5" aria-hidden />
        </Button>
      )}
    </div>
  );
}
