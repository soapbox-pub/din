import { useEffect, useState, type FormEvent } from 'react';
import {
  Bluetooth,
  Camera,
  Gamepad2,
  Headphones,
  Headset,
  Keyboard,
  Laptop,
  Loader2,
  Monitor,
  Mouse,
  Music,
  Plug,
  Printer,
  Router,
  ScanLine,
  Settings2,
  Smartphone,
  Speaker,
} from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import { Button } from '@/components/ui/button';
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuTrigger,
} from '@/components/ui/context-menu';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { PopoverClose } from '@/components/ui/popover';
import { Switch } from '@/components/ui/switch';
import { useBluetoothActions, useBluetoothState } from '@/hooks/useBluetooth';
import { useWindowActions } from '@/contexts/WindowManagerContext';
import {
  cleanBluetoothBridgeError,
  describeDevice,
  getBluetoothBridge,
  sortDevices,
  type BluetoothDevice,
  type BluetoothDeviceKind,
  type BluetoothRequest,
} from '@/lib/bluetooth';
import { cn } from '@/lib/utils';

const ICONS: Record<string, LucideIcon> = {
  'audio-headset': Headset,
  'audio-headphones': Headphones,
  'audio-card': Speaker,
  'input-keyboard': Keyboard,
  'input-mouse': Mouse,
  'input-tablet': Mouse,
  'input-gaming': Gamepad2,
  phone: Smartphone,
  computer: Laptop,
  'video-display': Monitor,
  printer: Printer,
  'camera-photo': Camera,
  'camera-video': Camera,
  'multimedia-player': Music,
  scanner: ScanLine,
  modem: Router,
  'network-wireless': Router,
};

/** Drawn like Lucide's icons, so they sit among them. */
function Glyph({ className, children }: { className?: string; children: React.ReactNode }) {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      width="24"
      height="24"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
      aria-hidden
    >
      {children}
    </svg>
  );
}

/** A phone, with Apple's logo on its screen. */
function IPhoneIcon({ className }: { className?: string }) {
  return (
    <Glyph className={className}>
      <rect width="14" height="20" x="5" y="2" rx="2" ry="2" />
      <path
        stroke="none"
        fill="currentColor"
        transform="translate(7.9 7.7) scale(0.34)"
        d="M12.152 6.896c-.948 0-2.415-1.078-3.96-1.04-2.04.027-3.91 1.183-4.961 3.014-2.117 3.675-.546 9.103 1.519 12.09 1.013 1.454 2.208 3.09 3.792 3.039 1.52-.065 2.09-.987 3.935-.987 1.831 0 2.35.987 3.96.948 1.637-.026 2.676-1.48 3.676-2.948 1.156-1.688 1.636-3.325 1.662-3.415-.039-.013-3.182-1.221-3.22-4.857-.026-3.04 2.48-4.494 2.597-4.559-1.429-2.09-3.623-2.324-4.39-2.376-2-.156-3.675 1.09-4.61 1.09zM15.53 3.83c.843-1.012 1.4-2.427 1.245-3.83-1.207.052-2.662.805-3.532 1.818-.78.896-1.454 2.338-1.273 3.714 1.338.104 2.715-.688 3.559-1.701"
      />
    </Glyph>
  );
}

/** A phone, with the Android robot's head on its screen. */
function AndroidPhoneIcon({ className }: { className?: string }) {
  return (
    <Glyph className={className}>
      <rect width="14" height="20" x="5" y="2" rx="2" ry="2" />
      <path strokeWidth="1.25" d="m9.7 11.3-1-1.5M14.3 11.3l1-1.5" />
      <path
        stroke="none"
        fill="currentColor"
        fillRule="evenodd"
        d="M7.75 15.5a4.25 4.25 0 0 1 8.5 0zM9.75 13.4a.65.65 0 1 0 1.3 0a.65.65 0 1 0-1.3 0zM12.95 13.4a.65.65 0 1 0 1.3 0a.65.65 0 1 0-1.3 0z"
      />
    </Glyph>
  );
}

/** Trezor's padlock, which is what a Trezor looks like. */
function TrezorIcon({ className }: { className?: string }) {
  return (
    <Glyph className={className}>
      <path d="M8 10V7a4 4 0 0 1 8 0v3" />
      <path d="M5.5 10h13v8.5L12 21.5l-6.5-3z" />
    </Glyph>
  );
}

const KIND_ICONS: Record<BluetoothDeviceKind, (props: { className?: string }) => React.ReactNode> = {
  iphone: IPhoneIcon,
  android: AndroidPhoneIcon,
  trezor: TrezorIcon,
};

/** A glyph for what kind of device this is. */
export function BluetoothDeviceIcon({
  device,
  className,
}: {
  device: Pick<BluetoothDevice, 'icon' | 'kind'>;
  className?: string;
}) {
  const Icon = (device.kind && KIND_ICONS[device.kind]) || (device.icon && ICONS[device.icon]) || Bluetooth;
  return <Icon className={className} aria-hidden />;
}

/**
 * The paired devices, each a button that connects or disconnects it, plus
 * the on/off switch. Popover content for the menu bar's Bluetooth item;
 * pairing new devices happens in Settings.
 */
export function BluetoothPopoverBody() {
  const { data } = useBluetoothState();
  const { setPowered, connect, disconnect } = useBluetoothActions();
  const { open } = useWindowActions();
  const [error, setError] = useState<{ path: string; message: string } | null>(null);

  const powered = data?.adapter?.powered ?? false;
  const paired = sortDevices((data?.devices ?? []).filter((d) => d.paired));

  const openSettings = () => open('settings', { section: 'bluetooth' });

  const toggle = (device: BluetoothDevice) => {
    setError(null);
    const onError = (e: Error) => setError({ path: device.path, message: cleanBluetoothBridgeError(e) });
    if (device.connected) disconnect.mutate(device.path, { onError });
    else connect.mutate(device.path, { onError });
  };

  return (
    <div className="flex flex-col">
      <header className="flex items-center justify-between gap-2 border-b border-border/60 px-3 py-2">
        <h2 className="text-sm font-medium text-foreground">Bluetooth</h2>
        <Switch
          aria-label="Bluetooth"
          checked={powered}
          disabled={!data?.adapter || setPowered.isPending}
          onCheckedChange={(on) =>
            setPowered.mutate(on, {
              onError: (e) => setError({ path: '', message: cleanBluetoothBridgeError(e) }),
            })
          }
        />
      </header>

      <div className="p-1.5">
        {!powered ? (
          <p className="px-2 py-3 text-center text-sm text-muted-foreground">Bluetooth is off.</p>
        ) : paired.length === 0 ? (
          <p className="px-2 py-3 text-center text-sm text-muted-foreground">No devices paired yet.</p>
        ) : (
          <ul className="flex flex-col gap-0.5" aria-label="Paired devices">
            {paired.map((device) => (
              <li key={device.path}>
                <ContextMenu>
                  <ContextMenuTrigger asChild>
                    <button
                      type="button"
                      onClick={() => toggle(device)}
                      disabled={device.busy !== null}
                      aria-label={device.connected ? `Disconnect ${device.name}` : `Connect ${device.name}`}
                      className={cn(
                        'flex w-full items-center gap-2.5 rounded-md px-2 py-1.5 text-left transition-colors',
                        'hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
                        'disabled:opacity-70',
                      )}
                    >
                      <span
                        className={cn(
                          'grid size-7 shrink-0 place-items-center rounded-full',
                          device.connected ? 'bg-primary text-primary-foreground' : 'bg-foreground/10 text-foreground/80',
                        )}
                      >
                        <BluetoothDeviceIcon device={device} className="size-3.5" />
                      </span>
                      <span className="min-w-0 flex-1">
                        <span className="block truncate text-sm text-foreground">{device.name}</span>
                        <span className="block truncate text-xs text-muted-foreground">
                          {describeDevice(device)}
                        </span>
                      </span>
                      {device.busy && (
                        <Loader2 className="size-3.5 shrink-0 animate-spin text-muted-foreground" aria-hidden />
                      )}
                    </button>
                  </ContextMenuTrigger>
                  <ContextMenuContent>
                    <ContextMenuItem disabled={device.busy !== null} onSelect={() => toggle(device)}>
                      <Plug aria-hidden />
                      {device.connected ? 'Disconnect' : 'Connect'}
                    </ContextMenuItem>
                    <ContextMenuSeparator />
                    <PopoverClose asChild>
                      <ContextMenuItem onSelect={openSettings}>
                        <Settings2 aria-hidden />
                        Bluetooth settings
                      </ContextMenuItem>
                    </PopoverClose>
                  </ContextMenuContent>
                </ContextMenu>
                {error?.path === device.path && (
                  <p role="alert" className="px-2 py-1 text-xs text-destructive">
                    {error.message}
                  </p>
                )}
              </li>
            ))}
          </ul>
        )}
        {error?.path === '' && (
          <p role="alert" className="px-2 py-1 text-xs text-destructive">
            {error.message}
          </p>
        )}
      </div>

      <footer className="border-t border-border/60 p-1.5">
        <PopoverClose asChild>
          <Button
            variant="ghost"
            size="sm"
            className="w-full justify-start text-muted-foreground hover:text-foreground"
            onClick={openSettings}
          >
            <Settings2 aria-hidden />
            Bluetooth settings
          </Button>
        </PopoverClose>
      </footer>
    </div>
  );
}

/**
 * Asks the user what a pairing needs - to compare a code, type a PIN, or
 * type a code on the device - however the pairing started (from Settings,
 * or by the device). Mounted once on the desktop; while it is, the main
 * process lets devices pair through it.
 */
export function BluetoothPromptHost() {
  const { data } = useBluetoothState();
  const request = data?.request ?? null;

  useEffect(() => {
    const bluetooth = getBluetoothBridge();
    if (!bluetooth) return;
    void bluetooth.setPrompts(true).catch(() => {});
    return () => void bluetooth.setPrompts(false).catch(() => {});
  }, []);

  if (!request) return null;
  return <BluetoothPrompt key={request.id} request={request} />;
}

function BluetoothPrompt({ request }: { request: BluetoothRequest }) {
  const [value, setValue] = useState('');
  const bluetooth = getBluetoothBridge();
  const { kind, name, code } = request;

  const answer = (accept: boolean, typed?: string) => void bluetooth?.answer(request.id, accept, typed).catch(() => {});
  const dismiss = () => {
    answer(false);
    void bluetooth?.cancel(request.device).catch(() => {});
  };

  const typing = kind === 'pin' || kind === 'passkey';
  const showing = kind === 'display-pin' || kind === 'display-passkey';
  const valid = kind === 'pin' ? /^[\x20-\x7e]{1,16}$/.test(value) : /^\d{1,6}$/.test(value);

  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (typing) {
      if (valid) answer(true, value);
    } else {
      answer(true);
    }
  };

  const description =
    kind === 'confirm'
      ? `Make sure ${name} shows this code too.`
      : kind === 'authorize'
        ? `${name} wants to pair with this computer.`
        : kind === 'pin'
          ? `Type the PIN for ${name}. It's often 0000 or 1234, or in the device's manual.`
          : kind === 'passkey'
            ? `Type the code ${name} shows.`
            : `Type this code on ${name}, then press Enter on it.`;

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) dismiss();
      }}
    >
      <DialogContent className="sm:max-w-sm">
        <form onSubmit={submit} className="flex flex-col gap-4">
          <DialogHeader>
            <DialogTitle>Pair with {name}</DialogTitle>
            <DialogDescription>{description}</DialogDescription>
          </DialogHeader>

          {code !== null && (kind === 'confirm' || showing) && (
            <p
              className="rounded-lg bg-foreground/5 py-3 text-center font-mono text-3xl font-semibold tracking-[0.3em] text-foreground"
              aria-label={`Code ${code.split('').join(' ')}`}
            >
              {code}
            </p>
          )}

          {typing && (
            <div className="flex flex-col gap-2">
              <Label htmlFor="bluetooth-code">{kind === 'pin' ? 'PIN' : 'Code'}</Label>
              <Input
                id="bluetooth-code"
                autoFocus
                autoComplete="off"
                inputMode={kind === 'passkey' ? 'numeric' : undefined}
                maxLength={kind === 'pin' ? 16 : 6}
                value={value}
                onChange={(e) => setValue(e.target.value)}
              />
            </div>
          )}

          <DialogFooter>
            <Button type="button" variant="ghost" onClick={dismiss}>
              {kind === 'authorize' ? 'Decline' : 'Cancel'}
            </Button>
            {!showing && (
              <Button type="submit" disabled={typing && !valid} autoFocus={!typing}>
                {kind === 'authorize' ? 'Allow' : 'Pair'}
              </Button>
            )}
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
