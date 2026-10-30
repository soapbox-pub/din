import { useState, type FormEvent } from 'react';
import { LoaderCircle, X } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Separator } from '@/components/ui/separator';
import { Switch } from '@/components/ui/switch';
import { cleanPasswordsError, type PasswordsState } from '@/lib/passwords';
import { useBridge } from './vault';

function ChangePassword() {
  const bridge = useBridge();
  const [old, setOld] = useState('');
  const [next, setNext] = useState('');
  const [confirm, setConfirm] = useState('');
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ error: boolean; text: string } | null>(null);
  const mismatch = confirm.length > 0 && confirm !== next;

  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (!bridge || busy || !old || !next || next !== confirm) return;
    setBusy(true);
    setMessage(null);
    bridge.changePassword(old, next).then(
      () => {
        setOld('');
        setNext('');
        setConfirm('');
        setMessage({ error: false, text: 'The password is changed.' });
        setBusy(false);
      },
      (err: unknown) => {
        setMessage({ error: true, text: cleanPasswordsError(err) });
        setBusy(false);
      },
    );
  };

  return (
    <form onSubmit={submit} className="space-y-3">
      <div>
        <h3 className="text-sm font-medium">Password</h3>
        <p className="text-xs text-muted-foreground">
          Passwords that share your computer’s password change with it, in Settings → Password.
        </p>
      </div>
      <Input type="password" autoComplete="current-password" aria-label="Current password" placeholder="Current password" value={old} onChange={(e) => setOld(e.target.value)} />
      <Input type="password" autoComplete="new-password" aria-label="New password" placeholder="New password" value={next} onChange={(e) => setNext(e.target.value)} />
      <Input
        type="password"
        autoComplete="new-password"
        aria-label="Confirm the new password"
        placeholder="Confirm new password"
        value={confirm}
        onChange={(e) => setConfirm(e.target.value)}
        aria-invalid={mismatch}
      />
      {message && (
        <p role={message.error ? 'alert' : 'status'} className={message.error ? 'text-sm text-destructive' : 'text-sm text-muted-foreground'}>
          {message.text}
        </p>
      )}
      <div className="flex justify-end">
        <Button type="submit" size="sm" disabled={busy || !old || !next || next !== confirm}>
          {busy && <LoaderCircle className="size-4 animate-spin" aria-hidden />}
          Change Password
        </Button>
      </div>
    </form>
  );
}

export function SettingsDialog({
  open,
  onOpenChange,
  state,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  state: PasswordsState;
}) {
  const bridge = useBridge();
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[85vh] overflow-y-auto sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Passwords Settings</DialogTitle>
          <DialogDescription>How Passwords unlocks, and where it keeps your passwords.</DialogDescription>
        </DialogHeader>
        <div className="space-y-5">
          <div className="flex items-start justify-between gap-4">
            <div className="space-y-0.5">
              <Label htmlFor="auto-unlock">Unlock when you sign in</Label>
              <p className="text-xs text-muted-foreground">
                Your computer’s password opens Passwords at login, through the login keyring. Off, it asks for its password each time.
              </p>
            </div>
            <Switch id="auto-unlock" checked={state.autoUnlock} onCheckedChange={(on) => void bridge?.setAutoUnlock(on)} />
          </div>
          <Separator />
          <ChangePassword />
          <Separator />
          <div className="space-y-1">
            <h3 className="text-sm font-medium">File</h3>
            <p className="break-all rounded-md bg-muted px-2 py-1.5 font-mono text-xs select-text">{state.file}</p>
            <p className="text-xs text-muted-foreground">A KeePass (KDBX 4) file. KeePassXC, Strongbox and KeePassDX open it with the same password.</p>
          </div>
          {state.never.length > 0 && (
            <>
              <Separator />
              <div className="space-y-2">
                <h3 className="text-sm font-medium">Never saved for</h3>
                <ul className="space-y-1">
                  {state.never.map((origin) => (
                    <li key={origin} className="flex items-center gap-2 rounded-md bg-muted/60 py-1 pr-1 pl-2 text-sm">
                      <span className="min-w-0 flex-1 truncate">{origin.replace(/^https?:\/\//, '')}</span>
                      <Button
                        variant="ghost"
                        size="icon"
                        className="size-6"
                        aria-label={`Offer to save passwords for ${origin} again`}
                        onClick={() => void bridge?.forgetNever(origin)}
                      >
                        <X className="size-3.5" />
                      </Button>
                    </li>
                  ))}
                </ul>
              </div>
            </>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}
