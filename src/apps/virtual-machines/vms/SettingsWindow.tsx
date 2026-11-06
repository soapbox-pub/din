import { useState, type FormEvent } from 'react';
import { Loader2, Plus, Trash2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { cleanVmsError, type VmConfig, type VmInfo, type VmPortForward, type VmsStatus } from '@/lib/vms';
import { formatBytes, isOn, useBridge, usePickDiscImage } from './bridge';
import { CdromField, CpuField, Field, MemoryField, OsPicker, SwitchRow } from './fields';
import { announce } from './windows';
import { FormWindow } from '@/shared/appChrome';
import { SettingsSubHeading } from '@/shared/settingsSection';

function Forwards({ value, onChange }: { value: VmPortForward[]; onChange: (forwards: VmPortForward[]) => void }) {
  const set = (i: number, patch: Partial<VmPortForward>) => onChange(value.map((f, j) => (i === j ? { ...f, ...patch } : f)));
  const port = (s: string) => Math.min(65535, Math.max(0, Number.parseInt(s, 10) || 0));
  return (
    <div className="space-y-2">
      {value.length === 0 && (
        <p className="rounded-lg px-3 py-4 text-center text-xs text-muted-foreground">
          Reach a server in the machine from this computer, like SSH on port 22.
        </p>
      )}
      {value.map((f, i) => (
        <div key={i} className="flex items-center gap-2">
          <Select value={f.protocol} onValueChange={(protocol) => set(i, { protocol: protocol as 'tcp' | 'udp' })}>
            <SelectTrigger className="w-20" aria-label="Protocol">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="tcp">TCP</SelectItem>
              <SelectItem value="udp">UDP</SelectItem>
            </SelectContent>
          </Select>
          <Input
            inputMode="numeric"
            aria-label="Port on this computer"
            placeholder="This computer"
            value={f.host || ''}
            onChange={(e) => set(i, { host: port(e.target.value) })}
            className="flex-1"
          />
          <span className="text-muted-foreground" aria-hidden>→</span>
          <Input
            inputMode="numeric"
            aria-label="Port in the machine"
            placeholder="Machine"
            value={f.guest || ''}
            onChange={(e) => set(i, { guest: port(e.target.value) })}
            className="flex-1"
          />
          <Button type="button" variant="ghost" size="icon" aria-label="Remove" onClick={() => onChange(value.filter((_, j) => j !== i))}>
            <Trash2 className="size-4.5" strokeWidth={1.75} />
          </Button>
        </div>
      ))}
      <Button type="button" variant="outline" size="sm" onClick={() => onChange([...value, { protocol: 'tcp', host: 0, guest: 0 }])}>
        <Plus className="size-4.5" strokeWidth={1.75} aria-hidden />
        Add Port
      </Button>
    </div>
  );
}

/** A machine's settings. Hardware changes made while it runs take effect when it next starts. */
export function SettingsWindow({ vm, status }: { vm: VmInfo; status: VmsStatus }) {
  const bridge = useBridge()!;
  const pick = usePickDiscImage();
  const [config, setConfig] = useState<VmConfig>(vm.config);
  const currentGiB = Math.round(vm.diskSizeBytes / 1024 ** 3);
  const [diskGiB, setDiskGiB] = useState(currentGiB);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const on = isOn(vm);
  const patch = (p: Partial<VmConfig>) => setConfig((c) => ({ ...c, ...p }));

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const forwards = config.forwards.filter((f) => f.host && f.guest);
      const saved = await bridge.update(vm.id, { ...config, forwards });
      if (diskGiB > currentGiB) await bridge.resizeDisk(saved.id, diskGiB);
      if (saved.id !== vm.id) announce({ type: 'renamed', id: saved.id });
      window.close();
    } catch (err) {
      setError(cleanVmsError(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <form onSubmit={submit} className="contents">
      <FormWindow
        title={`${vm.config.name} Settings`}
        description={on ? 'It’s running: changes to its hardware take effect when it next starts.' : 'Kept in its folder, with its disk.'}
        className="gap-5"
        footer={
          <>
            <Button type="button" variant="ghost" onClick={() => window.close()} disabled={busy}>
              Cancel
            </Button>
            <Button type="submit" disabled={busy || !config.name.trim()}>
              {busy && <Loader2 className="size-4 animate-spin" aria-hidden />}
              Save
            </Button>
          </>
        }
      >
              <Field label="Name" htmlFor="vm-settings-name" hint={on ? 'Turn it off to rename it.' : undefined}>
                <Input
                  id="vm-settings-name"
                  value={config.name}
                  onChange={(e) => patch({ name: e.target.value })}
                  maxLength={64}
                  disabled={on}
                  required
                />
              </Field>
              <Field label="Operating system" hint="Windows gets hardware its installer has drivers for; macOS gets a Mac’s, with OpenCore to start it; Linux gets faster virtio devices.">
                <OsPicker value={config.os} onChange={(os) => patch({ os })} />
              </Field>
              <Field label="Folder">
                <p className="truncate text-sm text-muted-foreground" title={vm.dir}>{vm.dir}</p>
              </Field>

              <SettingsSubHeading>System</SettingsSubHeading>
              <MemoryField value={config.memoryMiB} onChange={(memoryMiB) => patch({ memoryMiB })} status={status} />
              <CpuField value={config.cpus} onChange={(cpus) => patch({ cpus })} status={status} />
              <SwitchRow
                label="UEFI"
                description={on ? 'Turn it off to change its firmware.' : 'Changing the firmware forgets its boot settings.'}
                checked={config.firmware === 'uefi'}
                onChange={(uefi) => patch({ firmware: uefi ? 'uefi' : 'bios', secureBoot: uefi && config.secureBoot })}
                disabled={on}
              />
              <SwitchRow
                label="Secure Boot"
                checked={config.secureBoot}
                onChange={(secureBoot) => patch({ secureBoot })}
                disabled={on || config.firmware !== 'uefi' || !status.secureBoot}
              />
              <SwitchRow label="TPM 2.0" checked={config.tpm} onChange={(tpm) => patch({ tpm })} disabled={!status.tpm} />
              <SwitchRow label="Sound" checked={config.audio} onChange={(audio) => patch({ audio })} />

              <SettingsSubHeading>Storage</SettingsSubHeading>
              <CdromField
                path={config.cdrom}
                onChoose={() => void pick().then((file) => file && patch({ cdrom: file.path }))}
                onEject={() => patch({ cdrom: null })}
                hint={on ? 'Changes as soon as you save.' : undefined}
              />
              <Field
                label="Disk size"
                htmlFor="vm-disk-size"
                hint={on ? 'Turn it off to grow its disk.' : `It takes up ${formatBytes(vm.diskUsedBytes)} now. Grow the partition inside the machine afterwards.`}
              >
                <div className="flex items-center gap-2">
                  <Input
                    id="vm-disk-size"
                    type="number"
                    min={currentGiB}
                    max={65536}
                    value={diskGiB}
                    onChange={(e) => setDiskGiB(Math.max(currentGiB, Number.parseInt(e.target.value, 10) || currentGiB))}
                    disabled={on}
                    className="w-32"
                  />
                  <span className="text-sm text-muted-foreground">GB</span>
                </div>
              </Field>

              <SettingsSubHeading>Network</SettingsSubHeading>
              <SwitchRow
                label="Network"
                description="Through this computer’s connection (NAT)."
                checked={config.network}
                onChange={(network) => patch({ network })}
              />
              {config.network && (
                <Field label="Port forwarding" hint="Ports open on this computer only (127.0.0.1).">
                  <Forwards value={config.forwards} onChange={(forwards) => patch({ forwards })} />
                </Field>
              )}

          {error && <p role="alert" className="px-1 text-sm text-destructive">{error}</p>}
      </FormWindow>
    </form>
  );
}
