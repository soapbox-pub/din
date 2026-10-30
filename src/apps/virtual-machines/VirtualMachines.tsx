import { useCallback, useEffect, useRef, useState } from 'react';
import { AlertTriangle, Camera, Expand, Keyboard, Loader2, MoreHorizontal, Pause, Play, Plus, Power } from 'lucide-react';
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
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { DropdownMenu, DropdownMenuContent, DropdownMenuTrigger } from '@/components/ui/dropdown-menu';
import { Skeleton } from '@/components/ui/skeleton';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { cn } from '@/lib/utils';
import { cleanVmsError, type VmInfo, type VmInstallerId, type VmsBridge, type VmsStatus } from '@/lib/vms';
import type { MenuItem } from '@/sdk';
import { useDin, useMenuBar, useWindowTitle, WindowControls, WindowDragRegion } from '@/sdk/react';
import { formatBytes, formatMemory, isOn, OS_LABELS, STATE_LABELS, useBridge, usePickDiscImage, useVms, useVmsStatus } from './vms/bridge';
import { Console, type ConsoleHandle } from './vms/Console';
import { vmMenuItems, type VmAction } from './vms/actions';
import { VmActionItems } from './vms/ActionItems';
import { CdromField, OsBadge } from './vms/fields';
import { Gallery } from './vms/Gallery';
import { InstallCard } from './vms/InstallCard';
import { NewVmDialog } from './vms/NewVmDialog';
import { SettingsDialog } from './vms/SettingsDialog';
import { Sidebar, StateDot } from './vms/Sidebar';
import { SnapshotList, TakeSnapshotDialog } from './vms/Snapshots';

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
        <Button variant="ghost" size="icon" className="size-8" aria-label={label} onClick={onClick} disabled={disabled}>
          {children}
        </Button>
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
export function VirtualMachines() {
  const bridge = useBridge();
  const { data: status } = useVmsStatus();
  useWindowTitle('Virtual Machines');

  let body: React.ReactNode;
  if (!bridge) {
    body = <p className="m-auto max-w-sm p-8 text-center text-sm text-muted-foreground">Virtual Machines works in Din’s desktop app.</p>;
  } else if (!status) {
    body = <Skeleton className="m-auto h-24 w-72 rounded-xl" />;
  } else if (!status.available) {
    body = (
      <div className="m-auto max-w-md space-y-3 p-8 text-center">
        <AlertTriangle className="mx-auto size-10 text-amber-500" aria-hidden />
        <h1 className="text-lg font-semibold">Virtual machines can’t run here</h1>
        <p className="text-sm text-muted-foreground">This computer is missing {status.missing.join(' and ')}.</p>
      </div>
    );
  } else {
    return <Machines bridge={bridge} status={status} />;
  }
  return (
    <div className="flex h-full w-full flex-col bg-background text-foreground">
      <TitleBar />
      {body}
    </div>
  );
}

function Machines({ bridge, status }: { bridge: VmsBridge; status: VmsStatus }) {
  const din = useDin();
  const { data: vms = [], isLoading } = useVms();
  const [chosen, setChosen] = useState<string | null>(() => localStorage.getItem(SELECTED_KEY));
  const [scale, setScale] = useState(() => localStorage.getItem(SCALE_KEY) !== 'false');
  const [galleryOpen, setGalleryOpen] = useState(false);
  /** The form: undefined while closed, null for Other, else Custom Install of that system. */
  const [form, setForm] = useState<VmInstallerId | null | undefined>(undefined);
  const [cancelling, setCancelling] = useState<VmInfo | null>(null);
  /** Machines being installed whose screens are shown instead of their progress. */
  const [screens, setScreens] = useState<Set<string>>(new Set());
  const [settingsFor, setSettingsFor] = useState<string | null>(null);
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
    (err: unknown) => void din.notifications.show('Virtual Machines couldn’t do that', { body: cleanVmsError(err), transient: true }),
    [din],
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
            void din.notifications.show(`Asked “${target.config.name}” to shut down`, {
              body: 'If it doesn’t, its system isn’t listening for the power button: use Force Off.',
              transient: true,
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
          return setSettingsFor(id);
        case 'showInFiles':
          return void din.app.open('file-browser', { path: target.dir });
        case 'delete':
          return setDeleting(target);
        case 'cancelInstall':
          return setCancelling(target);
      }
    },
    [bridge, busy, din],
  );

  const install = useCallback(
    async (system: VmInstallerId) => {
      try {
        const created = await bridge.install(system);
        select(created.id);
        setGalleryOpen(false);
      } catch (err) {
        fail(err);
      }
    },
    [bridge, fail],
  );
  const custom = (system: VmInstallerId | null) => {
    setGalleryOpen(false);
    setForm(system);
  };
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
    if (id === 'new') setGalleryOpen(true);
    else if (id.startsWith('vm:') && vm) act(vm, id.slice(3) as VmAction);
    else if (id === 'scale') setScale((s) => !s);
    else if (id === 'fullscreen') consoleRef.current?.fullscreen();
    else if (id === 'cad') consoleRef.current?.sendCtrlAltDel();
    else if (id === 'super') sendKeys([KEY.super]);
    else if (id === 'print') sendKeys([KEY.print]);
    else if (id === 'zap') sendKeys([KEY.ctrl, KEY.alt, KEY.backspace]);
    else if (id.startsWith('vt:')) sendKeys([KEY.ctrl, KEY.alt, KEY.f(Number(id.slice(3)))]);
  });

  const settingsVm = vms.find((v) => v.id === settingsFor);
  const snapshotVm = vms.find((v) => v.id === snapshotFor);
  const working = vm ? pending.has(vm.id) : false;

  return (
    <div className="flex h-full w-full bg-background text-foreground">
      <Sidebar
        vms={vms}
        loading={isLoading}
        selected={vm?.id ?? null}
        onSelect={select}
        onNew={() => setGalleryOpen(true)}
        onAction={act}
        className="hidden sm:flex"
      />
      <main className="flex min-w-0 flex-1 flex-col">
        <TitleBar>
          {vm && (
            <>
              <div className="mr-2 flex min-w-0 items-center gap-2">
                <h1 className="truncate text-sm font-semibold">{vm.config.name}</h1>
                <span className="flex shrink-0 items-center gap-1.5 text-xs text-muted-foreground">
                  <StateDot state={vm.state} />
                  {STATE_LABELS[vm.state]}
                </span>
                {working && <Loader2 className="size-3.5 animate-spin text-muted-foreground" aria-label="Working" />}
              </div>
              <div className="flex-1" />
              {isOn(vm) && (
                <>
                  {vm.state === 'paused' ? (
                    <IconButton label="Resume" onClick={() => act(vm, 'resume')} disabled={working}>
                      <Play className="size-4" />
                    </IconButton>
                  ) : (
                    <IconButton label="Pause" onClick={() => act(vm, 'pause')} disabled={working || vm.state !== 'running'}>
                      <Pause className="size-4" />
                    </IconButton>
                  )}
                  <IconButton label="Send Ctrl+Alt+Delete" onClick={() => consoleRef.current?.sendCtrlAltDel()} disabled={!on}>
                    <Keyboard className="size-4" />
                  </IconButton>
                  <IconButton label="Take Snapshot" onClick={() => act(vm, 'snapshot')} disabled={!on}>
                    <Camera className="size-4" />
                  </IconButton>
                  <IconButton label="Full Screen" onClick={() => consoleRef.current?.fullscreen()} disabled={!on}>
                    <Expand className="size-4" />
                  </IconButton>
                  <IconButton label="Shut Down" onClick={() => act(vm, 'shutdown')} disabled={working || !on}>
                    <Power className="size-4" />
                  </IconButton>
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
              <Button variant="ghost" size="icon" className="size-8 sm:hidden" aria-label="New virtual machine" onClick={() => setGalleryOpen(true)}>
                <Plus className="size-4" />
              </Button>
            </>
          )}
        </TitleBar>

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
            onChooseIso={() => void pick().then((file) => file && busy(vm.id, () => bridge.retryInstall(vm.id, { iso: file.path })))}
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
      </main>

      <Dialog open={galleryOpen} onOpenChange={setGalleryOpen}>
        <DialogContent className="sm:max-w-xl">
          <DialogHeader>
            <DialogTitle>New Virtual Machine</DialogTitle>
            <DialogDescription>Pick a system and Din sets it all up. Right-click one to choose its settings first.</DialogDescription>
          </DialogHeader>
          <Gallery available={status.installers} onInstall={install} onCustom={custom} />
        </DialogContent>
      </Dialog>
      <NewVmDialog
        key={form ?? 'other'}
        system={form ?? null}
        open={form !== undefined}
        onOpenChange={(o) => !o && setForm(undefined)}
        status={status}
        existing={vms}
        onCreated={(created, start) => {
          select(created.id);
          if (start) act(created, 'start');
        }}
      />
      {settingsVm && (
        <SettingsDialog
          key={settingsVm.id}
          vm={settingsVm}
          status={status}
          onOpenChange={(o) => !o && setSettingsFor(null)}
          onRenamed={select}
        />
      )}
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
    <div className="rounded-lg border border-border/70 bg-muted/30 px-3 py-2.5">
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
