import { memo, useEffect, useRef, useState } from 'react';
import { Keyboard, LayoutDashboard } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Popover, PopoverClose, PopoverTrigger } from '@/components/ui/popover';
import { BarPopoverContent } from '@/components/desktop/BarPopoverContent';
import { Switch } from '@/components/ui/switch';
import { useAppContext } from '@/hooks/useAppContext';
import { activeWorkspace, homeArea, WORKSPACE_COUNT } from '@/hooks/useWindows';
import { useWindowActions, useWindowManager } from '@/contexts/WindowManagerContext';
import { useMonitors, useWorkAreas } from '@/contexts/MonitorsContext';
import { rectStyle } from '@/lib/monitors';
import { cn } from '@/lib/utils';
import { announce } from '@/lib/announce';

/** One monitor's workspaces, as the indicator shows them. */
interface MonitorWorkspaces {
  id: string;
  name: string;
  primary: boolean;
  active: number;
  /** Workspaces with windows on them. */
  used: number[];
}

/** Every monitor's workspaces, primary first. */
function useWorkspaces(): MonitorWorkspaces[] {
  const { windows, active } = useWindowManager();
  const areas = useWorkAreas();
  const { monitors } = useMonitors();
  const used = new Map<string, Set<number>>();
  for (const w of windows) {
    if (w.closing) continue;
    const area = homeArea(areas, w);
    if (!area) continue;
    const set = used.get(area.id) ?? new Set<number>();
    set.add(w.workspace);
    used.set(area.id, set);
  }
  return areas
    .map((a) => ({
      id: a.id,
      name: monitors.find((m) => m.id === a.id)?.name ?? 'Display',
      primary: a.primary,
      active: activeWorkspace(active, a.id),
      used: [...(used.get(a.id) ?? [])].sort((x, y) => x - y),
    }))
    .sort((a, b) => Number(b.primary) - Number(a.primary));
}

/** A workspace's key, as on the keyboard: 10 is 0. */
const workspaceLabel = (n: number) => (n === 10 ? '0' : String(n));

/**
 * The workspaces and tiling item, Waybar style: the primary monitor's busy
 * workspaces as numbers, the one showing highlighted. It appears only once
 * someone has gone looking - tiling is on, or a window or monitor is on a
 * workspace besides the first - so anyone who never presses Super+2 never
 * sees it. Clicking it opens the way back out: the tiling switch, every
 * monitor's workspaces, and the keyboard shortcuts.
 */
export function WorkspacesMenuItem() {
  const { config } = useAppContext();
  const monitors = useWorkspaces();
  const inUse = monitors.some((m) => m.active !== 1 || m.used.some((n) => n !== 1));
  if (!config.tilingEnabled && !inUse) return null;
  return <WorkspacesButton tiling={config.tilingEnabled} monitorsKey={JSON.stringify(monitors)} />;
}

const WorkspacesButton = memo(function WorkspacesButton({
  tiling,
  monitorsKey,
}: {
  tiling: boolean;
  /** The monitors' workspaces, serialized so the memo compares by value. */
  monitorsKey: string;
}) {
  const monitors = JSON.parse(monitorsKey) as MonitorWorkspaces[];
  const primary = monitors[0];
  const shown = primary ? [...new Set([...primary.used, primary.active])].sort((a, b) => a - b) : [];
  const label = `Workspace ${primary?.active ?? 1}${tiling ? ', tiling' : ''}`;

  return (
    <Popover>
      <PopoverTrigger asChild>
        <Button
          variant="ghost"
          aria-label={label}
          title={label}
          className="h-7 gap-1 rounded-md px-1.5 text-foreground/90 hover:bg-foreground/10 hover:text-foreground"
        >
          {tiling && <LayoutDashboard className="size-4" aria-hidden />}
          <span className="flex items-center gap-0.5" aria-hidden>
            {shown.map((n) => (
              <span
                key={n}
                className={cn(
                  'grid h-5 min-w-5 place-items-center rounded px-1 text-xs tabular-nums',
                  n === primary?.active ? 'bg-foreground/85 font-semibold text-background' : 'text-foreground/70',
                )}
              >
                {workspaceLabel(n)}
              </span>
            ))}
          </span>
        </Button>
      </PopoverTrigger>
      <BarPopoverContent align="end" className="w-80 p-0">
        <WorkspacesPopoverBody tiling={tiling} monitors={monitors} />
      </BarPopoverContent>
    </Popover>
  );
});

function WorkspacesPopoverBody({ tiling, monitors }: { tiling: boolean; monitors: MonitorWorkspaces[] }) {
  const { updateConfig } = useAppContext();
  const { open, showWorkspace } = useWindowActions();

  return (
    <div className="flex flex-col">
      <div className="flex items-center gap-2.5 border-b border-border/60 px-3 py-3">
        <LayoutDashboard
          className={cn('size-5 shrink-0', tiling ? 'text-foreground' : 'text-muted-foreground')}
          aria-hidden
        />
        <div className="flex min-w-0 flex-1 flex-col">
          <span className="text-sm text-foreground">Tiling</span>
          <span className="text-xs text-muted-foreground">
            Windows share the screen instead of overlapping.
          </span>
        </div>
        <Switch
          aria-label="Tiling"
          checked={tiling}
          onCheckedChange={(checked) => updateConfig((current) => ({ ...current, tilingEnabled: checked }))}
        />
      </div>

      <div className="flex flex-col gap-3 px-3 py-3">
        {monitors.map((m) => (
          <div key={m.id} className="flex flex-col gap-1.5">
            <span className="text-xs text-muted-foreground">
              {monitors.length > 1 ? `Workspaces on ${m.name}` : 'Workspaces'}
            </span>
            <div className="grid grid-cols-10 gap-1">
              {Array.from({ length: WORKSPACE_COUNT }, (_, i) => i + 1).map((n) => {
                const current = n === m.active;
                const busy = m.used.includes(n);
                return (
                  <button
                    key={n}
                    type="button"
                    aria-label={`Workspace ${n}${busy ? ', has windows' : ''}`}
                    aria-pressed={current}
                    onClick={() => showWorkspace(n, m.id)}
                    className={cn(
                      'relative grid h-7 place-items-center rounded-md text-xs tabular-nums transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
                      current
                        ? 'bg-primary font-semibold text-primary-foreground'
                        : busy
                          ? 'bg-foreground/10 text-foreground hover:bg-foreground/15'
                          : 'text-muted-foreground hover:bg-foreground/10 hover:text-foreground',
                    )}
                  >
                    {workspaceLabel(n)}
                  </button>
                );
              })}
            </div>
          </div>
        ))}
      </div>

      <footer className="border-t border-border/60 p-1.5">
        <PopoverClose asChild>
          <Button
            variant="ghost"
            size="sm"
            className="w-full justify-start text-muted-foreground hover:text-foreground"
            onClick={() => open('settings', { section: 'windows' })}
          >
            <Keyboard aria-hidden />
            Keyboard shortcuts
          </Button>
        </PopoverClose>
      </footer>
    </div>
  );
}

/** How long the workspace number stays up after a switch. */
const OSD_MS = 900;

/**
 * The workspace number, big in the middle of a monitor for a moment when it
 * switches workspace: monitors besides the primary have no menu bar to say
 * so. Positioned in the primary monitor's layer, like the other OSDs.
 */
export function WorkspaceOsd() {
  const { active } = useWindowManager();
  const { monitors, primary } = useMonitors();
  const [shown, setShown] = useState<{ monitor: string; n: number; key: number } | null>(null);
  const prev = useRef(active);

  useEffect(() => {
    const before = prev.current;
    prev.current = active;
    const changed = Object.keys(active).find((id) => activeWorkspace(active, id) !== activeWorkspace(before, id));
    if (!changed) return;
    const n = activeWorkspace(active, changed);
    setShown({ monitor: changed, n, key: Date.now() });
    announce(`Workspace ${n}`);
    const timer = window.setTimeout(() => setShown(null), OSD_MS);
    return () => window.clearTimeout(timer);
  }, [active]);

  const monitor = shown ? monitors.find((m) => m.id === shown.monitor) : undefined;
  if (!shown || !monitor) return null;
  return (
    <div
      aria-hidden
      className="pointer-events-none z-[9500] grid place-items-center"
      style={rectStyle({ ...monitor, x: monitor.x - primary.x, y: monitor.y - primary.y })}
    >
      <div
        key={shown.key}
        className="grid size-28 place-items-center rounded-3xl border border-border/60 bg-background/80 text-5xl font-semibold tabular-nums text-foreground shadow-lg backdrop-blur-md motion-safe:animate-in motion-safe:fade-in-0 motion-safe:zoom-in-90 motion-safe:animation-duration-150"
      >
        {workspaceLabel(shown.n)}
      </div>
    </div>
  );
}
