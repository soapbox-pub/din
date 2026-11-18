import { useEffect, useState, type ComponentProps, type DragEvent, type ReactNode } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import {
  Check,
  CircleAlert,
  Disc3,
  FileArchive,
  FolderOpen,
  Loader2,
  MemoryStick,
  RotateCw,
  Square,
  TriangleAlert,
  Usb,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Progress } from '@/components/ui/progress';
import { Skeleton } from '@/components/ui/skeleton';
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
import { ContextMenu, ContextMenuContent, ContextMenuItem, ContextMenuTrigger } from '@/components/ui/context-menu';
import {
  cleanFlasherError,
  driveProblem,
  flashRunning,
  formatDriveSize,
  timeLeft,
  type FlashDrive,
  type FlashImageInfo,
  type FlashPhase,
  type FlashSource,
  type FlashState,
  type FlasherBridge,
  type FlasherStatus,
} from '@/lib/flasher';
import { cn } from '@/lib/utils';
import { ContentPane, EmptyState, SidebarTitleIcon } from '@/shared/appChrome';
import { droppedHandles, fileTypes, pickFiles, useLaunchFiles } from '@/shared/fileHandles';
import { RadioMark } from '@/shared/settingsChrome';
import { settingsChoiceClass } from '@/shared/settingsChromeStyles';
import { WindowControls, WindowDragRegion, useDin, useMenuBar, useWindowTitle } from '@/sdk/react';

const ICON = '/icons/apps/usb-flasher.png';
const DIN_LOGO = '/din-logo.svg';
const KEY = ['flasher'] as const;

const IMAGE_TYPES = fileTypes([
  { description: 'Disk images', extensions: ['.iso', '.img', '.raw', '.xz', '.gz', '.zst', '.bz2'] },
]);

/** What's chosen to write: the image file opened, or DinOS. */
type Kind = 'file' | 'dinos';

/** The bridge's status, kept current by what main pushes. */
function useFlasher(bridge: FlasherBridge | undefined) {
  const queryClient = useQueryClient();
  const query = useQuery({
    queryKey: KEY,
    queryFn: () => bridge!.status(),
    enabled: !!bridge,
  });
  useEffect(
    () =>
      bridge?.onChanged((change) => {
        queryClient.setQueryData<FlasherStatus>(KEY, (old) => (old ? { ...old, ...change } : old));
      }),
    [bridge, queryClient],
  );
  return query;
}

export function UsbFlasher() {
  const din = useDin();
  const bridge = din.system.flasher;
  const status = useFlasher(bridge);
  const [image, setImage] = useState<FlashImageInfo | null>(null);
  const [kind, setKind] = useState<Kind | null>(null);
  const [drivePath, setDrivePath] = useState<string | null>(null);
  const [confirming, setConfirming] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [opening, setOpening] = useState(false);
  const [dragging, setDragging] = useState(false);

  const data = status.data;
  const job = data?.state;
  const running = !!job && flashRunning(job);
  const drives = data?.drives ?? [];
  const chosen = kind === 'dinos' ? 'dinos' : kind === 'file' && image ? 'file' : null;
  const imageBytes = chosen === 'file' ? image!.imageBytes : chosen === 'dinos' ? (data?.dinos.imageBytes ?? null) : null;
  const imagePath = chosen === 'file' ? image!.path : undefined;
  // The drive picked, while it's plugged in; with one drive plugged in, it's the one.
  const drive = drives.find((d) => d.path === drivePath) ?? (drives.length === 1 ? drives[0] : null);
  const problem = drive && chosen ? driveProblem(drive, imageBytes, imagePath) : null;

  const openPath = async (path: string) => {
    if (!bridge) return;
    setError(null);
    setOpening(true);
    try {
      setImage(await bridge.inspect(path));
      setKind('file');
    } catch (e) {
      setError(cleanFlasherError(e));
    } finally {
      setOpening(false);
    }
  };

  const chooseFile = async () => {
    const [file] = await pickFiles({
      title: 'Choose a Disk Image',
      types: IMAGE_TYPES,
      mode: 'read',
      startIn: 'downloads',
      confirmLabel: 'Choose',
    });
    if (file) await openPath(din.files.path(file));
  };

  const chooseDinos = () => {
    if (!data?.dinos.available) return;
    setError(null);
    setKind('dinos');
  };

  useLaunchFiles((files) => {
    const file = files.find((f) => f.kind === 'file');
    if (file && !running) void openPath(din.files.path(file));
  });

  const onDrop = async (e: DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    setDragging(false);
    if (running) return;
    const [file] = (await droppedHandles(e.nativeEvent)).filter((h) => h.kind === 'file');
    if (file) await openPath(din.files.path(file));
  };

  const start = async () => {
    setConfirming(false);
    if (!bridge || !chosen || !drive) return;
    setError(null);
    const source: FlashSource = chosen === 'dinos' ? { kind: 'dinos' } : { kind: 'file', path: image!.path };
    try {
      await bridge.flash(source, drive.path);
    } catch (e) {
      setError(cleanFlasherError(e));
    }
  };

  const ready = !!chosen && !!drive && !problem && !running;

  useMenuBar(
    [
      {
        label: 'File',
        items: [
          { id: 'open', label: 'Open Disk Image…', accelerator: 'CmdOrCtrl+O', enabled: !running },
          { id: 'dinos', label: 'Make a DinOS USB Stick', enabled: !running && !!data?.dinos.available },
          { type: 'separator' },
          { id: 'write', label: 'Erase and Write…', accelerator: 'CmdOrCtrl+Enter', enabled: ready },
        ],
      },
    ],
    (id) => {
      if (id === 'open') void chooseFile();
      else if (id === 'dinos') chooseDinos();
      else if (id === 'write' && ready) setConfirming(true);
    },
  );

  useWindowTitle(
    job && running && job.progress !== null && (job.phase === 'writing' || job.phase === 'verifying')
      ? `${job.phase === 'writing' ? 'Writing' : 'Checking'} ${Math.floor(job.progress * 100)}%`
      : null,
  );

  const sourceName = chosen === 'dinos' ? `DinOS${data?.dinos.version ? ` ${data.dinos.version}` : ''}` : chosen === 'file' ? image!.name : null;

  let body: ReactNode;
  if (!bridge) {
    body = <Unavailable>USB Flasher writes drives through Din, so it only works inside Din.</Unavailable>;
  } else if (status.isPending) {
    body = <SetupSkeleton />;
  } else if (status.isError) {
    body = <Unavailable>{cleanFlasherError(status.error)}</Unavailable>;
  } else if (!data!.available) {
    body = <Unavailable>{data!.reason ?? 'Drives can’t be written on this computer.'}</Unavailable>;
  } else if (job && job.phase !== 'idle') {
    body = (
      <JobView
        state={job}
        onCancel={() => void bridge.cancel().catch((e: unknown) => setError(cleanFlasherError(e)))}
        onDone={() => void bridge.reset().catch((e: unknown) => setError(cleanFlasherError(e)))}
        onRetry={() => {
          void bridge
            .reset()
            .then(() => start())
            .catch((e: unknown) => setError(cleanFlasherError(e)));
        }}
        canRetry={!!chosen && !!drive && !problem}
        error={error}
      />
    );
  } else {
    body = (
      <div className="flex min-h-0 flex-1 flex-col">
        <div className="flex min-h-0 flex-1 flex-col gap-6 overflow-y-auto p-6 [&>*]:shrink-0">
          <Section number={1} title="Choose what to write">
            <div role="radiogroup" aria-label="What to write" className="flex flex-col gap-2">
              <ImageChoice
                image={image}
                selected={chosen === 'file'}
                opening={opening}
                onSelect={() => (image ? setKind('file') : void chooseFile())}
                onChoose={() => void chooseFile()}
                onClear={() => {
                  setImage(null);
                  if (kind === 'file') setKind(null);
                }}
              />
              <DinosChoice status={data!.dinos} selected={chosen === 'dinos'} onSelect={chooseDinos} />
            </div>
          </Section>

          <Section number={2} title="Choose a drive">
            {drives.length === 0 ? (
              <div className="rounded-xl border border-dashed border-border">
                <EmptyState icon={Usb} title="No USB drives">
                  Plug in a USB drive or put in a memory card. Whatever is on it will be erased.
                </EmptyState>
              </div>
            ) : (
              <div role="radiogroup" aria-label="Drive" className="flex flex-col gap-2">
                {drives.map((d) => (
                  <DriveChoice
                    key={d.path}
                    drive={d}
                    selected={drive?.path === d.path}
                    problem={chosen ? driveProblem(d, imageBytes, imagePath) : null}
                    canWrite={!!chosen && !driveProblem(d, imageBytes, imagePath)}
                    sourceName={sourceName}
                    onSelect={() => setDrivePath(d.path)}
                    onWrite={() => {
                      setDrivePath(d.path);
                      setConfirming(true);
                    }}
                  />
                ))}
              </div>
            )}
          </Section>

          {error && <ErrorNote>{error}</ErrorNote>}
        </div>

        <div className="flex shrink-0 flex-wrap items-center justify-end gap-x-4 gap-y-2 px-6 pb-6">
          <p className="mr-auto text-sm text-muted-foreground">
            {data!.asksPassword ? 'Writing asks for your password. ' : ''}
            Everything on the drive is erased.
          </p>
          <Button variant="destructive" disabled={!ready} onClick={() => setConfirming(true)}>
            Erase and Write
          </Button>
        </div>
      </div>
    );
  }

  return (
    <div
      className="flex h-full w-full flex-col text-foreground"
      onDragOver={(e) => {
        if (running || !e.dataTransfer.types.includes('Files')) return;
        e.preventDefault();
        setDragging(true);
      }}
      onDragLeave={(e) => {
        if (e.currentTarget === e.target) setDragging(false);
      }}
      onDrop={(e) => void onDrop(e)}
    >
      <WindowDragRegion className="flex h-12 shrink-0 items-center gap-2 pr-2 pl-3.75">
        <SidebarTitleIcon src={ICON} />
        <h1 className="min-w-0 flex-1 truncate font-[family-name:var(--font-title)] text-lg font-medium text-foreground/90">
          USB Flasher
        </h1>
        <WindowControls />
      </WindowDragRegion>
      <ContentPane inset={false} className={cn('border-t-0', dragging && 'ring-2 ring-inset ring-ring/60')}>{body}</ContentPane>

      <AlertDialog open={confirming && !!drive && !!chosen} onOpenChange={setConfirming}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Erase {drive?.name}?</AlertDialogTitle>
            <AlertDialogDescription>
              Everything on this {drive ? formatDriveSize(drive.sizeBytes) : ''} drive
              {drive && drive.labels.length > 0 ? ` (${drive.labels.join(', ')})` : ''} will be permanently deleted
              and replaced with {sourceName}. This can’t be undone.
              {chosen === 'dinos' && ' Making DinOS first can take a while.'}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction variant="destructive" onClick={() => void start()}>
              Erase and Write
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Choosing
// ---------------------------------------------------------------------------

function Section({ number, title, children }: { number: number; title: string; children: ReactNode }) {
  return (
    <section className="flex flex-col gap-3" aria-label={title}>
      <h2 className="flex items-center gap-2.5 text-base font-semibold text-foreground">
        <span className="grid size-6 place-items-center rounded-full bg-foreground/10 text-xs font-semibold text-foreground/75 clay" aria-hidden>
          {number}
        </span>
        {title}
      </h2>
      {children}
    </section>
  );
}

/** A choice card, as the Installer's: a radio mark, an icon, a title and a line under it. */
function Choice({
  selected,
  disabled,
  onSelect,
  icon,
  title,
  description,
  children,
  ...props
}: {
  selected: boolean;
  disabled?: boolean;
  onSelect: () => void;
  icon: ReactNode;
  title: ReactNode;
  description: ReactNode;
  children?: ReactNode;
} & Omit<ComponentProps<'div'>, 'title' | 'onSelect'>) {
  return (
    <div {...props} className={cn(settingsChoiceClass(selected), 'flex items-center gap-3 p-4', disabled && 'opacity-60')}>
      <button
        type="button"
        role="radio"
        aria-checked={selected}
        disabled={disabled}
        onClick={onSelect}
        className="flex min-w-0 flex-1 items-start gap-3 rounded-lg text-left outline-none focus-visible:ring-2 focus-visible:ring-ring/60 disabled:cursor-not-allowed"
      >
        <RadioMark checked={selected} className="mt-0.5" />
        <span className="mt-px shrink-0 text-ink-accent [&_svg]:size-4.5" aria-hidden>
          {icon}
        </span>
        <span className="min-w-0 flex-1">
          <span className="block truncate text-sm font-medium text-foreground">{title}</span>
          <span className="mt-0.5 block text-xs text-muted-foreground">{description}</span>
        </span>
      </button>
      {children}
    </div>
  );
}

function describeImage(image: FlashImageInfo): string {
  const size = image.imageBytes !== null ? formatDriveSize(image.imageBytes) : null;
  if (image.compression) {
    return size
      ? `${formatDriveSize(image.fileBytes)}, ${image.compression}-compressed: ${size} on the drive`
      : `${formatDriveSize(image.fileBytes)}, ${image.compression}-compressed`;
  }
  return `${image.iso ? 'Disc image' : 'Disk image'}, ${size}`;
}

function ImageChoice({
  image: chosen,
  selected,
  opening,
  onSelect,
  onChoose,
  onClear,
}: {
  image: FlashImageInfo | null;
  selected: boolean;
  opening: boolean;
  onSelect: () => void;
  onChoose: () => void;
  onClear: () => void;
}) {
  const Icon = chosen?.compression ? FileArchive : Disc3;
  const card = (
    <Choice
      selected={selected}
      onSelect={onSelect}
      icon={opening ? <Loader2 className="motion-safe:animate-spin" /> : <Icon />}
      title={chosen ? chosen.name : 'A disk image'}
      description={
        chosen ? (
          <>
            {describeImage(chosen)}
            {chosen.notBootableFromUsb && (
              <span className="mt-1.5 flex items-start gap-1.5 text-foreground/80">
                <TriangleAlert className="mt-px size-3.5 shrink-0 text-amber-600 dark:text-amber-400" aria-hidden />
                This disc image isn’t made to start from a USB drive, so computers may not start from it. Windows’ own
                discs need Microsoft’s Media Creation Tool instead.
              </span>
            )}
          </>
        ) : (
          'An ISO or .img file, such as Linux or a Raspberry Pi system, compressed or not. You can drop one here.'
        )
      }
    >
      <Button variant="outline" size="sm" className="shrink-0" onClick={onChoose} disabled={opening}>
        <FolderOpen className="size-4" />
        {chosen ? 'Change…' : 'Choose…'}
      </Button>
    </Choice>
  );
  if (!chosen) return card;
  return (
    <ContextMenu>
      <ContextMenuTrigger asChild>{card}</ContextMenuTrigger>
      <ContextMenuContent>
        <ContextMenuItem onSelect={onChoose}>
          <FolderOpen />
          Choose Another Image…
        </ContextMenuItem>
        <ContextMenuItem onSelect={onClear}>
          <Square />
          Clear
        </ContextMenuItem>
      </ContextMenuContent>
    </ContextMenu>
  );
}

function DinosChoice({ status, selected, onSelect }: { status: FlasherStatus['dinos']; selected: boolean; onSelect: () => void }) {
  return (
    <Choice
      selected={selected}
      disabled={!status.available}
      onSelect={onSelect}
      icon={<img src={DIN_LOGO} alt="" className="size-4.5 object-contain" draggable={false} />}
      title={`DinOS${status.version ? ` ${status.version}` : ''}`}
      description={
        status.available
          ? `The DinOS on this computer${status.commit ? ` (${status.commit.slice(0, 7)})` : ''}, made into a USB stick to try or install it on another computer. It’s made from this computer’s system, which takes a while.`
          : (status.reason ?? 'DinOS can’t be made here.')
      }
    />
  );
}

function DriveChoice({
  drive,
  selected,
  problem,
  canWrite,
  sourceName,
  onSelect,
  onWrite,
}: {
  drive: FlashDrive;
  selected: boolean;
  problem: string | null;
  canWrite: boolean;
  sourceName: string | null;
  onSelect: () => void;
  onWrite: () => void;
}) {
  const Icon = drive.transport === 'mmc' ? MemoryStick : Usb;
  const contents = drive.labels.length > 0 ? drive.labels.join(', ') : null;
  return (
    <ContextMenu>
      <ContextMenuTrigger asChild>
        <Choice
          selected={selected}
          disabled={problem !== null}
          onSelect={onSelect}
          icon={<Icon />}
          title={
            <>
              {drive.name}
              <span className="ml-2 font-normal text-muted-foreground">{formatDriveSize(drive.sizeBytes)}</span>
            </>
          }
          description={problem ?? [drive.path, contents && `Has ${contents}`].filter(Boolean).join(' · ')}
        />
      </ContextMenuTrigger>
      <ContextMenuContent>
        <ContextMenuItem onSelect={onSelect} disabled={problem !== null}>
          <Check />
          Choose This Drive
        </ContextMenuItem>
        <ContextMenuItem variant="destructive" onSelect={onWrite} disabled={!canWrite}>
          <Usb />
          {sourceName ? `Erase and Write ${sourceName}…` : 'Erase and Write…'}
        </ContextMenuItem>
      </ContextMenuContent>
    </ContextMenu>
  );
}

// ---------------------------------------------------------------------------
// Writing
// ---------------------------------------------------------------------------

type Step = { id: 'building' | 'writing' | 'verifying' | 'ejecting'; label: string };

function stepsFor(state: FlashState): Step[] {
  return [
    ...(state.sourceKind === 'dinos' ? [{ id: 'building' as const, label: `Making ${state.sourceName ?? 'DinOS'}` }] : []),
    { id: 'writing', label: 'Writing' },
    { id: 'verifying', label: 'Checking what was written' },
    { id: 'ejecting', label: 'Ejecting' },
  ];
}

/** Which step a phase is in: preparing counts as writing's start. */
function stepOf(phase: FlashPhase): Step['id'] | null {
  if (phase === 'preparing') return 'writing';
  if (phase === 'building' || phase === 'writing' || phase === 'verifying' || phase === 'ejecting') return phase;
  return null;
}

function JobView({
  state,
  onCancel,
  onDone,
  onRetry,
  canRetry,
  error,
}: {
  state: FlashState;
  onCancel: () => void;
  onDone: () => void;
  onRetry: () => void;
  canRetry: boolean;
  error: string | null;
}) {
  const [stopping, setStopping] = useState(false);
  const steps = stepsFor(state);
  const drive = state.drive;

  if (state.phase === 'done') {
    return (
      <Centered
        icon={<Check className="size-8" aria-hidden />}
        title={`${drive?.name ?? 'The drive'} is ready`}
        action={<Button size="lg" onClick={onDone}>Write Another</Button>}
      >
        {state.sourceName} was written and checked.{' '}
        {state.ejected ? 'You can unplug it now.' : 'Nothing on it is open, so it’s safe to unplug.'}
      </Centered>
    );
  }

  if (state.phase === 'cancelled') {
    return (
      <Centered
        icon={<Square className="size-7" aria-hidden />}
        muted
        title="Stopped"
        action={<Button size="lg" onClick={onDone}>Back</Button>}
      >
        {drive?.name ?? 'The drive'} was only partly written, so it won’t work until it’s written again or erased.
      </Centered>
    );
  }

  const failed = state.phase === 'failed';
  const current = stepOf(failed ? (state.failedAt ?? 'preparing') : state.phase);
  const index = current ? steps.findIndex((s) => s.id === current) : steps.length;
  const percent = state.progress !== null ? Math.floor(state.progress * 100) : null;
  const left = timeLeft(state);

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex min-h-0 flex-1 flex-col gap-6 overflow-y-auto p-6 [&>*]:shrink-0">
        <div>
          <h2 className="text-xl font-semibold tracking-tight text-foreground">
            {failed
              ? 'The drive wasn’t written'
              : state.phase === 'building'
                ? `Making ${state.sourceName ?? 'DinOS'}`
                : `Writing ${state.sourceName ?? 'the image'}`}
          </h2>
          {drive && (
            <p className="mt-1 text-sm text-muted-foreground">
              To {drive.name}, {formatDriveSize(drive.sizeBytes)} ({drive.path})
            </p>
          )}
        </div>

        <ol className="flex flex-col gap-3">
          {steps.map((s, i) => {
            const done = i < index;
            const active = i === index && !failed;
            const broken = failed && i === index;
            const showBar = active && (s.id === 'writing' || s.id === 'verifying') && state.phase !== 'preparing';
            return (
              <li key={s.id} className="flex flex-col gap-2">
                <div className="flex items-center gap-3">
                  <span
                    className={cn(
                      'flex size-6 shrink-0 items-center justify-center rounded-full',
                      done && !broken && 'bg-pigment text-primary-foreground clay-pigment',
                      active && 'text-ink-accent ring-2 ring-ring/60',
                      broken && 'bg-destructive text-white',
                      !done && !active && !broken && 'bg-foreground/10 clay',
                    )}
                    aria-hidden
                  >
                    {broken ? (
                      <CircleAlert className="size-3.5" />
                    ) : done ? (
                      <Check className="size-3.5" />
                    ) : active ? (
                      <Loader2 className="size-3.5 motion-safe:animate-spin" />
                    ) : null}
                  </span>
                  <span className={cn('text-sm', done || active ? 'font-medium text-foreground' : 'text-muted-foreground')}>
                    {s.id === 'writing' && active && state.phase === 'preparing' ? 'Getting the drive ready' : s.label}
                  </span>
                  {showBar && percent !== null && (
                    <span className="ml-auto text-sm tabular-nums text-muted-foreground">{percent}%</span>
                  )}
                </div>
                {showBar && (
                  <div className="ml-9 flex flex-col gap-1.5">
                    <Progress value={percent ?? 0} aria-label={`${s.label} progress`} />
                    <p className="text-xs tabular-nums text-muted-foreground">
                      {[
                        state.totalBytes ? `${formatDriveSize(state.bytes)} of ${formatDriveSize(state.totalBytes)}` : formatDriveSize(state.bytes),
                        state.rate ? `${formatDriveSize(state.rate)}/s` : null,
                        left,
                      ]
                        .filter(Boolean)
                        .join(' · ')}
                    </p>
                  </div>
                )}
                {active && s.id === 'building' && state.detail && (
                  <p className="ml-9 truncate font-mono text-xs text-muted-foreground" title={state.detail}>
                    {state.detail}
                  </p>
                )}
              </li>
            );
          })}
        </ol>

        {failed && <ErrorNote>{state.error ?? 'Something went wrong.'}</ErrorNote>}
        {error && <ErrorNote>{error}</ErrorNote>}
        {!failed && (
          <p className="text-sm text-muted-foreground">
            {state.phase === 'building'
              ? 'DinOS is put together from the system on this computer. The first time takes a while; you can close this window and it carries on.'
              : 'Keep the drive plugged in. You can close this window; it carries on and tells you when it’s done.'}
          </p>
        )}
      </div>

      <div className="flex shrink-0 items-center justify-end gap-2 px-6 pb-6">
        {failed ? (
          <>
            <Button variant="ghost" onClick={onDone}>
              Back
            </Button>
            {canRetry && (
              <Button onClick={onRetry}>
                <RotateCw className="size-4" />
                Try Again
              </Button>
            )}
          </>
        ) : (
          <Button variant="outline" disabled={state.phase === 'ejecting'} onClick={() => setStopping(true)}>
            Stop
          </Button>
        )}
      </div>

      <AlertDialog open={stopping} onOpenChange={setStopping}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{state.phase === 'building' ? 'Stop making DinOS?' : 'Stop writing?'}</AlertDialogTitle>
            <AlertDialogDescription>
              {state.phase === 'building'
                ? 'Nothing has been written to the drive yet.'
                : 'The drive won’t work until it’s written again or erased.'}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Keep Going</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => {
                setStopping(false);
                onCancel();
              }}
            >
              Stop
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}

function Centered({
  icon,
  title,
  action,
  muted,
  children,
}: {
  icon: ReactNode;
  title: string;
  action: ReactNode;
  muted?: boolean;
  children: ReactNode;
}) {
  return (
    <div className="flex flex-1 flex-col items-center justify-center gap-6 p-6 text-center">
      <div
        className={cn(
          'flex size-16 items-center justify-center rounded-full',
          muted ? 'bg-foreground/10 text-foreground/75 clay' : 'bg-pigment text-primary-foreground clay-pigment',
        )}
      >
        {icon}
      </div>
      <div className="max-w-md space-y-3">
        <h2 className="text-2xl font-semibold tracking-tight text-foreground">{title}</h2>
        <p className="text-sm text-muted-foreground">{children}</p>
      </div>
      {action}
    </div>
  );
}

function Unavailable({ children }: { children: ReactNode }) {
  return (
    <EmptyState icon={Usb} title="Can’t write drives here" className="flex-1 justify-center">
      {children}
    </EmptyState>
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

function SetupSkeleton() {
  return (
    <div className="flex flex-col gap-6 p-6" aria-hidden>
      {[0, 1].map((section) => (
        <div key={section} className="flex flex-col gap-3">
          <Skeleton className="h-5 w-48 bg-foreground/10" />
          {[0, 1].map((i) => (
            <div key={i} className="flex items-start gap-3 rounded-xl bg-card p-4 clay">
              <Skeleton className="size-4 shrink-0 rounded-full bg-foreground/10" />
              <div className="flex-1 space-y-2">
                <Skeleton className="h-4 w-48 bg-foreground/10" />
                <Skeleton className="h-3 w-64 bg-foreground/10" />
              </div>
            </div>
          ))}
        </div>
      ))}
    </div>
  );
}
