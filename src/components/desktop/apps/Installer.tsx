import { useState } from 'react';
import type { ReactNode } from 'react';
import {
  ArrowLeft,
  Check,
  CircleAlert,
  HardDrive,
  Loader2,
  Lock,
  RotateCw,
  Usb,
} from 'lucide-react';
import type { AppComponentProps } from '@/lib/apps';
import { cn } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Progress } from '@/components/ui/progress';
import { Skeleton } from '@/components/ui/skeleton';
import { Switch } from '@/components/ui/switch';
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
import { useInstallerStatus, useInstallState } from '@/hooks/useInstaller';
import {
  cleanInstallerError,
  formatDiskSize,
  getInstallerBridge,
  passphraseProblem,
  type InstallMode,
  type InstallState,
  type InstallStep,
  type InstallerDisk,
} from '@/lib/installer';

/** A disk's name for people: its model, else its device. */
function diskName(disk: InstallerDisk): string {
  return disk.model || disk.path.replace('/dev/', '');
}

/** What's on a disk now, in a line. */
function describeContents(disk: InstallerDisk): string {
  if (disk.existingInstall) return 'DinOS is installed here';
  if (disk.partitions.length === 0) return 'Empty';
  const named = disk.partitions
    .map((p) => p.label || p.fsType)
    .filter((name) => name.length > 0);
  const unique = [...new Set(named)].slice(0, 3);
  const count = `${disk.partitions.length} partition${disk.partitions.length === 1 ? '' : 's'}`;
  return unique.length > 0 ? `${count}: ${unique.join(', ')}` : count;
}

/** Why a disk can't take an install, or null if it can. */
function diskProblem(disk: InstallerDisk, requiredBytes: number): string | null {
  if (disk.inUse) return 'In use';
  // A reinstall reuses the space DinOS already has.
  if (disk.sizeBytes < requiredBytes && !disk.existingInstall) {
    return `Too small, needs ${formatDiskSize(requiredBytes)}`;
  }
  return null;
}

/** Why installing alongside what's on a disk won't work, or null if it will. */
function alongsideProblem(disk: InstallerDisk, requiredBytes: number): string | null {
  if (disk.partitionTable !== 'gpt') {
    return 'This disk uses an older partition layout. Erasing it is the only option.';
  }
  if (disk.hasLinuxRoot) {
    return 'There is already a Linux system on this disk. Installing DinOS next to another Linux system isn’t supported yet.';
  }
  if (disk.largestFreeBytes < requiredBytes) {
    return `This needs ${formatDiskSize(requiredBytes)} of unpartitioned space, and the largest free stretch is ${formatDiskSize(disk.largestFreeBytes)}. In Windows, shrink its partition in Disk Management to make room, then come back.`;
  }
  return null;
}

/** Installs DinOS from a live USB boot onto this computer's own disk. */
export function Installer(_props: AppComponentProps) {
  const install = useInstallState();

  if (install && install.phase !== 'idle') {
    return <InstallProgress state={install} />;
  }
  return <InstallSetup />;
}

type Stage = 'welcome' | 'disk' | 'mode';

function InstallSetup() {
  const status = useInstallerStatus();
  const [stage, setStage] = useState<Stage>('welcome');
  const [diskPath, setDiskPath] = useState<string | null>(null);
  const [mode, setMode] = useState<InstallMode>('wipe');
  const [encrypt, setEncrypt] = useState(true);
  const [passphrase, setPassphrase] = useState('');
  const [repeat, setRepeat] = useState('');
  const [confirming, setConfirming] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (stage === 'welcome') {
    return (
      <Frame>
        <div className="flex flex-1 flex-col items-center justify-center gap-6 text-center">
          <div className="flex size-16 items-center justify-center rounded-2xl bg-primary/10 text-primary">
            <HardDrive className="size-8" aria-hidden />
          </div>
          <div className="max-w-md space-y-3">
            <h1 className="text-2xl font-semibold tracking-tight text-foreground">
              Install DinOS on this computer
            </h1>
            <p className="text-sm text-muted-foreground">
              You’re running DinOS from a USB stick. Installing copies it onto this
              computer’s own disk, so it starts faster and works without the stick.
            </p>
            <p className="text-sm text-muted-foreground">
              Your account, saved Wi-Fi networks, and files from this session come with you.
            </p>
          </div>
          <Button size="lg" onClick={() => setStage('disk')}>
            Choose a disk
          </Button>
        </div>
      </Frame>
    );
  }

  if (status.isPending) {
    return (
      <Frame title="Where should DinOS go?" onBack={() => setStage('welcome')}>
        <DiskSkeleton />
      </Frame>
    );
  }

  if (status.isError || !status.data.available) {
    return (
      <Frame title="Where should DinOS go?" onBack={() => setStage('welcome')}>
        <ErrorNote>
          {status.isError
            ? cleanInstallerError(status.error)
            : 'Installing isn’t available on this system.'}
        </ErrorNote>
      </Frame>
    );
  }

  const { disks, requiredBytes } = status.data;
  const disk = disks.find((d) => d.path === diskPath) ?? null;

  if (stage === 'disk' || !disk) {
    return (
      <Frame
        title="Where should DinOS go?"
        onBack={() => setStage('welcome')}
        footer={
          <>
            <Button
              variant="ghost"
              onClick={() => void status.refetch()}
              disabled={status.isFetching}
            >
              <RotateCw className={cn('size-4', status.isFetching && 'motion-safe:animate-spin')} />
              Rescan
            </Button>
            <Button
              disabled={!disk || diskProblem(disk, requiredBytes) !== null}
              onClick={() => {
                if (!disk) return;
                setMode(disk.existingInstall ? 'keep' : 'wipe');
                setPassphrase('');
                setRepeat('');
                setStage('mode');
              }}
            >
              Continue
            </Button>
          </>
        }
      >
        {disks.length === 0 ? (
          <div className="rounded-xl border border-dashed border-border px-8 py-12 text-center">
            <p className="mx-auto max-w-sm text-sm text-muted-foreground">
              No disks found besides the USB stick DinOS is running from.
            </p>
          </div>
        ) : (
          <div role="radiogroup" aria-label="Disk" className="flex flex-col gap-2">
            {disks.map((d) => {
              const problem = diskProblem(d, requiredBytes);
              const DiskIcon = d.transport === 'usb' || d.removable ? Usb : HardDrive;
              return (
                <Choice
                  key={d.path}
                  selected={diskPath === d.path}
                  disabled={problem !== null}
                  onSelect={() => setDiskPath(d.path)}
                  icon={<DiskIcon className="size-5" aria-hidden />}
                  title={
                    <>
                      {diskName(d)}
                      <span className="ml-2 font-normal text-muted-foreground">
                        {formatDiskSize(d.sizeBytes)}
                      </span>
                    </>
                  }
                  description={problem ?? describeContents(d)}
                />
              );
            })}
          </div>
        )}
      </Frame>
    );
  }

  const existing = disk.existingInstall;
  const keep = mode === 'keep';
  const alongside = alongsideProblem(disk, requiredBytes);
  const tooSmall = disk.sizeBytes < requiredBytes;
  const empty = disk.partitions.length === 0;
  const erasing = mode === 'wipe' && !empty;
  // A reinstall asks for the passphrase the disk already has, once.
  const unlocking = keep && existing?.encrypted === true;
  const passphraseIssue = passphrase ? passphraseProblem(passphrase) : null;
  const mismatch = repeat.length > 0 && repeat !== passphrase;
  const ready = keep
    ? !unlocking || passphrase.length > 0
    : !encrypt || (passphraseProblem(passphrase) === null && repeat === passphrase);

  const selectMode = (next: InstallMode) => {
    if ((next === 'keep') !== keep) {
      setPassphrase('');
      setRepeat('');
    }
    setMode(next);
  };

  const start = async () => {
    setConfirming(false);
    setError(null);
    const secret = keep ? (unlocking ? passphrase : null) : encrypt ? passphrase : null;
    try {
      await getInstallerBridge()?.install(disk.path, mode, secret);
    } catch (e) {
      setError(cleanInstallerError(e));
    }
  };

  const action = keep ? 'Reinstall' : erasing ? 'Erase and install' : 'Install';

  return (
    <Frame
      title={`Install on ${diskName(disk)}`}
      onBack={() => setStage('disk')}
      footer={
        <Button
          variant={erasing ? 'destructive' : 'default'}
          disabled={!ready}
          onClick={() => setConfirming(true)}
        >
          {action}
        </Button>
      }
    >
      <div role="radiogroup" aria-label="How to install" className="flex flex-col gap-2">
        {existing && (
          <Choice
            selected={keep}
            onSelect={() => selectMode('keep')}
            title="Reinstall DinOS and keep your files"
            description="The system is replaced with this version. Your files, apps, and settings stay, along with saved Wi-Fi networks and Bluetooth devices. Anything saved while running from the USB stick isn’t copied over."
          />
        )}
        <Choice
          selected={mode === 'wipe'}
          disabled={tooSmall}
          onSelect={() => selectMode('wipe')}
          title={empty ? 'Use the whole disk' : 'Erase the disk and install DinOS'}
          description={
            tooSmall
              ? `This disk is too small: DinOS needs ${formatDiskSize(requiredBytes)}.`
              : empty
                ? `All ${formatDiskSize(disk.sizeBytes)} goes to DinOS.`
                : existing
                  ? 'Everything on it is deleted, including your files in DinOS.'
                  : `Everything on it is deleted: ${describeContents(disk)}.`
          }
        />
        {!empty && !existing && (
          <Choice
            selected={mode === 'free'}
            disabled={alongside !== null}
            onSelect={() => selectMode('free')}
            title="Install alongside what’s there"
            description={
              alongside ??
              `DinOS takes the ${formatDiskSize(disk.largestFreeBytes)} of unpartitioned space and leaves everything else alone. DinOS starts by default; to start the other system, open your computer’s boot menu as it turns on.`
            }
          />
        )}
      </div>

      {unlocking && (
        <section className="flex flex-col gap-4 rounded-xl border border-border/60 bg-background/40 p-4">
          <div className="flex items-start gap-3">
            <Lock className="mt-0.5 size-5 shrink-0 text-muted-foreground" aria-hidden />
            <div className="flex min-w-0 flex-1 flex-col gap-3">
              <div>
                <Label htmlFor="installer-unlock" className="text-sm font-medium text-foreground">
                  Passphrase
                </Label>
                <p id="installer-unlock-hint" className="mt-0.5 text-xs text-muted-foreground">
                  This disk is encrypted. Enter the passphrase you type when DinOS starts; it
                  stays the same after reinstalling.
                </p>
              </div>
              <Input
                id="installer-unlock"
                type="password"
                autoComplete="current-password"
                value={passphrase}
                onChange={(e) => setPassphrase(e.target.value)}
                aria-describedby="installer-unlock-hint"
              />
            </div>
          </div>
        </section>
      )}

      {!keep && (
        <section className="flex flex-col gap-4 rounded-xl border border-border/60 bg-background/40 p-4">
          <div className="flex items-start gap-3">
            <Lock className="mt-0.5 size-5 shrink-0 text-muted-foreground" aria-hidden />
            <div className="min-w-0 flex-1">
              <Label htmlFor="installer-encrypt" className="text-sm font-medium text-foreground">
                Encrypt the disk
              </Label>
              <p className="mt-0.5 text-xs text-muted-foreground">
                Your account, keys, and files can’t be read without the passphrase, even
                if the computer is lost or stolen. You’ll type it every time the computer
                starts.
              </p>
            </div>
            <Switch id="installer-encrypt" checked={encrypt} onCheckedChange={setEncrypt} />
          </div>

          {encrypt && (
            <div className="flex flex-col gap-3 pl-8">
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="installer-passphrase">Passphrase</Label>
                <Input
                  id="installer-passphrase"
                  type="password"
                  autoComplete="new-password"
                  value={passphrase}
                  onChange={(e) => setPassphrase(e.target.value)}
                  aria-invalid={passphraseIssue !== null}
                  aria-describedby="installer-passphrase-hint"
                />
              </div>
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="installer-passphrase-repeat">Type it again</Label>
                <Input
                  id="installer-passphrase-repeat"
                  type="password"
                  autoComplete="new-password"
                  value={repeat}
                  onChange={(e) => setRepeat(e.target.value)}
                  aria-invalid={mismatch}
                  aria-describedby="installer-passphrase-hint"
                />
              </div>
              <p
                id="installer-passphrase-hint"
                className={cn(
                  'text-xs',
                  passphraseIssue || mismatch ? 'text-destructive' : 'text-muted-foreground',
                )}
              >
                {passphraseIssue ??
                  (mismatch
                    ? 'The passphrases don’t match.'
                    : 'If you forget it, everything on DinOS is lost: there’s no way to recover it. It’s typed with a US keyboard layout.')}
              </p>
            </div>
          )}
        </section>
      )}

      {error && <ErrorNote>{error}</ErrorNote>}

      <AlertDialog open={confirming} onOpenChange={setConfirming}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {keep ? 'Reinstall DinOS?' : erasing ? `Erase ${diskName(disk)}?` : 'Install DinOS?'}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {keep
                ? `The system on ${diskName(disk)} will be replaced with this version of DinOS. Your files and settings aren’t touched.`
                : erasing
                  ? `Everything on this ${formatDiskSize(disk.sizeBytes)} disk will be permanently deleted. This can’t be undone.`
                  : mode === 'free'
                    ? `DinOS will be installed in the free space on ${diskName(disk)}. Nothing already on it is changed.`
                    : `DinOS will be installed on ${diskName(disk)}.`}
              {!keep && encrypt && ' It will be encrypted, and asks for your passphrase each time it starts.'}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              className={cn(
                erasing &&
                  'bg-destructive text-white hover:bg-destructive/90 focus-visible:ring-destructive/20',
              )}
              onClick={() => void start()}
            >
              {action}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </Frame>
  );
}

const STEPS: { id: InstallStep; label: string }[] = [
  { id: 'partition', label: 'Preparing the disk' },
  { id: 'format', label: 'Creating file systems' },
  { id: 'copy', label: 'Copying DinOS' },
  { id: 'boot', label: 'Making it bootable' },
];

function InstallProgress({ state }: { state: InstallState }) {
  const [rebootError, setRebootError] = useState<string | null>(null);
  const [rebooting, setRebooting] = useState(false);
  const current = state.step ? STEPS.findIndex((s) => s.id === state.step) : -1;

  if (state.phase === 'done') {
    return (
      <Frame>
        <div className="flex flex-1 flex-col items-center justify-center gap-6 text-center">
          <div className="flex size-16 items-center justify-center rounded-full bg-primary/10 text-primary">
            <Check className="size-8" aria-hidden />
          </div>
          <div className="max-w-md space-y-3">
            <h1 className="text-2xl font-semibold tracking-tight text-foreground">
              DinOS is installed
            </h1>
            <p className="text-sm text-muted-foreground">
              Restart, and remove the USB stick when the screen goes dark. DinOS will
              start from this computer’s disk.
            </p>
            {state.encrypted && (
              <p className="text-sm text-muted-foreground">
                As it starts, it asks for your passphrase on a plain text screen. Type
                it and press Enter.
              </p>
            )}
          </div>
          <Button
            size="lg"
            disabled={rebooting}
            onClick={() => {
              setRebooting(true);
              setRebootError(null);
              getInstallerBridge()
                ?.reboot()
                .catch((e: unknown) => {
                  setRebooting(false);
                  setRebootError(cleanInstallerError(e));
                });
            }}
          >
            {rebooting && <Loader2 className="size-4 motion-safe:animate-spin" />}
            Restart now
          </Button>
          {rebootError && <ErrorNote>{rebootError}</ErrorNote>}
        </div>
      </Frame>
    );
  }

  const failed = state.phase === 'failed';

  return (
    <Frame title={failed ? 'The install didn’t finish' : 'Installing DinOS'}>
      <ol className="flex flex-col gap-3">
        {STEPS.map((s, i) => {
          const done = i < current;
          const active = i === current;
          const broken = failed && (active || (current === -1 && i === 0));
          return (
            <li key={s.id} className="flex flex-col gap-2">
              <div className="flex items-center gap-3">
                <span
                  className={cn(
                    'flex size-6 shrink-0 items-center justify-center rounded-full border',
                    done && 'border-primary bg-primary text-primary-foreground',
                    active && !failed && 'border-primary text-primary',
                    broken && 'border-destructive bg-destructive text-white',
                    !done && !active && !broken && 'border-muted-foreground/40',
                  )}
                  aria-hidden
                >
                  {done ? (
                    <Check className="size-3.5" />
                  ) : broken ? (
                    <CircleAlert className="size-3.5" />
                  ) : active ? (
                    <Loader2 className="size-3.5 motion-safe:animate-spin" />
                  ) : null}
                </span>
                <span
                  className={cn(
                    'text-sm',
                    done || active ? 'font-medium text-foreground' : 'text-muted-foreground',
                  )}
                >
                  {s.id === 'format' && state.mode === 'keep'
                    ? 'Clearing out the old system'
                    : s.id === 'format' && state.encrypted
                      ? 'Encrypting the disk'
                      : s.label}
                </span>
                {s.id === 'copy' && active && !failed && (
                  <span className="ml-auto text-sm tabular-nums text-muted-foreground">
                    {state.percent}%
                  </span>
                )}
              </div>
              {s.id === 'copy' && active && !failed && (
                <Progress value={state.percent} className="ml-9 w-auto" aria-label="Copy progress" />
              )}
            </li>
          );
        })}
      </ol>

      {failed ? (
        <>
          <ErrorNote>{state.error ?? 'Something went wrong.'}</ErrorNote>
          <div className="flex justify-end">
            <Button onClick={() => void getInstallerBridge()?.retry()}>
              <RotateCw className="size-4" />
              Try again
            </Button>
          </div>
        </>
      ) : (
        <p className="text-sm text-muted-foreground">
          This takes a few minutes. Keep the USB stick plugged in.
        </p>
      )}
    </Frame>
  );
}

/** The app's page: a heading with an optional back arrow, content, and a footer of actions. */
function Frame({
  title,
  onBack,
  footer,
  children,
}: {
  title?: string;
  onBack?: () => void;
  footer?: ReactNode;
  children: ReactNode;
}) {
  return (
    <div className="flex h-full flex-col bg-background">
      <div className="flex min-h-0 flex-1 flex-col gap-6 overflow-y-auto p-6">
        {title && (
          <div className="flex items-center gap-2">
            {onBack && (
              <Button variant="ghost" size="icon" onClick={onBack} aria-label="Back">
                <ArrowLeft className="size-4" />
              </Button>
            )}
            <h1 className="text-xl font-semibold tracking-tight text-foreground">{title}</h1>
          </div>
        )}
        {children}
      </div>
      {footer && (
        <div className="flex items-center justify-end gap-2 border-t border-border/60 px-6 py-4">
          {footer}
        </div>
      )}
    </div>
  );
}

function Choice({
  selected,
  disabled,
  onSelect,
  icon,
  title,
  description,
}: {
  selected: boolean;
  disabled?: boolean;
  onSelect: () => void;
  icon?: ReactNode;
  title: ReactNode;
  description: string;
}) {
  return (
    <button
      type="button"
      role="radio"
      aria-checked={selected}
      disabled={disabled}
      onClick={onSelect}
      className={cn(
        'flex items-start gap-3 rounded-xl border p-4 text-left transition-colors',
        'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
        'disabled:cursor-not-allowed disabled:opacity-60',
        selected
          ? 'border-primary bg-primary/10'
          : 'border-border/60 bg-background/40 hover:bg-foreground/5',
      )}
    >
      <span
        className={cn(
          'mt-0.5 flex size-5 shrink-0 items-center justify-center rounded-full border',
          selected
            ? 'border-primary bg-primary text-primary-foreground'
            : 'border-muted-foreground/50',
        )}
        aria-hidden
      >
        {selected && <Check className="size-3.5" />}
      </span>
      {icon && <span className="mt-0.5 shrink-0 text-muted-foreground">{icon}</span>}
      <span className="min-w-0 flex-1">
        <span className="block text-sm font-medium text-foreground">{title}</span>
        <span className="mt-0.5 block text-xs text-muted-foreground">{description}</span>
      </span>
    </button>
  );
}

function ErrorNote({ children }: { children: ReactNode }) {
  return (
    <p
      role="alert"
      className="flex items-start gap-2 rounded-lg border border-destructive/40 bg-destructive/10 p-3 text-sm text-destructive"
    >
      <CircleAlert className="mt-0.5 size-4 shrink-0" aria-hidden />
      <span>{children}</span>
    </p>
  );
}

function DiskSkeleton() {
  return (
    <div className="flex flex-col gap-2" aria-hidden>
      {[0, 1].map((i) => (
        <div key={i} className="flex items-start gap-3 rounded-xl border border-border/60 p-4">
          <Skeleton className="size-5 shrink-0 rounded-full bg-foreground/10" />
          <div className="flex-1 space-y-2">
            <Skeleton className="h-4 w-48 bg-foreground/10" />
            <Skeleton className="h-3 w-32 bg-foreground/10" />
          </div>
        </div>
      ))}
    </div>
  );
}
