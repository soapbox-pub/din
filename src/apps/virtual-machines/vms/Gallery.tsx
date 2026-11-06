import { useState } from 'react';
import { Disc3, Loader2, Settings2 } from 'lucide-react';
import { ContextMenu, ContextMenuContent, ContextMenuItem, ContextMenuTrigger } from '@/components/ui/context-menu';
import { cn } from '@/lib/utils';
import type { VmInstallerId } from '@/lib/vms';
import { SYSTEMS, SYSTEM_STYLE } from './systems';


function Tile({
  label,
  sublabel,
  badge,
  onClick,
  disabled,
  busy,
  ...rest
}: {
  label: string;
  sublabel: string;
  badge: React.ReactNode;
  onClick: () => void;
  disabled?: boolean;
  busy?: boolean;
} & Omit<React.ComponentProps<'button'>, 'onClick'>) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      {...rest}
      className={cn(
        'group flex flex-col items-center gap-3 rounded-2xl bg-card clay p-5 text-center transition',
        'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
        'enabled:hover:-translate-y-0.5 enabled:hover:shadow-md motion-reduce:transform-none',
        'disabled:opacity-50',
      )}
    >
      <span className="relative">
        {badge}
        {busy && (
          <span className="absolute inset-0 grid place-items-center rounded-2xl bg-black/40">
            <Loader2 className="size-6 animate-spin text-white" aria-label="Working" />
          </span>
        )}
      </span>
      <span>
        <span className="block font-semibold">{label}</span>
        <span className="block text-xs text-muted-foreground">{sublabel}</span>
      </span>
    </button>
  );
}

/**
 * What to put on a new machine, one click each: Din makes the machine,
 * fetches the system and installs it. Right-click one for the full form,
 * filled in for it; Other is the form, for any disc image.
 */
export function Gallery({
  available,
  onInstall,
  onCustom,
  className,
}: {
  available: VmInstallerId[];
  onInstall: (id: VmInstallerId) => Promise<unknown>;
  onCustom: (id: VmInstallerId | null) => void;
  className?: string;
}) {
  const [busy, setBusy] = useState<VmInstallerId | null>(null);
  const install = async (id: VmInstallerId) => {
    if (busy) return;
    setBusy(id);
    try {
      await onInstall(id);
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className={cn('grid grid-cols-2 gap-3 sm:grid-cols-3', className)}>
      {SYSTEMS.map(({ id, name, maker }) => {
        const { icon: Icon, className: color } = SYSTEM_STYLE[id];
        const ready = available.includes(id);
        return (
          <ContextMenu key={id}>
            <ContextMenuTrigger asChild disabled={!ready}>
              <Tile
                label={name}
                sublabel={ready ? maker : 'Coming soon'}
                disabled={!ready || !!busy}
                busy={busy === id}
                onClick={() => void install(id)}
                aria-label={`Install ${name}`}
                badge={
                  <span className={cn('grid size-16 place-items-center rounded-2xl text-white shadow-sm', color)}>
                    <Icon className="size-9" />
                  </span>
                }
              />
            </ContextMenuTrigger>
            <ContextMenuContent className="w-48">
              <ContextMenuItem onSelect={() => void install(id)}>
                <Disc3 className="size-4" aria-hidden />
                Install
              </ContextMenuItem>
              <ContextMenuItem onSelect={() => onCustom(id)}>
                <Settings2 className="size-4" aria-hidden />
                Custom Install…
              </ContextMenuItem>
            </ContextMenuContent>
          </ContextMenu>
        );
      })}
      <Tile
        label="Other…"
        sublabel="From a disc image"
        disabled={!!busy}
        onClick={() => onCustom(null)}
        badge={
          <span className="grid size-16 place-items-center bg-foreground/[0.04] rounded-2xl text-muted-foreground">
            <Disc3 className="size-8" aria-hidden />
          </span>
        }
      />
    </div>
  );
}
