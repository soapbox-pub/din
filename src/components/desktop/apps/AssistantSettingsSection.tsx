import { useEffect, useRef, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ArrowLeft, Bot, CircleAlert, ExternalLink, Folder, KeyRound, Loader2, Plus, RotateCw, Trash2 } from 'lucide-react';
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
import { Switch } from '@/components/ui/switch';
import { useFilePicker } from '@/contexts/FilePickerContext';
import { useAppContext } from '@/hooks/useAppContext';
import {
  assistantKeys,
  useAssistantIntegrations,
  useAssistantReady,
  useAssistantStatus,
  useHomeDirectory,
  useSetAssistantEnabled,
} from '@/hooks/useAssistant';
import { useOpenUrl } from '@/hooks/useOpenUrl';
import { useToast } from '@/hooks/useToast';
import {
  assistantApi,
  cleanAssistantError,
  getAssistantBridge,
  tildify,
  type IntegrationInfo,
  type OAuthAttempt,
} from '@/lib/assistant';
import { cn } from '@/lib/utils';

/**
 * Settings → Assistant: whether Din keeps OpenCode running, the state of
 * its server, where new conversations work, and the AI providers it may
 * use. Providers are OpenCode's own (its credential store), so ones added
 * from a Terminal show up here and the other way round.
 */
export function AssistantSettingsSection() {
  const { config, updateConfig } = useAppContext();
  const setEnabled = useSetAssistantEnabled();
  const bridge = getAssistantBridge();

  return (
    <section className="mx-auto flex max-w-2xl flex-col gap-4 p-4">
      <header className="flex items-center justify-between gap-2">
        <h2 className="text-lg font-semibold text-foreground">Assistant</h2>
      </header>

      {!bridge ? (
        <div className="rounded-xl border border-dashed border-border px-8 py-12 text-center">
          <Bot className="mx-auto mb-4 size-8 text-muted-foreground/80" aria-hidden />
          <p className="mx-auto max-w-sm text-sm text-muted-foreground">
            The assistant works through OpenCode on this computer, so it needs Din’s desktop app.
          </p>
        </div>
      ) : (
        <>
          <div className="flex items-center justify-between gap-4 rounded-md border bg-muted/20 p-3">
            <div className="flex min-w-0 items-start gap-3">
              <img src="/icons/apps/assistant.png" alt="" className="size-10 shrink-0 object-contain" />
              <div className="min-w-0">
                <Label htmlFor="assistant-enabled" className="cursor-pointer text-sm">
                  Assistant
                </Label>
                <p className="text-xs text-muted-foreground">
                  Keep OpenCode, the AI agent, running so you can ask it to do things on this computer: from the menu
                  bar, the Assistant app, or Super+A anywhere. It can read and change your files and run commands.
                </p>
              </div>
            </div>
            <Switch id="assistant-enabled" checked={config.assistantEnabled} onCheckedChange={setEnabled} />
          </div>

          {config.assistantEnabled && (
            <>
              <ServerStatus />
              <FolderSetting
                value={config.assistantDirectory}
                onChange={(assistantDirectory) => updateConfig((current) => ({ ...current, assistantDirectory }))}
              />
              <Providers />
            </>
          )}
        </>
      )}
    </section>
  );
}

function ServerStatus() {
  const { data: status } = useAssistantStatus();
  const { toast } = useToast();
  const bridge = getAssistantBridge();
  const install = useMutation({ mutationFn: () => bridge!.install() });
  const restart = useMutation({ mutationFn: () => bridge!.restart() });

  if (!status) return <Skeleton className="h-20 w-full rounded-md" />;

  const state = status.installing
    ? { label: 'Installing OpenCode…', tone: 'muted' }
    : !status.binary
      ? { label: status.version ? `OpenCode ${status.version} is too old` : 'OpenCode isn’t installed', tone: 'warn' }
      : status.running
        ? { label: status.connected ? 'Running' : 'Running, connecting…', tone: 'ok' }
        : status.error
          ? { label: 'Not running', tone: 'warn' }
          : { label: 'Starting…', tone: 'muted' };

  const fail = (title: string) => (error: unknown) =>
    toast({ title, description: cleanAssistantError(error), variant: 'destructive' });

  return (
    <div className="space-y-3 rounded-md border bg-muted/20 p-3">
      <div className="flex items-start justify-between gap-4">
        <div className="min-w-0">
          <p className="flex items-center gap-2 text-sm font-medium">
            <span
              aria-hidden
              className={cn(
                'size-2 rounded-full',
                state.tone === 'ok' && 'bg-emerald-500',
                state.tone === 'warn' && 'bg-amber-500',
                state.tone === 'muted' && 'bg-muted-foreground/50',
              )}
            />
            {state.label}
          </p>
          <p className="mt-0.5 truncate text-xs text-muted-foreground" title={status.binary ?? undefined}>
            {status.binary ? `OpenCode ${status.version ?? ''} · ${status.binary}` : 'OpenCode’s installer puts it in ~/.opencode, and it keeps itself up to date.'}
          </p>
        </div>
        <div className="flex shrink-0 gap-2">
          {!status.binary || (status.error && !status.running) ? (
            <Button
              size="sm"
              disabled={status.installing || install.isPending}
              onClick={() => install.mutate(undefined, { onError: fail('Couldn’t install OpenCode') })}
            >
              {(status.installing || install.isPending) && <Loader2 className="size-3.5 animate-spin" aria-hidden />}
              {status.binary ? 'Reinstall' : 'Install'}
            </Button>
          ) : (
            <Button
              size="sm"
              variant="outline"
              disabled={restart.isPending}
              title="Stops whatever the agent is doing, in Din and in Terminals"
              onClick={() => restart.mutate(undefined, { onError: fail('Couldn’t restart OpenCode') })}
            >
              {restart.isPending ? <Loader2 className="size-3.5 animate-spin" aria-hidden /> : <RotateCw className="size-3.5" aria-hidden />}
              Restart
            </Button>
          )}
        </div>
      </div>
      {status.error && !status.running && (
        <p role="alert" className="flex items-start gap-2 text-xs text-destructive">
          <CircleAlert className="mt-0.5 size-3.5 shrink-0" aria-hidden />
          <span className="break-words">{status.error}</span>
        </p>
      )}
      <p className="text-xs text-muted-foreground">
        Conversations are OpenCode’s, so they’re shared with <code className="font-mono">opencode</code> in a Terminal.
      </p>
    </div>
  );
}

function FolderSetting({ value, onChange }: { value: string; onChange: (path: string) => void }) {
  const home = useHomeDirectory();
  const { pickFile } = useFilePicker();
  const current = value.trim() || home;

  const choose = async () => {
    const picked = await pickFile({ title: 'Start conversations in', confirmLabel: 'Choose', directory: true, initialPath: current }).catch(
      () => null,
    );
    if (picked) onChange(picked === home ? '' : picked);
  };

  return (
    <div className="flex items-center justify-between gap-4 rounded-md border bg-muted/20 p-3">
      <div className="flex min-w-0 items-start gap-3">
        <Folder className="mt-0.5 size-4 shrink-0 text-muted-foreground" aria-hidden />
        <div className="min-w-0">
          <p className="text-sm">Start conversations in</p>
          <p className="truncate text-xs text-muted-foreground" title={current}>
            {current ? tildify(current, home) : 'Your home folder'} · each new conversation can pick another
          </p>
        </div>
      </div>
      <div className="flex shrink-0 gap-2">
        {value && (
          <Button variant="ghost" size="sm" onClick={() => onChange('')}>
            Use home
          </Button>
        )}
        <Button variant="outline" size="sm" onClick={() => void choose()}>
          Choose…
        </Button>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Providers
// ---------------------------------------------------------------------------

function Providers() {
  const ready = useAssistantReady();
  const { data: integrations, isLoading } = useAssistantIntegrations();
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const [adding, setAdding] = useState(false);
  const remove = useMutation({
    mutationFn: (credentialID: string) => assistantApi.removeCredential(credentialID),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: assistantKeys.integrations });
      void queryClient.invalidateQueries({ queryKey: assistantKeys.models });
    },
    onError: (error) => toast({ title: 'Couldn’t remove it', description: cleanAssistantError(error), variant: 'destructive' }),
  });

  const connected = (integrations ?? []).filter((i) => i.connections.length > 0);

  return (
    <div className="space-y-3">
      <div className="flex items-end justify-between gap-2">
        <div>
          <h3 className="text-sm font-medium text-foreground">AI providers</h3>
          <p className="text-xs text-muted-foreground">
            The services whose models the assistant may use. OpenCode’s free models need none.
          </p>
        </div>
        <Button variant="outline" size="sm" disabled={!ready} onClick={() => setAdding(true)}>
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
          {connected.map((integration) => (
            <li key={integration.id} className="flex items-center gap-3 px-3 py-2.5">
              <KeyRound className="size-4 shrink-0 text-muted-foreground" aria-hidden />
              <div className="min-w-0 flex-1">
                <p className="truncate text-sm font-medium">{integration.name}</p>
                <p className="truncate text-xs text-muted-foreground">
                  {integration.connections
                    .map((c) => (c.type === 'env' ? `$${c.name}` : c.label || 'Signed in'))
                    .join(' · ')}
                </p>
              </div>
              {integration.connections.map((c) =>
                c.type === 'credential' ? (
                  <Button
                    key={c.id}
                    variant="ghost"
                    size="icon"
                    className="size-8 text-muted-foreground hover:text-destructive"
                    aria-label={`Remove ${integration.name} (${c.label})`}
                    title="Remove"
                    disabled={remove.isPending}
                    onClick={() => remove.mutate(c.id)}
                  >
                    <Trash2 className="size-4" aria-hidden />
                  </Button>
                ) : null,
              )}
            </li>
          ))}
        </ul>
      )}

      <AddProviderDialog open={adding} onOpenChange={setAdding} integrations={integrations ?? []} />
    </div>
  );
}

function AddProviderDialog({
  open,
  onOpenChange,
  integrations,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  integrations: IntegrationInfo[];
}) {
  const [picked, setPicked] = useState<IntegrationInfo | null>(null);
  const close = (next: boolean) => {
    onOpenChange(next);
    if (!next) setPicked(null);
  };

  return (
    <Dialog open={open} onOpenChange={close}>
      <DialogContent className="gap-0 p-0 sm:max-w-md">
        <DialogHeader className="border-b border-border/60 p-4">
          <DialogTitle className="flex items-center gap-2">
            {picked && (
              <Button variant="ghost" size="icon" className="-ml-2 size-7" aria-label="Back" onClick={() => setPicked(null)}>
                <ArrowLeft className="size-4" aria-hidden />
              </Button>
            )}
            {picked ? picked.name : 'Add an AI provider'}
          </DialogTitle>
          <DialogDescription>
            {picked ? 'Connect it with an API key, or sign in.' : 'Choose the service to connect.'}
          </DialogDescription>
        </DialogHeader>
        {picked ? (
          <ConnectProvider integration={picked} onDone={() => close(false)} />
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
                    >
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

function ConnectProvider({ integration, onDone }: { integration: IntegrationInfo; onDone: () => void }) {
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const openUrl = useOpenUrl();
  const [key, setKey] = useState('');
  const [attempt, setAttempt] = useState<OAuthAttempt | null>(null);
  const [code, setCode] = useState('');

  const methods = integration.methods;
  const keyMethod = methods.find((m) => m.type === 'key');
  const oauthMethods = methods.filter((m): m is Extract<typeof m, { type: 'oauth' }> => m.type === 'oauth');
  const envMethod = methods.find((m): m is Extract<typeof m, { type: 'env' }> => m.type === 'env');

  const finish = () => {
    void queryClient.invalidateQueries({ queryKey: assistantKeys.integrations });
    void queryClient.invalidateQueries({ queryKey: assistantKeys.models });
    toast({ title: `${integration.name} is connected` });
    onDone();
  };
  const fail = (title: string) => (error: unknown) =>
    toast({ title, description: cleanAssistantError(error), variant: 'destructive' });

  const connectKey = useMutation({
    mutationFn: () => assistantApi.connectKey(integration.id, key.trim()),
    onSuccess: finish,
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
    mutationFn: () => assistantApi.completeOAuth(integration.id, attempt!.attemptID, code.trim()),
    onSuccess: finish,
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
    if (outcome === 'complete') finishRef.current();
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
          <Label htmlFor="provider-key">API key</Label>
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
              Connect
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
