import { useEffect, useRef, useState } from 'react';
import { ArrowLeft, Check, ChevronRight, EthernetPort, Loader2, Lock, Plus, RotateCw, Settings2, Wifi, WifiOff } from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import { TorControls } from '@/components/desktop/TorControls';
import { VpnControls } from '@/components/desktop/VpnControls';
import { WifiSignalIcon } from '@/components/desktop/WifiIndicator';
import { AddNetworkDialog } from '@/components/desktop/apps/WifiForms';
import { WifiNetworkDetails } from '@/components/desktop/apps/WifiNetworkDetails';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Skeleton } from '@/components/ui/skeleton';
import { Switch } from '@/components/ui/switch';
import { useSavedNetworks, useWifiMutations, useWifiNetworks, useWifiStatus } from '@/hooks/useWifi';
import { cn } from '@/lib/utils';
import {
  cleanWifiError,
  getWifiBridge,
  isEnterprise,
  isEthernetConnected,
  isSecured,
  savedFor,
  scannedSecurity,
  SECURITY_LABELS,
} from '@/lib/wifi';
import type { SavedWifiNetwork, WifiNetwork, WifiSecurity } from '@/lib/wifi';

type View = { kind: 'list' } | { kind: 'saved' } | { kind: 'details'; uuid: string; from: 'list' | 'saved' };

/**
 * Settings → Wi-Fi, through NetworkManager (`window.wifi`; see
 * electron/network.mts). The list of networks nearby to join, Add network for
 * hidden ones and enterprise sign-in, Saved networks, and each saved
 * network's own page (WifiNetworkDetails) to change how it connects.
 * `join` (from the menu bar) opens the sign-in form for an enterprise
 * network.
 */
export function WifiSettingsSection({ join }: { join?: { ssid: string; nonce: unknown } }) {
  const [view, setView] = useState<View>({ kind: 'list' });
  const [adding, setAdding] = useState<{ ssid?: string; security?: WifiSecurity } | null>(null);
  const status = useWifiStatus();
  const radioEnabled = status.data?.radioEnabled ?? false;
  const hasAdapter = status.data?.device != null;
  const networks = useWifiNetworks(radioEnabled && hasAdapter);
  const saved = useSavedNetworks();

  const lastJoin = useRef<unknown>(undefined);
  useEffect(() => {
    if (join && join.nonce !== lastJoin.current) {
      lastJoin.current = join.nonce;
      setView({ kind: 'list' });
      setAdding({ ssid: join.ssid, security: 'wpa-eap' });
    }
  }, [join]);

  if (!getWifiBridge()) {
    return (
      <Shell title="Wi-Fi">
        <Fallback>
          Wi-Fi settings need the Din desktop shell to talk to NetworkManager; they aren't available in a
          plain browser.
        </Fallback>
      </Shell>
    );
  }

  const dialog = adding && <AddNetworkDialog initial={adding} onClose={() => setAdding(null)} />;

  if (view.kind === 'details') {
    const network = saved.data?.find((n) => n.uuid === view.uuid);
    return (
      <>
        <WifiNetworkDetails
          key={view.uuid}
          uuid={view.uuid}
          scanned={network ? networks.data?.find((n) => n.ssid === network.ssid) : undefined}
          onBack={() => setView({ kind: view.from })}
        />
        {dialog}
      </>
    );
  }

  if (view.kind === 'saved') {
    return (
      <SavedNetworksView
        saved={saved.data}
        loading={saved.isLoading}
        inRange={new Set(networks.data?.map((n) => n.ssid))}
        onBack={() => setView({ kind: 'list' })}
        onOpen={(uuid) => setView({ kind: 'details', uuid, from: 'saved' })}
      />
    );
  }

  return (
    <>
      <NetworkListView
        saved={saved.data}
        onDetails={(uuid) => setView({ kind: 'details', uuid, from: 'list' })}
        onSaved={() => setView({ kind: 'saved' })}
        onAdd={(initial) => setAdding(initial)}
      />
      {dialog}
    </>
  );
}

function NetworkListView({
  saved,
  onDetails,
  onSaved,
  onAdd,
}: {
  saved: SavedWifiNetwork[] | undefined;
  onDetails: (uuid: string) => void;
  onSaved: () => void;
  onAdd: (initial: { ssid?: string; security?: WifiSecurity }) => void;
}) {
  const status = useWifiStatus();
  const radioEnabled = status.data?.radioEnabled ?? false;
  const hasAdapter = status.data?.device != null;
  const ethernet = isEthernetConnected(status.data);
  const networks = useWifiNetworks(radioEnabled && hasAdapter);
  const { connect, disconnect, setRadio } = useWifiMutations();

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
        onError: (error) => setOpError({ ssid: network.ssid, message: cleanWifiError(error) }),
      },
    );
  };

  const select = (network: WifiNetwork) => {
    const known = savedFor(saved, network.ssid);
    setOpError(null);
    if (known && network.inUse) onDetails(known.uuid);
    else if (known) joinNetwork(network);
    else if (isEnterprise(network)) onAdd({ ssid: network.ssid, security: 'wpa-eap' });
    else if (isSecured(network)) setJoining(network.ssid);
    else joinNetwork(network);
  };

  const available = status.data?.available ?? false;

  return (
    <Shell
      title="Wi-Fi"
      actions={
        <>
          <Button
            variant="ghost"
            size="icon"
            aria-label="Rescan for networks"
            title="Rescan for networks"
            disabled={!radioEnabled || !hasAdapter}
            onClick={() => networks.refetch()}
          >
            <RotateCw className={cn('size-4', networks.isFetching && 'animate-spin')} />
          </Button>
          <Switch
            aria-label="Wi-Fi radio"
            checked={radioEnabled}
            disabled={!available || setRadio.isPending}
            onCheckedChange={(checked) => setRadio.mutate(checked)}
          />
        </>
      }
    >
      {ethernet && (
        <div className="flex items-center gap-3 rounded-lg border border-border/60 bg-accent/40 px-3 py-2.5">
          <EthernetPort className="size-5 shrink-0 text-primary" aria-hidden />
          <div className="min-w-0 flex-1">
            <p className="text-sm font-medium text-foreground">Connected via Ethernet</p>
            {status.data?.ethernet?.iface && (
              <p className="truncate text-xs text-muted-foreground">
                {status.data.ethernet.iface}
                {status.data.ethernet.connection ? ` · ${status.data.ethernet.connection}` : ''}
              </p>
            )}
          </div>
          <Check className="size-4 shrink-0 text-primary" aria-hidden />
        </div>
      )}
      {status.isLoading ? (
        <NetworkListSkeleton />
      ) : status.isError ? (
        <Fallback>Could not read Wi-Fi state: {cleanWifiError(status.error)}</Fallback>
      ) : !available ? (
        <Fallback>NetworkManager is not available on this system, so Wi-Fi cannot be managed here.</Fallback>
      ) : !hasAdapter ? (
        <Fallback icon={WifiOff}>No Wi-Fi adapter was found on this system.</Fallback>
      ) : !radioEnabled ? (
        <Fallback icon={WifiOff}>Wi-Fi is turned off.</Fallback>
      ) : networks.isLoading ? (
        <NetworkListSkeleton />
      ) : networks.isError ? (
        <Fallback>Scan failed: {cleanWifiError(networks.error)}</Fallback>
      ) : (networks.data?.length ?? 0) === 0 ? (
        <Fallback icon={Wifi}>No networks found nearby.</Fallback>
      ) : (
        <ul className="flex flex-col gap-1" aria-label="Available networks">
          {networks.data?.map((network) => (
            <NetworkRow
              key={network.ssid}
              network={network}
              saved={savedFor(saved, network.ssid)}
              isJoining={joining === network.ssid}
              connectPending={connect.isPending && connect.variables?.ssid === network.ssid}
              disconnectPending={disconnect.isPending}
              error={opError?.ssid === network.ssid ? opError.message : null}
              onSelect={() => select(network)}
              onDetails={onDetails}
              onCancelJoin={() => setJoining(null)}
              onConnect={(password) => joinNetwork(network, password)}
              onDisconnect={() => {
                setOpError(null);
                disconnect.mutate(undefined, {
                  onError: (error) => setOpError({ ssid: network.ssid, message: cleanWifiError(error) }),
                });
              }}
            />
          ))}
        </ul>
      )}

      {available && (
        <div className="flex flex-col divide-y divide-border/60 rounded-lg border border-border/60 bg-background/40">
          <LinkRow icon={Plus} label="Add network" onClick={() => onAdd({})} />
          <LinkRow
            icon={Settings2}
            label="Saved networks"
            detail={saved ? `${saved.length} ${saved.length === 1 ? 'network' : 'networks'}` : undefined}
            onClick={onSaved}
          />
        </div>
      )}
      <VpnControls />
      <TorControls />
    </Shell>
  );
}

function LinkRow({
  icon: Icon,
  label,
  detail,
  onClick,
}: {
  icon: LucideIcon;
  label: string;
  detail?: string;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="flex items-center gap-3 px-3 py-2.5 text-left first:rounded-t-lg last:rounded-b-lg hover:bg-foreground/5 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
    >
      <Icon className="size-5 shrink-0 text-muted-foreground" aria-hidden />
      <span className="min-w-0 flex-1 text-sm text-foreground">{label}</span>
      {detail && <span className="text-xs text-muted-foreground">{detail}</span>}
      <ChevronRight className="size-4 shrink-0 text-muted-foreground" aria-hidden />
    </button>
  );
}

function NetworkRow({
  network,
  saved,
  isJoining,
  connectPending,
  disconnectPending,
  error,
  onSelect,
  onDetails,
  onCancelJoin,
  onConnect,
  onDisconnect,
}: {
  network: WifiNetwork;
  saved: SavedWifiNetwork | undefined;
  isJoining: boolean;
  connectPending: boolean;
  disconnectPending: boolean;
  error: string | null;
  onSelect: () => void;
  onDetails: (uuid: string) => void;
  onCancelJoin: () => void;
  onConnect: (password: string) => void;
  onDisconnect: () => void;
}) {
  const secured = isSecured(network);
  const securityText = secured || network.security ? network.security : 'Open';

  return (
    <li className="rounded-lg border border-border/60 bg-background/40">
      <div className="flex items-center gap-1 pr-2">
        <button
          type="button"
          onClick={onSelect}
          disabled={connectPending}
          className="flex min-w-0 flex-1 items-center gap-3 rounded-l-lg px-3 py-2 text-left hover:bg-foreground/5 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          <WifiSignalIcon
            signal={network.signal}
            className={cn('size-5 shrink-0', network.inUse ? 'text-primary' : 'text-muted-foreground')}
          />
          <span className="min-w-0 flex-1">
            <span className="block truncate text-sm text-foreground">{network.ssid}</span>
            <span className="flex items-center gap-1.5 text-xs text-muted-foreground">
              {connectPending ? (
                <>
                  <Loader2 className="size-3 shrink-0 animate-spin" aria-hidden />
                  Connecting…
                </>
              ) : network.inUse ? (
                <span className="font-medium text-primary">Connected</span>
              ) : (
                <>
                  {secured && <Lock className="size-3 shrink-0" aria-label="Secured" />}
                  <span>{securityText}</span>
                  {saved && <span aria-hidden>·</span>}
                  {saved && <span>Saved</span>}
                </>
              )}
            </span>
          </span>
        </button>

        {network.inUse && (
          <Button variant="outline" size="sm" disabled={disconnectPending} onClick={onDisconnect}>
            {disconnectPending ? 'Disconnecting…' : 'Disconnect'}
          </Button>
        )}
        {saved && (
          <Button
            variant="ghost"
            size="icon"
            aria-label={`Settings for ${network.ssid}`}
            title="Network details"
            onClick={() => onDetails(saved.uuid)}
          >
            <Settings2 className="size-4" />
          </Button>
        )}
      </div>

      {isJoining && (
        <PasswordForm
          ssid={network.ssid}
          security={scannedSecurity(network)}
          pending={connectPending}
          onSubmit={onConnect}
          onCancel={onCancelJoin}
        />
      )}

      {error !== null && (
        <p role="alert" className="border-t border-border/60 px-3 py-1.5 text-xs text-destructive">
          {error}
        </p>
      )}
    </li>
  );
}

/** Inline password entry for joining a secured network. */
function PasswordForm({
  ssid,
  security,
  pending,
  onSubmit,
  onCancel,
}: {
  ssid: string;
  security: WifiSecurity;
  pending: boolean;
  onSubmit: (password: string) => void;
  onCancel: () => void;
}) {
  const [password, setPassword] = useState('');
  const valid = security === 'wep' ? password.length > 0 : password.length >= 8;

  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        if (valid && !pending) onSubmit(password);
      }}
      className="flex items-center gap-2 border-t border-border/60 px-3 py-2"
    >
      <Input
        type="password"
        aria-label={`Password for ${ssid}`}
        placeholder="Network password"
        value={password}
        onChange={(e) => setPassword(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Escape') onCancel();
        }}
        disabled={pending}
        autoFocus
        autoComplete="off"
        className="h-8 flex-1"
      />
      <Button type="submit" size="sm" disabled={!valid || pending}>
        {pending ? (
          <>
            <Loader2 className="size-3.5 animate-spin" aria-hidden />
            Connecting…
          </>
        ) : (
          'Join'
        )}
      </Button>
      <Button type="button" variant="ghost" size="sm" disabled={pending} onClick={onCancel}>
        Cancel
      </Button>
    </form>
  );
}

function SavedNetworksView({
  saved,
  loading,
  inRange,
  onBack,
  onOpen,
}: {
  saved: SavedWifiNetwork[] | undefined;
  loading: boolean;
  inRange: Set<string>;
  onBack: () => void;
  onOpen: (uuid: string) => void;
}) {
  return (
    <Shell title="Saved networks" onBack={onBack}>
      {loading ? (
        <NetworkListSkeleton />
      ) : !saved || saved.length === 0 ? (
        <Fallback icon={Wifi}>No saved networks. Networks you join are remembered here.</Fallback>
      ) : (
        <ul className="flex flex-col divide-y divide-border/60 rounded-lg border border-border/60 bg-background/40" aria-label="Saved networks">
          {saved.map((network) => (
            <li key={network.uuid}>
              <button
                type="button"
                onClick={() => onOpen(network.uuid)}
                className="flex w-full items-center gap-3 px-3 py-2.5 text-left hover:bg-foreground/5 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              >
                {network.active || inRange.has(network.ssid) ? (
                  <Wifi className={cn('size-5 shrink-0', network.active ? 'text-primary' : 'text-muted-foreground')} aria-hidden />
                ) : (
                  <WifiOff className="size-5 shrink-0 text-muted-foreground/60" aria-hidden />
                )}
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-sm text-foreground">{network.ssid}</span>
                  <span className="block truncate text-xs text-muted-foreground">
                    {network.active ? 'Connected' : SECURITY_LABELS[network.security]}
                    {!network.autoconnect && ' · Won’t auto-connect'}
                  </span>
                </span>
                <ChevronRight className="size-4 shrink-0 text-muted-foreground" aria-hidden />
              </button>
            </li>
          ))}
        </ul>
      )}
    </Shell>
  );
}

function Shell({
  title,
  actions,
  onBack,
  children,
}: {
  title: string;
  actions?: React.ReactNode;
  onBack?: () => void;
  children: React.ReactNode;
}) {
  return (
    <section className="mx-auto flex max-w-2xl flex-col gap-4 p-4">
      <header className="flex items-center justify-between gap-2">
        <div className="flex min-w-0 items-center gap-2">
          {onBack && (
            <Button variant="ghost" size="icon" aria-label="Back to Wi-Fi" onClick={onBack}>
              <ArrowLeft className="size-4" />
            </Button>
          )}
          <h2 className="truncate text-lg font-semibold text-foreground">{title}</h2>
        </div>
        {actions && <div className="flex items-center gap-2">{actions}</div>}
      </header>
      {children}
    </section>
  );
}

function Fallback({ icon: Icon, children }: { icon?: LucideIcon; children: React.ReactNode }) {
  return (
    <div className="rounded-xl border border-dashed border-border px-8 py-12 text-center">
      {Icon && <Icon className="mx-auto mb-4 size-8 text-muted-foreground/80" aria-hidden />}
      <p className="mx-auto max-w-sm text-sm text-muted-foreground">{children}</p>
    </div>
  );
}

function NetworkListSkeleton() {
  return (
    <div className="flex flex-col gap-1" aria-hidden>
      {Array.from({ length: 4 }, (_, i) => (
        <div key={i} className="flex items-center gap-3 rounded-lg border border-border/60 px-3 py-2">
          <Skeleton className="size-5 rounded bg-foreground/10" />
          <div className="flex-1 space-y-1.5">
            <Skeleton className="h-3.5 bg-foreground/10" style={{ width: `${30 + ((i * 23) % 35)}%` }} />
            <Skeleton className="h-3 w-16 bg-foreground/10" />
          </div>
        </div>
      ))}
    </div>
  );
}
