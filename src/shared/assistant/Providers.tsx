import { useEffect, useMemo, useRef, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ArrowLeft, ExternalLink, Loader2, Pencil, Plus, Trash2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from '@/components/ui/command';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Skeleton } from '@/components/ui/skeleton';
import { ProviderIcon } from '@/shared/assistant/ProviderIcon';
import { assistantKeys, useAssistantIntegrations, useAssistantModels, useAssistantReady } from '@/hooks/useAssistant';
import { assistantApi, cleanAssistantError, type IntegrationInfo, type OAuthAttempt } from '@/lib/assistant';
import { useAssistantHost } from '@/shared/assistant/host';

/** Each provider's base URL, from its models, for its icon. */
function useProviderBaseURLs(): Map<string, string> {
  const { data } = useAssistantModels();
  return useMemo(() => {
    const urls = new Map<string, string>();
    for (const model of data?.models ?? []) {
      const url = model.settings?.baseURL;
      if (url && !urls.has(model.providerID)) urls.set(model.providerID, url);
    }
    return urls;
  }, [data]);
}

function useRefreshProviders() {
  const queryClient = useQueryClient();
  return () => {
    void queryClient.invalidateQueries({ queryKey: assistantKeys.integrations });
    void queryClient.invalidateQueries({ queryKey: assistantKeys.models });
  };
}

/** The credential ids a provider is connected with (not environment variables). */
function credentialIDs(integration: IntegrationInfo): string[] {
  return integration.connections.flatMap((c) => (c.type === 'credential' ? [c.id] : []));
}

/**
 * The AI providers OpenCode is connected to, with controls to add one,
 * replace one's key (or sign in again), and remove one. Providers are
 * OpenCode's own (its credential store), so ones added from a Terminal show
 * up here and the other way round.
 */
export function ProviderList({ description = true }: { description?: boolean }) {
  const ready = useAssistantReady();
  const { data: integrations, isLoading } = useAssistantIntegrations();
  const baseURLs = useProviderBaseURLs();
  const refresh = useRefreshProviders();
  const { notify } = useAssistantHost();
  const [dialog, setDialog] = useState<{ open: boolean; integration: IntegrationInfo | null }>({
    open: false,
    integration: null,
  });
  const remove = useMutation({
    mutationFn: (ids: string[]) => Promise.all(ids.map((id) => assistantApi.removeCredential(id))),
    onSuccess: refresh,
    onError: (error) => notify({ title: 'Couldn’t remove it', description: cleanAssistantError(error), destructive: true }),
  });

  const connected = (integrations ?? []).filter((i) => i.connections.length > 0);

  return (
    <div className="space-y-3">
      <div className="flex items-end justify-between gap-2">
        <div>
          <h3 className="text-sm font-medium text-foreground">AI providers</h3>
          {description && (
            <p className="text-xs text-muted-foreground">
              The services whose models the assistant may use. OpenCode’s free models need none.
            </p>
          )}
        </div>
        <Button variant="outline" size="sm" disabled={!ready} onClick={() => setDialog({ open: true, integration: null })}>
          <Plus className="size-3.5" aria-hidden /> Add
        </Button>
      </div>

      {!ready || isLoading ? (
        <div className="space-y-2">
          <Skeleton className="h-12 w-full rounded-md" />
          <Skeleton className="h-12 w-full rounded-md" />
        </div>
      ) : connected.length === 0 ? (
        <div className="rounded-md border border-dashed px-6 py-8 text-center text-sm text-muted-foreground">
          No providers yet. Add one with an API key or by signing in.
        </div>
      ) : (
        <ul className="divide-y divide-border/60 rounded-md border">
          {connected.map((integration) => {
            const credentials = credentialIDs(integration);
            return (
              <li key={integration.id} className="flex items-center gap-3 px-3 py-2.5">
                <ProviderIcon baseURL={baseURLs.get(integration.id)} className="text-muted-foreground" />
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm font-medium">{integration.name}</p>
                  <p className="truncate text-xs text-muted-foreground">
                    {integration.connections
                      .map((c) => (c.type === 'env' ? `$${c.name}` : c.label || 'Signed in'))
                      .join(' · ')}
                  </p>
                </div>
                <Button
                  variant="ghost"
                  size="icon"
                  className="size-8 text-muted-foreground hover:text-foreground"
                  aria-label={`Edit ${integration.name}`}
                  title="Replace the key, or sign in again"
                  onClick={() => setDialog({ open: true, integration })}
                >
                  <Pencil className="size-4" aria-hidden />
                </Button>
                {credentials.length > 0 && (
                  <Button
                    variant="ghost"
                    size="icon"
                    className="size-8 text-muted-foreground hover:text-destructive"
                    aria-label={`Remove ${integration.name}`}
                    title="Remove"
                    disabled={remove.isPending}
                    onClick={() => remove.mutate(credentials)}
                  >
                    <Trash2 className="size-4" aria-hidden />
                  </Button>
                )}
              </li>
            );
          })}
        </ul>
      )}

      <ProviderDialog
        open={dialog.open}
        initial={dialog.integration}
        onOpenChange={(open) => setDialog((current) => ({ ...current, open }))}
        integrations={integrations ?? []}
      />
    </div>
  );
}

/** The provider list in a dialog, for the model picker's "Manage providers". */
export function ManageProvidersDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (open: boolean) => void }) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Manage providers</DialogTitle>
          <DialogDescription>The services whose models the assistant may use. OpenCode’s free models need none.</DialogDescription>
        </DialogHeader>
        <ProviderList description={false} />
      </DialogContent>
    </Dialog>
  );
}

/** Pick a provider to connect, or (given `initial`) reconnect that one. */
function ProviderDialog({
  open,
  initial,
  onOpenChange,
  integrations,
}: {
  open: boolean;
  initial: IntegrationInfo | null;
  onOpenChange: (open: boolean) => void;
  integrations: IntegrationInfo[];
}) {
  const [picked, setPicked] = useState<IntegrationInfo | null>(initial);
  const [opened, setOpened] = useState({ open, initial });
  if (opened.open !== open || opened.initial !== initial) {
    setOpened({ open, initial });
    if (open) setPicked(initial);
  }
  const editing = picked !== null && picked.connections.length > 0;
  const baseURLs = useProviderBaseURLs();

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="gap-0 p-0 sm:max-w-md">
        <DialogHeader className="border-b border-border/60 p-4">
          <DialogTitle className="flex items-center gap-2">
            {picked && !initial && (
              <Button variant="ghost" size="icon" className="-ml-2 size-7" aria-label="Back" onClick={() => setPicked(null)}>
                <ArrowLeft className="size-4" aria-hidden />
              </Button>
            )}
            {picked ? (editing ? `Edit ${picked.name}` : picked.name) : 'Add an AI provider'}
          </DialogTitle>
          <DialogDescription>
            {picked
              ? editing
                ? 'Replace its API key, or sign in again.'
                : 'Connect it with an API key, or sign in.'
              : 'Choose the service to connect.'}
          </DialogDescription>
        </DialogHeader>
        {picked ? (
          <ConnectProvider key={picked.id} integration={picked} onDone={() => onOpenChange(false)} />
        ) : (
          <Command className="rounded-none">
            <CommandInput placeholder="Search providers…" />
            <CommandList className="max-h-80">
              <CommandEmpty>No provider matches.</CommandEmpty>
              <CommandGroup>
                {[...integrations]
                  .sort((a, b) => a.name.localeCompare(b.name))
                  .map((integration) => (
                    <CommandItem
                      key={integration.id}
                      value={`${integration.name} ${integration.id}`}
                      onSelect={() => setPicked(integration)}
                      className="gap-2"
                    >
                      <ProviderIcon baseURL={baseURLs.get(integration.id)} className="text-muted-foreground" />
                      <span className="flex-1 truncate">{integration.name}</span>
                      {integration.connections.length > 0 && (
                        <span className="text-xs text-muted-foreground">Connected</span>
                      )}
                    </CommandItem>
                  ))}
              </CommandGroup>
            </CommandList>
          </Command>
        )}
      </DialogContent>
    </Dialog>
  );
}

/**
 * Connect a provider with a key or by signing in. A provider that's already
 * connected keeps one credential: the new one replaces the old.
 */
function ConnectProvider({ integration, onDone }: { integration: IntegrationInfo; onDone: () => void }) {
  const refresh = useRefreshProviders();
  const { notify, openUrl } = useAssistantHost();
  const [key, setKey] = useState('');
  const [attempt, setAttempt] = useState<OAuthAttempt | null>(null);
  const [code, setCode] = useState('');
  const [replacing] = useState(() => credentialIDs(integration));

  const methods = integration.methods;
  const keyMethod = methods.find((m) => m.type === 'key');
  const oauthMethods = methods.filter((m): m is Extract<typeof m, { type: 'oauth' }> => m.type === 'oauth');
  const envMethod = methods.find((m): m is Extract<typeof m, { type: 'env' }> => m.type === 'env');

  const finish = async () => {
    // The new credential is in; the ones it replaces go.
    await Promise.allSettled(replacing.map((id) => assistantApi.removeCredential(id)));
    refresh();
    notify({ title: replacing.length > 0 ? `${integration.name} is updated` : `${integration.name} is connected` });
    onDone();
  };
  const fail = (title: string) => (error: unknown) =>
    notify({ title, description: cleanAssistantError(error), destructive: true });

  const connectKey = useMutation({
    mutationFn: async () => {
      await assistantApi.connectKey(integration.id, key.trim());
      await finish();
    },
    onError: fail('Couldn’t connect'),
  });
  const startOAuth = useMutation({
    mutationFn: (methodID: string) => assistantApi.connectOAuth(integration.id, methodID),
    onSuccess: (started) => {
      setAttempt(started);
      openUrl(started.url);
    },
    onError: fail('Couldn’t start signing in'),
  });
  const completeOAuth = useMutation({
    mutationFn: async () => {
      await assistantApi.completeOAuth(integration.id, attempt!.attemptID, code.trim());
      await finish();
    },
    onError: fail('That code didn’t work'),
  });

  // A sign-in the provider completes on its own: wait for it.
  const status = useQuery({
    queryKey: ['assistant', 'oauth', integration.id, attempt?.attemptID],
    queryFn: () => assistantApi.oauthStatus(integration.id, attempt!.attemptID),
    enabled: attempt?.mode === 'auto',
    refetchInterval: (query) => (query.state.data?.status === 'pending' || !query.state.data ? 2_000 : false),
  });
  const outcome = status.data?.status;
  const finishRef = useRef(finish);
  useEffect(() => {
    finishRef.current = finish;
  });
  // Finishing closes the dialog, and this with it.
  useEffect(() => {
    if (outcome === 'complete') void finishRef.current();
  }, [outcome]);

  if (attempt) {
    return (
      <div className="space-y-4 p-4">
        <p className="text-sm text-muted-foreground">{attempt.instructions || 'Finish signing in in the browser.'}</p>
        <Button variant="outline" size="sm" onClick={() => openUrl(attempt.url)}>
          <ExternalLink className="size-3.5" aria-hidden /> Open the sign-in page again
        </Button>
        {attempt.mode === 'code' ? (
          <form
            className="flex gap-2"
            onSubmit={(event) => {
              event.preventDefault();
              if (code.trim()) completeOAuth.mutate();
            }}
          >
            <Input autoFocus value={code} onChange={(e) => setCode(e.target.value)} placeholder="Paste the code" aria-label="Code" />
            <Button type="submit" disabled={!code.trim() || completeOAuth.isPending}>
              {completeOAuth.isPending && <Loader2 className="size-3.5 animate-spin" aria-hidden />}
              Connect
            </Button>
          </form>
        ) : outcome === 'failed' || outcome === 'expired' ? (
          <p role="alert" className="text-sm text-destructive">
            {status.data?.status === 'failed' ? status.data.message : 'The sign-in expired.'} Try again.
          </p>
        ) : (
          <p className="flex items-center gap-2 text-sm text-muted-foreground">
            <Loader2 className="size-3.5 animate-spin" aria-hidden /> Waiting for you to sign in…
          </p>
        )}
      </div>
    );
  }

  return (
    <div className="space-y-4 p-4">
      {oauthMethods.map((method) => (
        <Button
          key={method.id}
          className="w-full"
          variant="outline"
          disabled={startOAuth.isPending}
          onClick={() => startOAuth.mutate(method.id)}
        >
          {startOAuth.isPending && startOAuth.variables === method.id && <Loader2 className="size-3.5 animate-spin" aria-hidden />}
          {method.label}
        </Button>
      ))}
      {keyMethod && (
        <form
          className="space-y-2"
          onSubmit={(event) => {
            event.preventDefault();
            if (key.trim()) connectKey.mutate();
          }}
        >
          <Label htmlFor="provider-key">{replacing.length > 0 ? 'New API key' : 'API key'}</Label>
          <div className="flex gap-2">
            <Input
              id="provider-key"
              type="password"
              autoComplete="off"
              autoFocus={oauthMethods.length === 0}
              value={key}
              onChange={(e) => setKey(e.target.value)}
              placeholder={`Your ${integration.name} API key`}
            />
            <Button type="submit" disabled={!key.trim() || connectKey.isPending}>
              {connectKey.isPending && <Loader2 className="size-3.5 animate-spin" aria-hidden />}
              {replacing.length > 0 ? 'Save' : 'Connect'}
            </Button>
          </div>
          <p className="text-xs text-muted-foreground">Kept by OpenCode on this computer.</p>
        </form>
      )}
      {!keyMethod && oauthMethods.length === 0 && (
        <p className="text-sm text-muted-foreground">
          {envMethod
            ? `Set ${envMethod.names.map((n) => `$${n}`).join(' or ')} in your environment, then restart the assistant.`
            : 'Set this one up from a Terminal with `opencode auth`.'}
        </p>
      )}
    </div>
  );
}
