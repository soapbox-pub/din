import { useEffect, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { FolderOpen, KeyRound, Laptop, Loader2, Lock, SlidersHorizontal, Wifi, type LucideIcon } from 'lucide-react';
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
import { Progress } from '@/components/ui/progress';
import { useUpdateState } from '@/hooks/useUpdater';
import { getEraseBridge, type EraseStatus } from '@/lib/erase';
import { cleanInstallerError } from '@/lib/installer';
import { cleanLockError } from '@/lib/lock';
import { DEFAULT_UPDATE_BRANCH, DEFAULT_UPDATE_URL, getUpdaterBridge, type UpdateState } from '@/lib/updater';

/**
 * Settings → About's Erase All Content and Settings (window.dinos.erase):
 * the computer back to official DinOS as it was installed, over a restart
 * (os/din-erase.sh). `request` changes to open the dialog, as
 * `din update erase` does.
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
          <p className="text-sm font-medium text-foreground">Erase All Content and Settings</p>
          <p className="text-xs text-muted-foreground">
            {data.available
              ? 'Return this computer to how DinOS came.'
              : 'This DinOS was installed before your files were kept apart from the system. To start over, reinstall it from a USB stick and erase the disk.'}
          </p>
        </div>
        {data.available && (
          <Button
            variant="outline"
            size="sm"
            className="shrink-0"
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

/** What erasing removes, as the summary lists it. */
const REMOVED: { icon: LucideIcon; title: string; detail: string }[] = [
  { icon: FolderOpen, title: 'Files and apps', detail: 'Everything in your home folder' },
  { icon: KeyRound, title: 'Nostr keys', detail: 'Your account stays on relays. Keep a copy of your key.' },
  { icon: Wifi, title: 'Networks and devices', detail: 'Saved Wi-Fi and Bluetooth pairings' },
  { icon: SlidersHorizontal, title: 'Settings', detail: 'Back to how DinOS came' },
];

type Step = 'summary' | 'password' | 'confirm';

/**
 * Erasing in the steps a Mac's Erase Assistant takes: what goes, the
 * password, then one last question.
 */
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
  const [step, setStep] = useState<Step>('summary');
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
        setStep(status.password ? 'password' : 'summary');
      });
  };

  return (
    <Dialog open={open} onOpenChange={(next) => !next && !erasing && onClose()}>
      <DialogContent className={step === 'confirm' ? 'sm:max-w-sm' : 'sm:max-w-md'}>
        {step === 'summary' && (
          <div className="flex flex-col gap-6">
            <DialogHeader className="items-center gap-3 text-center sm:text-center">
              <span className="grid size-16 place-items-center rounded-2xl bg-gradient-to-b from-primary/25 to-primary/10 text-primary">
                <Laptop className="size-8" aria-hidden />
              </span>
              <DialogTitle className="text-xl">Erase All Content and Settings</DialogTitle>
              <DialogDescription>These will be removed, and DinOS reset to how it came.</DialogDescription>
            </DialogHeader>

            <ul className="divide-y divide-border/60 overflow-hidden rounded-xl border border-border/60 bg-foreground/[0.03]">
              {REMOVED.map(({ icon: Icon, title, detail }) => (
                <li key={title} className="flex items-center gap-3 px-4 py-3">
                  <span className="grid size-8 shrink-0 place-items-center rounded-lg bg-foreground/[0.07] text-foreground/80">
                    <Icon className="size-4" aria-hidden />
                  </span>
                  <span className="min-w-0">
                    <span className="block text-sm font-medium text-foreground">{title}</span>
                    <span className="block text-xs text-muted-foreground">{detail}</span>
                  </span>
                </li>
              ))}
            </ul>

            {!status.official && (
              <OfficialNotice update={update} building={building || busy} onBuild={() => void buildOfficial()} />
            )}

            {error && (
              <p className="text-center text-sm text-destructive" role="alert">
                {error}
              </p>
            )}

            <p className="text-center text-xs text-muted-foreground">
              Giving it away? Reinstalling from a USB stick erases the disk completely.
            </p>

            <DialogFooter>
              <Button type="button" variant="secondary" onClick={onClose}>
                Cancel
              </Button>
              <Button
                type="button"
                disabled={!status.official || busy}
                onClick={() => {
                  setError(null);
                  setStep(status.password ? 'password' : 'confirm');
                }}
              >
                Continue
              </Button>
            </DialogFooter>
          </div>
        )}

        {step === 'password' && (
          <form
            className="flex flex-col gap-6"
            onSubmit={(e) => {
              e.preventDefault();
              if (!password) return;
              setError(null);
              setStep('confirm');
            }}
          >
            <DialogHeader className="items-center gap-3 text-center sm:text-center">
              <span className="grid size-16 place-items-center rounded-2xl bg-foreground/[0.07] text-foreground/80">
                <Lock className="size-8" aria-hidden />
              </span>
              <DialogTitle className="text-xl">Enter Your Password</DialogTitle>
              <DialogDescription>The one you type when the computer starts.</DialogDescription>
            </DialogHeader>
            <div className="flex flex-col gap-2">
              <Input
                type="password"
                autoComplete="current-password"
                autoFocus
                placeholder="Password"
                aria-label="Password"
                value={password}
                aria-invalid={error ? true : undefined}
                aria-describedby={error ? 'erase-error' : undefined}
                onChange={(e) => {
                  setPassword(e.target.value);
                  setError(null);
                }}
              />
              {error && (
                <p id="erase-error" className="text-sm text-destructive" role="alert">
                  {error}
                </p>
              )}
            </div>
            <DialogFooter>
              <Button type="button" variant="secondary" onClick={() => setStep('summary')}>
                Back
              </Button>
              <Button type="submit" disabled={!password}>
                Continue
              </Button>
            </DialogFooter>
          </form>
        )}

        {step === 'confirm' && (
          <div className="flex flex-col gap-6">
            <DialogHeader className="items-center gap-2 text-center sm:text-center">
              <DialogTitle>Erase this computer?</DialogTitle>
              <DialogDescription className="text-center">
                It restarts and starts like new. This can’t be undone.
              </DialogDescription>
            </DialogHeader>
            <DialogFooter className="sm:justify-center">
              <Button type="button" variant="secondary" disabled={erasing} onClick={onClose}>
                Cancel
              </Button>
              <Button type="button" variant="destructive" disabled={erasing} onClick={erase}>
                {erasing && <Loader2 className="motion-safe:animate-spin" aria-hidden />}
                {erasing ? 'Restarting…' : 'Erase'}
              </Button>
            </DialogFooter>
          </div>
        )}
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
      <div>
        <p className="text-sm font-medium text-foreground">Official DinOS first</p>
        <p className="text-xs text-muted-foreground">
          This computer runs a customized DinOS, which is erased with your files. Build official
          DinOS to continue. Keep the charger plugged in.
        </p>
      </div>
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
