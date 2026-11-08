import { useState } from 'react';
import { Loader2 } from 'lucide-react';
import { OnionIcon } from '@/components/icons/OnionIcon';
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import { Progress } from '@/components/ui/progress';
import { Switch } from '@/components/ui/switch';
import { useTorStatus } from '@/hooks/useTor';
import { cleanTorError, getTorBridge, torState, type TorStatus } from '@/lib/tor';
import { cn } from '@/lib/utils';
import { trayRuleTop, trayTokenClass } from './trayPanel';
import { settingsCard } from '@/shared/settingsChromeStyles';

/** One line on where Tor stands. */
function describe(status: TorStatus): string {
  if (status.installing) return `${status.installing}…`;
  switch (torState(status)) {
    case 'ready':
      return 'Connected. Onion sites open in the Web Browser.';
    case 'connecting':
      return status.summary
        ? `Connecting: ${status.summary.replace(/\.$/, '')}`
        : 'Connecting to the Tor network…';
    case 'off':
      return "Off. Onion sites won't open.";
    case 'missing':
      return status.canInstall
        ? 'Not running. Set up Tor, or start Tor or Tor Browser, and Din uses it for onion sites.'
        : 'Not running. Start Tor or Tor Browser and Din uses it for onion sites.';
  }
}

/**
 * Settings → Wi-Fi's Tor section: where Tor stands, and a switch to turn it
 * on and off on DinOS or once Din has a Tor of its own, which elsewhere Set
 * Up gets it. Only .onion addresses go through Tor; the rest of the
 * computer's traffic doesn't. Renders nothing outside the Electron shell.
 */
export function TorControls() {
  const bridge = getTorBridge();
  const status = useTorStatus();
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (!bridge || !status) return null;
  const state = torState(status);
  const installing = status.installing !== null;
  const canSetUp = status.canInstall && !status.installed && state === 'missing';
  const problem = error ?? status.error;

  const act = (action: () => Promise<unknown>) => {
    setPending(true);
    setError(null);
    action()
      .catch((e: unknown) => setError(cleanTorError(e)))
      .finally(() => setPending(false));
  };
  const setEnabled = (enabled: boolean) => act(() => bridge.setEnabled(enabled));

  return (
    <div className="mt-6">
      <h3 className="mb-2 flex items-center gap-2 px-1 text-sm font-semibold text-foreground/90">
        <OnionIcon className="size-4.5 shrink-0 text-ink-accent" />
        Tor
      </h3>
      <div className={settingsCard}>
        <div className="flex items-center gap-3 px-4 py-2.5">
          <span className={cn(trayTokenClass(state === 'ready'), 'size-9')}>
            {state === 'connecting' || installing ? (
              <Loader2 className="size-4.5 motion-safe:animate-spin" aria-hidden />
            ) : (
              <OnionIcon className="size-4.5" />
            )}
          </span>
          <div className="min-w-0 flex-1 space-y-0.5">
            <Label htmlFor="tor-enabled" className="text-sm">
              Onion sites through Tor
            </Label>
            <p className="text-xs text-muted-foreground" aria-live="polite">
              {describe(status)}
            </p>
          </div>
          {(canSetUp || installing) && (
            <Button
              size="sm"
              className="shrink-0"
              disabled={pending || installing}
              title="Downloads Tor from the Tor Project into ~/.local/share/din/tor"
              onClick={() => act(() => bridge.install())}
            >
              {(pending || installing) && <Loader2 className="size-3.5 motion-safe:animate-spin" aria-hidden />}
              Set Up Tor
            </Button>
          )}
          {status.canToggle && !installing && (
            <Switch
              id="tor-enabled"
              checked={status.enabled === true}
              disabled={pending}
              onCheckedChange={setEnabled}
            />
          )}
        </div>
        {state === 'connecting' && status.progress !== null && (
          <div className="flex items-center gap-3 px-4 pb-3">
            <Progress value={status.progress} className="h-1.5" aria-label="Connecting to Tor" />
            <span className="w-9 shrink-0 text-right text-xs tabular-nums text-muted-foreground">
              {status.progress}%
            </span>
          </div>
        )}
        <p className={cn(trayRuleTop, 'px-4 py-2.5 text-xs text-muted-foreground')}>
          Only .onion addresses go through Tor. Everything else connects as usual, so this doesn't hide
          your IP address from other sites.
          {status.installed &&
            ` Tor ${status.installed} is Din’s own, in ~/.local/share/din/tor, and Din keeps it up to date.`}
        </p>
        {problem && (
          <p role="alert" className="px-4 py-1.5 text-xs text-destructive">
            {problem}
          </p>
        )}
      </div>
    </div>
  );
}
