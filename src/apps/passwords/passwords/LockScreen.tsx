import { useState, type FormEvent } from 'react';
import { LoaderCircle, LockKeyhole } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { cleanPasswordsError } from '@/lib/passwords';
import { useBridge } from './vault';

function Shell({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex flex-1 items-center justify-center overflow-y-auto p-8">
      <div className="w-full max-w-sm space-y-6 text-center motion-safe:animate-in motion-safe:fade-in motion-safe:zoom-in-95">
        <img src="/icons/apps/passwords.png" alt="" className="mx-auto size-24 drop-shadow-md" />
        {children}
      </div>
    </div>
  );
}

/** Asks for the vault's password. */
export function LockScreen() {
  const bridge = useBridge();
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (!bridge || !password || busy) return;
    setBusy(true);
    setError(null);
    bridge.unlock(password).then(
      () => setPassword(''),
      (err: unknown) => {
        setError(cleanPasswordsError(err));
        setBusy(false);
      },
    );
  };

  return (
    <Shell>
      <div className="space-y-2">
        <h1 className="flex items-center justify-center gap-2 text-2xl font-semibold tracking-tight">
          <LockKeyhole className="size-5 text-muted-foreground" aria-hidden />
          Passwords is locked
        </h1>
        <p className="text-sm text-muted-foreground">Enter your password to see your passwords and fill them in.</p>
      </div>
      <form onSubmit={submit} className="space-y-3">
        <Input
          type="password"
          autoComplete="current-password"
          autoFocus
          aria-label="Password"
          placeholder="Password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          aria-invalid={!!error}
          className="h-10 text-center"
        />
        {error && (
          <p role="alert" className="text-sm text-destructive">
            {error}
          </p>
        )}
        <Button type="submit" className="w-full" disabled={!password || busy}>
          {busy && <LoaderCircle className="size-4 animate-spin" aria-hidden />}
          Unlock
        </Button>
      </form>
    </Shell>
  );
}

/** Makes the vault: a password, twice. */
export function SetupScreen() {
  const bridge = useBridge();
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const mismatch = confirm.length > 0 && confirm !== password;

  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (!bridge || !password || mismatch || busy) return;
    setBusy(true);
    setError(null);
    bridge.create(password).catch((err: unknown) => {
      setError(cleanPasswordsError(err));
      setBusy(false);
    });
  };

  return (
    <Shell>
      <div className="space-y-2">
        <h1 className="text-3xl font-semibold tracking-tight">Passwords</h1>
        <p className="text-sm text-muted-foreground">
          Keep your logins, verification codes and notes in one place, and have the Web Browser fill them in for you.
        </p>
      </div>
      <form onSubmit={submit} className="space-y-4 text-left">
        <div className="space-y-2">
          <Label htmlFor="setup-password">Password</Label>
          <Input
            id="setup-password"
            type="password"
            autoComplete="new-password"
            autoFocus
            value={password}
            onChange={(e) => setPassword(e.target.value)}
          />
          <p className="text-xs text-muted-foreground">
            Use your computer's password: then Passwords unlocks when you sign in, and changes along with it in Settings.
          </p>
        </div>
        <div className="space-y-2">
          <Label htmlFor="setup-confirm">Confirm password</Label>
          <Input
            id="setup-confirm"
            type="password"
            autoComplete="new-password"
            value={confirm}
            onChange={(e) => setConfirm(e.target.value)}
            aria-invalid={mismatch}
          />
          {mismatch && <p className="text-xs text-destructive">The passwords don't match.</p>}
        </div>
        {error && (
          <p role="alert" className="text-sm text-destructive">
            {error}
          </p>
        )}
        <Button type="submit" className="w-full" disabled={!password || confirm !== password || busy}>
          {busy && <LoaderCircle className="size-4 animate-spin" aria-hidden />}
          Set Up Passwords
        </Button>
        <p className="text-center text-xs text-muted-foreground">
          Saved as a KeePass file, which apps like KeePassXC open too.
        </p>
      </form>
    </Shell>
  );
}
