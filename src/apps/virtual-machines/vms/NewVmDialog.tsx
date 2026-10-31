import { useState, type FormEvent } from 'react';
import { ChevronDown, Loader2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { cleanVmsError, vmDefaults, type NewVm, type VmInfo, type VmInstallerId, type VmOs, type VmsStatus } from '@/lib/vms';
import { guessName, guessOs, OS_LABELS, useBridge, usePickDiscImage } from './bridge';
import { CdromField, CpuField, Field, MemoryField, OsBadge, OsPicker, SliderField, SwitchRow } from './fields';
import { SYSTEMS } from './systems';

function defaultsFor(os: VmOs, status: VmsStatus, system: VmInstallerId | null = null): Omit<NewVm, 'name' | 'cdrom'> {
  const d = { ...vmDefaults(os), system };
  return {
    ...d,
    // Never more than half of this computer.
    memoryMiB: Math.max(1024, Math.min(d.memoryMiB, Math.floor(status.hostMemoryMiB / 2 / 512) * 512)),
    cpus: Math.max(1, Math.min(d.cpus, Math.floor(status.hostCpus / 2))),
    secureBoot: d.secureBoot && status.secureBoot,
    tpm: d.tpm && status.tpm,
  };
}

/**
 * A new machine: a disc image to install from, what's on it (which picks
 * its hardware), and how big. Windows gets Windows 11's needs (UEFI with
 * Secure Boot, a TPM, 4 GB and up).
 *
 * With a `system`, it's Custom Install: that system, installed hands-free
 * like its tile does, from a disc image of the user's or Din's download.
 */
export function NewVmDialog({
  open,
  onOpenChange,
  status,
  existing,
  onCreated,
  system = null,
}: {
  system?: VmInstallerId | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  status: VmsStatus;
  existing: VmInfo[];
  onCreated: (vm: VmInfo, start: boolean) => void;
}) {
  const bridge = useBridge()!;
  const pick = usePickDiscImage();
  const [cdrom, setCdrom] = useState<string | null>(null);
  const [name, setName] = useState('');
  const [nameEdited, setNameEdited] = useState(false);
  const systemOs: VmOs = system === 'windows' || system === 'macos' ? system : system ? 'linux' : 'windows';
  const systemName = SYSTEMS.find((s) => s.id === system)?.name ?? null;
  const [vm, setVm] = useState(() => defaultsFor(systemOs, status, system));
  const [advanced, setAdvanced] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const reset = () => {
    setCdrom(null);
    setName('');
    setNameEdited(false);
    setVm(defaultsFor(systemOs, status, system));
    setAdvanced(false);
    setError(null);
  };

  const uniqueName = (base: string) => {
    const taken = new Set(existing.map((v) => v.id.toLowerCase()));
    if (!taken.has(base.toLowerCase())) return base;
    for (let n = 2; ; n++) if (!taken.has(`${base} ${n}`.toLowerCase())) return `${base} ${n}`;
  };

  const chooseImage = async () => {
    const file = await pick(system);
    if (!file) return;
    setCdrom(file.path);
    if (!system) setVm(defaultsFor(guessOs(file.name), status));
    if (!nameEdited) setName(uniqueName(guessName(file.name)));
  };

  const setOs = (os: VmOs) => {
    setVm(defaultsFor(os, status));
    if (!nameEdited && !cdrom) setName('');
  };

  const shownName = name || uniqueName(systemName ?? (vm.os === 'other' ? 'Virtual Machine' : OS_LABELS[vm.os]));

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      if (system) {
        const { memoryMiB, cpus, diskGiB } = vm;
        // It starts by itself once its disc image is ready.
        onCreated(await bridge.install(system, { iso: cdrom ?? undefined, name: shownName.trim(), memoryMiB, cpus, diskGiB }), false);
      } else {
        const created = await bridge.create({ ...vm, name: shownName.trim(), cdrom });
        onCreated(created, !!cdrom);
      }
      onOpenChange(false);
      reset();
    } catch (err) {
      setError(cleanVmsError(err));
    } finally {
      setBusy(false);
    }
  };

  const windowsWarning =
    vm.os === 'windows' && (!vm.tpm || !vm.secureBoot || vm.memoryMiB < 4096 || vm.diskGiB < 64)
      ? 'Windows 11 needs a TPM, Secure Boot, 4 GB of memory and a 64 GB disk.'
      : null;

  return (
    <Dialog
      open={open}
      onOpenChange={(o) => {
        if (!busy) onOpenChange(o);
        if (!o && !busy) reset();
      }}
    >
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-lg">
        <form onSubmit={submit} className="space-y-6">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-3">
              {system && <OsBadge os={vm.os} system={system} />}
              {systemName ? `Install ${systemName}` : 'New Virtual Machine'}
            </DialogTitle>
            <DialogDescription>
              {system === 'macos'
                ? 'It installs by itself; at the end, macOS’s Setup Assistant asks you a few questions. Everything here can be changed later in Settings.'
                : systemName
                ? `It sets itself up without asking anything. Everything here can be changed later in Settings.`
                : 'Choose the installer’s disc image, and the machine is set up to suit it.'}
            </DialogDescription>
          </DialogHeader>

          <CdromField
            path={cdrom}
            onChoose={() => void chooseImage()}
            onEject={() => setCdrom(null)}
            hint={
              systemName
                ? cdrom
                  ? `It installs from this disc image instead of downloading ${systemName}.`
                  : `Leave it empty and Din downloads the newest ${systemName}.`
                : cdrom
                  ? 'It starts from this disc to install.'
                  : 'An .iso file, like the ones Windows and Linux are downloaded as. You can add one later.'
            }
          />

          {!system && (
            <Field label="Operating system">
              <OsPicker value={vm.os} onChange={setOs} />
            </Field>
          )}

          <Field label="Name" htmlFor="vm-name">
            <Input
              id="vm-name"
              value={shownName}
              onChange={(e) => {
                setName(e.target.value);
                setNameEdited(true);
              }}
              maxLength={64}
              required
            />
          </Field>

          <MemoryField value={vm.memoryMiB} onChange={(memoryMiB) => setVm({ ...vm, memoryMiB })} status={status} />
          <CpuField value={vm.cpus} onChange={(cpus) => setVm({ ...vm, cpus })} status={status} />
          <SliderField
            label="Disk"
            value={vm.diskGiB}
            min={8}
            max={1024}
            step={8}
            format={(n) => `${n} GB`}
            onChange={(diskGiB) => setVm({ ...vm, diskGiB })}
            hint="It only takes up what the machine writes to it, and can grow later."
          />

          {!system && <Collapsible open={advanced} onOpenChange={setAdvanced}>
            <CollapsibleTrigger asChild>
              <Button type="button" variant="ghost" size="sm" className="-ml-2 gap-1 text-muted-foreground">
                <ChevronDown className={advanced ? 'size-4 rotate-180 transition-transform' : 'size-4 transition-transform'} aria-hidden />
                Firmware and devices
              </Button>
            </CollapsibleTrigger>
            <CollapsibleContent className="space-y-4 pt-3">
              <SwitchRow
                label="UEFI"
                description="Modern firmware. Off is a legacy BIOS, for older systems."
                checked={vm.firmware === 'uefi'}
                onChange={(on) => setVm({ ...vm, firmware: on ? 'uefi' : 'bios', secureBoot: on && vm.secureBoot })}
              />
              <SwitchRow
                label="Secure Boot"
                description={status.secureBoot ? 'Starts only systems signed by Microsoft’s keys: Windows, and Linux with shim.' : 'Microsoft’s keys for the firmware aren’t installed.'}
                checked={vm.secureBoot}
                onChange={(secureBoot) => setVm({ ...vm, secureBoot })}
                disabled={vm.firmware !== 'uefi' || !status.secureBoot}
              />
              <SwitchRow
                label="TPM 2.0"
                description={status.tpm ? 'A security chip, which Windows 11 needs.' : 'swtpm isn’t installed.'}
                checked={vm.tpm}
                onChange={(tpm) => setVm({ ...vm, tpm })}
                disabled={!status.tpm}
              />
              <SwitchRow label="Network" description="Through this computer’s connection." checked={vm.network} onChange={(network) => setVm({ ...vm, network })} />
              <SwitchRow label="Sound" description="Through this computer’s speakers and microphone." checked={vm.audio} onChange={(audio) => setVm({ ...vm, audio })} />
            </CollapsibleContent>
          </Collapsible>}

          {windowsWarning && <p className="rounded-lg bg-amber-500/10 px-3 py-2 text-xs text-amber-700 dark:text-amber-300">{windowsWarning}</p>}
          {error && <p role="alert" className="text-sm text-destructive">{error}</p>}

          <DialogFooter>
            <Button type="button" variant="ghost" onClick={() => onOpenChange(false)} disabled={busy}>
              Cancel
            </Button>
            <Button type="submit" disabled={busy || !shownName.trim()}>
              {busy && <Loader2 className="size-4 animate-spin" aria-hidden />}
              {system ? 'Install' : cdrom ? 'Create and Start' : 'Create'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
