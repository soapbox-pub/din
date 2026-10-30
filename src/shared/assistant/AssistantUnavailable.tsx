import { useMutation } from '@tanstack/react-query';
import { CircleAlert, Download, Loader2, Power } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { useAssistantStatus } from '@/hooks/useAssistant';
import { cleanAssistantError, getAssistantBridge } from '@/lib/assistant';
import { cn } from '@/lib/utils';
import { useAssistantHost } from '@/shared/assistant/host';

/**
 * Why the assistant can't answer yet, and what to do about it: it's off,
 * OpenCode isn't installed (with the button that installs it), installing,
 * starting, or failed. Renders nothing once it's ready.
 */
export function AssistantUnavailable({ className, compact = false }: { className?: string; compact?: boolean }) {
  const { data: status, isLoading } = useAssistantStatus();
  const { setEnabled, openApp } = useAssistantHost();
  const openSettings = () => openApp('settings', { section: 'assistant' });

  if (!getAssistantBridge()) {
    return (
      <Shell className={className} compact={compact} icon={<CircleAlert className="size-6" aria-hidden />}>
        <p className="font-medium">The assistant runs in Din’s desktop app</p>
        <p className="text-sm text-muted-foreground">It works through OpenCode on this computer, which a browser can’t reach.</p>
      </Shell>
    );
  }
  if (isLoading || !status) return null;
  if (status.enabled && status.running) return null;

  if (!status.enabled) {
    return (
      <Shell className={className} compact={compact} icon={<Power className="size-6" aria-hidden />}>
        <p className="font-medium">The assistant is off</p>
        <p className="text-sm text-muted-foreground">Turn it on to ask OpenCode to do things on this computer.</p>
        {setEnabled ? (
          <Button size="sm" onClick={() => setEnabled(true)} className="mt-2">
            Turn on
          </Button>
        ) : (
          <Button size="sm" onClick={openSettings} className="mt-2">
            Turn on in Settings
          </Button>
        )}
      </Shell>
    );
  }

  if (!status.binary && !status.installing) {
    return <InstallOpenCode className={className} compact={compact} version={status.version} error={status.error} />;
  }

  if (status.installing || !status.error) {
    return (
      <Shell className={className} compact={compact} icon={<Loader2 className="size-6 animate-spin" aria-hidden />}>
        <p className="font-medium">{status.installing ? 'Installing OpenCode…' : 'Starting the assistant…'}</p>
        <p className="text-sm text-muted-foreground">
          {status.installing ? 'This takes a minute the first time.' : 'Just a moment.'}
        </p>
      </Shell>
    );
  }

  return (
    <Shell className={className} compact={compact} icon={<CircleAlert className="size-6 text-destructive" aria-hidden />}>
      <p className="font-medium">The assistant couldn’t start</p>
      <p className="break-words text-sm text-muted-foreground">{status.error}</p>
      <Button size="sm" variant="outline" onClick={openSettings} className="mt-2">
        Open Settings
      </Button>
    </Shell>
  );
}

/** OpenCode isn't installed, or is too old to speak to: install it from here. */
function InstallOpenCode({
  className,
  compact,
  version,
  error,
}: {
  className?: string;
  compact: boolean;
  version: string | null;
  error: string | null;
}) {
  const install = useMutation({ mutationFn: () => getAssistantBridge()!.install() });
  const failure = install.error ? cleanAssistantError(install.error) : error;

  return (
    <Shell className={className} compact={compact} icon={<Download className="size-6" aria-hidden />}>
      <p className="font-medium">{version ? 'Update OpenCode to continue' : 'Install OpenCode to continue'}</p>
      <p className="text-sm text-muted-foreground">
        {version
          ? `The assistant needs OpenCode 2 or newer, and this computer has ${version}.`
          : 'The assistant is OpenCode, the AI agent, which isn’t on this computer yet. It installs into your home folder and keeps itself up to date.'}
      </p>
      <Button size="sm" onClick={() => install.mutate()} disabled={install.isPending} className="mt-2">
        {install.isPending && <Loader2 className="size-3.5 animate-spin" aria-hidden />}
        {version ? 'Update OpenCode' : 'Install OpenCode'}
      </Button>
      {failure && !install.isPending && (
        <p role="alert" className="mt-1 break-words text-xs text-destructive">
          {failure}
        </p>
      )}
    </Shell>
  );
}

function Shell({
  icon,
  children,
  className,
  compact,
}: {
  icon: React.ReactNode;
  children: React.ReactNode;
  className?: string;
  compact: boolean;
}) {
  return (
    <div
      className={cn(
        'flex flex-col items-center gap-1 text-center',
        compact ? 'px-4 py-6' : 'mx-auto max-w-sm px-6 py-12',
        className,
      )}
    >
      <div className="mb-2 grid size-12 place-items-center rounded-2xl bg-muted text-muted-foreground">{icon}</div>
      {children}
    </div>
  );
}
