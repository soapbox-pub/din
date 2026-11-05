import { useEffect, useRef, useState, type FormEvent } from 'react';
import { Airplay, Columns2, Copy, ExternalLink, Loader2, Settings2, Tv } from 'lucide-react';
import { Button } from '@/components/ui/button';
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
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group';
import { useAirPlayActions, useAirPlayScan, useAirPlayState } from '@/hooks/useAirPlay';
import { useOpenUrl } from '@/hooks/useOpenUrl';
import { useToast } from '@/hooks/useToast';
import { useWindowActions } from '@/contexts/WindowManagerContext';
import { cleanAirPlayError, getAirPlayBridge, type AirPlayMode, type AirPlaySession } from '@/lib/airplay';
import { cn } from '@/lib/utils';
import { trayFooter, trayFooterButton, trayHeader, trayTitle } from './trayPanel';
import { glassPanel } from '@/shared/appChromeStyles';

/** What a session is doing, in a few words. */
function describeSession(session: AirPlaySession): string {
  switch (session.state) {
    case 'connecting':
      return 'Connecting…';
    case 'waiting_for_code':
      return session.prompt === 'password' ? 'Waiting for the password' : 'Waiting for the PIN';
    case 'streaming':
      return session.extend ? 'Extending the desktop' : 'Mirroring the screen';
  }
}

/**
 * The receivers nearby, each with what it's showing, and a way to start or
 * stop sharing with it. A receiver connects the way it was last shared
 * (extending the desktop by default), like a monitor plugged back in; while
 * it's connected, it can be switched between extending and mirroring. Shared
 * by the menu bar's AirPlay panel and Settings → Display. Looks for
 * receivers when it mounts.
 */
export function AirPlayReceiverList({ className }: { className?: string }) {
  const { data } = useAirPlayState();
  const { connect, disconnect, mode: switchMode } = useAirPlayActions();
  const [error, setError] = useState<string | null>(null);
  useAirPlayScan();

  const receivers = data?.receivers ?? [];
  const sessions = data?.sessions ?? [];
  const failure = data?.failure;
  const onError = (e: unknown) => setError(cleanAirPlayError(e));

  const start = (target: string) => {
    setError(null);
    connect.mutate(target, { onError });
  };
  const setMode = (target: string, mode: AirPlayMode) => {
    setError(null);
    switchMode.mutate({ target, mode }, { onError });
  };

  return (
    <div className={cn('flex flex-col gap-3', className)}>
      {receivers.length === 0 ? (
        <div className="flex items-center justify-center gap-2 rounded-lg border border-dashed border-border/60 px-3 py-6 text-sm text-muted-foreground">
          {data?.scanning && <Loader2 className="size-4 animate-spin" aria-hidden />}
          {data?.scanning ? 'Looking for AirPlay receivers…' : 'No AirPlay receivers found nearby.'}
        </div>
      ) : (
        <ul className="flex flex-col gap-1" aria-label="AirPlay receivers">
          {receivers.map((receiver) => {
            const session = sessions.find((s) => s.target === receiver.name);
            const switching = switchMode.isPending && switchMode.variables?.target === receiver.name;
            const pending =
              (connect.isPending && connect.variables === receiver.name && !session) ||
              (disconnect.isPending && disconnect.variables === receiver.name) ||
              switching;
            const active = session?.state === 'streaming';
            // There's one spare connector for a display of its own.
            const extendingElsewhere = sessions.find((s) => s.extend && s.target !== receiver.name);
            const shownMode: AirPlayMode = switching
              ? (switchMode.variables?.mode ?? 'extend')
              : session?.extend ? 'extend' : 'mirror';
            return (
              <li
                key={receiver.name}
                className={cn(
                  'flex flex-col gap-2 rounded-lg px-2 py-1.5',
                  active && 'bg-primary/10',
                )}
              >
                <div className="flex items-center gap-3">
                  <span
                    className={cn(
                      'grid size-8 shrink-0 place-items-center rounded-full',
                      active ? 'bg-primary text-primary-foreground' : 'bg-foreground/10 text-foreground/80',
                    )}
                  >
                    <Tv className="size-4" aria-hidden />
                  </span>
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-sm font-medium text-foreground">{receiver.name}</p>
                    <p className="truncate text-xs text-muted-foreground">
                      {switching
                        ? 'Switching…'
                        : session ? describeSession(session) : receiver.model || receiver.host}
                    </p>
                  </div>
                  {session && !switching ? (
                    <Button
                      variant="secondary"
                      size="sm"
                      disabled={pending}
                      onClick={() => disconnect.mutate(receiver.name)}
                      aria-label={`Stop sharing with ${receiver.name}`}
                    >
                      {pending && <Loader2 className="size-4 animate-spin" aria-hidden />}
                      Stop
                    </Button>
                  ) : (
                    <Button
                      variant="outline"
                      size="sm"
                      disabled={pending}
                      onClick={() => start(receiver.name)}
                      aria-label={`Share the screen with ${receiver.name}`}
                    >
                      {pending && <Loader2 className="size-4 animate-spin" aria-hidden />}
                      Connect
                    </Button>
                  )}
                </div>
                {(active || switching) && (
                  <ToggleGroup
                    type="single"
                    variant="outline"
                    size="sm"
                    value={shownMode}
                    disabled={switching}
                    onValueChange={(value) => {
                      if (value && value !== shownMode) setMode(receiver.name, value as AirPlayMode);
                    }}
                    aria-label={`How to share the screen with ${receiver.name}`}
                    className="w-full pl-11"
                  >
                    <ToggleGroupItem
                      value="extend"
                      className="flex-1"
                      disabled={switching || !!extendingElsewhere}
                      title={extendingElsewhere ? `${extendingElsewhere.name} is already a separate display` : undefined}
                    >
                      Extend
                    </ToggleGroupItem>
                    <ToggleGroupItem value="mirror" className="flex-1">
                      Mirror
                    </ToggleGroupItem>
                  </ToggleGroup>
                )}
              </li>
            );
          })}
        </ul>
      )}

      {(error ?? failure) && (
        <p role="alert" className="text-xs text-destructive">
          {error ?? failure?.message}
        </p>
      )}
    </div>
  );
}

/** deckmon's repository, whose README says how to build and install it. */
const DECKMON_URL =
  'https://git.shakespeare.diy/npub1q3sle0kvfsehgsuexttt3ugjd8xdklxfwwkh559wxckmzddywnws6cd26p/deckmon.git';

/**
 * Why there's no AirPlay here: deckmon, which does the sending, isn't
 * installed. DinOS comes with it; elsewhere it's built from source, so this
 * says where to get it rather than installing it.
 */
function AirPlayUnavailable() {
  const openUrl = useOpenUrl();

  return (
    <div className="flex flex-col items-center gap-1 px-4 py-6 text-center">
      <div className="mb-2 grid size-12 place-items-center rounded-2xl bg-muted text-muted-foreground">
        <Airplay className="size-6" aria-hidden />
      </div>
      <p className="text-sm font-medium text-foreground">AirPlay needs deckmon installed to work</p>
      <p className="text-sm text-muted-foreground">
        deckmon shares the screen with Apple TVs, AirPlay TVs and Rokus. Din finds it once it’s on your PATH; DinOS
        comes with it.
      </p>
      <PopoverClose asChild>
        <Button size="sm" variant="outline" className="mt-2" onClick={() => openUrl(DECKMON_URL)}>
          <ExternalLink aria-hidden />
          How to install deckmon
        </Button>
      </PopoverClose>
    </div>
  );
}

/** Popover content for the menu bar's AirPlay item. */
export function AirPlayPopoverBody() {
  const { open } = useWindowActions();
  const { data } = useAirPlayState();

  return (
    <div className="flex flex-col">
      <header className={trayHeader}>
        <h2 className={trayTitle}>Screen sharing</h2>
        <Airplay className="size-4 text-muted-foreground" aria-hidden />
      </header>
      {data?.available === false ? <AirPlayUnavailable /> : <AirPlayReceiverList className="p-3" />}
      <footer className={trayFooter}>
        <PopoverClose asChild>
          <Button
            variant="ghost"
            size="sm"
            className={trayFooterButton}
            onClick={() => open('settings', { section: 'display' })}
          >
            <Settings2 aria-hidden />
            Display settings
          </Button>
        </PopoverClose>
      </footer>
    </div>
  );
}

/** How long the OSD stays on screen after the display-switch key. */
const OSD_VISIBLE_MS = 2000;

/**
 * On-screen display for the display-switch key (F7 on ThinkPads), which
 * switches the receiver being shared with between extending and mirroring.
 * Both ways are shown, the new one highlighted, Win+P style.
 */
export function AirPlayOsd() {
  const [change, setChange] = useState<{ name: string; mode: AirPlayMode } | null>(null);
  const [visible, setVisible] = useState(false);
  const hideTimer = useRef<number | undefined>(undefined);

  useEffect(() => {
    const airplay = getAirPlayBridge();
    if (!airplay) return;
    const unsubscribe = airplay.onOsd((next) => {
      setChange(next);
      setVisible(true);
      window.clearTimeout(hideTimer.current);
      hideTimer.current = window.setTimeout(() => setVisible(false), OSD_VISIBLE_MS);
    });
    return () => {
      unsubscribe();
      window.clearTimeout(hideTimer.current);
    };
  }, []);

  if (!change) return null;

  const options = [
    { mode: 'extend', label: 'Extend', Icon: Columns2 },
    { mode: 'mirror', label: 'Mirror', Icon: Copy },
  ] as const;

  return (
    <div
      role="status"
      aria-live="polite"
      className={cn(
        'pointer-events-none fixed inset-x-0 bottom-24 z-[9998] flex justify-center',
        'transition-opacity duration-200 motion-reduce:transition-none',
        visible ? 'opacity-100' : 'opacity-0',
      )}
    >
      <div className={cn('flex flex-col items-center gap-2 px-4 py-3', glassPanel)}>
        <p className="flex items-center gap-2 text-sm font-medium text-foreground">
          <Airplay className="size-4 text-muted-foreground" aria-hidden />
          {change.name}
        </p>
        <div className="flex gap-2">
          {options.map(({ mode, label, Icon }) => (
            <span
              key={mode}
              className={cn(
                'flex w-20 flex-col items-center gap-1 rounded-xl px-2 py-2 text-xs font-medium',
                change.mode === mode ? 'bg-primary text-primary-foreground' : 'text-muted-foreground',
              )}
            >
              <Icon className="size-5" aria-hidden />
              {label}
            </span>
          ))}
        </div>
        <span className="sr-only">
          {change.mode === 'extend' ? `Extending the desktop to ${change.name}` : `Mirroring the screen to ${change.name}`}
        </span>
      </div>
    </div>
  );
}

/**
 * Asks for the PIN a receiver shows (or its password) when it wants one, and
 * says so when sharing fails. Mounted once on the desktop, so the prompt
 * appears however the session was started.
 */
export function AirPlayPromptHost() {
  const { data } = useAirPlayState();
  const { code, disconnect } = useAirPlayActions();
  const { toast } = useToast();
  const [value, setValue] = useState('');
  const [error, setError] = useState<string | null>(null);

  const waiting = data?.sessions.find((s) => s.state === 'waiting_for_code') ?? null;
  const target = waiting?.target ?? null;

  // A fresh prompt starts empty.
  const [lastTarget, setLastTarget] = useState(target);
  if (target !== lastTarget) {
    setLastTarget(target);
    setValue('');
    setError(null);
  }

  const failure = data?.failure ?? null;
  const announced = useRef<number | null>(null);
  useEffect(() => {
    if (!failure || announced.current === failure.at) return;
    // Only failures from now on: not one left over from before a reload.
    if (announced.current !== null || Date.now() - failure.at < 10_000) {
      toast({
        variant: 'destructive',
        title: failure.connecting
          ? `Couldn’t connect to ${failure.target}`
          : `Stopped sharing with ${failure.target}`,
        description: failure.message,
      });
    }
    announced.current = failure.at;
  }, [failure, toast]);

  if (!waiting) return null;
  const password = waiting.prompt === 'password';

  const submit = (e: FormEvent) => {
    e.preventDefault();
    const trimmed = value.trim();
    if (!trimmed) return;
    setError(null);
    code.mutate(
      { target: waiting.target, code: trimmed },
      { onError: (err) => setError(cleanAirPlayError(err)) },
    );
  };

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) disconnect.mutate(waiting.target);
      }}
    >
      {/* Only Cancel or Escape gives up: a stray click, or focus moving
          when a display is added or removed, would end the session. */}
      <DialogContent className="sm:max-w-sm" onInteractOutside={(e) => e.preventDefault()}>
        <form onSubmit={submit} className="flex flex-col gap-4">
          <DialogHeader>
            <DialogTitle>Share with {waiting.name}</DialogTitle>
            <DialogDescription>
              {password
                ? `Enter the AirPlay password set on ${waiting.name}.`
                : `Enter the code ${waiting.name} shows on its screen.`}
            </DialogDescription>
          </DialogHeader>
          <div className="flex flex-col gap-2">
            <Label htmlFor="airplay-code">{password ? 'Password' : 'Code'}</Label>
            <Input
              id="airplay-code"
              autoFocus
              autoComplete="off"
              type={password ? 'password' : 'text'}
              inputMode={password ? undefined : 'numeric'}
              value={value}
              onChange={(e) => setValue(e.target.value)}
              aria-invalid={error !== null}
            />
            {error !== null && (
              <p role="alert" className="text-xs text-destructive">
                {error}
              </p>
            )}
          </div>
          <DialogFooter>
            <Button type="button" variant="ghost" onClick={() => disconnect.mutate(waiting.target)}>
              Cancel
            </Button>
            <Button type="submit" disabled={!value.trim() || code.isPending}>
              {code.isPending && <Loader2 className="size-4 animate-spin" aria-hidden />}
              Connect
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
