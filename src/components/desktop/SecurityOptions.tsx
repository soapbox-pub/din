import { useEffect, useRef, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { ArrowLeft, Loader2, Power, RotateCcw } from 'lucide-react';
import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { useWorkAreas } from '@/contexts/MonitorsContext';
import { useWindowActions } from '@/contexts/WindowManagerContext';
import { useLoggedInAccounts, type Account } from '@/hooks/useLoggedInAccounts';
import { getAvatarShape } from '@/lib/avatarShape';
import { primaryArea } from '@/lib/monitors';
import { cleanLockError, getLockBridge } from '@/lib/lock';
import { cleanPowerError, getPowerBridge } from '@/lib/power';
import { onShowSecurityOptions, setSecurityOptionsActive } from '@/lib/securityOptions';
import { cn } from '@/lib/utils';

interface Option {
  label: string;
  run: () => void | Promise<void>;
}

/**
 * The Ctrl+Alt+Delete screen, as Windows has it: a full-screen pause over
 * the desktop offering Lock, Switch account, Sign out, Change password and
 * System Monitor, with restart and shut down in the corner and Cancel (or
 * Escape) to go back. Each option shows only where it can work: Lock and
 * Change password need the computer's password (DinOS's lock screen), Sign
 * out an account the signer daemon keeps, Switch account another account.
 */
export function SecurityOptions() {
  const [open, setOpen] = useState(false);

  useEffect(() => onShowSecurityOptions(() => setOpen(true)), []);
  useEffect(() => {
    setSecurityOptionsActive(open);
  }, [open]);

  if (!open) return null;
  return <SecurityOptionsScreen onClose={() => setOpen(false)} />;
}

function SecurityOptionsScreen({ onClose }: { onClose: () => void }) {
  const { open: openApp } = useWindowActions();
  const { currentUser, otherUsers, setLogin, signOut, isNostrdAccount } = useLoggedInAccounts();
  const lockBridge = getLockBridge();
  const powerBridge = getPowerBridge();
  const { data: lockAvailable = false, isPending: lockPending } = useQuery({
    queryKey: ['lock', 'available'],
    queryFn: () => lockBridge?.available() ?? false,
    enabled: !!lockBridge,
    staleTime: 60_000,
  });
  const { data: power } = useQuery({
    queryKey: ['power', 'actions'],
    queryFn: () => powerBridge?.actions() ?? { reboot: false, powerOff: false },
    enabled: !!powerBridge,
    staleTime: 60_000,
  });

  const [switching, setSwitching] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState('');
  const rootRef = useRef<HTMLDivElement>(null);
  // The dim covers every monitor; what's on it sits on the primary one.
  const { bounds } = primaryArea(useWorkAreas());

  // What had focus goes back to it (a native app's window, say) on Cancel.
  const [returnFocus] = useState(() => document.activeElement);
  const close = () => {
    onClose();
    if (returnFocus instanceof HTMLElement && returnFocus.isConnected) {
      requestAnimationFrame(() => returnFocus.focus({ preventScroll: true }));
    }
  };

  /** Run an option that leaves the screen once it's done. */
  const act = (label: string, run: () => void | Promise<void>, describe: (e: unknown) => string) => async () => {
    setError('');
    setBusy(label);
    try {
      await run();
      onClose();
    } catch (e) {
      setError(describe(e));
      setBusy(null);
    }
  };
  const plain = (e: unknown) => (e instanceof Error ? e.message : String(e));

  const canLock = !!lockBridge && lockAvailable;
  const options: Option[] = switching
    ? otherUsers.map((user) => ({
        label: accountName(user),
        run: act(accountName(user), () => setLogin(user.id), plain),
      }))
    : [
        ...(canLock ? [{ label: 'Lock', run: act('Lock', () => lockBridge.lock(), cleanLockError) }] : []),
        ...(otherUsers.length > 0 ? [{ label: 'Switch account', run: () => setSwitching(true) }] : []),
        ...(currentUser && isNostrdAccount(currentUser.id)
          ? [{ label: 'Sign out', run: act('Sign out', () => signOut(currentUser.id), plain) }]
          : []),
        ...(canLock
          ? [
              {
                label: 'Change password',
                run: act('Change password', () => void openApp('settings', { section: 'password' }), plain),
              },
            ]
          : []),
        {
          label: 'System Monitor',
          run: act('System Monitor', () => void openApp('system-monitor'), plain),
        },
      ];

  // The list waits for whether there's a lock screen, so Lock doesn't push
  // in above an option already focused.
  const ready = !lockBridge || !lockPending;

  // The first option has focus, so Enter does what the top line says.
  useEffect(() => {
    if (ready) rootRef.current?.querySelector<HTMLButtonElement>('[data-option]')?.focus();
  }, [switching, ready]);

  const restartOrShutDown = (action: 'reboot' | 'powerOff') =>
    act(action, () => (action === 'reboot' ? powerBridge!.reboot() : powerBridge!.powerOff()), cleanPowerError);

  return (
    <div
      ref={rootRef}
      role="dialog"
      aria-modal="true"
      aria-label="Security options"
      className={cn(
        'fixed inset-0 z-[10000] bg-background/80 backdrop-blur-2xl',
        'motion-safe:animate-in motion-safe:fade-in-0 motion-safe:duration-200',
      )}
      onKeyDown={(e) => {
        if (e.key === 'Escape' && !e.ctrlKey && !e.shiftKey) {
          e.preventDefault();
          e.stopPropagation();
          if (switching) setSwitching(false);
          else close();
          return;
        }
        // Up and Down step through the options, as Tab does.
        if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
          const items = [...(rootRef.current?.querySelectorAll<HTMLButtonElement>('[data-option]') ?? [])];
          if (items.length === 0) return;
          e.preventDefault();
          const at = items.indexOf(document.activeElement as HTMLButtonElement);
          const next = e.key === 'ArrowDown' ? at + 1 : at - 1;
          items[(next + items.length) % items.length]?.focus();
        }
      }}
      // Keep Tab inside the screen.
      onBlur={(e) => {
        if (!e.currentTarget.contains(e.relatedTarget as Node | null) && e.relatedTarget) {
          rootRef.current?.querySelector<HTMLButtonElement>('[data-option]')?.focus();
        }
      }}
    >
      <div
        className="absolute flex flex-col"
        style={{ left: bounds.x, top: bounds.y, width: bounds.width, height: bounds.height }}
      >
        <div className="flex flex-1 items-center justify-center p-8">
          <div className="flex w-full max-w-sm flex-col gap-2">
            {switching && (
              <Button
                variant="ghost"
                size="sm"
                className="mb-2 self-start text-muted-foreground"
                onClick={() => setSwitching(false)}
              >
                <ArrowLeft aria-hidden />
                Back
              </Button>
            )}
            {switching &&
              otherUsers.map((user, i) => (
                <OptionButton key={user.id} option={options[i]} busy={busy} icon={<AccountAvatar account={user} />} />
              ))}
            {!switching && ready && options.map((option) => <OptionButton key={option.label} option={option} busy={busy} />)}
            {error && (
              <p role="alert" className="mt-2 px-4 text-sm text-destructive">
                {error}
              </p>
            )}
          </div>
        </div>

        <div className="flex items-center justify-end gap-2 p-6">
          {(power?.reboot || power?.powerOff) && (
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button variant="ghost" size="icon" className="size-10" aria-label="Power" disabled={busy !== null}>
                  <Power className="size-5" />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" side="top" className="z-[10001]">
                {power.reboot && (
                  <DropdownMenuItem onSelect={() => void restartOrShutDown('reboot')()}>
                    <RotateCcw aria-hidden />
                    Restart
                  </DropdownMenuItem>
                )}
                {power.powerOff && (
                  <DropdownMenuItem onSelect={() => void restartOrShutDown('powerOff')()}>
                    <Power aria-hidden />
                    Shut down
                  </DropdownMenuItem>
                )}
              </DropdownMenuContent>
            </DropdownMenu>
          )}
          <Button variant="secondary" className="min-w-24" disabled={busy !== null} onClick={close}>
            Cancel
          </Button>
        </div>
      </div>
    </div>
  );
}

function OptionButton({ option, busy, icon }: { option: Option; busy: string | null; icon?: React.ReactNode }) {
  return (
    <button
      type="button"
      data-option
      disabled={busy !== null}
      onClick={() => void option.run()}
      className={cn(
        'flex items-center gap-3 rounded-lg px-4 py-3 text-left text-lg font-medium text-foreground',
        'transition-colors hover:bg-foreground/10 disabled:opacity-60',
        'focus:bg-foreground/10 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
      )}
    >
      {icon}
      <span className="truncate">{option.label}</span>
      {busy === option.label && <Loader2 className="ml-auto size-4 motion-safe:animate-spin" aria-hidden />}
    </button>
  );
}

function accountName(account: Account): string {
  return account.metadata.name ?? 'Anonymous';
}

function AccountAvatar({ account }: { account: Account }) {
  return (
    <Avatar className="size-8" shape={getAvatarShape(account.metadata)}>
      <AvatarImage src={account.metadata.picture} alt="" />
      <AvatarFallback className="text-xs">{accountName(account).charAt(0)}</AvatarFallback>
    </Avatar>
  );
}
