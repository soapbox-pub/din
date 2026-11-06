import { useState, type FormEvent } from 'react';
import { FileUp, LoaderCircle, X } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import { cleanPasswordsError, type PasswordsState } from '@/lib/passwords';
import { cn } from '@/lib/utils';
import { FormWindow, ToolButton } from '@/shared/appChrome';
import { settingsCard, settingsGroup } from '@/shared/settingsChromeStyles';
import { SettingsSubHeading } from '@/shared/settingsSection';
import { openPasswordsWindow, useBridge } from './vault';

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

/**
 * Passwords' settings, in a window of its own (opened with
 * `{ window: 'settings' }`): how it unlocks, its password, its file,
 * importing, and the sites it doesn't offer to save for.
 */
export function SettingsWindow({ state }: { state: PasswordsState }) {
  const bridge = useBridge();
  return (
    <FormWindow title="Passwords Settings" description="How Passwords unlocks, and where it keeps your passwords.">
      <div className={settingsGroup}>
        <div className="flex items-center justify-between gap-4 px-4 py-3">
          <div className="min-w-0">
            <Label htmlFor="auto-unlock" className="cursor-pointer text-sm">
              Unlock when you sign in
            </Label>
            <p className="text-xs text-muted-foreground">
              Your computer’s password opens Passwords at login, through the login keyring. Off, it asks for its password each time.
            </p>
          </div>
          <Switch id="auto-unlock" checked={state.autoUnlock} onCheckedChange={(on) => void bridge?.setAutoUnlock(on)} />
        </div>
        <div className="flex items-center justify-between gap-4 px-4 py-3">
          <div className="min-w-0">
            <p className="text-sm">Import</p>
            <p className="text-xs text-muted-foreground">
              From another KeePass file, Google Passwords, a browser, Apple Passwords, Bitwarden, 1Password and other apps’ exports.
            </p>
          </div>
          <Button variant="outline" size="sm" className="shrink-0" onClick={() => openPasswordsWindow('import')}>
            <FileUp className="size-4.5" strokeWidth={1.75} aria-hidden />
            Import…
          </Button>
        </div>
      </div>

      <SettingsSubHeading>Password</SettingsSubHeading>
      <div className={cn(settingsCard, 'px-4 py-3')}>
        <ChangePassword />
      </div>

      <SettingsSubHeading>File</SettingsSubHeading>
      <div className={cn(settingsCard, 'space-y-1 px-4 py-3')}>
        <p className="break-all font-mono text-xs select-text">{state.file}</p>
        <p className="text-xs text-muted-foreground">A KeePass (KDBX 4) file. KeePassXC, Strongbox and KeePassDX open it with the same password.</p>
      </div>

      {state.never.length > 0 && (
        <>
          <SettingsSubHeading>Never saved for</SettingsSubHeading>
          <ul className={settingsGroup}>
            {state.never.map((origin) => (
              <li key={origin} className="flex items-center gap-2 py-1.5 pr-2 pl-4 text-sm">
                <span className="min-w-0 flex-1 truncate">{origin.replace(/^https?:\/\//, '')}</span>
                <ToolButton size="sm" label={`Offer to save passwords for ${origin} again`} onClick={() => void bridge?.forgetNever(origin)}>
                  <X className="size-4" strokeWidth={1.75} />
                </ToolButton>
              </li>
            ))}
          </ul>
        </>
      )}
    </FormWindow>
  );
}
