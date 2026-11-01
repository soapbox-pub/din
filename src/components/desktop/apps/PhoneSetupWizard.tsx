import { useEffect, useState } from 'react';
import { Bluetooth, Check, ChevronLeft, Loader2, Smartphone, TriangleAlert, Wifi } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { QRCodeCanvas } from '@/components/ui/qrcode';
import { useBluetoothActions, useBluetoothDiscovery, useBluetoothState } from '@/hooks/useBluetooth';
import { usePhoneActions, usePhoneDiscovery, usePhoneState } from '@/hooks/usePhone';
import { cleanBluetoothBridgeError, getBluetoothBridge, type BluetoothDevice } from '@/lib/bluetooth';
import { getPhoneDesktopBridge, type PhoneDevice, type PhoneState } from '@/lib/phone';
import { cleanPhoneError } from '@/shared/phone';
import { cn } from '@/lib/utils';

/** KDE Connect on Google Play, and on F-Droid. */
const KDE_CONNECT_URL = 'https://play.google.com/store/apps/details?id=org.kde.kdeconnect_tp';
const KDE_CONNECT_FDROID = 'https://f-droid.org/packages/org.kde.kdeconnect_tp/';

type Step =
  | { kind: 'choose' }
  | { kind: 'ios-pair' }
  | { kind: 'ios-share'; address: string; name: string }
  | { kind: 'ios-connect'; address: string; name: string }
  | { kind: 'android-install' }
  | { kind: 'android-find' }
  | { kind: 'done'; phoneId: string };

/** The id phone.mts gives a Bluetooth phone (bt-<address without colons>). */
function bluetoothPhoneId(address: string): string {
  return `bt-${address.replace(/:/g, '').toLowerCase()}`;
}

/** Whether an error from the phone means a switch on it is still off, rather than it being away. */
function sharingOff(error: string | null): boolean {
  return !!error && /Show Notifications|turned it down|isn’t sharing/.test(error);
}

/**
 * Adding a phone, a step at a time: iPhone or Android first, then pairing
 * and whatever the phone needs turned on or installed. Every step is worked
 * out from what main says about the phones, so the wizard moves on by
 * itself when the phone does its part (pairs, connects, sends its texts).
 */
export function PhoneSetupWizard({
  open,
  onOpenChange,
  onOpenMessages,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onOpenMessages: (phoneId: string) => void;
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg">
        {/* Remounted each time it opens, so it starts at the first step. */}
        {open && <Wizard onClose={() => onOpenChange(false)} onOpenMessages={onOpenMessages} />}
      </DialogContent>
    </Dialog>
  );
}

function Wizard({ onClose, onOpenMessages }: { onClose: () => void; onOpenMessages: (phoneId: string) => void }) {
  const status = usePhoneState();
  const [step, setStep] = useState<Step>({ kind: 'choose' });
  // The phones there were before, to tell which one is new.
  const [before] = useState(() => new Set(status.data?.phones.map((p) => p.id) ?? []));
  const state = status.data;

  const back = (): Step | null => {
    switch (step.kind) {
      case 'ios-pair':
      case 'android-install':
        return { kind: 'choose' };
      case 'ios-share':
        return { kind: 'ios-pair' };
      case 'ios-connect':
        return { kind: 'ios-share', address: step.address, name: step.name };
      case 'android-find':
        return { kind: 'android-install' };
      default:
        return null;
    }
  };
  const previous = back();

  const body = (() => {
    switch (step.kind) {
      case 'choose':
        return <ChooseStep onPick={(kind) => setStep({ kind: kind === 'iphone' ? 'ios-pair' : 'android-install' })} />;
      case 'ios-pair':
        return <IosPairStep state={state} onPaired={(address, name) => setStep({ kind: 'ios-share', address, name })} />;
      case 'ios-share':
        return <IosShareStep name={step.name} error={null} onDone={() => setStep({ kind: 'ios-connect', address: step.address, name: step.name })} />;
      case 'ios-connect':
        return (
          <IosConnectStep
            address={step.address}
            name={step.name}
            state={state}
            onConnected={(phoneId) => setStep({ kind: 'done', phoneId })}
            onBackToShare={() => setStep({ kind: 'ios-share', address: step.address, name: step.name })}
          />
        );
      case 'android-install':
        return <AndroidInstallStep onDone={() => setStep({ kind: 'android-find' })} />;
      case 'android-find':
        return <AndroidFindStep state={state} before={before} onPaired={(phoneId) => setStep({ kind: 'done', phoneId })} />;
      case 'done':
        return (
          <DoneStep
            phone={state?.phones.find((p) => p.id === step.phoneId)}
            onOpenMessages={() => {
              onOpenMessages(step.phoneId);
              onClose();
            }}
            onClose={onClose}
          />
        );
    }
  })();

  return (
    <div className="flex min-w-0 flex-col gap-4">
      {previous && (
        <button
          type="button"
          onClick={() => setStep(previous)}
          className="-ml-1 flex w-fit items-center gap-0.5 rounded-md px-1 text-sm text-muted-foreground hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          <ChevronLeft className="size-4" aria-hidden />
          Back
        </button>
      )}
      {body}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Steps
// ---------------------------------------------------------------------------

function StepHeader({ step, of, title, children }: { step?: number; of?: number; title: string; children?: React.ReactNode }) {
  return (
    <DialogHeader>
      {step !== undefined && of !== undefined && (
        <div className="flex items-center gap-1.5" aria-label={`Step ${step} of ${of}`}>
          {Array.from({ length: of }, (_, i) => (
            <span key={i} className={cn('h-1 w-6 rounded-full', i < step ? 'bg-primary' : 'bg-foreground/15')} />
          ))}
        </div>
      )}
      <DialogTitle>{title}</DialogTitle>
      {children && <DialogDescription asChild><div className="flex flex-col gap-2 text-sm text-muted-foreground">{children}</div></DialogDescription>}
    </DialogHeader>
  );
}

function ChooseStep({ onPick }: { onPick: (kind: 'iphone' | 'android') => void }) {
  return (
    <>
      <StepHeader title="Add a phone">Read and answer its texts on this computer. What kind of phone is it?</StepHeader>
      <div className="grid grid-cols-2 gap-3">
        <KindTile icon={Smartphone} label="iPhone" hint="Over Bluetooth" onClick={() => onPick('iphone')} />
        <KindTile icon={Smartphone} label="Android" hint="Over Wi-Fi, with KDE Connect" onClick={() => onPick('android')} />
      </div>
    </>
  );
}

function KindTile({ icon: Icon, label, hint, onClick }: { icon: typeof Smartphone; label: string; hint: string; onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="flex flex-col items-center gap-2 rounded-xl border border-border/60 bg-background/40 px-4 py-6 text-center transition-colors hover:border-primary/60 hover:bg-primary/5 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
    >
      <Icon className="size-10 text-foreground/80" strokeWidth={1.5} aria-hidden />
      <span className="text-base font-semibold text-foreground">{label}</span>
      <span className="text-xs text-muted-foreground">{hint}</span>
    </button>
  );
}

function IosPairStep({ state, onPaired }: { state: PhoneState | undefined; onPaired: (address: string, name: string) => void }) {
  const bluetooth = useBluetoothState();
  const { setPowered } = useBluetoothActions();
  const [pairing, setPairing] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const adapter = bluetooth.data?.adapter ?? null;
  const powered = adapter?.powered ?? false;
  useBluetoothDiscovery(powered);

  const phones = (bluetooth.data?.devices ?? []).filter((d) => d.icon === 'phone');
  const paired = phones.filter((d) => d.paired);
  const nearby = phones.filter((d) => !d.paired);
  const added = new Set(state?.phones.map((p) => p.id) ?? []);

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
    onPaired(device.address, device.name);
  };

  return (
    <>
      <StepHeader step={1} of={3} title="Pair your iPhone">
        <p>
          On the iPhone, open <span className="font-medium text-foreground">Settings → Bluetooth</span> and keep that
          screen open. It shows up here; choose Pair, then check that both screens show the same code.
        </p>
      </StepHeader>
      {!bluetooth.data?.available || !adapter ? (
        <Notice icon={TriangleAlert} tone="error">
          {bluetooth.isLoading ? 'Checking Bluetooth…' : 'This computer has no Bluetooth, so an iPhone can’t be added.'}
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
          {paired.length > 0 && (
            <DeviceList label="Already paired">
              {paired.map((d) => (
                <DeviceRow key={d.path} name={d.name}>
                  {added.has(bluetoothPhoneId(d.address)) ? (
                    <span className="text-xs text-muted-foreground">Already added</span>
                  ) : (
                    <Button size="sm" onClick={() => onPaired(d.address, d.name)}>
                      Use This Phone
                    </Button>
                  )}
                </DeviceRow>
              ))}
            </DeviceList>
          )}
          <DeviceList label="Nearby" busy={adapter.discovering}>
            {nearby.length === 0 ? (
              <p className="rounded-lg border border-dashed border-border/60 px-3 py-4 text-center text-sm text-muted-foreground">
                Looking for your iPhone…
              </p>
            ) : (
              nearby.map((d) => (
                <DeviceRow key={d.path} name={d.name}>
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

function IosShareStep({ name, error, onDone }: { name: string; error: string | null; onDone: () => void }) {
  return (
    <>
      <StepHeader step={2} of={3} title="Let it share your texts">
        <p>On {name}:</p>
        <ol className="flex list-decimal flex-col gap-1 pl-5 text-foreground/90">
          <li>Open <span className="font-medium">Settings → Bluetooth</span>.</li>
          <li>Tap <span className="font-medium">ⓘ</span> beside this computer.</li>
          <li>Turn on <span className="font-medium">Show Notifications</span>, for texts.</li>
          <li>Turn on <span className="font-medium">Sync Contacts</span>, for names.</li>
        </ol>
      </StepHeader>
      {error && (
        <Notice icon={TriangleAlert} tone="error">
          {error}
        </Notice>
      )}
      <DialogFooter>
        <Button onClick={onDone}>{error ? 'Try Again' : 'I’ve Turned Them On'}</Button>
      </DialogFooter>
    </>
  );
}

function IosConnectStep({
  address,
  name,
  state,
  onConnected,
  onBackToShare,
}: {
  address: string;
  name: string;
  state: PhoneState | undefined;
  onConnected: (phoneId: string) => void;
  onBackToShare: () => void;
}) {
  const id = bluetoothPhoneId(address);
  const { add, refresh } = usePhoneActions();
  const [failed, setFailed] = useState<string | null>(null);
  const phone = state?.phones.find((p) => p.id === id);

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
    if (phone?.status === 'connected') onConnected(id);
  }, [phone?.status, id, onConnected]);

  if (sharingOff(phone?.error ?? null)) {
    return <IosShareStep name={name} error={phone?.error ?? null} onDone={() => refresh.mutate(id)} />;
  }

  const error = failed ?? (phone?.status === 'offline' ? phone.error : null);
  return (
    <>
      <StepHeader step={3} of={3} title={`Connecting to ${name}`} />
      {error ? (
        <>
          <Notice icon={TriangleAlert} tone="error">
            {error}
          </Notice>
          <DialogFooter>
            <Button variant="outline" onClick={onBackToShare}>Check the Switches</Button>
            <Button disabled={refresh.isPending || add.isPending} onClick={() => (phone ? refresh.mutate(id) : add.mutate(id))}>
              Try Again
            </Button>
          </DialogFooter>
        </>
      ) : (
        <Notice icon={Loader2} spin>
          {phone?.status === 'offline' && !phone.error ? 'Keep the iPhone nearby and unlocked…' : 'Connecting…'}
        </Notice>
      )}
    </>
  );
}

function AndroidInstallStep({ onDone }: { onDone: () => void }) {
  return (
    <>
      <StepHeader step={1} of={3} title="Install KDE Connect">
        <p>
          Your Android phone talks to this computer through <span className="font-medium text-foreground">KDE Connect</span>,
          a free app. Scan the code with the phone to get it from Google Play, or get it from{' '}
          <span className="font-medium text-foreground">F-Droid</span> ({KDE_CONNECT_FDROID.replace(/^https:\/\//, '')}).
        </p>
      </StepHeader>
      <div className="mx-auto rounded-xl bg-white p-2">
        <QRCodeCanvas value={KDE_CONNECT_URL} size={160} className="size-40" />
      </div>
      <DialogFooter>
        <Button onClick={onDone}>It’s Installed</Button>
      </DialogFooter>
    </>
  );
}

function AndroidFindStep({ state, before, onPaired }: { state: PhoneState | undefined; before: Set<string>; onPaired: (phoneId: string) => void }) {
  usePhoneDiscovery();
  const { add, answer } = usePhoneActions();
  const [error, setError] = useState<string | null>(null);
  const fresh = state?.phones.find((p) => p.kind === 'kdeconnect' && !before.has(p.id));

  useEffect(() => {
    if (fresh) onPaired(fresh.id);
  }, [fresh, onPaired]);

  const pairing = state?.pairing ?? null;
  if (pairing) {
    return (
      <>
        <StepHeader step={2} of={3} title={pairing.incoming ? `${pairing.name} wants to pair` : `Pairing with ${pairing.name}`}>
          <p>
            {pairing.incoming
              ? 'Pair only if the phone shows this same key:'
              : 'On the phone, accept the request if it shows this same key:'}
          </p>
        </StepHeader>
        <p className="text-center font-mono text-4xl font-semibold tracking-[0.3em] text-foreground">{pairing.key}</p>
        <DialogFooter>
          <Button variant="outline" disabled={answer.isPending} onClick={() => answer.mutate({ id: pairing.id, accept: false })}>
            Cancel
          </Button>
          {pairing.incoming && (
            <Button disabled={answer.isPending} onClick={() => answer.mutate({ id: pairing.id, accept: true })}>
              Pair
            </Button>
          )}
        </DialogFooter>
      </>
    );
  }

  const found = state?.candidates.filter((c) => c.kind === 'kdeconnect') ?? [];
  return (
    <>
      <StepHeader step={2} of={3} title="Find your phone">
        <p>
          Open KDE Connect on the phone, on the same Wi-Fi as this computer. Pair it here, or tap “{state?.name}” in the
          app.
        </p>
      </StepHeader>
      {state?.network.error ? (
        <Notice icon={TriangleAlert} tone="error">
          {state.network.error}
        </Notice>
      ) : found.length === 0 ? (
        <Notice icon={state?.network.listening ? Loader2 : Wifi} spin={state?.network.listening}>
          Looking for phones with KDE Connect open…
        </Notice>
      ) : (
        <DeviceList label="Found">
          {found.map((c) => (
            <DeviceRow key={c.id} name={c.name}>
              <Button
                size="sm"
                variant="outline"
                disabled={add.isPending}
                onClick={() => {
                  setError(null);
                  add.mutate(c.id, { onError: (e) => setError(cleanPhoneError(e)) });
                }}
              >
                {add.isPending && add.variables === c.id && <Loader2 className="size-3.5 animate-spin" aria-hidden />}
                Pair
              </Button>
            </DeviceRow>
          ))}
        </DeviceList>
      )}
      {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
    </>
  );
}

function DoneStep({ phone, onOpenMessages, onClose }: { phone: PhoneDevice | undefined; onOpenMessages: () => void; onClose: () => void }) {
  const android = phone?.kind === 'kdeconnect';
  return (
    <>
      <div className="flex flex-col items-center gap-3 pt-2 text-center">
        <span className="grid size-14 place-items-center rounded-full bg-primary/15 text-primary">
          <Check className="size-7" strokeWidth={2.5} aria-hidden />
        </span>
        <DialogTitle>{phone ? `${phone.name} is connected` : 'Your phone is connected'}</DialogTitle>
        <DialogDescription asChild>
          <div className="flex max-w-sm flex-col gap-2 text-sm text-muted-foreground">
            {android ? (
              <p>
                One last thing: when KDE Connect asks, allow it to see your <span className="font-medium text-foreground">SMS</span>{' '}
                and <span className="font-medium text-foreground">Contacts</span>. Your conversations show up in Messages once
                it can.
              </p>
            ) : (
              <p>
                New texts show up in Messages and as notifications you can reply to. An iPhone doesn’t share pictures or group
                conversations over Bluetooth; that’s up to Apple, and the same on Windows.
              </p>
            )}
          </div>
        </DialogDescription>
      </div>
      <DialogFooter>
        <Button variant="outline" onClick={onClose}>Done</Button>
        <Button onClick={onOpenMessages}>Open Messages</Button>
      </DialogFooter>
    </>
  );
}

// ---------------------------------------------------------------------------
// Pieces
// ---------------------------------------------------------------------------

function DeviceList({ label, busy, children }: { label: string; busy?: boolean; children: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-1.5">
      <h3 className="flex items-center gap-1.5 text-xs font-medium text-muted-foreground">
        {label}
        {busy && <Loader2 className="size-3 animate-spin" aria-label="Searching" />}
      </h3>
      <ul className="flex flex-col gap-1">{children}</ul>
    </div>
  );
}

function DeviceRow({ name, children }: { name: string; children: React.ReactNode }) {
  return (
    <li className="flex items-center gap-3 rounded-lg border border-border/60 bg-background/40 px-3 py-2">
      <Smartphone className="size-5 shrink-0 text-muted-foreground" aria-hidden />
      <span className="min-w-0 flex-1 truncate text-sm text-foreground">{name}</span>
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
  icon: typeof Wifi;
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
