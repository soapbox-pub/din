import { useEffect, useRef, useState, type ReactNode } from 'react';
import { History, Loader2, LogIn, MonitorCog, RotateCw, Star, Trash2, Undo2 } from 'lucide-react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { Label } from '@/components/ui/label';
import { cleanInstallerError } from '@/lib/installer';
import { shortRevision } from '@/lib/updater';
import {
  getSessionBridge,
  type LoginSessionAction,
  type LoginSessionRelease,
  type LoginSessionStatus,
} from '@/lib/session';

/** How the login screen names some sessions people come from. */
const SESSION_NAMES: Record<string, string> = {
  gnome: 'GNOME',
  'gnome-wayland': 'GNOME',
  'gnome-xorg': 'GNOME on Xorg',
  ubuntu: 'Ubuntu',
  'ubuntu-wayland': 'Ubuntu',
  'ubuntu-xorg': 'Ubuntu on Xorg',
  pop: 'Pop!_OS',
  cosmic: 'COSMIC',
  pantheon: 'Pantheon',
  plasma: 'Plasma',
  plasmawayland: 'Plasma',
  plasmax11: 'Plasma (X11)',
  xfce: 'Xfce',
  cinnamon: 'Cinnamon',
  mate: 'MATE',
  budgie: 'Budgie',
};

function sessionName(id: string | null | undefined): string {
  if (!id) return 'your previous desktop';
  return SESSION_NAMES[id.toLowerCase()] ?? id.charAt(0).toUpperCase() + id.slice(1);
}

function releaseLabel(release: LoginSessionRelease | null | undefined): string {
  if (!release) return '';
  const commit = release.commit ? `commit ${shortRevision(release.commit)}${release.dirty ? ' with changes' : ''}` : release.id;
  const built = release.built ? `, built ${new Date(release.built).toLocaleString()}` : '';
  return `${commit}${built}`;
}

/** The checkout has something the login session's build doesn't. */
function hasNewer(status: LoginSessionStatus): boolean {
  const { checkout, current } = status;
  if (!checkout || !current) return false;
  return checkout.dirty || checkout.commit !== current.commit;
}

type Confirm = 'return' | 'uninstall' | null;

/** The Login screen heading over a note with nothing to press. */
function SystemSessionCard({ title, children }: { title: string; children: ReactNode }) {
  return (
    <>
      <h3 className="mt-2 text-sm font-medium text-muted-foreground">Login screen</h3>
      <div className="flex items-start gap-3 rounded-xl border border-border/60 p-4">
        <LogIn className="mt-0.5 size-5 shrink-0 text-muted-foreground" aria-hidden />
        <div className="min-w-0">
          <p className="text-sm font-medium text-foreground">{title}</p>
          <p className="text-xs text-muted-foreground">{children}</p>
        </div>
      </div>
    </>
  );
}

/**
 * Settings → About, on a Linux that isn't DinOS: puts Din on the login
 * screen beside the desktop that's there (scripts/session.mjs, through
 * window.dinos.session), from `npm run dev`; and from that session, updates
 * it from the checkout, rolls it back, goes back to the old desktop, or
 * takes Din off again. On NixOS it says the system's configuration does
 * that instead (os/desktop-module.nix), and in that session that it did.
 * Nothing shows anywhere else Din can't be a session.
 */
export function LoginSessionSection() {
  const bridge = getSessionBridge();
  const queryClient = useQueryClient();
  const { data: status } = useQuery({
    queryKey: ['session', 'status'],
    queryFn: (): Promise<LoginSessionStatus> => bridge?.status() ?? Promise.resolve({ available: false }),
    enabled: !!bridge?.status,
    staleTime: 30_000,
  });
  const [action, setAction] = useState<LoginSessionAction | null>(null);
  const [lines, setLines] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);
  const [makeDefault, setMakeDefault] = useState(true);
  const [confirm, setConfirm] = useState<Confirm>(null);
  const logRef = useRef<HTMLPreElement>(null);
  const linesRef = useRef<string[]>([]);

  useEffect(() => {
    if (!bridge?.onOutput) return;
    return bridge.onOutput((line) => {
      linesRef.current = [...linesRef.current.slice(-300), line];
      setLines(linesRef.current);
    });
  }, [bridge]);

  useEffect(() => {
    const log = logRef.current;
    if (log) log.scrollTop = log.scrollHeight;
  }, [lines]);

  // NixOS: the system's configuration puts Din on the login screen
  // (os/desktop-module.nix), not this.
  if (status?.system) {
    return (
      <SystemSessionCard title="Din is your desktop">
        It’s on the login screen from this computer’s NixOS configuration
        (<code className="font-mono">services.desktopManager.din</code>), and updates along with the system.
      </SystemSessionCard>
    );
  }
  if (status?.available && !status.supported && status.nixos) {
    return (
      <SystemSessionCard title="Use Din as your desktop">
        On NixOS, Din goes on the login screen from the system’s configuration: add the{' '}
        <code className="font-mono">nixosModules.din</code> of Din’s <code className="font-mono">os</code> flake to
        it and set <code className="font-mono">services.desktopManager.din.enable = true</code> (the README’s “Din
        on NixOS”).
      </SystemSessionCard>
    );
  }

  if (!bridge?.status || !status?.available || !status.supported) return null;

  const busy = action !== null || !!status.busy;
  const running = !!status.running;
  const isDefault = status.defaultSession === 'din';
  const previous = sessionName(status.previousSession);
  const checkout = status.checkout;

  const perform = async (next: LoginSessionAction, options: { makeDefault?: boolean; then?: () => void } = {}) => {
    setAction(next);
    linesRef.current = [];
    setLines([]);
    setError(null);
    setDone(null);
    try {
      await bridge.run(next, options.makeDefault);
      setDone(linesRef.current.filter((line) => line.trim()).pop() ?? null);
      options.then?.();
    } catch (e) {
      setError(cleanInstallerError(e));
    } finally {
      setAction(null);
      await queryClient.invalidateQueries({ queryKey: ['session', 'status'] });
    }
  };

  return (
    <>
      <h3 className="mt-2 text-sm font-medium text-muted-foreground">Login screen</h3>

      {!status.installed ? (
        <div className="flex flex-col gap-3 rounded-xl border border-border/60 p-4">
          <div className="flex items-start gap-3">
            <MonitorCog className="mt-0.5 size-5 shrink-0 text-muted-foreground" aria-hidden />
            <div className="min-w-0">
              <p className="text-sm font-medium text-foreground">Use Din as your desktop</p>
              <p className="text-xs text-muted-foreground">
                Add Din to your login screen, next to the desktop you have now. It runs a build of this
                checkout, so editing it doesn’t change what you log in to until you update. You can go back at
                any time.
              </p>
            </div>
          </div>
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div className="flex items-center gap-2">
              <Checkbox
                id="login-session-default"
                checked={makeDefault}
                disabled={busy}
                onCheckedChange={(checked) => setMakeDefault(checked === true)}
              />
              <Label htmlFor="login-session-default" className="cursor-pointer text-sm">
                Log in to Din by default
              </Label>
            </div>
            <Button size="sm" disabled={busy} onClick={() => void perform('install', { makeDefault })}>
              {action === 'install' && <Loader2 className="size-4 motion-safe:animate-spin" aria-hidden />}
              {action === 'install' ? 'Installing…' : 'Install'}
            </Button>
          </div>
          <p className="text-xs text-muted-foreground">
            The first build compiles Din’s compositor, which takes a few minutes. You’ll be asked for your
            password once.
          </p>
        </div>
      ) : (
        <div className="flex flex-col gap-3 rounded-xl border border-border/60 p-4">
          <div className="flex items-start gap-3">
            <LogIn className="mt-0.5 size-5 shrink-0 text-muted-foreground" aria-hidden />
            <div className="min-w-0 flex-1">
              <p className="text-sm font-medium text-foreground">
                {running ? 'Din is your desktop' : 'Din is on your login screen'}
              </p>
              <p className="text-xs text-muted-foreground">
                {isDefault
                  ? 'You log in to Din by default.'
                  : `You log in to ${sessionName(status.defaultSession)} by default; pick Din from the login screen’s menu.`}
              </p>
              <p className="mt-1 truncate text-xs text-muted-foreground" title={status.current?.id}>
                Logging in runs {releaseLabel(status.current)}.
              </p>
            </div>
          </div>

          {checkout && hasNewer(status) && (
            <div className="flex items-center justify-between gap-4 rounded-md border border-primary/40 bg-primary/10 p-3">
              <p className="min-w-0 text-xs text-foreground">
                The checkout has changes since: commit{' '}
                <span className="font-mono">{shortRevision(checkout.commit)}</span>
                {checkout.dirty && ', with uncommitted edits'}.
              </p>
              <Button size="sm" disabled={busy} onClick={() => void perform('update')}>
                {action === 'update' ? (
                  <Loader2 className="size-4 motion-safe:animate-spin" aria-hidden />
                ) : (
                  <RotateCw className="size-4" aria-hidden />
                )}
                Update
              </Button>
            </div>
          )}
          {!status.systemFilesCurrent && !hasNewer(status) && (
            <div className="flex items-center justify-between gap-4 rounded-md border bg-muted/20 p-3">
              <p className="min-w-0 text-xs text-muted-foreground">The login screen’s files are out of date.</p>
              <Button size="sm" variant="outline" disabled={busy} onClick={() => void perform('update')}>
                Update
              </Button>
            </div>
          )}

          <div className="flex flex-wrap gap-2">
            {status.previous && (
              <Button size="sm" variant="outline" disabled={busy} onClick={() => void perform('rollback')}>
                <History className="size-4" aria-hidden />
                Roll back
              </Button>
            )}
            {isDefault ? (
              running ? (
                <Button size="sm" variant="outline" disabled={busy} onClick={() => setConfirm('return')}>
                  <Undo2 className="size-4" aria-hidden />
                  Return to {previous}
                </Button>
              ) : (
                <Button size="sm" variant="outline" disabled={busy} onClick={() => void perform('restore')}>
                  <Undo2 className="size-4" aria-hidden />
                  Log in to {previous} by default
                </Button>
              )
            ) : (
              <Button size="sm" variant="outline" disabled={busy} onClick={() => void perform('default')}>
                <Star className="size-4" aria-hidden />
                Log in to Din by default
              </Button>
            )}
            <Button
              size="sm"
              variant="ghost"
              className="text-destructive hover:text-destructive"
              disabled={busy}
              onClick={() => setConfirm('uninstall')}
            >
              <Trash2 className="size-4" aria-hidden />
              Remove from login screen…
            </Button>
          </div>
          {status.previous && (
            <p className="text-xs text-muted-foreground">Roll back goes to {releaseLabel(status.previous)}.</p>
          )}
        </div>
      )}

      {(action || lines.length > 0) && (
        <pre
          ref={logRef}
          aria-live="polite"
          aria-label="What the installer printed"
          className="max-h-48 overflow-auto whitespace-pre-wrap rounded-md border bg-muted/30 p-3 font-mono text-xs text-muted-foreground"
        >
          {lines.join('\n') || 'Starting…'}
        </pre>
      )}
      {done && !error && <p className="text-sm text-foreground">{done}</p>}
      {error && <p className="whitespace-pre-line text-sm text-destructive">{error}</p>}

      <AlertDialog open={confirm !== null} onOpenChange={(open) => !open && setConfirm(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {confirm === 'return' ? `Return to ${previous}?` : 'Remove Din from the login screen?'}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {confirm === 'return'
                ? `You’ll log out, and log in to ${previous} from now on. Din stays on the login screen’s menu. Open apps will close.`
                : running
                  ? `Din’s builds are deleted once you log out, and you’ll log in to ${previous}. Your accounts, files and settings stay, and npm run dev still works.`
                  : `Din’s builds are deleted, and you’ll log in to ${previous}. Your accounts, files and settings stay.`}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              className={confirm === 'uninstall' ? 'bg-destructive text-destructive-foreground hover:bg-destructive/90' : undefined}
              onClick={() => {
                if (confirm === 'return') void perform('restore', { then: () => bridge.end() });
                else void perform('uninstall');
              }}
            >
              {confirm === 'return' ? 'Log out' : 'Remove'}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}
