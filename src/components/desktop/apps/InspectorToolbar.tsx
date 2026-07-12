import { Check, Code, Monitor, PanelBottom, PanelRight, Smartphone, SquareArrowOutUpRight, X } from 'lucide-react';
import { cn } from '@/lib/utils';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { DEVICE_PRESETS } from '@/lib/devicePresets';

/**
 * Where a tab's inspector lives:
 *   'closed' - no inspector
 *   'bottom' - docked pane below the page (draggable height)
 *   'right'  - docked pane beside the page (draggable width)
 *   'window' - undocked into its own desktop window
 */
export type DockMode = 'closed' | 'bottom' | 'right' | 'window';

/** Dock positions offered in the inspector's dock-mode menu. */
const DOCK_OPTIONS: {
  mode: Exclude<DockMode, 'closed'>;
  label: string;
  icon: typeof PanelBottom;
}[] = [
  { mode: 'right', label: 'Dock to right', icon: PanelRight },
  { mode: 'bottom', label: 'Dock to bottom', icon: PanelBottom },
  { mode: 'window', label: 'Open in separate window', icon: SquareArrowOutUpRight },
];

/**
 * The control strip attached to the top edge of the inspector pane, so the
 * dock-position and (optionally) device-view controls read as part of the
 * inspector rather than the browser's chrome. Used both by the docked pane
 * (see WebBrowser's TabSurface) and the undocked DevTools window.
 *
 * The device menu is omitted (`onSelectDevice` unset) in the undocked window,
 * where the responsive frame - rendered in the browser window - can't follow.
 */
export function InspectorToolbar({
  dock,
  deviceId,
  onSetDock,
  onClose,
  onSelectDevice,
}: {
  dock: Exclude<DockMode, 'closed'>;
  /** Selected device preset id, or null. Only meaningful with onSelectDevice. */
  deviceId?: string | null;
  onSetDock: (mode: Exclude<DockMode, 'closed'>) => void;
  onClose: () => void;
  /** Provide to show the device menu; omit to hide it (undocked window). */
  onSelectDevice?: (deviceId: string | null) => void;
}) {
  const dockLabel =
    DOCK_OPTIONS.find((o) => o.mode === dock)?.label ?? 'Dock position';

  return (
    <div className="flex h-7 shrink-0 items-center gap-1 border-b border-border/60 bg-background/70 px-2">
      <Code className="size-3.5 shrink-0 text-muted-foreground" aria-hidden />
      <span className="flex-1 truncate text-xs font-medium text-foreground/80">
        Developer tools
      </span>

      {onSelectDevice && (
        <DeviceMenu deviceId={deviceId ?? null} onSelect={onSelectDevice} />
      )}

      <DropdownMenu>
        <DropdownMenuTrigger
          aria-label="Dock position"
          title={dockLabel}
          className={cn(
            'grid size-6 shrink-0 place-items-center rounded-md text-foreground/70',
            'hover:bg-foreground/10 hover:text-foreground',
            'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
          )}
        >
          {dock === 'right' ? (
            <PanelRight className="size-3.5" />
          ) : dock === 'window' ? (
            <SquareArrowOutUpRight className="size-3.5" />
          ) : (
            <PanelBottom className="size-3.5" />
          )}
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="w-52">
          <DropdownMenuLabel>Dock side</DropdownMenuLabel>
          {DOCK_OPTIONS.map(({ mode, label, icon: Icon }) => (
            <DropdownMenuItem key={mode} onSelect={() => onSetDock(mode)}>
              <Icon className="size-4" />
              <span className="flex-1">{label}</span>
              {dock === mode && <Check className="size-4" />}
            </DropdownMenuItem>
          ))}
        </DropdownMenuContent>
      </DropdownMenu>

      <button
        type="button"
        aria-label="Close developer tools"
        title="Close developer tools"
        onClick={onClose}
        className={cn(
          'grid size-6 shrink-0 place-items-center rounded-md text-foreground/70',
          'hover:bg-foreground/10 hover:text-foreground',
          'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
        )}
      >
        <X className="size-3.5" />
      </button>
    </div>
  );
}

/**
 * The device / responsive-view control: a button showing the current mode
 * with a menu to pick a device preset (or turn emulation off).
 */
function DeviceMenu({
  deviceId,
  onSelect,
}: {
  deviceId: string | null;
  onSelect: (deviceId: string | null) => void;
}) {
  const active = deviceId !== null;
  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        aria-label="Device view"
        aria-pressed={active}
        title="Device view"
        className={cn(
          'grid size-6 shrink-0 place-items-center rounded-md text-foreground/70',
          'hover:bg-foreground/10 hover:text-foreground',
          'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
          active && 'bg-foreground/10 text-foreground',
        )}
      >
        {active ? <Smartphone className="size-3.5" /> : <Monitor className="size-3.5" />}
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-56">
        <DropdownMenuLabel>Device</DropdownMenuLabel>
        <DropdownMenuItem onSelect={() => onSelect(null)}>
          <Monitor className="size-4" />
          <span className="flex-1">Responsive (no emulation)</span>
          {!active && <Check className="size-4" />}
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        {DEVICE_PRESETS.map((preset) => (
          <DropdownMenuItem key={preset.id} onSelect={() => onSelect(preset.id)}>
            {preset.mobile ? (
              <Smartphone className="size-4" />
            ) : (
              <Monitor className="size-4" />
            )}
            <span className="flex-1">{preset.name}</span>
            {deviceId === preset.id && <Check className="size-4" />}
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
