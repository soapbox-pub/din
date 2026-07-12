import { useState } from 'react';
import {
  Check,
  Loader2,
  Lock,
  Settings2,
  Wifi,
  WifiHigh,
  WifiLow,
  WifiZero,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Switch } from '@/components/ui/switch';
import { PopoverClose } from '@/components/ui/popover';
import { Skeleton } from '@/components/ui/skeleton';
import { cn } from '@/lib/utils';
import { cleanWifiError, isSecured } from '@/lib/wifi';
import type { WifiNetwork } from '@/lib/wifi';
import {
  useSavedNetworks,
  useWifiMutations,
  useWifiNetworks,
  useWifiStatus,
} from '@/hooks/useWifi';
import { useWindowManager } from '@/contexts/WindowManagerContext';

/** Signal-strength icon (0-100), shared with the Settings Wi-Fi section. */
export function WifiSignalIcon({ signal, className }: { signal: number; className?: string }) {
  const Icon = signal >= 70 ? Wifi : signal >= 45 ? WifiHigh : signal >= 20 ? WifiLow : WifiZero;
  return <Icon className={className} aria-hidden />;
}

/** Popover content: radio toggle, quick-connect network list, settings link. */
export function WifiPopoverBody() {
  const status = useWifiStatus();
  const radioEnabled = status.data?.radioEnabled ?? false;
  const hasAdapter = status.data?.device != null;
  const networks = useWifiNetworks(radioEnabled && hasAdapter);
  const saved = useSavedNetworks();
  const { connect, disconnect, setRadio } = useWifiMutations();
  const { open } = useWindowManager();

  // SSID whose inline password form is open, if any.
  const [joining, setJoining] = useState<string | null>(null);
  // Last failed operation, keyed to the SSID it concerned.
  const [opError, setOpError] = useState<{ ssid: string; message: string } | null>(null);

  const joinNetwork = (network: WifiNetwork, password?: string) => {
    setOpError(null);
    connect.mutate(
      { ssid: network.ssid, password },
      {
        onSuccess: () => setJoining(null),
        onError: (error) =>
          setOpError({ ssid: network.ssid, message: cleanWifiError(error) }),
      },
    );
  };

  return (
    <div className="flex flex-col">
      <header className="flex items-center justify-between gap-2 border-b border-border/60 px-3 py-2">
        <h2 className="text-sm font-medium text-foreground">Wi-Fi</h2>
        <Switch
          aria-label="Wi-Fi radio"
          checked={radioEnabled}
          disabled={status.data === undefined || setRadio.isPending}
          onCheckedChange={(checked) => setRadio.mutate(checked)}
        />
      </header>

      <div className="max-h-72 overflow-y-auto p-1.5">
        {!radioEnabled ? (
          <p className="px-2 py-6 text-center text-xs text-muted-foreground">
            Wi-Fi is turned off.
          </p>
        ) : networks.isLoading ? (
          <QuickListSkeleton />
        ) : networks.isError ? (
          <p className="px-2 py-6 text-center text-xs text-muted-foreground">
            Scan failed: {cleanWifiError(networks.error)}
          </p>
        ) : (networks.data?.length ?? 0) === 0 ? (
          <p className="px-2 py-6 text-center text-xs text-muted-foreground">
            No networks found nearby.
          </p>
        ) : (
          <ul aria-label="Available networks" className="flex flex-col gap-0.5">
            {networks.data?.map((network) => (
              <QuickNetworkRow
                key={network.ssid}
                network={network}
                isJoining={joining === network.ssid}
                connectPending={connect.isPending && connect.variables?.ssid === network.ssid}
                disconnectPending={disconnect.isPending}
                error={opError?.ssid === network.ssid ? opError.message : null}
                onSelect={() => {
                  setOpError(null);
                  if (network.inUse) {
                    disconnect.mutate(undefined, {
                      onError: (error) =>
                        setOpError({ ssid: network.ssid, message: cleanWifiError(error) }),
                    });
                  } else if (isSecured(network) && !(saved.data?.includes(network.ssid) ?? false)) {
                    setJoining(network.ssid);
                  } else {
                    joinNetwork(network);
                  }
                }}
                onCancelJoin={() => setJoining(null)}
                onConnect={(password) => joinNetwork(network, password)}
              />
            ))}
          </ul>
        )}
      </div>

      <footer className="border-t border-border/60 p-1.5">
        <PopoverClose asChild>
          <Button
            variant="ghost"
            size="sm"
            className="w-full justify-start text-muted-foreground hover:text-foreground"
            onClick={() => open('settings')}
          >
            <Settings2 aria-hidden />
            Wi-Fi settings
          </Button>
        </PopoverClose>
      </footer>
    </div>
  );
}

/** One compact network row: click connects/disconnects or opens the password form. */
function QuickNetworkRow({
  network,
  isJoining,
  connectPending,
  disconnectPending,
  error,
  onSelect,
  onCancelJoin,
  onConnect,
}: {
  network: WifiNetwork;
  isJoining: boolean;
  connectPending: boolean;
  disconnectPending: boolean;
  error: string | null;
  onSelect: () => void;
  onCancelJoin: () => void;
  onConnect: (password?: string) => void;
}) {
  const secured = isSecured(network);
  const pending = connectPending || (network.inUse && disconnectPending);

  return (
    <li>
      <button
        type="button"
        onClick={onSelect}
        disabled={pending}
        aria-label={
          network.inUse
            ? `Disconnect from ${network.ssid}`
            : `Connect to ${network.ssid}`
        }
        className={cn(
          'flex w-full items-center gap-2.5 rounded-md px-2 py-1.5 text-left transition-colors',
          'hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
          'disabled:opacity-70',
          network.inUse && 'bg-accent/60',
        )}
      >
        <WifiSignalIcon
          signal={network.signal}
          className={cn(
            'size-4.5 shrink-0',
            network.inUse ? 'text-primary' : 'text-muted-foreground',
          )}
        />
        <span className="min-w-0 flex-1">
          <span className="block truncate text-sm text-foreground">{network.ssid}</span>
          {network.inUse && (
            <span className="block text-xs text-primary">Connected</span>
          )}
        </span>
        {pending ? (
          <Loader2 className="size-3.5 shrink-0 animate-spin text-muted-foreground" aria-hidden />
        ) : network.inUse ? (
          <Check className="size-3.5 shrink-0 text-primary" aria-hidden />
        ) : (
          secured && <Lock className="size-3 shrink-0 text-muted-foreground" aria-label="Secured" />
        )}
      </button>

      {isJoining && (
        <QuickPasswordForm
          ssid={network.ssid}
          pending={connectPending}
          onSubmit={onConnect}
          onCancel={onCancelJoin}
        />
      )}

      {error !== null && (
        <p role="alert" className="px-2 py-1 text-xs text-destructive">
          {error}
        </p>
      )}
    </li>
  );
}

/** Inline password entry for joining a secured, unsaved network. */
function QuickPasswordForm({
  ssid,
  pending,
  onSubmit,
  onCancel,
}: {
  ssid: string;
  pending: boolean;
  onSubmit: (password: string) => void;
  onCancel: () => void;
}) {
  const [password, setPassword] = useState('');
  const valid = password.length >= 8;

  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        if (valid && !pending) onSubmit(password);
      }}
      className="flex items-center gap-1.5 px-2 py-1.5"
    >
      <Input
        type="password"
        aria-label={`Password for ${ssid}`}
        placeholder="Password"
        value={password}
        onChange={(e) => setPassword(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Escape') onCancel();
        }}
        disabled={pending}
        autoFocus
        autoComplete="off"
        className="h-7 flex-1 text-sm"
      />
      <Button type="submit" size="sm" className="h-7" disabled={!valid || pending}>
        {pending ? <Loader2 className="size-3.5 animate-spin" aria-hidden /> : 'Join'}
      </Button>
    </form>
  );
}

function QuickListSkeleton() {
  return (
    <div className="flex flex-col gap-0.5" aria-hidden>
      {Array.from({ length: 3 }, (_, i) => (
        <div key={i} className="flex items-center gap-2.5 rounded-md px-2 py-1.5">
          <Skeleton className="size-4.5 rounded bg-foreground/10" />
          <Skeleton
            className="h-3.5 bg-foreground/10"
            style={{ width: `${40 + ((i * 27) % 35)}%` }}
          />
        </div>
      ))}
    </div>
  );
}
