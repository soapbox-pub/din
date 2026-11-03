import { useEffect, useMemo, useRef, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ArrowLeft, Check, ChevronRight, CircleAlert, ExternalLink, Loader2, Pencil, Plus, Trash2 } from 'lucide-react';
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
import {
  assistantApi,
  cleanAssistantError,
  credentialIDs,
  providerName,
  type IntegrationInfo,
  type OAuthAttempt,
} from '@/lib/assistant';
import { CLAUDE_PROVIDER } from '@/lib/claudeProvider';
import {
  cancelClaudeSetup,
  sendClaudeCode,
  startClaudeSetup,
  useClaudeSetup,
  type ClaudeSetupState,
} from '@/shared/assistant/claudeSetup';
import { useAssistantHost } from '@/shared/assistant/host';
import { cn } from '@/lib/utils';

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

/** The providers offered first, as big buttons, before the full list. */
const FEATURED: { id: string; blurb: string; className: string }[] = [
  {
    id: CLAUDE_PROVIDER,
    blurb: 'Use your Claude Pro or Max plan',
    className: 'bg-gradient-to-br from-[#D97757] to-[#B85C3E] text-white hover:from-[#C96A4B] hover:to-[#A85335]',
  },
  {
    id: 'openrouter',
    blurb: 'Hundreds of models with one key',
    className: 'bg-gradient-to-br from-[#6467F2] to-[#4338CA] text-white hover:from-[#5558E8] hover:to-[#3730A3]',
  },
];

/** Where a provider hands out API keys, for a link beside the field. */
const KEY_PAGES: Record<string, string> = {
  openrouter: 'https://openrouter.ai/settings/keys',
  anthropic: 'https://console.anthropic.com/settings/keys',
  openai: 'https://platform.openai.com/api-keys',
  google: 'https://aistudio.google.com/apikey',
  xai: 'https://console.x.ai',
  deepseek: 'https://platform.deepseek.com/api_keys',
  groq: 'https://console.groq.com/keys',
  mistral: 'https://console.mistral.ai/api-keys',
};

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
          <Plus className="size-3.5" aria-hidden /> Add provider
        </Button>
      </div>

      <ClaudeSetupCard />

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
            const name = providerName(integration.id, integration.name);
            const problem = integration.connections.find((c) => c.status)?.status;
            return (
              <li key={integration.id} className="flex items-center gap-3 px-3 py-2.5">
                <ProviderIcon providerID={integration.id} baseURL={baseURLs.get(integration.id)} size={20} className="text-foreground/80" />
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm font-medium">{name}</p>
                  {problem ? (
                    <p className="flex items-center gap-1 truncate text-xs text-amber-700 dark:text-amber-400" title={problem.message}>
                      <CircleAlert className="size-3 shrink-0" aria-hidden />
                      <span className="truncate">{problem.message}</span>
                    </p>
                  ) : (
                    <p className="truncate text-xs text-muted-foreground">
                      {integration.connections
                        .map((c) => (c.type === 'env' ? `$${c.name}` : c.method === 'external' ? 'Signed in' : c.label || 'Signed in'))
                        .join(' · ')}
                    </p>
                  )}
                </div>
                <Button
                  variant="ghost"
                  size="icon"
                  className="size-8 text-muted-foreground hover:text-foreground"
                  aria-label={`Edit ${name}`}
                  title={problem ? 'Fix it' : 'Replace the key, or sign in again'}
                  onClick={() => setDialog({ open: true, integration })}
                >
                  <Pencil className="size-4" aria-hidden />
                </Button>
                {credentials.length > 0 && (
                  <Button
                    variant="ghost"
                    size="icon"
                    className="size-8 text-muted-foreground hover:text-destructive"
                    aria-label={`Remove ${name}`}
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

      <AddProviderDialog
        open={dialog.open}
        initial={dialog.integration}
        onOpenChange={(open) => setDialog((current) => ({ ...current, open }))}
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

/**
 * Pick a provider to connect (Claude and OpenRouter first, the rest under
 * Other providers), or (given `initial`) reconnect that one.
 */
export function AddProviderDialog({
  open,
  initial = null,
  onOpenChange,
}: {
  open: boolean;
  initial?: IntegrationInfo | null;
  onOpenChange: (open: boolean) => void;
}) {
  const { data: integrations } = useAssistantIntegrations(open);
  const [picked, setPicked] = useState<IntegrationInfo | null>(initial);
  const [browsing, setBrowsing] = useState(false);
  const [opened, setOpened] = useState({ open, initial });
  if (opened.open !== open || opened.initial !== initial) {
    setOpened({ open, initial });
    if (open) {
      setPicked(initial);
      setBrowsing(false);
    }
  }
  const editing = picked !== null && picked.connections.length > 0;
  const name = picked ? providerName(picked.id, picked.name) : '';
  const back = picked && !initial ? () => setPicked(null) : browsing && !picked ? () => setBrowsing(false) : null;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="gap-0 p-0 sm:max-w-md">
        <DialogHeader className="border-b border-border/60 p-4">
          <DialogTitle className="flex items-center gap-2">
            {back && (
              <Button variant="ghost" size="icon" className="-ml-2 size-7" aria-label="Back" onClick={back}>
                <ArrowLeft className="size-4" aria-hidden />
              </Button>
            )}
            {picked && <ProviderIcon providerID={picked.id} size={20} className="text-foreground/80" />}
            {picked ? (editing && picked.id !== CLAUDE_PROVIDER ? `Edit ${name}` : name) : browsing ? 'Other providers' : 'Add an AI provider'}
          </DialogTitle>
          <DialogDescription>
            {picked
              ? picked.id === CLAUDE_PROVIDER
                ? 'Your Claude plan, through Claude Code on this computer. Din sets it all up.'
                : editing
                  ? 'Replace its API key, or sign in again.'
                  : 'Connect it with an API key, or sign in.'
              : browsing
                ? 'Every service OpenCode can use.'
                : 'Choose the service whose models the assistant uses.'}
          </DialogDescription>
        </DialogHeader>
        {picked ? (
          picked.id === CLAUDE_PROVIDER ? (
            <ClaudeSetup key={picked.id} onDone={() => onOpenChange(false)} />
          ) : (
            <ConnectProvider key={picked.id} integration={picked} onDone={() => onOpenChange(false)} />
          )
        ) : !integrations ? (
          <div className="space-y-3 p-4">
            <Skeleton className="h-16 w-full rounded-xl" />
            <Skeleton className="h-16 w-full rounded-xl" />
          </div>
        ) : browsing ? (
          <AllProviders integrations={integrations} onPick={setPicked} />
        ) : (
          <FeaturedProviders integrations={integrations} onPick={setPicked} onOther={() => setBrowsing(true)} />
        )}
      </DialogContent>
    </Dialog>
  );
}

function FeaturedProviders({
  integrations,
  onPick,
  onOther,
}: {
  integrations: IntegrationInfo[];
  onPick: (integration: IntegrationInfo) => void;
  onOther: () => void;
}) {
  const featured = FEATURED.flatMap((f) => {
    const integration = integrations.find((i) => i.id === f.id);
    return integration ? [{ ...f, integration }] : [];
  });
  return (
    <div className="space-y-3 p-4">
      {featured.map(({ id, blurb, className, integration }) => (
        <button
          key={id}
          type="button"
          onClick={() => onPick(integration)}
          className={cn(
            'flex w-full items-center gap-4 rounded-xl px-4 py-3.5 text-left shadow-sm transition-[background-color,transform] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 motion-safe:active:scale-[0.99]',
            className,
          )}
        >
          <span className="grid size-10 shrink-0 place-items-center rounded-lg bg-white/15">
            {id === CLAUDE_PROVIDER ? (
              <ClaudeMark className="size-6" />
            ) : (
              <ProviderIcon providerID={id} size={24} className="text-white" />
            )}
          </span>
          <span className="min-w-0 flex-1">
            <span className="block text-base font-semibold">{providerName(id, integration.name)}</span>
            <span className="block truncate text-sm text-white/85">{blurb}</span>
          </span>
          {integration.connections.length > 0 ? (
            <span className="flex shrink-0 items-center gap-1 rounded-full bg-white/20 px-2 py-0.5 text-xs font-medium">
              <Check className="size-3" aria-hidden /> Connected
            </span>
          ) : (
            <ChevronRight className="size-4 shrink-0 opacity-80" aria-hidden />
          )}
        </button>
      ))}
      <Button variant="ghost" size="sm" className="w-full justify-between text-muted-foreground" onClick={onOther}>
        Other providers
        <ChevronRight className="size-4" aria-hidden />
      </Button>
    </div>
  );
}

/** Claude's mark in one color, for the colored button (the icon itself is Claude's orange). */
function ClaudeMark({ className }: { className?: string }) {
  const mask = 'url("/claude.svg") center / contain no-repeat';
  return <span aria-hidden className={cn('inline-block bg-white', className)} style={{ mask, WebkitMask: mask }} />;
}

function AllProviders({ integrations, onPick }: { integrations: IntegrationInfo[]; onPick: (integration: IntegrationInfo) => void }) {
  const baseURLs = useProviderBaseURLs();
  return (
    <Command className="rounded-none">
      <CommandInput autoFocus placeholder="Search providers…" />
      <CommandList className="max-h-96">
        <CommandEmpty>No provider matches.</CommandEmpty>
        <CommandGroup>
          {[...integrations]
            .map((integration) => ({ integration, name: providerName(integration.id, integration.name) }))
            .sort((a, b) => a.name.localeCompare(b.name))
            .map(({ integration, name }) => (
              <CommandItem
                key={integration.id}
                value={`${name} ${integration.id}`}
                onSelect={() => onPick(integration)}
                className="gap-2.5"
              >
                <ProviderIcon providerID={integration.id} baseURL={baseURLs.get(integration.id)} size={18} className="text-foreground/80" />
                <span className="flex-1 truncate">{name}</span>
                {integration.connections.length > 0 && <span className="text-xs text-muted-foreground">Connected</span>}
              </CommandItem>
            ))}
        </CommandGroup>
      </CommandList>
    </Command>
  );
}

/**
 * Claude, set up for the user from start to end (claudeSetup.ts): Claude
 * Code installed if it isn't, signed in to their Claude plan in the browser
 * if it isn't, and OpenCode connected to it. Closing the dialog leaves it
 * going, in the provider list; where the dialog would cover the sign-in
 * page (the desktop's), it closes itself for it.
 */
function ClaudeSetup({ onDone }: { onDone: () => void }) {
  const refresh = useRefreshProviders();
  const { notify, openUrl, dialogsOverWindows } = useAssistantHost();
  const state = useClaudeSetup();
  const hooks = useRef({ refresh, notify, openUrl, onDone });
  useEffect(() => {
    hooks.current = { refresh, notify, openUrl, onDone };
  });

  useEffect(() => {
    startClaudeSetup({
      openUrl: (url) => hooks.current.openUrl(url),
      onConnected: (account) => {
        hooks.current.refresh();
        hooks.current.notify({ title: 'Claude is connected', description: account ? `Signed in as ${account}` : undefined });
      },
    });
  }, []);

  // Done (or stopped), or signing in under a dialog that would cover the page.
  const [started, setStarted] = useState(false);
  if (state.step !== 'idle' && !started) setStarted(true);
  const leave = (started && state.step === 'idle') || (dialogsOverWindows && state.step === 'signing-in');
  useEffect(() => {
    if (leave) hooks.current.onDone();
  }, [leave]);

  return <ClaudeSetupSteps state={state} />;
}

/** Claude being set up, outside the dialog that started it: in the provider list. */
function ClaudeSetupCard() {
  const state = useClaudeSetup();
  if (state.step === 'idle') return null;
  return (
    <div className="rounded-md border bg-muted/20">
      <div className="flex items-center gap-2 border-b border-border/60 px-3 py-2">
        <ProviderIcon providerID={CLAUDE_PROVIDER} size={16} />
        <p className="flex-1 text-sm font-medium">Setting up Claude</p>
        <Button variant="ghost" size="sm" className="h-7 text-muted-foreground" onClick={cancelClaudeSetup}>
          {state.step === 'failed' ? 'Dismiss' : 'Cancel'}
        </Button>
      </div>
      <ClaudeSetupSteps state={state} compact />
    </div>
  );
}

function ClaudeSetupSteps({ state, compact }: { state: ClaudeSetupState; compact?: boolean }) {
  const { notify, openUrl, openApp } = useAssistantHost();
  const refresh = useRefreshProviders();
  const [code, setCode] = useState('');
  const [pasting, setPasting] = useState(false);
  const sendCode = useMutation({
    mutationFn: () => sendClaudeCode(code.trim()),
    onSuccess: () => setCode(''),
    onError: (error) => notify({ title: 'That code didn’t go through', description: cleanAssistantError(error), destructive: true }),
  });
  const retry = () =>
    startClaudeSetup({
      openUrl,
      onConnected: (account) => {
        refresh();
        notify({ title: 'Claude is connected', description: account ? `Signed in as ${account}` : undefined });
      },
    });

  const stepIndex =
    state.step === 'checking' || state.step === 'installing' || state.step === 'idle'
      ? 0
      : state.step === 'signing-in'
        ? 1
        : state.step === 'connecting'
          ? 2
          : -1;
  const steps = [
    state.step === 'checking' || state.step === 'idle' ? 'Checking for Claude Code' : 'Install Claude Code',
    'Sign in to Claude',
    state.step === 'connecting' && state.restarting ? 'Restart the assistant to find Claude Code' : 'Connect the assistant',
  ];

  if (state.step === 'failed') {
    return (
      <div className={cn('space-y-4', compact ? 'p-3' : 'p-4')}>
        <p role="alert" className="flex items-start gap-2 text-sm text-destructive">
          <CircleAlert className="mt-0.5 size-4 shrink-0" aria-hidden />
          <span className="break-words">{state.message}</span>
        </p>
        <div className="flex flex-wrap gap-2">
          <Button size="sm" onClick={retry}>
            Try again
          </Button>
          {!compact && (
            <Button size="sm" variant="ghost" onClick={() => openApp('settings', { section: 'assistant' })}>
              Open Settings
            </Button>
          )}
        </div>
      </div>
    );
  }

  const page = state.step === 'signing-in' ? (state.login.url ?? state.login.codeUrl) : null;
  const codeUrl = state.step === 'signing-in' ? state.login.codeUrl : null;
  return (
    <div className={cn('space-y-4', compact ? 'p-3' : 'p-4')}>
      <ol className="space-y-2.5" aria-label="Setting up Claude">
        {steps.map((label, index) => {
          const step = index < stepIndex ? 'done' : index === stepIndex ? 'active' : 'todo';
          return (
            <li key={index} className={cn('flex items-center gap-3 text-sm', step === 'todo' && 'text-muted-foreground')}>
              <span
                className={cn(
                  'grid size-6 shrink-0 place-items-center rounded-full border text-xs',
                  step === 'done' && 'border-transparent bg-[#D97757] text-white',
                  step === 'active' && 'border-[#D97757] text-[#B85C3E] dark:text-[#E8957A]',
                )}
              >
                {step === 'done' ? (
                  <Check className="size-3.5" aria-hidden />
                ) : step === 'active' ? (
                  <Loader2 className="size-3.5 animate-spin" aria-hidden />
                ) : (
                  index + 1
                )}
              </span>
              <span className={cn(step === 'active' && 'font-medium')}>
                {label}
                {index === 1 && state.step === 'connecting' && state.account && (
                  <span className="text-muted-foreground"> · {state.account}</span>
                )}
              </span>
              <span className="sr-only">{step === 'done' ? '(done)' : step === 'active' ? '(under way)' : ''}</span>
            </li>
          );
        })}
      </ol>

      {state.step === 'installing' && (
        <p className="text-xs text-muted-foreground">Downloading Claude Code from Anthropic into ~/.local/bin. It takes a minute.</p>
      )}

      {state.step === 'signing-in' && (
        <div className="space-y-3 rounded-lg border bg-muted/30 p-3">
          <p className="text-sm">Sign in to Claude in the browser, and allow Claude Code. Din carries on by itself once you have.</p>
          <div className="flex flex-wrap gap-2">
            {page && (
              <Button variant="outline" size="sm" onClick={() => openUrl(page)}>
                <ExternalLink className="size-3.5" aria-hidden /> Open the sign-in page again
              </Button>
            )}
            {codeUrl && !pasting && (
              <Button variant="ghost" size="sm" className="text-muted-foreground" onClick={() => setPasting(true)}>
                Sign in with a code instead
              </Button>
            )}
          </div>
          {pasting && codeUrl && (
            <form
              className="space-y-2"
              onSubmit={(event) => {
                event.preventDefault();
                if (code.trim()) sendCode.mutate();
              }}
            >
              <p className="text-xs text-muted-foreground">
                On{' '}
                <button type="button" className="underline underline-offset-2 hover:text-foreground" onClick={() => openUrl(codeUrl)}>
                  this page
                </button>
                , which works on any device, Claude shows a code once you’ve signed in. Paste it here.
              </p>
              <div className="flex gap-2">
                <Input autoFocus value={code} onChange={(e) => setCode(e.target.value)} placeholder="Paste the code" aria-label="Code" />
                <Button type="submit" disabled={!code.trim() || sendCode.isPending}>
                  {sendCode.isPending && <Loader2 className="size-3.5 animate-spin" aria-hidden />}
                  Sign in
                </Button>
              </div>
            </form>
          )}
        </div>
      )}

      {state.step === 'connecting' && state.restarting && (
        <p className="text-xs text-muted-foreground">OpenCode started before Claude Code was installed, so it’s restarting once to find it.</p>
      )}
    </div>
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
  const name = providerName(integration.id, integration.name);

  const methods = integration.methods;
  const keyMethod = methods.find((m) => m.type === 'key');
  const oauthMethods = methods.filter((m): m is Extract<typeof m, { type: 'oauth' }> => m.type === 'oauth');
  const envMethod = methods.find((m): m is Extract<typeof m, { type: 'env' }> => m.type === 'env');
  const keyPage = KEY_PAGES[integration.id];

  const finish = async () => {
    // The new credential is in; the ones it replaces go.
    await Promise.allSettled(replacing.map((id) => assistantApi.removeCredential(id)));
    refresh();
    notify({ title: replacing.length > 0 ? `${name} is updated` : `${name} is connected` });
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
          <div className="flex items-baseline justify-between gap-2">
            <Label htmlFor="provider-key">{replacing.length > 0 ? 'New API key' : 'API key'}</Label>
            {keyPage && (
              <button
                type="button"
                className="flex items-center gap-1 text-xs text-muted-foreground underline-offset-2 hover:text-foreground hover:underline"
                onClick={() => openUrl(keyPage)}
              >
                Get a key <ExternalLink className="size-3" aria-hidden />
              </button>
            )}
          </div>
          <div className="flex gap-2">
            <Input
              id="provider-key"
              type="password"
              autoComplete="off"
              autoFocus={oauthMethods.length === 0}
              value={key}
              onChange={(e) => setKey(e.target.value)}
              placeholder={`Your ${name} API key`}
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
            : `${name} can’t be connected from here yet.`}
        </p>
      )}
    </div>
  );
}
