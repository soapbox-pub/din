import { useId, type ReactNode } from 'react';
import { Disc3 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import { Slider } from '@/components/ui/slider';
import { Switch } from '@/components/ui/switch';
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group';
import { cn } from '@/lib/utils';
import type { VmInstallerId, VmOs, VmsStatus } from '@/lib/vms';
import { formatMemory, OS_LABELS } from './bridge';
import { OS_STYLE, SYSTEM_STYLE } from './systems';

/** A machine's badge: its system's mark (or its OS's glyph) on a rounded square. */
export function OsBadge({ os, system, className }: { os: VmOs; system?: VmInstallerId | null; className?: string }) {
  const { icon: Icon, className: color } = system ? SYSTEM_STYLE[system] : OS_STYLE[os];
  return (
    <span aria-hidden className={cn('grid size-8 shrink-0 place-items-center rounded-lg text-white shadow-sm', color, className)}>
      <Icon className="size-[55%]" />
    </span>
  );
}

export function OsPicker({ value, onChange }: { value: VmOs; onChange: (os: VmOs) => void }) {
  return (
    <ToggleGroup
      type="single"
      variant="outline"
      value={value}
      onValueChange={(v) => v && onChange(v as VmOs)}
      className="w-full"
      aria-label="Operating system"
    >
      {(['windows', 'linux', 'other'] as const).map((os) => (
        <ToggleGroupItem key={os} value={os} className="flex-1 gap-2">
          <OsBadge os={os} className="size-5 rounded-md" />
          {OS_LABELS[os]}
        </ToggleGroupItem>
      ))}
    </ToggleGroup>
  );
}

export function Field({ label, hint, children, htmlFor }: { label: string; hint?: ReactNode; children: ReactNode; htmlFor?: string }) {
  return (
    <div className="space-y-2">
      <Label htmlFor={htmlFor}>{label}</Label>
      {children}
      {hint && <p className="text-xs text-muted-foreground">{hint}</p>}
    </div>
  );
}

/** A slider with its value beside it. */
export function SliderField({
  label,
  value,
  min,
  max,
  step,
  format,
  onChange,
  hint,
  disabled,
}: {
  label: string;
  value: number;
  min: number;
  max: number;
  step: number;
  format: (n: number) => string;
  onChange: (n: number) => void;
  hint?: ReactNode;
  disabled?: boolean;
}) {
  return (
    <div className="space-y-2">
      <div className="flex items-baseline justify-between">
        <Label>{label}</Label>
        <span className="text-sm tabular-nums text-muted-foreground">{format(value)}</span>
      </div>
      <Slider
        value={[Math.min(Math.max(value, min), max)]}
        min={min}
        max={max}
        step={step}
        onValueChange={([v]) => onChange(v)}
        aria-label={label}
        disabled={disabled}
      />
      {hint && <p className="text-xs text-muted-foreground">{hint}</p>}
    </div>
  );
}

export function MemoryField({ value, onChange, status, disabled }: { value: number; onChange: (mib: number) => void; status: VmsStatus; disabled?: boolean }) {
  const max = Math.max(1024, Math.floor((status.hostMemoryMiB * 0.75) / 512) * 512);
  return (
    <SliderField
      label="Memory"
      value={value}
      min={512}
      max={max}
      step={512}
      format={formatMemory}
      onChange={onChange}
      disabled={disabled}
      hint={`Of this computer’s ${formatMemory(status.hostMemoryMiB)}, while the machine runs.`}
    />
  );
}

export function CpuField({ value, onChange, status, disabled }: { value: number; onChange: (n: number) => void; status: VmsStatus; disabled?: boolean }) {
  return (
    <SliderField
      label="Processors"
      value={value}
      min={1}
      max={Math.max(1, status.hostCpus)}
      step={1}
      format={(n) => `${n} ${n === 1 ? 'core' : 'cores'}`}
      onChange={onChange}
      disabled={disabled}
      hint={`Of this computer’s ${status.hostCpus}.`}
    />
  );
}

export function SwitchRow({
  label,
  description,
  checked,
  onChange,
  disabled,
}: {
  label: string;
  description?: ReactNode;
  checked: boolean;
  onChange: (checked: boolean) => void;
  disabled?: boolean;
}) {
  const id = useId();
  return (
    <div className="flex items-start justify-between gap-4">
      <div className="space-y-0.5">
        <Label htmlFor={id}>{label}</Label>
        {description && <p className="text-xs text-muted-foreground">{description}</p>}
      </div>
      <Switch id={id} checked={checked} onCheckedChange={onChange} disabled={disabled} />
    </div>
  );
}

/** The CD drive: what's in it, and buttons to change it. */
export function CdromField({
  path,
  onChoose,
  onEject,
  hint,
}: {
  path: string | null;
  onChoose: () => void;
  onEject: () => void;
  hint?: ReactNode;
}) {
  return (
    <div className="space-y-2">
      <Label>CD/DVD drive</Label>
      <div className="flex items-center gap-3 rounded-lg border border-border/70 bg-muted/30 p-3">
        <Disc3 className={cn('size-5 shrink-0', path ? 'text-primary' : 'text-muted-foreground')} aria-hidden />
        <div className="min-w-0 flex-1">
          <p className="truncate text-sm">{path ? path.slice(path.lastIndexOf('/') + 1) : 'Empty'}</p>
          {path && <p className="truncate text-xs text-muted-foreground" title={path}>{path}</p>}
        </div>
        {path && (
          <Button type="button" variant="ghost" size="sm" onClick={onEject}>
            Eject
          </Button>
        )}
        <Button type="button" variant="outline" size="sm" onClick={onChoose}>
          Choose…
        </Button>
      </div>
      {hint && <p className="text-xs text-muted-foreground">{hint}</p>}
    </div>
  );
}
