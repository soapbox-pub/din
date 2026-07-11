import { useState } from 'react';
import {
  Check,
  Cloud,
  CloudOff,
  Loader2,
  Lock,
  Moon,
  Palette,
  RotateCw,
  Sun,
  TriangleAlert,
  Wifi,
  WifiHigh,
  WifiLow,
  WifiOff,
  WifiZero,
} from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import { cn } from '@/lib/utils';
import type { AppComponentProps } from '@/lib/apps';
import { cleanWifiError, getWifiBridge, isSecured } from '@/lib/wifi';
import type { WifiNetwork } from '@/lib/wifi';
import {
  useSavedNetworks,
  useWifiMutations,
  useWifiNetworks,
  useWifiStatus,
} from '@/hooks/useWifi';
import { useTheme } from '@/hooks/useTheme';
import { useAppContext } from '@/hooks/useAppContext';
import { useCurrentUser } from '@/hooks/useCurrentUser';
import { useAppDataSyncStatus } from '@/hooks/useAppData';
import { RelayListManager } from '@/components/RelayListManager';
import { BlossomServerManager } from '@/components/BlossomServerManager';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import { Skeleton } from '@/components/ui/skeleton';

type SectionId = 'wifi' | 'nostr' | 'appearance';

const SECTIONS: { id: SectionId; name: string; icon: LucideIcon }[] = [
  { id: 'wifi', name: 'Wi-Fi', icon: Wifi },
  { id: 'nostr', name: 'Nostr & Storage', icon: Cloud },
  { id: 'appearance', name: 'Appearance', icon: Palette },
];

/**
 * Settings - system preferences for the shell.
 *
 * The Wi-Fi section drives NetworkManager through `window.wifi` (Electron
 * preload + nmcli in the main process): toggle the radio, scan, join,
 * disconnect and forget networks. Outside the Electron shell it renders an
 * explanatory fallback. Nostr & Storage manages Din's encrypted app-data
 * sync, NIP-65 relay list, and Blossom server list. Appearance switches the
 * shell theme (AppContext, persisted to localStorage and roamed via
 * encrypted sync).
 */
export function Settings(_props: AppComponentProps) {
  const [section, setSection] = useState<SectionId>('wifi');

  return (
    <div className="flex h-full w-full">
      {/* Section sidebar */}
      <nav
        aria-label="Settings sections"
        className="flex w-44 shrink-0 flex-col gap-0.5 overflow-y-auto border-r border-border/60 bg-background/30 p-2"
      >
        {SECTIONS.map((s) => (
          <button
            key={s.id}
            type="button"
            onClick={() => setSection(s.id)}
            aria-current={section === s.id ? 'page' : undefined}
            className={cn(
              'flex items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm',
              'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
              section === s.id
                ? 'bg-foreground/15 text-foreground'
                : 'text-muted-foreground hover:bg-foreground/10 hover:text-foreground',
            )}
          >
            <s.icon className="size-4 shrink-0" aria-hidden />
            <span className="truncate">{s.name}</span>
          </button>
        ))}
      </nav>

      <div className="min-w-0 flex-1 overflow-y-auto">
        {section === 'wifi' ? (
          <WifiSection />
        ) : section === 'nostr' ? (
          <NostrStorageSection />
        ) : (
          <AppearanceSection />
        )}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Wi-Fi
// ---------------------------------------------------------------------------

function WifiSection() {
  const bridge = getWifiBridge();
  const status = useWifiStatus();
  const radioEnabled = status.data?.radioEnabled ?? false;
  const hasAdapter = status.data?.device != null;
  const networks = useWifiNetworks(radioEnabled && hasAdapter);
  const saved = useSavedNetworks();
  const { connect, disconnect, forget, setRadio } = useWifiMutations();

  // SSID whose inline password/connect form is open, if any.
  const [joining, setJoining] = useState<string | null>(null);
  // Last failed operation, keyed to the SSID it concerned.
  const [opError, setOpError] = useState<{ ssid: string; message: string } | null>(null);

  if (!bridge) {
    return (
      <SectionShell title="Wi-Fi">
        <FallbackCard>
          Wi-Fi settings need the Electron shell to talk to NetworkManager. Run{' '}
          <code className="rounded bg-foreground/10 px-1 py-0.5">make dev</code> or boot
          the VM; the bridge is not available in a plain browser.
        </FallbackCard>
      </SectionShell>
    );
  }

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
    <SectionShell
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
            disabled={status.data === undefined || !status.data.available || setRadio.isPending}
            onCheckedChange={(checked) => setRadio.mutate(checked)}
          />
        </>
      }
    >
      {status.isLoading ? (
        <NetworkListSkeleton />
      ) : status.isError ? (
        <FallbackCard>Could not read Wi-Fi state: {cleanWifiError(status.error)}</FallbackCard>
      ) : !status.data?.available ? (
        <FallbackCard>
          NetworkManager is not available on this system, so Wi-Fi cannot be managed here.
        </FallbackCard>
      ) : !hasAdapter ? (
        <FallbackCard icon={WifiOff}>No Wi-Fi adapter was found on this system.</FallbackCard>
      ) : !radioEnabled ? (
        <FallbackCard icon={WifiOff}>Wi-Fi is turned off.</FallbackCard>
      ) : networks.isLoading ? (
        <NetworkListSkeleton />
      ) : networks.isError ? (
        <FallbackCard>Scan failed: {cleanWifiError(networks.error)}</FallbackCard>
      ) : (networks.data?.length ?? 0) === 0 ? (
        <FallbackCard icon={Wifi}>No networks found nearby.</FallbackCard>
      ) : (
        <ul className="flex flex-col gap-1" aria-label="Available networks">
          {networks.data?.map((network) => (
            <NetworkRow
              key={network.ssid}
              network={network}
              isSaved={saved.data?.includes(network.ssid) ?? false}
              isJoining={joining === network.ssid}
              connectPending={connect.isPending && connect.variables?.ssid === network.ssid}
              disconnectPending={disconnect.isPending}
              error={opError?.ssid === network.ssid ? opError.message : null}
              onOpenJoin={() => {
                setOpError(null);
                setJoining(network.ssid);
              }}
              onCancelJoin={() => setJoining(null)}
              onConnect={(password) => joinNetwork(network, password)}
              onDisconnect={() => {
                setOpError(null);
                disconnect.mutate(undefined, {
                  onError: (error) =>
                    setOpError({ ssid: network.ssid, message: cleanWifiError(error) }),
                });
              }}
              onForget={() => {
                setOpError(null);
                forget.mutate(network.ssid, {
                  onError: (error) =>
                    setOpError({ ssid: network.ssid, message: cleanWifiError(error) }),
                });
              }}
            />
          ))}
        </ul>
      )}
    </SectionShell>
  );
}

/** Signal-strength icon for a network (0-100). */
function SignalIcon({ network }: { network: WifiNetwork }) {
  const className = cn(
    'size-5 shrink-0',
    network.inUse ? 'text-primary' : 'text-muted-foreground',
  );
  const Icon =
    network.signal >= 70 ? Wifi : network.signal >= 45 ? WifiHigh : network.signal >= 20 ? WifiLow : WifiZero;
  return <Icon className={className} aria-hidden />;
}

function NetworkRow({
  network,
  isSaved,
  isJoining,
  connectPending,
  disconnectPending,
  error,
  onOpenJoin,
  onCancelJoin,
  onConnect,
  onDisconnect,
  onForget,
}: {
  network: WifiNetwork;
  isSaved: boolean;
  isJoining: boolean;
  connectPending: boolean;
  disconnectPending: boolean;
  error: string | null;
  onOpenJoin: () => void;
  onCancelJoin: () => void;
  onConnect: (password?: string) => void;
  onDisconnect: () => void;
  onForget: () => void;
}) {
  const secured = isSecured(network);
  // A password prompt is only needed for secured networks we don't know yet.
  const needsPassword = secured && !isSaved;

  return (
    <li className="rounded-lg border border-border/60 bg-background/40">
      <div className="flex items-center gap-3 px-3 py-2">
        <SignalIcon network={network} />
        <div className="min-w-0 flex-1">
          <p className="truncate text-sm text-foreground">{network.ssid}</p>
          <p className="flex items-center gap-1.5 text-xs text-muted-foreground">
            {secured && <Lock className="size-3 shrink-0" aria-label="Secured" />}
            <span>{secured ? network.security : 'Open'}</span>
            {isSaved && !network.inUse && <span aria-hidden>·</span>}
            {isSaved && !network.inUse && <span>Saved</span>}
          </p>
        </div>

        {network.inUse ? (
          <>
            <span className="flex items-center gap-1 text-xs font-medium text-primary">
              <Check className="size-3.5" aria-hidden />
              Connected
            </span>
            <Button
              variant="outline"
              size="sm"
              disabled={disconnectPending}
              onClick={onDisconnect}
            >
              {disconnectPending ? 'Disconnecting…' : 'Disconnect'}
            </Button>
          </>
        ) : isJoining && !needsPassword ? null : (
          <Button
            variant="outline"
            size="sm"
            disabled={connectPending}
            onClick={() => {
              if (needsPassword) onOpenJoin();
              else onConnect();
            }}
          >
            {connectPending ? (
              <>
                <Loader2 className="size-3.5 animate-spin" aria-hidden />
                Connecting…
              </>
            ) : (
              'Connect'
            )}
          </Button>
        )}

        {isSaved && !network.inUse && (
          <Button variant="ghost" size="sm" onClick={onForget}>
            Forget
          </Button>
        )}
      </div>

      {isJoining && needsPassword && (
        <PasswordForm
          ssid={network.ssid}
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

function NetworkListSkeleton() {
  return (
    <div className="flex flex-col gap-1" aria-hidden>
      {Array.from({ length: 4 }, (_, i) => (
        <div
          key={i}
          className="flex items-center gap-3 rounded-lg border border-border/60 px-3 py-2"
        >
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

// ---------------------------------------------------------------------------
// Nostr & Storage
// ---------------------------------------------------------------------------

/**
 * Manages where Din stores your data: encrypted app-data sync (NIP-78 +
 * NIP-44), the NIP-65 relay list, and the BUD-03 Blossom server list.
 */
function NostrStorageSection() {
  const { config, updateConfig } = useAppContext();
  const { user } = useCurrentUser();
  const syncStatus = useAppDataSyncStatus();

  const nip44Missing = Boolean(user) && !user?.signer.nip44;

  return (
    <SectionShell title="Nostr & Storage" actions={<SyncStatusBadge status={syncStatus} />}>
      {/* Encrypted sync master toggle */}
      <div className="flex items-center justify-between gap-4 rounded-md border bg-muted/20 p-3">
        <div className="min-w-0">
          <Label htmlFor="sync-to-nostr" className="cursor-pointer text-sm">
            Encrypted sync
          </Label>
          <p className="text-xs text-muted-foreground">
            Store desktop settings encrypted on your Nostr relays so they follow
            you across devices. Turn off to keep everything on this device only.
          </p>
        </div>
        <Switch
          id="sync-to-nostr"
          checked={config.syncToNostr}
          onCheckedChange={(checked) =>
            updateConfig((current) => ({ ...current, syncToNostr: checked }))
          }
        />
      </div>

      {!user && (
        <p className="text-xs text-muted-foreground">
          Log in to sync your settings, relays, and servers with Nostr.
        </p>
      )}

      {nip44Missing && config.syncToNostr && (
        <p role="alert" className="flex items-start gap-2 rounded-md border border-border bg-muted/20 p-3 text-xs text-muted-foreground">
          <TriangleAlert className="mt-0.5 size-3.5 shrink-0" aria-hidden />
          Your signer doesn't support NIP-44 encryption, so settings stay on this
          device. Upgrade your signer to enable encrypted sync.
        </p>
      )}

      <div className="space-y-3">
        <div>
          <h3 className="text-sm font-medium text-foreground">Relays</h3>
          <p className="text-xs text-muted-foreground">
            Nostr relays Din reads from and publishes to (NIP-65).
          </p>
        </div>
        <RelayListManager />
      </div>

      <div className="space-y-3 border-t border-border/60 pt-4">
        <div>
          <h3 className="text-sm font-medium text-foreground">Blossom servers</h3>
          <p className="text-xs text-muted-foreground">
            Servers where Din stores files like your avatar (BUD-03).
          </p>
        </div>
        <BlossomServerManager />
      </div>
    </SectionShell>
  );
}

/** Small pill showing the aggregate state of Din's encrypted app-data sync. */
function SyncStatusBadge({ status }: { status: ReturnType<typeof useAppDataSyncStatus> }) {
  const view = {
    local: { icon: CloudOff, label: 'Local only', className: 'text-muted-foreground' },
    syncing: { icon: Loader2, label: 'Syncing…', className: 'text-muted-foreground' },
    synced: { icon: Check, label: 'Synced', className: 'text-primary' },
    error: { icon: TriangleAlert, label: 'Sync error', className: 'text-destructive' },
  }[status];

  return (
    <span
      role="status"
      className={cn('flex items-center gap-1.5 text-xs font-medium', view.className)}
    >
      <view.icon
        className={cn('size-3.5', status === 'syncing' && 'animate-spin')}
        aria-hidden
      />
      {view.label}
    </span>
  );
}

// ---------------------------------------------------------------------------
// Appearance
// ---------------------------------------------------------------------------

function AppearanceSection() {
  const { theme, setTheme } = useTheme();

  return (
    <SectionShell title="Appearance">
      <p className="mb-3 text-sm text-muted-foreground">Theme</p>
      <div className="flex gap-2" role="radiogroup" aria-label="Theme">
        {(
          [
            { value: 'light', name: 'Light', icon: Sun },
            { value: 'dark', name: 'Dark', icon: Moon },
          ] as const
        ).map((option) => (
          <button
            key={option.value}
            type="button"
            role="radio"
            aria-checked={theme === option.value}
            onClick={() => setTheme(option.value)}
            className={cn(
              'flex w-28 flex-col items-center gap-2 rounded-xl border p-4',
              'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
              theme === option.value
                ? 'border-primary bg-primary/10 text-foreground'
                : 'border-border/60 text-muted-foreground hover:bg-foreground/5 hover:text-foreground',
            )}
          >
            <option.icon className="size-6" aria-hidden />
            <span className="text-sm">{option.name}</span>
          </button>
        ))}
      </div>
    </SectionShell>
  );
}

// ---------------------------------------------------------------------------
// Shared layout bits
// ---------------------------------------------------------------------------

function SectionShell({
  title,
  actions,
  children,
}: {
  title: string;
  actions?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <section className="mx-auto flex max-w-2xl flex-col gap-4 p-4">
      <header className="flex items-center justify-between gap-2">
        <h2 className="text-lg font-semibold text-foreground">{title}</h2>
        {actions && <div className="flex items-center gap-2">{actions}</div>}
      </header>
      {children}
    </section>
  );
}

function FallbackCard({
  icon: Icon,
  children,
}: {
  icon?: LucideIcon;
  children: React.ReactNode;
}) {
  return (
    <div className="rounded-xl border border-dashed border-border px-8 py-12 text-center">
      {Icon && <Icon className="mx-auto mb-4 size-8 text-muted-foreground/80" aria-hidden />}
      <p className="mx-auto max-w-sm text-sm text-muted-foreground">{children}</p>
    </div>
  );
}
