import { useEffect, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Loader2, TriangleAlert } from 'lucide-react';
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
import { Progress } from '@/components/ui/progress';
import { useUpdateState } from '@/hooks/useUpdater';
import { getEraseBridge, type EraseStatus } from '@/lib/erase';
import { cleanInstallerError } from '@/lib/installer';
import { cleanLockError } from '@/lib/lock';
import { DEFAULT_UPDATE_BRANCH, DEFAULT_UPDATE_URL, getUpdaterBridge, type UpdateState } from '@/lib/updater';

/**
 * Settings → About's Erase All Data (window.dinos.erase): the computer back
 * to official DinOS as it was installed, over a restart (os/din-erase.sh).
 * `request` changes to open the dialog, as `din update erase` does.
 */
export function EraseSection({ request }: { request?: unknown }) {
  const bridge = getEraseBridge();
  const status = useQuery({
    queryKey: ['erase', 'status'],
    queryFn: () => bridge?.status() ?? Promise.reject(new Error('Erasing is for DinOS')),
    enabled: !!bridge,
  });
  const [open, setOpen] = useState(request !== undefined);
  const [attempt, setAttempt] = useState(0);

  const [lastRequest, setLastRequest] = useState(request);
  if (request !== lastRequest) {
    setLastRequest(request);
    if (request !== undefined) {
      setAttempt((n) => n + 1);
      setOpen(true);
    }
  }

  const data = status.data;
  if (!bridge || !data || data.reason === 'live' || data.reason === 'unsupported') return null;

  return (
    <>
      <h3 className="mt-2 text-sm font-medium text-muted-foreground">Erase This Computer</h3>
      <div className="flex items-center justify-between gap-4 rounded-xl border border-border/60 bg-background/40 p-4">
        <div className="min-w-0">
          <p className="text-sm font-medium text-foreground">Erase all data and settings</p>
          <p className="text-xs text-muted-foreground">
            {data.available
              ? 'Start over with DinOS as it was installed: your files, accounts, apps and settings are deleted.'
              : 'This DinOS was installed before your files were kept apart from the system. To start over, reinstall it from a USB stick and erase the disk.'}
          </p>
        </div>
        {data.available && (
          <Button
            variant="outline"
            size="sm"
            className="shrink-0 border-destructive/50 text-destructive hover:bg-destructive/10 hover:text-destructive"
            onClick={() => {
              setAttempt((n) => n + 1);
              setOpen(true);
            }}
          >
            Erase…
          </Button>
        )}
      </div>
      {data.available && (
        <EraseDialog
          key={attempt}
          open={open}
          status={data}
          onRefresh={() => void status.refetch()}
          onClose={() => setOpen(false)}
        />
      )}
    </>
  );
}

function EraseDialog({
  open,
  status,
  onRefresh,
  onClose,
}: {
  open: boolean;
  status: EraseStatus;
  onRefresh: () => void;
  onClose: () => void;
}) {
  const update = useUpdateState();
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [erasing, setErasing] = useState(false);
  const [building, setBuilding] = useState(false);
  const busy = update?.phase === 'checking' || update?.phase === 'updating';

  // A build of official DinOS finishing is what makes it the next boot's.
  const phase = update?.phase;
  const staged = update?.staged;
  useEffect(() => {
    if (phase !== 'checking' && phase !== 'updating') onRefresh();
    // eslint-disable-next-line react-hooks/exhaustive-deps -- refetch on the build's end only
  }, [phase, staged]);

  const buildOfficial = async () => {
    const updater = getUpdaterBridge();
    if (!updater) return;
    setBuilding(true);
    setError(null);
    try {
      if (update?.url !== DEFAULT_UPDATE_URL || update?.branch !== DEFAULT_UPDATE_BRANCH) {
        await updater.setSource(DEFAULT_UPDATE_URL, DEFAULT_UPDATE_BRANCH);
      }
      await updater.replace();
    } catch (e) {
      setError(cleanInstallerError(e));
    } finally {
      setBuilding(false);
    }
  };

  const erase = () => {
    const bridge = getEraseBridge();
    if (!bridge) return;
    setErasing(true);
    setError(null);
    bridge
      .start(status.password ? password : undefined)
      .catch((e: unknown) => {
        setErasing(false);
        setPassword('');
        setError(cleanLockError(e));
      });
  };

  const ready = status.official && !busy && !erasing && (!status.password || password.length > 0);

  return (
    <Dialog open={open} onOpenChange={(next) => !next && !erasing && onClose()}>
      <DialogContent className="sm:max-w-lg">
        <form
          className="flex flex-col gap-4"
          onSubmit={(e) => {
            e.preventDefault();
            if (ready) erase();
          }}
        >
          <DialogHeader className="flex-row items-center gap-3 text-left">
            <span className="grid size-10 shrink-0 place-items-center rounded-full bg-destructive/10 text-destructive">
              <TriangleAlert className="size-5" aria-hidden />
            </span>
            <div className="min-w-0 space-y-1">
              <DialogTitle>Erase all data and settings?</DialogTitle>
              <DialogDescription>
                Everything on this computer is deleted: your files, apps, accounts, saved Wi-Fi
                networks and settings. DinOS stays, as it was installed.
              </DialogDescription>
            </div>
          </DialogHeader>

          <ul className="flex list-disc flex-col gap-2 pl-5 text-sm text-muted-foreground">
            <li>
              Your Nostr account isn’t deleted, since it lives on relays, but its key on this
              computer is. Make sure you have a copy of it, or you can’t sign in again.
            </li>
            <li>
              {status.encrypted
                ? 'The computer restarts and asks for its password one last time. Then it starts like new, and asks you to choose a new password.'
                : 'The computer restarts, and starts like new.'}
            </li>
            <li>
              Deleted files aren’t overwritten. Before you give the computer away, reinstalling
              DinOS from a USB stick and erasing the disk is surest.
            </li>
          </ul>

          {!status.official && (
            <OfficialNotice update={update} building={building || busy} onBuild={() => void buildOfficial()} />
          )}

          {status.password && (
            <div className="flex flex-col gap-2">
              <Label htmlFor="erase-password">Password</Label>
              <Input
                id="erase-password"
                type="password"
                autoComplete="current-password"
                autoFocus={status.official}
                value={password}
                disabled={erasing}
                aria-invalid={error ? true : undefined}
                aria-describedby={error ? 'erase-error' : undefined}
                onChange={(e) => {
                  setPassword(e.target.value);
                  setError(null);
                }}
              />
            </div>
          )}

          {error && (
            <p id="erase-error" className="text-sm text-destructive" role="alert">
              {error}
            </p>
          )}

          <DialogFooter>
            <Button type="button" variant="secondary" onClick={onClose} disabled={erasing}>
              Cancel
            </Button>
            <Button type="submit" variant="destructive" disabled={!ready}>
              {erasing && <Loader2 className="motion-safe:animate-spin" aria-hidden />}
              {erasing ? 'Restarting…' : 'Erase and Restart'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

/**
 * Why official DinOS comes first: a system with the user's changes, or
 * from another repository, is built from what erasing deletes (~/DinOS),
 * or from a source the next owner didn't choose.
 */
function OfficialNotice({
  update,
  building,
  onBuild,
}: {
  update: UpdateState | null;
  building: boolean;
  onBuild: () => void;
}) {
  const updating = update?.phase === 'updating';
  return (
    <div className="flex flex-col gap-3 rounded-xl border border-amber-500/40 bg-amber-500/10 p-4">
      <p className="text-sm text-foreground">
        This computer runs DinOS with changes of yours, or from another repository. Erasing it goes
        back to official DinOS, which is built first. That can take a while; keep the computer
        plugged in.
      </p>
      {updating ? (
        <div className="flex flex-col gap-2" role="status">
          <p className="text-xs text-muted-foreground">Building official DinOS… {update.percent}%</p>
          <Progress value={update.percent} aria-label="Building official DinOS" />
        </div>
      ) : (
        <>
          {update?.phase === 'failed' && update.error && (
            <p className="text-xs text-destructive">{update.error}</p>
          )}
          <div>
            <Button type="button" size="sm" variant="outline" disabled={building} onClick={onBuild}>
              {building && <Loader2 className="motion-safe:animate-spin" aria-hidden />}
              Build Official DinOS
            </Button>
          </div>
        </>
      )}
    </div>
  );
}
