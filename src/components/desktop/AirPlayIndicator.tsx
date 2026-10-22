import { useEffect, useRef, useState, type FormEvent } from 'react';
import { Airplay, Loader2, Settings2, Tv } from 'lucide-react';
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
import { useToast } from '@/hooks/useToast';
import { useWindowActions } from '@/contexts/WindowManagerContext';
import { cleanAirPlayError, type AirPlayMode, type AirPlaySession } from '@/lib/airplay';
import { cn } from '@/lib/utils';

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
 * stop sharing with it. Shared by the menu bar's AirPlay panel and Settings →
 * Display. Looks for receivers when it mounts.
 */
export function AirPlayReceiverList({ className }: { className?: string }) {
  const { data } = useAirPlayState();
  const { connect, disconnect } = useAirPlayActions();
  const [mode, setMode] = useState<AirPlayMode>('mirror');
  const [error, setError] = useState<string | null>(null);
  useAirPlayScan();

  const receivers = data?.receivers ?? [];
  const sessions = data?.sessions ?? [];
  const extending = sessions.find((s) => s.extend);
  const failure = data?.failure;

  const start = (target: string) => {
    setError(null);
    connect.mutate(
      { target, mode },
      { onError: (e) => setError(cleanAirPlayError(e)) },
    );
  };

  return (
    <div className={cn('flex flex-col gap-3', className)}>
      <ToggleGroup
        type="single"
        variant="outline"
        size="sm"
        value={mode}
        onValueChange={(value) => value && setMode(value as AirPlayMode)}
        aria-label="How to share the screen"
        className="w-full"
      >
        <ToggleGroupItem value="mirror" className="flex-1">
          Mirror
        </ToggleGroupItem>
        <ToggleGroupItem
          value="extend"
          className="flex-1"
          disabled={!!extending}
          title={extending ? `${extending.name} is already a separate display` : undefined}
        >
          Separate display
        </ToggleGroupItem>
      </ToggleGroup>

      {receivers.length === 0 ? (
        <div className="flex items-center justify-center gap-2 rounded-lg border border-dashed border-border/60 px-3 py-6 text-sm text-muted-foreground">
          {data?.scanning && <Loader2 className="size-4 animate-spin" aria-hidden />}
          {data?.scanning ? 'Looking for AirPlay receivers…' : 'No AirPlay receivers found nearby.'}
        </div>
      ) : (
        <ul className="flex flex-col gap-1" aria-label="AirPlay receivers">
          {receivers.map((receiver) => {
            const session = sessions.find((s) => s.target === receiver.name);
            const pending =
              (connect.isPending && connect.variables?.target === receiver.name && !session) ||
              (disconnect.isPending && disconnect.variables === receiver.name);
            const active = session?.state === 'streaming';
            return (
              <li
                key={receiver.name}
                className={cn(
                  'flex items-center gap-3 rounded-lg px-2 py-1.5',
                  active && 'bg-primary/10',
                )}
              >
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
                    {session ? describeSession(session) : receiver.model || receiver.host}
                  </p>
                </div>
                {session ? (
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
                    disabled={pending || (mode === 'extend' && !!extending)}
                    onClick={() => start(receiver.name)}
                    aria-label={`${mode === 'extend' ? 'Extend the desktop to' : 'Mirror the screen to'} ${receiver.name}`}
                  >
                    {pending && <Loader2 className="size-4 animate-spin" aria-hidden />}
                    Share
                  </Button>
                )}
              </li>
            );
          })}
        </ul>
      )}

      {(error ?? failure) && (
        <p role="alert" className="text-xs text-destructive">
          {error ?? `${failure?.target}: ${failure?.message}`}
        </p>
      )}
    </div>
  );
}

/** Popover content for the menu bar's AirPlay item. */
export function AirPlayPopoverBody() {
  const { open } = useWindowActions();

  return (
    <div className="flex flex-col">
      <header className="flex items-center justify-between gap-2 border-b border-border/60 px-3 py-2">
        <h2 className="text-sm font-medium text-foreground">Screen sharing</h2>
        <Airplay className="size-4 text-muted-foreground" aria-hidden />
      </header>
      <AirPlayReceiverList className="p-3" />
      <footer className="border-t border-border/60 p-1.5">
        <PopoverClose asChild>
          <Button
            variant="ghost"
            size="sm"
            className="w-full justify-start text-muted-foreground hover:text-foreground"
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
        title: `Stopped sharing with ${failure.target}`,
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
      <DialogContent className="sm:max-w-sm">
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
