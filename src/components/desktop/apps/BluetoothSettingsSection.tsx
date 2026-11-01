import { useState } from 'react';
import { Bluetooth, BluetoothConnected, BluetoothOff, Link2, Loader2, Settings2, Trash2 } from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import { BluetoothDeviceIcon } from '@/components/desktop/BluetoothIndicator';
import {
  ActionButton,
  ActionButtons,
  DetailsError,
  DetailsHero,
  DetailsPage,
  DeviceRowButton,
  InfoList,
  InfoRow,
} from '@/components/desktop/apps/DetailsPage';
import { Button } from '@/components/ui/button';
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuTrigger,
} from '@/components/ui/context-menu';
import { Skeleton } from '@/components/ui/skeleton';
import { Switch } from '@/components/ui/switch';
import { useBluetoothActions, useBluetoothDiscovery, useBluetoothState } from '@/hooks/useBluetooth';
import { cleanBluetoothBridgeError, describeDevice, deviceKind, getBluetoothBridge, sortDevices } from '@/lib/bluetooth';
import type { BluetoothDevice } from '@/lib/bluetooth';

/**
 * Settings → Bluetooth: the adapter's on/off switch, then, as Android lays
 * them out, the devices connected now, the paired ones to connect with a
 * click, and the ones nearby to pair with, via the Bluetooth bridge
 * (window.dinos.bluetooth -> BlueZ). A connected device's row opens its page
 * (BluetoothDeviceDetails), where it's disconnected; a paired one's gear opens
 * it too. Looks for devices while it's open and Bluetooth is on. Prompts that
 * pairing needs appear from BluetoothPromptHost, wherever the pairing started.
 */
export function BluetoothSettingsSection() {
  const bridge = getBluetoothBridge();
  const status = useBluetoothState();
  const { setPowered, pair, connect, disconnect, forget } = useBluetoothActions();
  const [opError, setOpError] = useState<{ path: string; message: string } | null>(null);
  const [viewing, setViewing] = useState<string | null>(null);

  const data = status.data;
  const adapter = data?.adapter ?? null;
  const powered = adapter?.powered ?? false;
  useBluetoothDiscovery(powered && viewing === null);

  if (!bridge) {
    return (
      <Shell title="Bluetooth">
        <Fallback icon={Bluetooth}>
          Bluetooth settings need the Din desktop shell; they aren't available in
          a plain browser.
        </Fallback>
      </Shell>
    );
  }

  if (viewing !== null) {
    return (
      <BluetoothDeviceDetails
        key={viewing}
        device={data?.devices.find((d) => d.path === viewing && d.paired)}
        onBack={() => setViewing(null)}
      />
    );
  }

  const devices = sortDevices(data?.devices ?? []);
  const connected = devices.filter((d) => d.paired && d.connected);
  const saved = devices.filter((d) => d.paired && !d.connected);
  const nearby = devices.filter((d) => !d.paired);

  const run = (path: string, action: typeof pair) => {
    setOpError(null);
    action.mutate(path, {
      onError: (error) => setOpError({ path, message: cleanBluetoothBridgeError(error) }),
    });
  };
  const rowProps = (device: BluetoothDevice) => ({
    device,
    error: opError?.path === device.path ? opError.message : null,
    onPair: () => run(device.path, pair),
    onConnect: () => run(device.path, connect),
    onDisconnect: () => run(device.path, disconnect),
    onForget: () => run(device.path, forget),
    onDetails: () => setViewing(device.path),
  });

  return (
    <Shell
      title="Bluetooth"
      actions={
        <Switch
          aria-label="Bluetooth"
          checked={powered}
          disabled={!adapter || setPowered.isPending}
          onCheckedChange={(on) => {
            setOpError(null);
            setPowered.mutate(on, {
              onError: (error) => setOpError({ path: '', message: cleanBluetoothBridgeError(error) }),
            });
          }}
        />
      }
    >
      {opError?.path === '' && (
        <p role="alert" className="text-xs text-destructive">
          {opError.message}
        </p>
      )}
      {status.isLoading ? (
        <DeviceListSkeleton />
      ) : status.isError ? (
        <Fallback>Could not read Bluetooth state: {cleanBluetoothBridgeError(status.error)}</Fallback>
      ) : !data?.available ? (
        <Fallback icon={Bluetooth}>
          The Bluetooth service isn't running on this system, so Bluetooth can't be
          managed here.
        </Fallback>
      ) : !adapter ? (
        <Fallback icon={Bluetooth}>No Bluetooth adapter was found on this computer.</Fallback>
      ) : !powered ? (
        <Fallback icon={Bluetooth}>Bluetooth is turned off.</Fallback>
      ) : (
        <div className="flex flex-col gap-4">
          <p className="text-xs text-muted-foreground">
            Devices see this computer as “{adapter.name}”.
          </p>

          {connected.length > 0 && (
            <div className="flex flex-col gap-2">
              <SubHeading>Connected devices</SubHeading>
              <ul className="flex flex-col gap-1" aria-label="Connected devices">
                {connected.map((device) => (
                  <BluetoothDeviceRow key={device.path} {...rowProps(device)} />
                ))}
              </ul>
            </div>
          )}

          {saved.length > 0 && (
            <div className="flex flex-col gap-2">
              <SubHeading>Saved devices</SubHeading>
              <ul className="flex flex-col gap-1" aria-label="Saved devices">
                {saved.map((device) => (
                  <BluetoothDeviceRow key={device.path} {...rowProps(device)} />
                ))}
              </ul>
            </div>
          )}

          <div className="flex flex-col gap-2">
            <div className="flex items-end gap-2">
              <SubHeading>Devices nearby</SubHeading>
              {adapter.discovering && (
                <Loader2 className="size-3.5 animate-spin text-muted-foreground" aria-label="Searching" />
              )}
            </div>
            {nearby.length === 0 ? (
              <div className="rounded-lg border border-dashed border-border/60 px-3 py-6 text-center text-sm text-muted-foreground">
                {adapter.discovering
                  ? 'Looking for devices… Put the one you want to pair in pairing mode.'
                  : 'No devices found nearby.'}
              </div>
            ) : (
              <ul className="flex flex-col gap-1" aria-label="Devices nearby">
                {nearby.map((device) => (
                  <BluetoothDeviceRow key={device.path} {...rowProps(device)} />
                ))}
              </ul>
            )}
          </div>
        </div>
      )}
    </Shell>
  );
}

/** What a row says under the name: what it's doing, else its battery, else what it is. */
function rowDetail(device: BluetoothDevice): string {
  if (device.busy) return describeDevice(device);
  if (device.battery !== null) return `${device.battery}% battery`;
  return device.connected ? '' : deviceKind(device.icon);
}

function BluetoothDeviceRow({
  device,
  error,
  onPair,
  onConnect,
  onDisconnect,
  onForget,
  onDetails,
}: {
  device: BluetoothDevice;
  error: string | null;
  onPair: () => void;
  onConnect: () => void;
  onDisconnect: () => void;
  onForget: () => void;
  onDetails: () => void;
}) {
  const busy = device.busy !== null;

  return (
    <li className="rounded-lg border border-border/60 bg-background/40">
      <ContextMenu>
        <ContextMenuTrigger asChild>
          <DeviceRowButton
            icon={<BluetoothDeviceIcon icon={device.icon} />}
            name={device.name}
            detail={rowDetail(device)}
            connected={device.connected}
            pending={busy}
            disabled={busy && !device.connected}
            chevron={device.connected}
            onClick={!device.paired ? onPair : device.connected ? onDetails : onConnect}
            trailing={
              device.paired &&
              !device.connected && (
                <Button
                  variant="ghost"
                  size="icon"
                  aria-label={`Settings for ${device.name}`}
                  title="Device details"
                  onClick={onDetails}
                >
                  <Settings2 className="size-4" />
                </Button>
              )
            }
          />
        </ContextMenuTrigger>
        <ContextMenuContent>
          {!device.paired ? (
            <ContextMenuItem disabled={busy} onSelect={onPair}>
              <Link2 aria-hidden />
              Pair
            </ContextMenuItem>
          ) : (
            <>
              {device.connected ? (
                <ContextMenuItem disabled={busy} onSelect={onDisconnect}>
                  <BluetoothOff aria-hidden />
                  Disconnect
                </ContextMenuItem>
              ) : (
                <ContextMenuItem disabled={busy} onSelect={onConnect}>
                  <BluetoothConnected aria-hidden />
                  Connect
                </ContextMenuItem>
              )}
              <ContextMenuItem onSelect={onDetails}>
                <Settings2 aria-hidden />
                Device details
              </ContextMenuItem>
              <ContextMenuSeparator />
              <ContextMenuItem variant="destructive" disabled={busy} onSelect={onForget}>
                <Trash2 aria-hidden />
                Forget
              </ContextMenuItem>
            </>
          )}
        </ContextMenuContent>
      </ContextMenu>

      {error !== null && (
        <p role="alert" className="border-t border-border/60 px-3 py-1.5 text-xs text-destructive">
          {error}
        </p>
      )}
    </li>
  );
}

/** One paired device's page: connect or disconnect it, forget it, and what it is. */
function BluetoothDeviceDetails({ device, onBack }: { device: BluetoothDevice | undefined; onBack: () => void }) {
  const { connect, disconnect, forget } = useBluetoothActions();
  const [error, setError] = useState<string | null>(null);
  const onError = (e: unknown) => setError(cleanBluetoothBridgeError(e));

  return (
    <DetailsPage title={device?.name ?? 'Device details'} backLabel="Back to Bluetooth" onBack={onBack}>
      {!device ? (
        <Fallback icon={Bluetooth}>This device is no longer paired.</Fallback>
      ) : (
        <>
          <DetailsHero
            icon={<BluetoothDeviceIcon icon={device.icon} />}
            name={device.name}
            status={
              <>
                {device.busy && <Loader2 className="size-3.5 animate-spin" aria-hidden />}
                {describeDevice(device)}
              </>
            }
            active={device.connected}
          />

          <ActionButtons>
            <ActionButton
              icon={Trash2}
              label="Forget"
              pending={forget.isPending}
              disabled={device.busy !== null}
              onClick={() => {
                setError(null);
                forget.mutate(device.path, { onSuccess: onBack, onError });
              }}
            />
            {device.connected ? (
              <ActionButton
                icon={BluetoothOff}
                label="Disconnect"
                pending={disconnect.isPending || device.busy === 'disconnecting'}
                disabled={device.busy !== null}
                onClick={() => {
                  setError(null);
                  disconnect.mutate(device.path, { onError });
                }}
              />
            ) : (
              <ActionButton
                icon={BluetoothConnected}
                label="Connect"
                pending={connect.isPending || device.busy === 'connecting'}
                disabled={device.busy !== null}
                onClick={() => {
                  setError(null);
                  connect.mutate(device.path, { onError });
                }}
              />
            )}
          </ActionButtons>

          {error !== null && <DetailsError>{error}</DetailsError>}

          <InfoList>
            <InfoRow label="Type" value={deviceKind(device.icon)} />
            {device.battery !== null && <InfoRow label="Battery" value={`${device.battery}%`} />}
            <InfoRow label="Bluetooth address" value={device.address} />
          </InfoList>
        </>
      )}
    </DetailsPage>
  );
}

function SubHeading({ children }: { children: React.ReactNode }) {
  return <h3 className="text-sm font-medium text-muted-foreground">{children}</h3>;
}

function Shell({
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
        <h2 className="font-[family-name:var(--font-title)] text-lg font-semibold text-foreground">{title}</h2>
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

function DeviceListSkeleton() {
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
