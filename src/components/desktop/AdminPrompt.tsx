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
import { closeNotification, notify } from '@/lib/notificationCenter';

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
 * ask on (electron/askpass.mts), for programs other than the Assistant, which
 * asks in its conversation. Each request is a notification first, so nothing
 * takes the keyboard while the user is typing elsewhere; clicking it opens
 * the dialog. A wrong password stays there, and only the right one goes to
 * sudo.
 *
 * Renders nothing outside the Electron shell.
 */
export function AdminPromptHost() {
  const [requests, setRequests] = useState<AskpassRequest[]>([]);
  const [openId, setOpenId] = useState<number | null>(null);
  const notifications = useRef(new Map<number, string>());

  useEffect(() => {
    const bridge = getAskpassBridge();
    if (!bridge) return;
    const shown = notifications.current;
    const offRequest = bridge.onRequest((request) => {
      setRequests((q) => [...q, request]);
      shown.set(
        request.requestId,
        notify({
          source: { name: 'Din', icon: ShieldCheck },
          title: `${request.requester} needs your password`,
          body: request.command,
          urgency: 'critical',
          replaceKey: `askpass:${request.requestId}`,
          onActivate: () => setOpenId(request.requestId),
        }),
      );
    });
    const offCancel = bridge.onCancel((requestId) => {
      setRequests((q) => q.filter((r) => r.requestId !== requestId));
      const id = shown.get(requestId);
      if (id) closeNotification(id, 'closed');
      shown.delete(requestId);
    });
    return () => {
      offRequest();
      offCancel();
    };
  }, []);

  const current = requests.find((r) => r.requestId === openId) ?? null;
  const done = (requestId: number) => {
    setRequests((q) => q.filter((r) => r.requestId !== requestId));
    setOpenId(null);
    const id = notifications.current.get(requestId);
    if (id) closeNotification(id, 'closed');
    notifications.current.delete(requestId);
  };

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
