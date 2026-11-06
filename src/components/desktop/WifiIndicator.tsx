import { useRef, useState } from 'react';
import {
  Check,
  EthernetPort,
  Loader2,
  Lock,
  Settings2,
  Wifi,
  WifiHigh,
  WifiLow,
  WifiOff,
  WifiZero,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuTrigger,
} from '@/components/ui/context-menu';
import { Input } from '@/components/ui/input';
import { Switch } from '@/components/ui/switch';
import { PopoverClose } from '@/components/ui/popover';
import { Skeleton } from '@/components/ui/skeleton';
import { cn } from '@/lib/utils';
import { trayFooter, trayFooterButton, trayHeader, trayRowClass, trayRuleBottom, trayTitle, trayTokenClass } from './trayPanel';
import { cleanWifiError, isEnterprise, isEthernetConnected, isSecured, savedFor } from '@/lib/wifi';
import type { WifiNetwork } from '@/lib/wifi';
import {
  useSavedNetworks,
  useWifiMutations,
  useWifiNetworks,
  useWifiStatus,
} from '@/hooks/useWifi';
import { useWindowActions } from '@/contexts/WindowManagerContext';
import { VpnControls } from '@/components/desktop/VpnControls';

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
  const ethernet = isEthernetConnected(status.data);
  const networks = useWifiNetworks(radioEnabled && hasAdapter);
  const saved = useSavedNetworks();
  const { connect, disconnect, setRadio } = useWifiMutations();
  const { open } = useWindowActions();

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
      <header className={trayHeader}>
        <h2 className={trayTitle}>Wi-Fi</h2>
        <Switch
          aria-label="Wi-Fi radio"
          checked={radioEnabled}
          disabled={status.data === undefined || setRadio.isPending}
          onCheckedChange={(checked) => setRadio.mutate(checked)}
        />
      </header>

      {setRadio.isError && (
        <p role="alert" className={cn(trayRuleBottom, 'px-4 py-2 text-xs text-destructive')}>
          {cleanWifiError(setRadio.error)}
        </p>
      )}

      {/* One scroller for Ethernet and the networks, so they share its gutter and line up. */}
      <div className="max-h-80 overflow-y-auto p-2">
        {ethernet && (
          <div className={cn(trayRowClass(true), 'mb-0.5')}>
            <span className={trayTokenClass(true)}>
              <EthernetPort className="size-4" aria-hidden />
            </span>
            <span className="min-w-0 flex-1">
              <span className="block truncate text-sm text-foreground">Ethernet</span>
              <span className="block text-xs text-muted-foreground">Connected</span>
            </span>
            <Check className="size-4 shrink-0 text-ink-accent" aria-hidden />
          </div>
        )}
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
                  } else if (isEnterprise(network) && !savedFor(saved.data, network.ssid)) {
                    // Signing in to a work or school network takes the full form.
                    open('settings', { section: 'wifi', join: network.ssid, nonce: Date.now() });
                  } else if (isSecured(network) && !savedFor(saved.data, network.ssid)) {
                    setJoining(network.ssid);
                  } else {
                    joinNetwork(network);
                  }
                }}
                onCancelJoin={() => setJoining(null)}
                onConnect={(password) => joinNetwork(network, password)}
                onOpenSettings={() => open('settings', { section: 'wifi' })}
              />
            ))}
          </ul>
        )}
      </div>

      <VpnControls compact />

      <footer className={trayFooter}>
        <PopoverClose asChild>
          <Button
            variant="ghost"
            size="sm"
            className={trayFooterButton}
            onClick={() => open('settings', { section: 'wifi' })}
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
  onOpenSettings,
}: {
  network: WifiNetwork;
  isJoining: boolean;
  connectPending: boolean;
  disconnectPending: boolean;
  error: string | null;
  onSelect: () => void;
  onCancelJoin: () => void;
  onConnect: (password?: string) => void;
  onOpenSettings: () => void;
}) {
  const secured = isSecured(network);
  const pending = connectPending || (network.inUse && disconnectPending);
  // Connect may open the password form; the closing menu mustn't take its focus.
  const keepFocus = useRef(false);

  return (
    <li>
      <ContextMenu>
        <ContextMenuTrigger asChild>
          <button
            type="button"
            onClick={onSelect}
            disabled={pending}
            aria-label={
              network.inUse
                ? `Disconnect from ${network.ssid}`
                : `Connect to ${network.ssid}`
            }
            className={cn(trayRowClass(network.inUse), 'disabled:opacity-70')}
          >
            <span className={trayTokenClass(network.inUse)}>
              <WifiSignalIcon signal={network.signal} className="size-4" />
            </span>
            <span className="min-w-0 flex-1">
              <span className="block truncate">{network.ssid}</span>
              {network.inUse && (
                <span className="block text-xs text-muted-foreground">Connected</span>
              )}
            </span>
            {pending ? (
              <Loader2 className="size-3.5 shrink-0 animate-spin text-muted-foreground" aria-hidden />
            ) : network.inUse ? (
              <Check className="size-4 shrink-0 text-ink-accent" aria-hidden />
            ) : (
              secured && <Lock className="size-3.5 shrink-0 text-muted-foreground" aria-label="Secured" />
            )}
          </button>
        </ContextMenuTrigger>
        <ContextMenuContent
          onCloseAutoFocus={(e) => {
            if (keepFocus.current) e.preventDefault();
            keepFocus.current = false;
          }}
        >
          <ContextMenuItem
            disabled={pending}
            onSelect={() => {
              keepFocus.current = !network.inUse;
              onSelect();
            }}
          >
            {network.inUse ? <WifiOff aria-hidden /> : <Wifi aria-hidden />}
            {network.inUse ? 'Disconnect' : 'Connect'}
          </ContextMenuItem>
          <ContextMenuSeparator />
          <PopoverClose asChild>
            <ContextMenuItem onSelect={onOpenSettings}>
              <Settings2 aria-hidden />
              Wi-Fi settings
            </ContextMenuItem>
          </PopoverClose>
        </ContextMenuContent>
      </ContextMenu>

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
        <div key={i} className="flex items-center gap-3 rounded-lg px-2.5 py-2">
          <Skeleton className="size-8 rounded-full bg-foreground/10" />
          <Skeleton
            className="h-3.5 bg-foreground/10"
            style={{ width: `${40 + ((i * 27) % 35)}%` }}
          />
        </div>
      ))}
    </div>
  );
}
