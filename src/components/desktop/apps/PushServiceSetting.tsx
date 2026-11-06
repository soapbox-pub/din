import { useEffect, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Loader2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Skeleton } from '@/components/ui/skeleton';
import { cn } from '@/lib/utils';
import { getWebPushHost, type WebPushStatus } from '@/lib/webPush';
import { settingsCard } from '@/shared/settingsChromeStyles';
import { SettingsSubHeading } from '@/shared/settingsSection';

const QUERY_KEY = ['web-push', 'status'];

/**
 * The push service websites' Web Push subscriptions go through
 * (electron/web-push.mts): Mozilla's by default, the one Firefox uses, or
 * any server speaking its protocol. Changing it drops every subscription;
 * sites subscribe again on their next visit. Nothing outside the Electron
 * shell.
 */
export function PushServiceSetting() {
  const host = getWebPushHost();
  const queryClient = useQueryClient();

  const { data: status } = useQuery({
    queryKey: QUERY_KEY,
    queryFn: () => host!.status(),
    enabled: !!host,
  });

  useEffect(
    () => host?.onChanged(() => void queryClient.invalidateQueries({ queryKey: QUERY_KEY })),
    [host, queryClient],
  );

  if (!host) return null;

  return (
    <div>
      <SettingsSubHeading>Push service</SettingsSubHeading>
      <p className="mb-3 px-1 text-xs text-muted-foreground">
        Websites send their notifications through this service while they’re closed. Mozilla’s, the one Firefox
        uses, is the default.
      </p>
      {status ? (
        <ServerForm key={status.url} status={status} />
      ) : (
        <div className={cn(settingsCard, 'space-y-2 px-4 py-3')} aria-hidden>
          <Skeleton className="h-3.5 w-48" />
          <Skeleton className="h-9 w-full" />
        </div>
      )}
    </div>
  );
}

function ServerForm({ status }: { status: WebPushStatus }) {
  const host = getWebPushHost()!;
  const queryClient = useQueryClient();
  const [url, setUrl] = useState(status.url);
  const isDefault = status.url === status.defaultUrl;
  const edited = url.trim() !== status.url;

  const save = useMutation({
    mutationFn: (next: string | null) => host.setServer(next),
    onSettled: () => void queryClient.invalidateQueries({ queryKey: QUERY_KEY }),
  });

  return (
    <form
      className={cn(settingsCard, 'flex flex-col gap-3 px-4 py-3')}
      onSubmit={(event) => {
        event.preventDefault();
        if (edited) save.mutate(url.trim());
      }}
    >
      <StatusLine status={status} />
      <div className="flex flex-col gap-1.5">
        <Label htmlFor="push-service-url" className="text-xs text-muted-foreground">
          Server
        </Label>
        <div className="flex flex-wrap gap-2">
          <Input
            id="push-service-url"
            value={url}
            onChange={(event) => {
              setUrl(event.target.value);
              save.reset();
            }}
            spellCheck={false}
            autoComplete="off"
            className="min-w-48 flex-1 font-mono text-xs"
            aria-invalid={save.isError || undefined}
            aria-describedby="push-service-help"
          />
          <Button type="submit" size="sm" disabled={!edited || save.isPending}>
            {save.isPending && <Loader2 className="size-4 motion-safe:animate-spin" />}
            Save
          </Button>
          {!isDefault && (
            <Button type="button" size="sm" variant="outline" disabled={save.isPending} onClick={() => save.mutate(null)}>
              Use default
            </Button>
          )}
        </div>
        <p id="push-service-help" className={cn('text-xs', save.isError ? 'text-destructive' : 'text-muted-foreground')}>
          {save.isError
            ? errorMessage(save.error)
            : edited && status.subscriptions > 0
              ? 'Changing it unsubscribes every site; they subscribe again the next time they’re opened.'
              : 'Any server speaking Mozilla’s autopush protocol (wss://).'}
        </p>
      </div>
    </form>
  );
}

function StatusLine({ status }: { status: WebPushStatus }) {
  const sites = status.subscriptions === 1 ? '1 subscription' : `${status.subscriptions} subscriptions`;
  const [dot, label] =
    status.state === 'ready'
      ? ['bg-success', 'Connected']
      : status.state === 'connecting'
        ? ['bg-warning', 'Connecting…']
        : status.subscriptions === 0
          ? ['bg-muted-foreground/50', 'Connects when a site subscribes']
          : ['bg-destructive', status.lastError ? `Not connected (${status.lastError})` : 'Not connected'];
  return (
    <p className="flex items-center gap-2 text-sm" role="status">
      <span className={cn('size-2 shrink-0 rounded-full', dot)} aria-hidden />
      <span className="min-w-0 truncate">{label}</span>
      <span className="ml-auto shrink-0 text-xs text-muted-foreground">{sites}</span>
    </p>
  );
}

/** What Electron's IPC leaves of an error thrown in the main process. */
function errorMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.replace(/^Error invoking remote method '[^']+': (Error: )?/, '');
}
