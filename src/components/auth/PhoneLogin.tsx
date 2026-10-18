import { useCallback, useEffect, useRef, useState } from 'react';
import { Loader2, Smartphone } from 'lucide-react';
import { generateSecretKey, getPublicKey } from 'nostr-tools';
import { Button } from '@/components/ui/button';
import { useLoginActions } from '@/hooks/useLoginActions';
import {
  cleanBluetoothError,
  getBluetoothLoginBridge,
  openKeyPayload,
  type BluetoothLoginEvent,
} from '@/lib/bluetoothLogin';

type Phase =
  | { name: 'starting' }
  | { name: 'waiting' }
  | { name: 'connected' }
  | { name: 'code'; code: string }
  | { name: 'failed'; message: string };

interface PhoneLoginProps {
  /** The user is logged in. */
  onDone: () => void;
  onCancel: () => void;
}

/**
 * Receive the account key from a phone running Tenna, over Bluetooth.
 *
 * Each attempt makes a fresh ephemeral key; the phone encrypts the account
 * key to it once the user has checked that both screens show the same code.
 * See electron/bluetooth-login.mts for the handshake.
 */
export function PhoneLogin({ onDone, onCancel }: PhoneLoginProps) {
  const [phase, setPhase] = useState<Phase>({ name: 'starting' });
  // Bumped by "Try again" to start over with a new key.
  const [attempt, setAttempt] = useState(0);

  const login = useLoginActions();
  const loginRef = useRef(login);
  const onDoneRef = useRef(onDone);
  useEffect(() => {
    loginRef.current = login;
    onDoneRef.current = onDone;
  }, [login, onDone]);

  useEffect(() => {
    const bridge = getBluetoothLoginBridge();
    if (!bridge) return;

    const sk = generateSecretKey();
    let active = true;

    const onEvent = (event: BluetoothLoginEvent) => {
      if (!active) return;
      switch (event.type) {
        case 'waiting':
          return setPhase({ name: 'waiting' });
        case 'connected':
          return setPhase({ name: 'connected' });
        case 'code':
          return setPhase({ name: 'code', code: event.code });
        case 'ended':
          return setPhase({
            name: 'failed',
            message:
              event.reason === 'timeout'
                ? 'Stopped looking for your phone.'
                : (event.message ?? 'Something went wrong with Bluetooth.'),
          });
        case 'key':
          try {
            loginRef.current.nsec(openKeyPayload(sk, event));
            active = false;
            onDoneRef.current();
          } catch (error) {
            setPhase({ name: 'failed', message: cleanBluetoothError(error) });
          }
      }
    };

    const unsubscribe = bridge.onEvent(onEvent);
    bridge.start(getPublicKey(sk)).catch((error: unknown) => {
      if (active) setPhase({ name: 'failed', message: cleanBluetoothError(error) });
    });

    return () => {
      active = false;
      unsubscribe();
      void bridge.stop();
    };
  }, [attempt]);

  const retry = useCallback(() => {
    setPhase({ name: 'starting' });
    setAttempt((n) => n + 1);
  }, []);

  if (phase.name === 'failed') {
    return (
      <div className="flex flex-col items-center gap-4 py-4 text-center">
        <p role="alert" className="text-sm text-destructive">
          {phase.message}
        </p>
        <div className="flex gap-2">
          <Button variant="ghost" onClick={onCancel} className="rounded-full">
            Back
          </Button>
          <Button variant="outline" onClick={retry} className="rounded-full">
            Try again
          </Button>
        </div>
      </div>
    );
  }

  return (
    <div className="flex flex-col items-center gap-5 py-2 text-center" aria-live="polite">
      {phase.name === 'code' ? (
        <>
          <p className="text-sm text-muted-foreground">Check that your phone shows</p>
          <p className="font-mono text-4xl font-semibold tracking-widest tabular-nums">
            {phase.code.slice(0, 3)} {phase.code.slice(3)}
          </p>
          <p className="text-sm text-muted-foreground">
            If it does, approve on your phone. If it doesn't, cancel on both.
          </p>
        </>
      ) : (
        <>
          <div className="flex size-20 items-center justify-center rounded-full bg-primary/10">
            {phase.name === 'waiting' ? (
              <Smartphone className="size-9 text-primary motion-safe:animate-pulse" />
            ) : (
              <Loader2 className="size-9 animate-spin text-primary" />
            )}
          </div>
          <div className="space-y-1">
            <p className="font-medium">
              {phase.name === 'starting'
                ? 'Turning on Bluetooth…'
                : phase.name === 'connected'
                  ? 'Phone connected…'
                  : 'Waiting for your phone'}
            </p>
            {phase.name === 'waiting' && (
              <p className="text-sm text-muted-foreground">
                In Tenna, open Settings and choose <span className="font-medium">Log in on a computer</span>.
                Keep your phone close to this one.
              </p>
            )}
          </div>
        </>
      )}

      <button
        type="button"
        onClick={onCancel}
        className="text-sm font-medium text-primary underline-offset-4 hover:underline"
      >
        Cancel
      </button>
    </div>
  );
}
