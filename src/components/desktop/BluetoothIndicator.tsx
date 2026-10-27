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
  Plug,
  Printer,
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
};

/** A glyph for what kind of device this is. */
export function BluetoothDeviceIcon({ icon, className }: { icon: string | null; className?: string }) {
  const Icon = (icon && ICONS[icon]) || Bluetooth;
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
                        <BluetoothDeviceIcon icon={device.icon} className="size-3.5" />
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
