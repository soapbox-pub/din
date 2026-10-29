import { useEffect, useRef, useState, type FormEvent } from 'react';
import { Loader2, ShieldCheck } from 'lucide-react';
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
import { getAskpassBridge, type AskpassRequest } from '@/lib/askpass';

interface AdminPasswordDialogProps {
  open: boolean;
  title: string;
  /** What it's for, in a line. */
  description?: string;
  /** The command it's for, shown as typed. */
  command?: string;
  confirmLabel?: string;
  /** Try the password: resolves an error to show, or null when it was taken. */
  onSubmit: (password: string) => Promise<string | null>;
  onCancel: () => void;
}

/**
 * The computer's password, asked for something to run as administrator:
 * sudo's requests (AdminPromptHost) and Settings turning the question off.
 * Key it per request, so each one starts with an empty field.
 */
export function AdminPasswordDialog({
  open,
  title,
  description,
  command,
  confirmLabel = 'Allow',
  onSubmit,
  onCancel,
}: AdminPasswordDialogProps) {
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [checking, setChecking] = useState(false);
  const input = useRef<HTMLInputElement>(null);

  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (!password || checking) return;
    setChecking(true);
    setError(null);
    onSubmit(password)
      .then((message) => {
        if (message === null) return;
        setError(message);
        setPassword('');
        input.current?.focus();
      })
      .catch((e: unknown) => setError(e instanceof Error ? e.message : String(e)))
      .finally(() => setChecking(false));
  };

  return (
    <Dialog open={open} onOpenChange={(next) => !next && !checking && onCancel()}>
      <DialogContent className="sm:max-w-md">
        <form onSubmit={submit} className="flex flex-col gap-4">
          <DialogHeader className="flex-row items-center gap-3 text-left">
            <span className="grid size-10 shrink-0 place-items-center rounded-full bg-primary/10 text-primary">
              <ShieldCheck className="size-5" aria-hidden />
            </span>
            <div className="min-w-0 space-y-1">
              <DialogTitle className="break-words">{title}</DialogTitle>
              {description && <DialogDescription>{description}</DialogDescription>}
            </div>
          </DialogHeader>

          {command && (
            <pre className="max-h-32 overflow-auto whitespace-pre-wrap break-all rounded-lg bg-foreground/5 px-3 py-2 font-mono text-sm text-foreground">
              {command}
            </pre>
          )}

          <div className="flex flex-col gap-2">
            <Label htmlFor="admin-password">Password</Label>
            <Input
              ref={input}
              id="admin-password"
              type="password"
              autoComplete="current-password"
              autoFocus
              value={password}
              aria-invalid={error ? true : undefined}
              aria-describedby={error ? 'admin-password-error' : undefined}
              onChange={(e) => {
                setPassword(e.target.value);
                setError(null);
              }}
            />
            {error && (
              <p id="admin-password-error" className="text-sm text-destructive" role="alert">
                {error}
              </p>
            )}
          </div>

          <DialogFooter>
            <Button type="button" variant="secondary" onClick={onCancel} disabled={checking}>
              Cancel
            </Button>
            <Button type="submit" disabled={!password || checking}>
              {checking && <Loader2 className="motion-safe:animate-spin" aria-hidden />}
              {confirmLabel}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

/**
 * Asks for the computer's password when sudo needs it and has no terminal to
 * ask on, as for the Assistant's commands (electron/askpass.mts). One request
 * at a time; a wrong password stays here, and only the right one goes to sudo.
 *
 * Renders nothing outside the Electron shell.
 */
export function AdminPromptHost() {
  const [queue, setQueue] = useState<AskpassRequest[]>([]);

  useEffect(() => {
    const bridge = getAskpassBridge();
    if (!bridge) return;
    const offRequest = bridge.onRequest((request) => setQueue((q) => [...q, request]));
    const offCancel = bridge.onCancel((requestId) =>
      setQueue((q) => q.filter((r) => r.requestId !== requestId)),
    );
    return () => {
      offRequest();
      offCancel();
    };
  }, []);

  const current = queue[0] ?? null;
  const done = (requestId: number) => setQueue((q) => q.filter((r) => r.requestId !== requestId));

  return (
    <AdminPasswordDialog
      key={current?.requestId}
      open={current !== null}
      title={`${current?.requester ?? ''} wants to run as administrator`}
      command={current?.command}
      onSubmit={async (password) => {
        if (!current) return null;
        const { ok } = (await getAskpassBridge()?.answer(current.requestId, password)) ?? { ok: true };
        if (!ok) return 'That password isn’t right.';
        done(current.requestId);
        return null;
      }}
      onCancel={() => {
        if (!current) return;
        void getAskpassBridge()?.answer(current.requestId, null).catch(() => {});
        done(current.requestId);
      }}
    />
  );
}
