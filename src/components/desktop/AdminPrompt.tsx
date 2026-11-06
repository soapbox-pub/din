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
import { getPolkitBridge, type PolkitRequest } from '@/lib/polkit';
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
          <DialogHeader className="flex-row items-center gap-3 pr-6 text-left">
            <span className="grid size-10 shrink-0 place-items-center rounded-full bg-primary/10 text-primary">
              <ShieldCheck className="size-5" aria-hidden />
            </span>
            <div className="min-w-0 space-y-1">
              <DialogTitle className="wrap-anywhere">{title}</DialogTitle>
              {description && <DialogDescription className="wrap-anywhere">{description}</DialogDescription>}
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

/** A request in words, for one of Din's own commands: "Update Din?" */
function describedTitle(action: string): string {
  return `${action.charAt(0).toUpperCase()}${action.slice(1)}?`;
}

/** A command to allow to run as administrator, or deny, with a click. */
function ApprovalDialog({
  open,
  title,
  description = 'Only allow commands you expect.',
  command,
  onAnswer,
}: {
  open: boolean;
  title: string;
  description?: string;
  command?: string;
  onAnswer: (allow: boolean) => void;
}) {
  return (
    <Dialog open={open} onOpenChange={(next) => !next && onAnswer(false)}>
      <DialogContent className="sm:max-w-md">
        <div className="flex flex-col gap-4">
          <DialogHeader className="flex-row items-center gap-3 pr-6 text-left">
            <span className="grid size-10 shrink-0 place-items-center rounded-full bg-primary/10 text-primary">
              <ShieldCheck className="size-5" aria-hidden />
            </span>
            <div className="min-w-0 space-y-1">
              <DialogTitle className="wrap-anywhere">{title}</DialogTitle>
              <DialogDescription className="wrap-anywhere">{description}</DialogDescription>
            </div>
          </DialogHeader>

          {command && (
            <pre className="max-h-32 overflow-auto whitespace-pre-wrap break-all rounded-lg bg-foreground/5 px-3 py-2 font-mono text-sm text-foreground">
              {command}
            </pre>
          )}

          <DialogFooter>
            <Button type="button" variant="secondary" onClick={() => onAnswer(false)}>
              Deny
            </Button>
            <Button type="button" onClick={() => onAnswer(true)}>
              Allow
            </Button>
          </DialogFooter>
        </div>
      </DialogContent>
    </Dialog>
  );
}

/**
 * Asks to approve what sudo runs (electron/askpass.mts), and for the
 * computer's password when sudo needs it and has no terminal to ask on, for
 * programs other than the Assistant, which asks in its conversation. Each
 * request is a notification first, so nothing takes the keyboard while the
 * user is typing elsewhere; an approval can be answered right on it, and
 * clicking it opens the dialog. One Din asks itself, because the user just
 * clicked to install something, opens the dialog at once. A wrong password stays there, and only the
 * right one goes to sudo.
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
      if (request.direct) setOpenId(request.requestId);
      shown.set(
        request.requestId,
        notify({
          source: { name: 'Din', icon: ShieldCheck },
          title: request.action
            ? describedTitle(request.action)
            : request.approve
              ? `Allow ${request.requester} to run this as administrator?`
              : `${request.requester} needs your password`,
          body: request.detail ?? request.command,
          urgency: 'critical',
          actions: request.approve
            ? [
                { id: 'allow', label: 'Allow' },
                { id: 'deny', label: 'Deny' },
              ]
            : undefined,
          replaceKey: `askpass:${request.requestId}`,
          onScreenOnly: request.approve,
          onActivate: (action) => {
            if (request.approve && (action === 'allow' || action === 'deny')) {
              void bridge.approve(request.requestId, action === 'allow').catch(() => {});
            } else {
              setOpenId(request.requestId);
            }
          },
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

  if (current?.approve) {
    return (
      <ApprovalDialog
        key={current.requestId}
        open
        title={current.action ? describedTitle(current.action) : `${current.requester} wants to run as administrator`}
        description={current.detail ?? undefined}
        command={current.action ? undefined : current.command}
        onAnswer={(allow) => {
          void getAskpassBridge()?.approve(current.requestId, allow).catch(() => {});
          done(current.requestId);
        }}
      />
    );
  }

  return (
    <AdminPasswordDialog
      key={current?.requestId}
      open={current !== null}
      title={current?.action ? describedTitle(current.action) : `${current?.requester ?? ''} wants to run as administrator`}
      description={current?.detail ?? undefined}
      command={current?.action ? undefined : current?.command}
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

/** What a polkit request says it's for, with whose password when it isn't the user's. */
function polkitDescription(request: PolkitRequest): string | undefined {
  const forUser = request.user ? `Enter the password for ${request.user}.` : '';
  return [request.message, forUser].filter(Boolean).join(' ') || undefined;
}

/**
 * Asks for the computer's password when a program asks polkit for something
 * that needs it, as pkexec does (electron/polkit-agent.mts). As with sudo's
 * requests (AdminPromptHost), each is a notification first, and clicking it
 * opens the dialog. A wrong password stays there; polkit checks it, and
 * only the right one lets the program go on.
 *
 * Renders nothing outside the Electron shell.
 */
export function PolkitPromptHost() {
  const [requests, setRequests] = useState<PolkitRequest[]>([]);
  const [openId, setOpenId] = useState<number | null>(null);
  const notifications = useRef(new Map<number, string>());

  useEffect(() => {
    const bridge = getPolkitBridge();
    if (!bridge) return;
    const shown = notifications.current;
    const offRequest = bridge.onRequest((request) => {
      setRequests((q) => [...q, request]);
      shown.set(
        request.requestId,
        notify({
          source: { name: 'Din', icon: ShieldCheck },
          title: `${request.requester} needs your password`,
          body: request.message,
          urgency: 'critical',
          replaceKey: `polkit:${request.requestId}`,
          onActivate: () => setOpenId(request.requestId),
        }),
      );
    });
    const offCancel = bridge.onCancel((requestId) => {
      setRequests((q) => q.filter((r) => r.requestId !== requestId));
      setOpenId((open) => (open === requestId ? null : open));
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
      title={`${current?.requester ?? ''} wants to make changes as administrator`}
      description={current ? polkitDescription(current) : undefined}
      onSubmit={async (password) => {
        if (!current) return null;
        const { ok } = (await getPolkitBridge()?.answer(current.requestId, password)) ?? { ok: true };
        if (!ok) return 'That password isn’t right.';
        done(current.requestId);
        return null;
      }}
      onCancel={() => {
        if (!current) return;
        void getPolkitBridge()?.answer(current.requestId, null).catch(() => {});
        done(current.requestId);
      }}
    />
  );
}
