import { useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { Fingerprint, Plus, ShieldCheck, Trash2 } from 'lucide-react';
import { AdminPasswordDialog } from '@/components/desktop/AdminPrompt';
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent,
  AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { Button } from '@/components/ui/button';
import { ContextMenu, ContextMenuContent, ContextMenuItem, ContextMenuTrigger } from '@/components/ui/context-menu';
import { Skeleton } from '@/components/ui/skeleton';
import { Switch } from '@/components/ui/switch';
import { useWindowActions } from '@/contexts/WindowManagerContext';
import { useFingerprintStatus } from '@/hooks/useFingerprintStatus';
import { cleanLockError, FINGERPRINT_SETUP_APP_ID, FINGERPRINT_STATUS_KEY, FINGERS, type LockBridge } from '@/lib/lock';
import { cn } from '@/lib/utils';
import { settingsCard, settingsGroup, settingsTokenClass } from '@/shared/settingsChromeStyles';

export function FingerprintSettings({ bridge, requestEnable }: { bridge: LockBridge; requestEnable: boolean }) {
  const { data, isPending, isError, refetch } = useFingerprintStatus(bridge);
  const client = useQueryClient();
  const { open } = useWindowActions();
  const [busy, setBusy] = useState(false);
  const [authorizing, setAuthorizing] = useState(requestEnable);
  const [removing, setRemoving] = useState<(typeof FINGERS)[number] | null>(null);
  const [error, setError] = useState('');

  async function change(action: () => Promise<void>) {
    setBusy(true);
    setError('');
    try {
      await action();
    } catch (error) {
      setError(cleanLockError(error));
    } finally {
      await client.invalidateQueries({ queryKey: FINGERPRINT_STATUS_KEY });
      setBusy(false);
    }
  }

  const fingers = FINGERS.filter(({ id }) => data?.fingers.includes(id));
  const enabled = !!data?.enabled;
  return (
    <section className="flex flex-col gap-2" aria-labelledby="fingerprint-heading">
      <h2 id="fingerprint-heading" className="text-sm font-semibold">Fingerprint unlock</h2>
      <div className={cn(settingsCard, 'flex flex-wrap items-center gap-4 p-4')}>
        <span className="grid size-14 shrink-0 place-items-center rounded-2xl bg-selected text-ink-accent clay">
          <Fingerprint className="size-8" strokeWidth={1.4} aria-hidden />
        </span>
        <div className="min-w-0 flex-1 basis-36">
          <p className="text-sm font-semibold">Unlock with a fingerprint</p>
          {isPending ? <Skeleton className="mt-2 h-3 w-32" /> : (
            <p className="mt-1 text-xs text-muted-foreground">
              {isError ? 'Couldn’t check the fingerprint reader.' : data?.reader || 'No supported fingerprint reader detected.'}
            </p>
          )}
        </div>
        {isError ? <Button size="sm" variant="secondary" onClick={() => void refetch()}>Try again</Button> :
          (fingers.length > 0 || enabled) ? (
            <Switch aria-label="Unlock with a fingerprint" checked={enabled} disabled={busy}
              onCheckedChange={(on) => on ? setAuthorizing(true) : void change(() => bridge.setFingerprintUnlock(false))} />
          ) : data?.reader && (
            <Button size="sm" onClick={() => open(FINGERPRINT_SETUP_APP_ID)}>
              <Plus aria-hidden /> Add fingerprint
            </Button>
          )}
      </div>
      {fingers.length > 0 && (
        <div className={settingsGroup}>
          {fingers.map((finger) => {
            const { id, label } = finger;
            const remove = () => setRemoving(finger);
            return (
              <ContextMenu key={id}>
                <ContextMenuTrigger asChild>
                  <div className="flex items-center gap-3 px-4 py-2">
                    <span className={settingsTokenClass()}><Fingerprint aria-hidden /></span>
                    <span className="min-w-0 flex-1 text-sm">{label}</span>
                    <Button size="sm" variant="ghost" disabled={busy} aria-label={`Remove ${label.toLowerCase()}`} onClick={remove}>
                      <Trash2 aria-hidden />
                    </Button>
                  </div>
                </ContextMenuTrigger>
                <ContextMenuContent>
                  <ContextMenuItem variant="destructive" disabled={busy} onSelect={remove}>
                    <Trash2 aria-hidden /> Remove fingerprint
                  </ContextMenuItem>
                </ContextMenuContent>
              </ContextMenu>
            );
          })}
          {fingers.length < FINGERS.length && (
            <div className="px-3 py-2">
              <Button size="sm" variant="ghost" disabled={busy} onClick={() => open(FINGERPRINT_SETUP_APP_ID)}>
                <Plus aria-hidden /> Add fingerprint
              </Button>
            </div>
          )}
        </div>
      )}
      <p className="flex items-start gap-2 px-1 text-xs text-muted-foreground">
        <ShieldCheck className="size-4 shrink-0" aria-hidden />
        <span>Fingerprints stay on this computer and only unlock the screen. Keep using your password at startup and for administrator tasks.</span>
      </p>
      {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
      <AlertDialog open={!!removing} onOpenChange={(open) => !open && setRemoving(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Remove {removing?.label.toLowerCase()} fingerprint?</AlertDialogTitle>
            <AlertDialogDescription>
              {fingers.length === 1 ? 'This turns off fingerprint unlock. You can still unlock with your password.' :
                'This finger will no longer unlock the screen.'}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction variant="destructive" onClick={() => {
              if (removing) void change(() => bridge.removeFingerprint(removing.id));
            }}>Remove fingerprint</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
      {authorizing && !enabled && fingers.length > 0 && (
        <AdminPasswordDialog open title="Turn on fingerprint unlock?"
          description="Enter your computer password to allow saved fingerprints to unlock the screen."
          confirmLabel="Turn on" onCancel={() => setAuthorizing(false)}
          onSubmit={async (password) => {
            try {
              await bridge.setFingerprintUnlock(true, password);
              setAuthorizing(false);
              void client.invalidateQueries({ queryKey: FINGERPRINT_STATUS_KEY });
              return null;
            } catch (error) {
              return cleanLockError(error);
            }
          }} />
      )}
    </section>
  );
}
