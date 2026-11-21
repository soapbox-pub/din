import { useEffect, useRef, useState, type FormEvent } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { Check, Fingerprint, Loader2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { useWindowActions } from '@/contexts/WindowManagerContext';
import { useFingerprintStatus } from '@/hooks/useFingerprintStatus';
import type { AppComponentProps } from '@/lib/apps';
import { cleanLockError, FINGERPRINT_STATUS_KEY, FINGERS, getLockBridge, type FingerprintProgress } from '@/lib/lock';
import { cn } from '@/lib/utils';

const guidance: Record<string, string> = {
  'enroll-stage-passed': 'Lift your finger and try a slightly different part of it.',
  'enroll-finger-not-centered': 'Center your finger on the reader.',
  'enroll-swipe-too-short': 'Swipe all the way across the reader.',
  'enroll-too-fast': 'Move a little more slowly.',
  'enroll-remove-and-retry': 'Lift your finger before trying again.',
  'enroll-retry-scan': 'The reader missed that scan. Try again.',
};

export function FingerprintSetupWindow({ windowId }: AppComponentProps) {
  const bridge = getLockBridge();
  const { close } = useWindowActions();
  const client = useQueryClient();
  const { data, isError, isLoading } = useFingerprintStatus(bridge);
  const [picked, setPicked] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(false);
  const [error, setError] = useState('');
  const [progress, setProgress] = useState<FingerprintProgress | null>(null);
  const operation = useRef<string | null>(null);
  const choices = FINGERS.filter(({ id }) => !data?.fingers.includes(id));
  const finger = busy || done ? picked : choices.some(({ id }) => id === picked) ? picked : choices[0]?.id ?? '';
  const label = FINGERS.find(({ id }) => id === finger)?.label;
  const fraction = done ? 1 : progress ? progress.passed / progress.stages : 0;
  const title = done ? `${label} saved` : progress ? (progress.swipe ? 'Swipe your finger' : 'Touch the reader') : 'Add a fingerprint';
  const detail = done ? 'You can manage this fingerprint in Settings → Password.' : progress
    ? (progress.swipe && progress.status === 'enroll-stage-passed' ? 'Swipe again with a slightly different angle.' :
      guidance[progress.status] ?? `Use your ${label?.toLowerCase()} and repeat until the ring fills.`)
    : 'Set up a finger you can comfortably reach the reader with.';

  useEffect(() => {
    const stop = bridge?.onFingerprintProgress((id, update) => {
      if (operation.current === id) setProgress(update);
    });
    return () => {
      stop?.();
      const id = operation.current;
      operation.current = null;
      if (id) void bridge?.cancelFingerprint(id).catch(() => {});
    };
  }, [bridge]);

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (!bridge || !finger || !password || operation.current) return;
    const id = crypto.randomUUID();
    operation.current = id;
    setPicked(finger);
    setBusy(true);
    setError('');
    setProgress(null);
    setPassword('');
    try {
      await bridge.enrollFingerprint(id, finger, password);
      if (operation.current === id) setDone(true);
    } catch (error) {
      if (operation.current === id) {
        setError(cleanLockError(error));
        setProgress(null);
      }
    } finally {
      if (operation.current === id) {
        operation.current = null;
        setBusy(false);
      }
      void client.invalidateQueries({ queryKey: FINGERPRINT_STATUS_KEY });
    }
  }

  return (
    <form className="@container flex h-full flex-col gap-4 overflow-y-auto bg-background p-6" onSubmit={submit}>
      <div className="flex shrink-0 flex-col items-center gap-3 text-center">
        <div className={cn('relative grid size-32 place-items-center rounded-full bg-selected text-ink-accent clay',
          done && 'bg-pigment text-primary-foreground clay-pigment')}>
          <svg viewBox="0 0 128 128" className="absolute inset-0 size-full -rotate-90" aria-hidden>
            <circle cx="64" cy="64" r="58" fill="none" stroke="currentColor" strokeWidth="2" opacity=".2" />
            <circle cx="64" cy="64" r="58" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round"
              pathLength="100" strokeDasharray="100" strokeDashoffset={100 * (1 - fraction)}
              className="motion-safe:transition-[stroke-dashoffset] motion-safe:duration-300" />
          </svg>
          {done ? <Check className="size-12" aria-hidden /> : <Fingerprint className="size-14" strokeWidth={1.3} aria-hidden />}
        </div>
        <div aria-live="polite">
          <h1 className="font-heading text-2xl font-semibold">{title}</h1>
          <p className="mt-1 text-sm text-muted-foreground">{detail}</p>
        </div>
        {progress && !done && (
          <div role="progressbar" aria-label="Fingerprint scans" aria-valuemin={0} aria-valuemax={progress.stages}
            aria-valuenow={progress.passed} className="text-xs tabular-nums text-muted-foreground">
            {progress.passed} of {progress.stages} scans
          </div>
        )}
      </div>
      {!busy && !done && data?.reader && choices.length > 0 && (
        <div className="flex shrink-0 flex-col gap-3">
          <div className="grid gap-2">
            <Label htmlFor="fingerprint-finger">Finger</Label>
            <select id="fingerprint-finger" className="h-9 rounded-full border border-input bg-background px-3 text-sm focus-visible:ring-2 focus-visible:ring-ring/60"
              value={finger} onChange={(event) => setPicked(event.target.value)}>
              {choices.map(({ id, label }) => <option key={id} value={id}>{label}</option>)}
            </select>
          </div>
          <div className="grid gap-2">
            <Label htmlFor="fingerprint-password">Computer password</Label>
            <Input id="fingerprint-password" type="password" autoComplete="current-password"
              value={password} onChange={(event) => setPassword(event.target.value)} />
          </div>
          {!data.fingers.length && (
            <p className="text-xs text-muted-foreground">Adding your first fingerprint turns on fingerprint unlock for the lock screen.</p>
          )}
        </div>
      )}
      {!busy && !done && !error && (!data?.reader || !choices.length) && (
        <p role="status" className="text-center text-sm text-muted-foreground">
          {isLoading ? 'Checking for a reader…' : isError ? 'Couldn’t check the fingerprint reader.' :
            data?.reader ? 'All fingers are already set up.' : 'No supported fingerprint reader detected.'}
        </p>
      )}
      {error && <p role="alert" className="shrink-0 text-sm text-destructive">{error}</p>}
      <div className="mt-auto flex shrink-0 justify-end gap-2">
        <Button type="button" variant={done ? 'default' : 'secondary'} onClick={() => close(windowId)}>{done ? 'Done' : 'Cancel'}</Button>
        {!done && !progress && data?.reader && choices.length > 0 && (
          <Button type="submit" disabled={busy || !password}>
            {busy && <Loader2 className="motion-safe:animate-spin" aria-hidden />}
            {busy ? 'Starting…' : 'Start scanning'}
          </Button>
        )}
      </div>
    </form>
  );
}
