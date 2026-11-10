import { useCallback, useEffect, useRef, useState } from 'react';
import { AlertTriangle, Camera, Expand, Keyboard, Loader2, Monitor, MoreHorizontal, Pause, Play, Plus, Power } from 'lucide-react';
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
import { ContextMenu, ContextMenuContent, ContextMenuTrigger } from '@/components/ui/context-menu';
import { DropdownMenu, DropdownMenuContent, DropdownMenuTrigger } from '@/components/ui/dropdown-menu';
import { Skeleton } from '@/components/ui/skeleton';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { cn } from '@/lib/utils';
import { ContentPane, ToolButton } from '@/shared/appChrome';
import { toolIcon } from '@/shared/appChromeStyles';
import { cleanFsError, parentPath } from '@/lib/fs';
import { cleanVmsError, type VmInfo, type VmInstallerId, type VmsBridge, type VmsStatus } from '@/lib/vms';
import type { MenuItem } from '@/sdk';
import { useDin, useMenuBar, useWindowTitle, WindowControls, WindowDragRegion } from '@/sdk/react';
import { toast } from '@/shared/toast';
import { formatBytes, formatMemory, isOn, OS_LABELS, STATE_LABELS, useBridge, usePickDiscImage, useVms, useVmsStatus } from './vms/bridge';
import { Console, type ConsoleHandle } from './vms/Console';
import { POWER_ACTIONS, vmMenuItems, type VmAction } from './vms/actions';
import { VmActionItems } from './vms/ActionItems';
import { CdromField, OsBadge } from './vms/fields';
import { Gallery } from './vms/Gallery';
import { InstallCard } from './vms/InstallCard';
import { NewVmWindow } from './vms/NewVmWindow';
import { SettingsWindow } from './vms/SettingsWindow';
import { openVmWindow, useVmWindowMessages, type VmWindow } from './vms/windows';
import { Sidebar, StateDot } from './vms/Sidebar';
import { SnapshotList, TakeSnapshotDialog } from './vms/Snapshots';
import { FeatureInstallButton } from '@/shared/FeatureInstall';
import { appLink, windowLaunch, type Launch } from '@/shared/launch';

const SELECTED_KEY = 'virtual-machines:selected';
const SCALE_KEY = 'virtual-machines:scale';

/** Keys the desktop would keep for itself, sent to the machine from a menu. */
const KEY = {
  ctrl: { keysym: 0xffe3, code: 'ControlLeft' },
  alt: { keysym: 0xffe9, code: 'AltLeft' },
  super: { keysym: 0xffeb, code: 'MetaLeft' },
  backspace: { keysym: 0xff08, code: 'Backspace' },
  print: { keysym: 0xff61, code: 'PrintScreen' },
  f: (n: number) => ({ keysym: 0xffbe + n - 1, code: `F${n}` }),
};

function TitleBar({ children, className }: { children?: React.ReactNode; className?: string }) {
  return (
    <WindowDragRegion className={cn('flex h-12 shrink-0 items-center gap-1 px-3', className)}>
      {children ?? <div className="flex-1" />}
      <WindowControls />
    </WindowDragRegion>
  );
}

function IconButton({ label, onClick, disabled, children }: { label: string; onClick: () => void; disabled?: boolean; children: React.ReactNode }) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <ToolButton label={label} title={undefined} onClick={onClick} disabled={disabled}>
          {children}
        </ToolButton>
      </TooltipTrigger>
      <TooltipContent>{label}</TooltipContent>
    </Tooltip>
  );
}

/**
 * Virtual Machines - Din's VirtualBox: machines down the side, and the one
 * picked, its screen while it runs and its details while it's off.
 *
 * QEMU with KVM, run by Electron main (din.system.vms, the `vms`
 * permission; electron/vms.mts). Each machine is a folder in ~/VMs. Its
 * screen is QEMU's VNC server, drawn by noVNC over the app's bridge port.
 */
/** The window a launch asks for: Virtual Machines itself, or one it opened for a form. */
function windowKind({ params }: Launch): VmWindow | null {
  if (params.window === 'settings' && typeof params.vm === 'string') return { window: 'settings', vm: params.vm };
  if (params.window === 'new') {
    return { window: 'new', system: typeof params.system === 'string' ? (params.system as VmInstallerId) : undefined, other: params.other === true };
  }
  return null;
}

export function VirtualMachines() {
  const bridge = useBridge();
  const { data: status } = useVmsStatus();
  const [kind] = useState(() => windowKind(windowLaunch()));
  useWindowTitle(kind?.window === 'new' ? 'New Virtual Machine' : kind?.window === 'settings' ? 'Settings' : 'Virtual Machines');

  let body: React.ReactNode;
  if (!bridge) {
    body = <p className="m-auto max-w-sm p-8 text-center text-sm text-muted-foreground">Virtual Machines works in Din’s desktop app.</p>;
  } else if (!status) {
    body = <Skeleton className="m-auto h-24 w-72 rounded-xl" />;
  } else if (!status.available && status.optionalFeature) {
    body = (
      <div className="m-auto max-w-md space-y-3 p-8 text-center">
        <Monitor className="mx-auto size-10 text-muted-foreground" aria-hidden />
        <h1 className="text-lg font-semibold">Virtual machines aren’t installed yet</h1>
        <p className="text-sm text-muted-foreground">This window is ready as soon as they are.</p>
        <FeatureInstallButton
          feature="vms"
          fallback={<Button onClick={() => void window.open(appLink('settings', { section: 'features' }))}>Open Optional Features</Button>}
        />
      </div>
    );
  } else if (!status.available) {
    body = (
      <div className="m-auto max-w-md space-y-3 p-8 text-center">
        <AlertTriangle className="mx-auto size-10 text-warning" aria-hidden />
        <h1 className="text-lg font-semibold">Virtual machines can’t run here</h1>
        <p className="text-sm text-muted-foreground">This computer is missing {status.missing.join(' and ')}.</p>
      </div>
    );
  } else if (kind) {
    return <FormWindowFor kind={kind} status={status} />;
  } else {
    return <Machines bridge={bridge} status={status} />;
  }
  return (
    <div className="flex h-full w-full flex-col text-foreground">
      <TitleBar />
      <ContentPane inset={false} className="border-t-0">
        {body}
      </ContentPane>
    </div>
  );
}

/** A window Virtual Machines opened beside its own: a new machine, or one's settings. */
function FormWindowFor({ kind, status }: { kind: VmWindow; status: VmsStatus }) {
  const { data: vms, isLoading } = useVms();
  if (kind.window === 'new') return <NewVmWindow status={status} existing={vms ?? []} system={kind.system} other={kind.other} />;
  const vm = vms?.find((v) => v.id === kind.vm);
  if (vm) return <SettingsWindow key={vm.id} vm={vm} status={status} />;
  return (
    <div className="flex h-full w-full flex-col text-foreground">
      <TitleBar />
      <ContentPane inset={false} className="border-t-0">
        {isLoading ? <Skeleton className="m-auto h-24 w-72 rounded-xl" /> : <p className="m-auto p-8 text-sm text-muted-foreground">This machine isn’t here any more.</p>}
      </ContentPane>
    </div>
  );
}

function Machines({ bridge, status }: { bridge: VmsBridge; status: VmsStatus }) {
  const din = useDin();
  const { data: vms = [], isLoading } = useVms();
  const [chosen, setChosen] = useState<string | null>(() => localStorage.getItem(SELECTED_KEY));
  const [scale, setScale] = useState(() => localStorage.getItem(SCALE_KEY) !== 'false');
  const [cancelling, setCancelling] = useState<VmInfo | null>(null);
  /** Machines being installed whose screens are shown instead of their progress. */
  const [screens, setScreens] = useState<Set<string>>(new Set());
  const [snapshotFor, setSnapshotFor] = useState<string | null>(null);
  const [deleting, setDeleting] = useState<VmInfo | null>(null);
  const [pending, setPending] = useState<Set<string>>(new Set());
  const consoleRef = useRef<ConsoleHandle>(null);
  const pick = usePickDiscImage();

  const vm = vms.find((v) => v.id === chosen) ?? vms[0] ?? null;
  const select = (id: string) => {
    setChosen(id);
    localStorage.setItem(SELECTED_KEY, id);
  };
  useEffect(() => {
    localStorage.setItem(SCALE_KEY, String(scale));
  }, [scale]);

  const fail = useCallback(
    (err: unknown) => toast('Virtual Machines couldn’t do that', { body: cleanVmsError(err), destructive: true }),
    [],
  );

  /** Run something on a machine, its buttons held while it does. */
  const busy = useCallback(
    async (id: string, fn: () => Promise<unknown>) => {
      setPending((p) => new Set(p).add(id));
      try {
        await fn();
      } catch (err) {
        fail(err);
      } finally {
        setPending((p) => {
          const next = new Set(p);
          next.delete(id);
          return next;
        });
      }
    },
    [fail],
  );

  const act = useCallback(
    (target: VmInfo, action: VmAction) => {
      const id = target.id;
      switch (action) {
        case 'start':
          select(id);
          return void busy(id, () => bridge.start(id));
        case 'shutdown':
          return void busy(id, async () => {
            await bridge.shutdown(id);
            toast(`Asked “${target.config.name}” to shut down`, {
              body: 'If it doesn’t, its system isn’t listening for the power button: use Force Off.',
            });
          });
        case 'pause':
          return void busy(id, () => bridge.pause(id));
        case 'resume':
          return void busy(id, () => bridge.resume(id));
        case 'reset':
          return void busy(id, () => bridge.reset(id));
        case 'forceStop':
          return void busy(id, () => bridge.forceStop(id));
        case 'snapshot':
          return setSnapshotFor(id);
        case 'settings':
          return openVmWindow({ window: 'settings', vm: id });
        case 'showInFiles':
          // Files opens at a folder it's handed, not one named in its params.
          return void din.files.fromPath(parentPath(target.dir)).then(
            (folder) => din.app.launch(appLink('file-browser', { select: target.id }), [folder]),
            (err: unknown) => toast('Virtual Machines couldn’t show that in Files', { body: cleanFsError(err), destructive: true }),
          );
        case 'delete':
          return setDeleting(target);
        case 'cancelInstall':
          return setCancelling(target);
      }
    },
    [bridge, busy, din],
  );

  // The empty window's systems: a tile installs at once, a right-click (or
  // Other) opens the form in a window of its own.
  const install = useCallback(
    async (system: VmInstallerId) => {
      try {
        select((await bridge.install(system)).id);
      } catch (err) {
        fail(err);
      }
    },
    [bridge, fail],
  );
  const custom = (system: VmInstallerId | null) => openVmWindow(system ? { window: 'new', system } : { window: 'new', other: true });

  // What the windows it opened made: a new machine, or one renamed, to choose.
  useVmWindowMessages(
    useCallback((message) => {
      setChosen(message.id);
      localStorage.setItem(SELECTED_KEY, message.id);
    }, []),
  );
  const toggleScreen = (id: string) =>
    setScreens((s) => {
      const next = new Set(s);
      if (!next.delete(id)) next.add(id);
      return next;
    });

  const on = vm ? isOn(vm) && vm.state !== 'stopping' : false;
  const sendKeys = (keys: { keysym: number; code: string }[]) => consoleRef.current?.sendKeys(keys);

  const menus: { label: string; items: MenuItem[] }[] = [
    {
      label: 'Machine',
      items: [{ id: 'new', label: 'New Virtual Machine…' }, ...(vm ? [{ type: 'separator' } as const, ...vmMenuItems(vm)] : [])],
    },
    {
      label: 'View',
      items: [
        { id: 'scale', label: 'Scale to Window', type: 'checkbox', checked: scale },
        { id: 'fullscreen', label: 'Full Screen', enabled: on },
      ],
    },
    {
      label: 'Input',
      items: [
        { id: 'cad', label: 'Send Ctrl+Alt+Delete', enabled: on },
        { id: 'super', label: 'Send Windows Key', enabled: on },
        { id: 'print', label: 'Send Print Screen', enabled: on },
        { id: 'zap', label: 'Send Ctrl+Alt+Backspace', enabled: on },
        {
          id: 'vt',
          type: 'submenu',
          label: 'Switch to Console',
          enabled: on,
          items: Array.from({ length: 7 }, (_, i) => ({ id: `vt:${i + 1}`, label: `Ctrl+Alt+F${i + 1}` })),
        },
      ],
    },
  ];
  useMenuBar(menus, (id) => {
    if (id === 'new') openVmWindow({ window: 'new' });
    else if (id.startsWith('vm:') && vm) act(vm, id.slice(3) as VmAction);
    else if (id === 'scale') setScale((s) => !s);
    else if (id === 'fullscreen') consoleRef.current?.fullscreen();
    else if (id === 'cad') consoleRef.current?.sendCtrlAltDel();
    else if (id === 'super') sendKeys([KEY.super]);
    else if (id === 'print') sendKeys([KEY.print]);
    else if (id === 'zap') sendKeys([KEY.ctrl, KEY.alt, KEY.backspace]);
    else if (id.startsWith('vt:')) sendKeys([KEY.ctrl, KEY.alt, KEY.f(Number(id.slice(3)))]);
  });

  const snapshotVm = vms.find((v) => v.id === snapshotFor);
  const working = vm ? pending.has(vm.id) : false;

  return (
    <div className="flex h-full w-full text-foreground">
      <Sidebar
        vms={vms}
        loading={isLoading}
        selected={vm?.id ?? null}
        onSelect={select}
        onNew={() => openVmWindow({ window: 'new' })}
        onAction={act}
        className="hidden sm:flex"
      />
      <div className="flex min-w-0 flex-1 flex-col">
        <TitleBar>
          {vm && (
            <>
              {isOn(vm) && (
                <>
                  {vm.state === 'paused' ? (
                    <IconButton label="Resume" onClick={() => act(vm, 'resume')} disabled={working}>
                      <Play {...toolIcon} />
                    </IconButton>
                  ) : (
                    <IconButton label="Pause" onClick={() => act(vm, 'pause')} disabled={working || vm.state !== 'running'}>
                      <Pause {...toolIcon} />
                    </IconButton>
                  )}
                  <IconButton label="Send Ctrl+Alt+Delete" onClick={() => consoleRef.current?.sendCtrlAltDel()} disabled={!on}>
                    <Keyboard {...toolIcon} />
                  </IconButton>
                  <IconButton label="Take Snapshot" onClick={() => act(vm, 'snapshot')} disabled={!on}>
                    <Camera {...toolIcon} />
                  </IconButton>
                  <IconButton label="Full Screen" onClick={() => consoleRef.current?.fullscreen()} disabled={!on}>
                    <Expand {...toolIcon} />
                  </IconButton>
                  {/* Right-click for the rest of the power actions, Force Off
                      among them. The span takes the click while the button is
                      disabled (it has no pointer events then), as it is while
                      a machine that won't stop is stopping. */}
                  <ContextMenu>
                    <ContextMenuTrigger asChild>
                      <span className="grid">
                        <IconButton label="Shut Down" onClick={() => act(vm, 'shutdown')} disabled={working || !on}>
                          <Power {...toolIcon} />
                        </IconButton>
                      </span>
                    </ContextMenuTrigger>
                    <ContextMenuContent className="w-48">
                      <VmActionItems vm={vm} kind="context" only={POWER_ACTIONS} onAction={(action) => act(vm, action)} />
                    </ContextMenuContent>
                  </ContextMenu>
                </>
              )}
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <Button variant="ghost" size="icon" className="size-8" aria-label={`Actions for ${vm.config.name}`}>
                    <MoreHorizontal className="size-4" />
                  </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end" className="w-48">
                  <VmActionItems vm={vm} kind="dropdown" onAction={(action) => act(vm, action)} />
                </DropdownMenuContent>
              </DropdownMenu>
              <Button variant="ghost" size="icon" className="size-8 sm:hidden" aria-label="New virtual machine" onClick={() => openVmWindow({ window: 'new' })}>
                <Plus className="size-4" />
              </Button>
              {/* The VM's state after what acts on it; its name only while the
                  sidebar, whose chosen row names it, is hidden. */}
              <div className="ml-2 flex min-w-0 items-center gap-2">
                <h1 className="truncate text-sm font-semibold sm:sr-only">{vm.config.name}</h1>
                <span className="flex shrink-0 items-center gap-1.5 text-xs text-muted-foreground">
                  <StateDot state={vm.state} />
                  {STATE_LABELS[vm.state]}
                </span>
                {working && <Loader2 className="size-3.5 animate-spin text-muted-foreground" aria-label="Working" />}
              </div>
              <div className="flex-1" />
            </>
          )}
        </TitleBar>

        <ContentPane className="max-sm:m-0 max-sm:rounded-none">
          {!vm ? (
            isLoading ? (
              <Skeleton className="m-auto h-40 w-80 rounded-xl" />
            ) : (
              <Empty status={status} onInstall={install} onCustom={custom} />
            )
          ) : vm.install && !(isOn(vm) && screens.has(vm.id)) ? (
            <InstallCard
              key={vm.id}
              vm={vm}
              onShowScreen={isOn(vm) ? () => toggleScreen(vm.id) : undefined}
              onStart={() => act(vm, 'start')}
              onRetry={() => void busy(vm.id, () => bridge.retryInstall(vm.id))}
              onChooseIso={() => void pick(vm.install?.installer).then((file) => file && busy(vm.id, () => bridge.retryInstall(vm.id, { iso: file.path })))}
              onCancel={() => act(vm, 'cancelInstall')}
            />
          ) : isOn(vm) ? (
            <div className="relative flex min-h-0 flex-1 flex-col">
              <Console key={vm.id} ref={consoleRef} bridge={bridge} vmId={vm.id} scale={scale} />
              {vm.state === 'paused' && (
                <div className="absolute inset-0 grid place-items-center bg-black/50 backdrop-blur-[2px]">
                  <div className="space-y-3 text-center text-white">
                    <p className="text-lg font-semibold">Paused</p>
                    <Button onClick={() => act(vm, 'resume')} disabled={working}>
                      <Play className="size-4" aria-hidden />
                      Resume
                    </Button>
                  </div>
                </div>
              )}
              {vm.install && (
                <Button
                  variant="secondary"
                  size="sm"
                  className="absolute right-3 top-3 shadow-md"
                  onClick={() => toggleScreen(vm.id)}
                >
                  Show Progress
                </Button>
              )}
              {vm.changesPending && (
                <p className="absolute bottom-3 left-1/2 -translate-x-1/2 rounded-full bg-black/70 px-3 py-1 text-xs text-white">
                  Some settings take effect when it next starts.
                </p>
              )}
            </div>
          ) : (
            <Details vm={vm} working={working} onAction={(action) => act(vm, action)} onError={fail} />
          )}
        </ContentPane>
      </div>

      {snapshotVm && <TakeSnapshotDialog vm={snapshotVm} onOpenChange={(o) => !o && setSnapshotFor(null)} onError={fail} />}
      <AlertDialog open={!!cancelling} onOpenChange={(o) => !o && setCancelling(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Stop installing “{cancelling?.config.name}”?</AlertDialogTitle>
            <AlertDialogDescription>The machine is thrown away. Nothing’s on it yet.</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Keep Installing</AlertDialogCancel>
            <AlertDialogAction
              className="bg-destructive text-white hover:bg-destructive/90"
              onClick={() => cancelling && void busy(cancelling.id, () => bridge.cancelInstall(cancelling.id))}
            >
              Stop and Throw Away
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
      <AlertDialog open={!!deleting} onOpenChange={(o) => !o && setDeleting(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Move “{deleting?.config.name}” to the Trash?</AlertDialogTitle>
            <AlertDialogDescription>
              Its folder goes, with its disk ({deleting ? formatBytes(deleting.diskUsedBytes) : ''}) and snapshots. Empty the Trash to free the space.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              className="bg-destructive text-white hover:bg-destructive/90"
              onClick={() => deleting && void busy(deleting.id, () => bridge.remove(deleting.id))}
            >
              Move to Trash
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}

function Empty({
  status,
  onInstall,
  onCustom,
}: {
  status: VmsStatus;
  onInstall: (system: VmInstallerId) => Promise<unknown>;
  onCustom: (system: VmInstallerId | null) => void;
}) {
  return (
    <div className="min-h-0 flex-1 overflow-y-auto">
      <div className="mx-auto max-w-xl space-y-8 px-6 py-10">
        <div className="space-y-2 text-center">
          <h1 className="text-3xl font-semibold tracking-tight sm:text-4xl">Another computer, in a window</h1>
          <p className="text-muted-foreground">Pick a system. Din downloads it and sets it up, and you can change anything later.</p>
        </div>
        <Gallery available={status.installers} onInstall={onInstall} onCustom={onCustom} />
        <p className="text-center text-xs text-muted-foreground">Machines are kept in {status.dir}.</p>
      </div>
    </div>
  );
}

function Spec({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-xl bg-card clay px-3 py-2.5">
      <dt className="text-xs text-muted-foreground">{label}</dt>
      <dd className="mt-0.5 truncate text-sm font-medium">{value}</dd>
    </div>
  );
}

/** A machine that's off: what it is, what's in its CD drive, its snapshots, and Start. */
function Details({ vm, working, onAction, onError }: { vm: VmInfo; working: boolean; onAction: (action: VmAction) => void; onError: (err: unknown) => void }) {
  const bridge = useBridge()!;
  const pick = usePickDiscImage();
  const { config } = vm;
  const firmware = config.firmware === 'uefi' ? ['UEFI', config.secureBoot && 'Secure Boot', config.tpm && 'TPM'].filter(Boolean).join(' · ') : 'BIOS';
  const network = config.network
    ? config.forwards.length
      ? `NAT · ${config.forwards.length} ${config.forwards.length === 1 ? 'port' : 'ports'}`
      : 'NAT'
    : 'Off';

  return (
    <div className="min-h-0 flex-1 overflow-y-auto">
      <div className="mx-auto max-w-2xl space-y-8 px-6 pb-10 pt-4">
        <header className="flex flex-wrap items-center gap-4">
          <OsBadge os={config.os} system={config.system} className="size-16 rounded-2xl" />
          <div className="min-w-0 flex-1">
            <h2 className="truncate text-2xl font-semibold tracking-tight">{config.name}</h2>
            <p className="text-sm text-muted-foreground">
              {OS_LABELS[config.os]} · {formatBytes(vm.diskUsedBytes)} on disk
            </p>
          </div>
          <Button size="lg" onClick={() => onAction('start')} disabled={working}>
            {working ? <Loader2 className="size-4 animate-spin" aria-hidden /> : <Play className="size-4" aria-hidden />}
            Start
          </Button>
        </header>

        {vm.error && (
          <div role="alert" className="flex gap-3 rounded-lg border border-destructive/40 bg-destructive/10 p-3 text-sm">
            <AlertTriangle className="mt-0.5 size-4 shrink-0 text-destructive" aria-hidden />
            <div className="min-w-0 space-y-1">
              <p className="font-medium">It stopped with an error</p>
              <p className="whitespace-pre-wrap break-words text-xs text-muted-foreground">{vm.error}</p>
            </div>
          </div>
        )}

        <dl className="grid grid-cols-2 gap-2 sm:grid-cols-3">
          <Spec label="Memory" value={formatMemory(config.memoryMiB)} />
          <Spec label="Processors" value={`${config.cpus} ${config.cpus === 1 ? 'core' : 'cores'}`} />
          <Spec label="Disk" value={formatBytes(vm.diskSizeBytes)} />
          <Spec label="Firmware" value={firmware} />
          <Spec label="Network" value={network} />
          <Spec label="Sound" value={config.audio ? 'On' : 'Off'} />
        </dl>

        <CdromField
          path={config.cdrom}
          onChoose={() => void pick().then((file) => file && bridge.setCdrom(vm.id, file.path).catch(onError))}
          onEject={() => void bridge.setCdrom(vm.id, null).catch(onError)}
          hint={config.cdrom ? 'It starts from this disc while the disk has nothing to start.' : 'Put an installer’s disc image here to install a system.'}
        />

        <SnapshotList vm={vm} onTake={() => onAction('snapshot')} onError={onError} />

        <div className="flex justify-end">
          <Button variant="outline" onClick={() => onAction('settings')}>
            Settings…
          </Button>
        </div>
      </div>
    </div>
  );
}
