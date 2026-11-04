import { useEffect, useState } from 'react';
import { Bluetooth, Check, ChevronLeft, Loader2, MessageCircle, Share2, TriangleAlert } from 'lucide-react';
import { BluetoothDeviceIcon } from '@/components/desktop/BluetoothIndicator';
import { Button } from '@/components/ui/button';
import { useBluetoothActions, useBluetoothDiscovery, useBluetoothState } from '@/hooks/useBluetooth';
import { usePhoneActions, usePhoneState } from '@/hooks/usePhone';
import { cleanBluetoothBridgeError, getBluetoothBridge, type BluetoothDevice } from '@/lib/bluetooth';
import { getPhoneDesktopBridge, type PhoneDevice, type PhonePlatform, type PhoneState } from '@/lib/phone';
import { cleanPhoneError } from '@/shared/phone';
import { cn } from '@/lib/utils';

type Step =
  | { kind: 'pair' }
  | { kind: 'connect'; address: string; name: string; platform: PhonePlatform | null }
  | { kind: 'done'; phoneId: string; platform: PhonePlatform | null };

const STEPS = 2;

/** The id phone.mts gives a Bluetooth phone (bt-<address without colons>). */
function bluetoothPhoneId(address: string): string {
  return `bt-${address.replace(/:/g, '').toLowerCase()}`;
}

/** Whether an error from the phone means a switch on it is still off, rather than it being away. */
function sharingOff(error: string | null): boolean {
  return !!error && /turned it down|isn’t sharing/.test(error);
}

/**
 * Adding a phone, a step at a time, in Settings → Phone's own pane: pairing
 * it over Bluetooth, then connecting. What to switch on on the phone shows
 * only when connecting says it's off, and only for its kind of phone (when
 * Bluetooth can tell). Each step follows what main says about the phones, so
 * it moves on by itself when the phone does its part. The last says what the
 * phone can do here now.
 */
export function PhoneSetupWizard({ onClose, onOpenMessages }: { onClose: () => void; onOpenMessages: (phoneId: string) => void }) {
  const status = usePhoneState();
  const [step, setStep] = useState<Step>({ kind: 'pair' });
  const state = status.data;

  const previous: Step | null = step.kind === 'connect' ? { kind: 'pair' } : null;

  return (
    <section className="mx-auto flex max-w-2xl flex-col gap-4 p-4" aria-label="Add a phone">
      <header className="flex items-center gap-1">
        <button
          type="button"
          aria-label={previous ? 'Back' : 'Back to my phones'}
          onClick={() => (previous ? setStep(previous) : onClose())}
          className="-ml-1.5 grid size-8 place-items-center rounded-md text-muted-foreground hover:bg-foreground/10 hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          <ChevronLeft className="size-5" aria-hidden />
        </button>
        <h2 className="min-w-0 flex-1 truncate font-[family-name:var(--font-title)] text-lg font-semibold text-foreground">Add a phone</h2>
        {step.kind !== 'done' && (
          <Button variant="ghost" size="sm" onClick={onClose}>
            Cancel
          </Button>
        )}
      </header>

      {step.kind === 'pair' ? (
        <PairStep onPaired={(address, name, platform) => setStep({ kind: 'connect', address, name, platform })} />
      ) : step.kind === 'connect' ? (
        <ConnectStep
          address={step.address}
          name={step.name}
          platform={step.platform}
          state={state}
          onConnected={(phoneId, platform) => setStep({ kind: 'done', phoneId, platform })}
        />
      ) : (
        <DoneStep
          phone={state?.phones.find((p) => p.id === step.phoneId)}
          platform={step.platform}
          onOpenMessages={() => {
            onOpenMessages(step.phoneId);
            onClose();
          }}
          onClose={onClose}
        />
      )}
    </section>
  );
}

// ---------------------------------------------------------------------------
// Steps
// ---------------------------------------------------------------------------

function StepHeader({ step, title, children }: { step?: number; title: string; children?: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-2">
      {step !== undefined && (
        <div className="flex items-center gap-1.5" role="img" aria-label={`Step ${step} of ${STEPS}`}>
          {Array.from({ length: STEPS }, (_, i) => (
            <span key={i} className={cn('h-1 w-6 rounded-full', i < step ? 'bg-primary' : 'bg-foreground/15')} />
          ))}
        </div>
      )}
      <h3 className="text-base font-semibold text-foreground">{title}</h3>
      {children && <div className="flex flex-col gap-2 text-sm text-muted-foreground">{children}</div>}
    </div>
  );
}

function PairStep({ onPaired }: { onPaired: (address: string, name: string, platform: PhonePlatform | null) => void }) {
  const bluetooth = useBluetoothState();
  const { setPowered } = useBluetoothActions();
  const [pairing, setPairing] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const adapter = bluetooth.data?.adapter ?? null;
  const powered = adapter?.powered ?? false;
  useBluetoothDiscovery(powered);

  const phones = (bluetooth.data?.devices ?? []).filter((d) => d.icon === 'phone');
  const nearby = phones.filter((d) => !d.paired);

  const pair = async (device: BluetoothDevice) => {
    const bridge = getBluetoothBridge();
    if (!bridge) return;
    setPairing(device.path);
    setError(null);
    try {
      await bridge.pair(device.path);
    } catch (e) {
      // Pairing can work and the connection after it fail (a phone has
      // nothing for a computer to connect to until it's asked for texts).
      const now = await bridge.state().catch(() => null);
      if (!now?.devices.some((d) => d.path === device.path && d.paired)) {
        setPairing(null);
        setError(cleanBluetoothBridgeError(e));
        return;
      }
    }
    setPairing(null);
    onPaired(device.address, device.name, device.kind === 'iphone' || device.kind === 'android' ? device.kind : null);
  };

  return (
    <>
      <StepHeader step={1} title="Pair your phone">
        <p>
          On the phone, open its <span className="font-medium text-foreground">Bluetooth</span> settings and keep that screen
          open. It shows up here; choose Pair, then check that both screens show the same code.
        </p>
      </StepHeader>
      {!bluetooth.data?.available || !adapter ? (
        <Notice icon={bluetooth.isLoading ? Loader2 : TriangleAlert} spin={bluetooth.isLoading} tone={bluetooth.isLoading ? undefined : 'error'}>
          {bluetooth.isLoading ? 'Checking Bluetooth…' : 'This computer has no Bluetooth, so a phone can’t be added.'}
        </Notice>
      ) : !powered ? (
        <Notice icon={Bluetooth}>
          Bluetooth is off.
          <Button size="sm" variant="outline" className="ml-auto" disabled={setPowered.isPending} onClick={() => setPowered.mutate(true)}>
            Turn On
          </Button>
        </Notice>
      ) : (
        <div className="flex flex-col gap-3">
          <DeviceList label="Nearby" busy={adapter.discovering}>
            {nearby.length === 0 ? (
              <p className="rounded-lg border border-dashed border-border/60 px-3 py-4 text-center text-sm text-muted-foreground">
                Looking for your phone…
              </p>
            ) : (
              nearby.map((d) => (
                <DeviceRow key={d.path} device={d}>
                  <Button size="sm" variant="outline" disabled={pairing !== null} onClick={() => void pair(d)}>
                    {pairing === d.path && <Loader2 className="size-3.5 animate-spin" aria-hidden />}
                    Pair
                  </Button>
                </DeviceRow>
              ))
            )}
          </DeviceList>
          {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
        </div>
      )}
    </>
  );
}

/** What to switch on on the phone, for its kind (both when Bluetooth can't tell), once connecting says it's off. */
function TurnOnSharing({ name, platform, busy, onRetry }: { name: string; platform: PhonePlatform | null; busy: boolean; onRetry: () => void }) {
  return (
    <>
      <StepHeader step={2} title={`Let ${name} share its texts`}>
        <p>{name} didn’t let this computer read its messages yet.</p>
      </StepHeader>
      <div className={cn('grid gap-3', platform === null && 'sm:grid-cols-2')}>
        {platform !== 'android' && (
          <div className="flex flex-col gap-1.5 rounded-lg border border-border/60 bg-background/40 p-3 text-sm">
            {platform === null && <p className="font-medium text-foreground">iPhone</p>}
            <ol className="flex list-decimal flex-col gap-1 pl-5 text-foreground/90">
              <li>Open <span className="font-medium">Settings → Bluetooth</span>.</li>
              <li>Tap <span className="font-medium">ⓘ</span> beside this computer.</li>
              <li>Turn on <span className="font-medium">Show Notifications</span> and <span className="font-medium">Sync Contacts</span>.</li>
            </ol>
          </div>
        )}
        {platform !== 'iphone' && (
          <div className="flex flex-col gap-1.5 rounded-lg border border-border/60 bg-background/40 p-3 text-sm">
            {platform === null && <p className="font-medium text-foreground">Android</p>}
            <p className="text-foreground/90">
              When you try again, the phone asks to allow access to your <span className="font-medium">messages</span> and{' '}
              <span className="font-medium">contacts</span>. Allow both.
            </p>
          </div>
        )}
      </div>
      <div className="flex justify-end">
        <Button disabled={busy} onClick={onRetry}>
          {busy && <Loader2 className="size-3.5 animate-spin" aria-hidden />}
          Try Again
        </Button>
      </div>
    </>
  );
}

function ConnectStep({
  address,
  name,
  platform: pairedAs,
  state,
  onConnected,
}: {
  address: string;
  name: string;
  platform: PhonePlatform | null;
  state: PhoneState | undefined;
  onConnected: (phoneId: string, platform: PhonePlatform | null) => void;
}) {
  const id = bluetoothPhoneId(address);
  const { add, refresh } = usePhoneActions();
  const [failed, setFailed] = useState<string | null>(null);
  const phone = state?.phones.find((p) => p.id === id);
  const platform = phone?.platform ?? pairedAs;

  // Add it once (or, if it's there already, connect it again), then follow
  // what main says about it.
  useEffect(() => {
    const bridge = getPhoneDesktopBridge();
    if (!bridge) return;
    const already = state?.phones.some((p) => p.id === id);
    (already ? bridge.refresh(id) : bridge.add(id)).catch((e: unknown) => setFailed(cleanPhoneError(e)));
    // Only on arriving at this step.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id]);

  useEffect(() => {
    if (phone?.status === 'connected') onConnected(id, platform);
  }, [phone?.status, id, platform, onConnected]);

  if (phone?.status === 'offline' && sharingOff(phone.error)) {
    return <TurnOnSharing name={name} platform={platform} busy={refresh.isPending} onRetry={() => refresh.mutate(id)} />;
  }

  const error = failed ?? (phone?.status === 'offline' ? phone.error : null);
  return (
    <>
      <StepHeader step={2} title={`Connecting to ${name}`} />
      {error ? (
        <>
          <Notice icon={TriangleAlert} tone="error">
            {error}
          </Notice>
          <div className="flex justify-end gap-2">
            <Button disabled={refresh.isPending || add.isPending} onClick={() => (phone ? refresh.mutate(id) : add.mutate(id))}>
              Try Again
            </Button>
          </div>
        </>
      ) : (
        <Notice icon={Loader2} spin>
          {phone?.status === 'offline' && !phone.error
            ? 'Keep the phone nearby and unlocked…'
            : 'Connecting… If the phone asks to allow access, allow it.'}
        </Notice>
      )}
    </>
  );
}

/** Connected: what the phone can do here now, for its kind. */
function DoneStep({
  phone,
  platform,
  onOpenMessages,
  onClose,
}: {
  phone: PhoneDevice | undefined;
  platform: PhonePlatform | null;
  onOpenMessages: () => void;
  onClose: () => void;
}) {
  const kind = phone?.platform ?? platform;
  // Quick Share is Android's; iPhones have no way to send files here.
  const quickShare = kind !== 'iphone' && (phone?.receiveFiles ?? true);
  return (
    <>
      <div className="flex flex-col items-center gap-3 pt-6 text-center">
        <span className="grid size-14 place-items-center rounded-full bg-primary/15 text-primary">
          <Check className="size-7" strokeWidth={2.5} aria-hidden />
        </span>
        <h3 className="text-base font-semibold text-foreground">{phone ? `${phone.name} is connected` : 'Your phone is connected'}</h3>
        <p className="text-sm text-muted-foreground">Here’s what you can do now.</p>
      </div>
      <ul className="mx-auto flex w-full max-w-md flex-col gap-2">
        <Feature icon={MessageCircle} title="Text from this computer">
          New texts show up in Messages and as notifications you can reply to. Pictures and group conversations don’t come over
          Bluetooth.
        </Feature>
        {quickShare && (
          <Feature icon={Share2} title="Share to this computer">
            {kind === null ? 'On an Android phone, share' : 'Share'} photos, files and links from any app: choose{' '}
            <span className="font-medium text-foreground">Quick Share</span>, then this computer. There’s nothing to turn on here,
            and they’re saved to Downloads.
          </Feature>
        )}
      </ul>
      <div className="flex justify-center gap-2">
        <Button variant="outline" onClick={onClose}>Done</Button>
        <Button onClick={onOpenMessages}>Open Messages</Button>
      </div>
    </>
  );
}

function Feature({ icon: Icon, title, children }: { icon: typeof Bluetooth; title: string; children: React.ReactNode }) {
  return (
    <li className="flex gap-3 rounded-lg border border-border/60 bg-background/40 p-3">
      <span className="grid size-8 shrink-0 place-items-center rounded-full bg-primary/10 text-primary">
        <Icon className="size-4" aria-hidden />
      </span>
      <div className="flex min-w-0 flex-col gap-0.5 text-sm">
        <p className="font-medium text-foreground">{title}</p>
        <p className="text-muted-foreground">{children}</p>
      </div>
    </li>
  );
}

// ---------------------------------------------------------------------------
// Pieces
// ---------------------------------------------------------------------------

function DeviceList({ label, busy, children }: { label: string; busy?: boolean; children: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-1.5">
      <h4 className="flex items-center gap-1.5 text-xs font-medium text-muted-foreground">
        {label}
        {busy && <Loader2 className="size-3 animate-spin" aria-label="Searching" />}
      </h4>
      <ul className="flex flex-col gap-1">{children}</ul>
    </div>
  );
}

function DeviceRow({ device, children }: { device: BluetoothDevice; children: React.ReactNode }) {
  return (
    <li className="flex items-center gap-3 rounded-lg border border-border/60 bg-background/40 px-3 py-2">
      <BluetoothDeviceIcon device={device} className="size-5 shrink-0 text-muted-foreground" />
      <span className="min-w-0 flex-1 truncate text-sm text-foreground">{device.name}</span>
      {children}
    </li>
  );
}

function Notice({
  icon: Icon,
  spin,
  tone,
  children,
}: {
  icon: typeof Bluetooth;
  spin?: boolean;
  tone?: 'error';
  children: React.ReactNode;
}) {
  return (
    <div
      role={tone === 'error' ? 'alert' : undefined}
      className={cn(
        'flex items-center gap-2 rounded-lg border px-3 py-3 text-sm',
        tone === 'error' ? 'border-destructive/50 text-destructive' : 'border-dashed border-border/60 text-muted-foreground',
      )}
    >
      <Icon className={cn('size-4 shrink-0', spin && 'animate-spin motion-reduce:animate-none')} aria-hidden />
      <span className="flex min-w-0 flex-1 items-center gap-2">{children}</span>
    </div>
  );
}
