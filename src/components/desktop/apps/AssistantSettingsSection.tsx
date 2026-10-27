import { useMutation } from '@tanstack/react-query';
import { Bot, CircleAlert, Folder, Loader2, RotateCw } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import { Skeleton } from '@/components/ui/skeleton';
import { Switch } from '@/components/ui/switch';
import { ProviderList } from '@/components/desktop/assistant/Providers';
import { useFilePicker } from '@/contexts/FilePickerContext';
import { useAppContext } from '@/hooks/useAppContext';
import { useAssistantStatus, useHomeDirectory, useSetAssistantEnabled } from '@/hooks/useAssistant';
import { useToast } from '@/hooks/useToast';
import { cleanAssistantError, getAssistantBridge, tildify } from '@/lib/assistant';
import { cn } from '@/lib/utils';

/**
 * Settings → Assistant: whether Din keeps OpenCode running, the state of
 * its server, where new conversations work, and the AI providers it may
 * use.
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
              <ProviderList />
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
