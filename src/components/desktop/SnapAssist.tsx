import { useEffect, useRef } from 'react';
import type { KeyboardEvent } from 'react';
import { X } from 'lucide-react';
import { AppIcon } from '@/components/desktop/AppIcon';
import { useInstalledApps } from '@/contexts/InstalledAppsContext';
import { useWorkAreas } from '@/contexts/MonitorsContext';
import { useWindowManager } from '@/contexts/WindowManagerContext';
import { snapGroup } from '@/hooks/useWindows';
import { EVEN_SPLIT, rectStyle, snapRect } from '@/lib/monitors';
import { dismissSnapAssist, emptyZones, useSnapAssistRequest } from '@/lib/snapAssist';
import { cn } from '@/lib/utils';

/** Gap between the panel and the edges of the space it fills, as the snap preview has. */
const INSET = 6;

const ZONE_NAMES = {
  left: 'left half',
  right: 'right half',
  'top-left': 'top left quarter',
  'top-right': 'top right quarter',
  'bottom-left': 'bottom left quarter',
  'bottom-right': 'bottom right quarter',
} as const;

/**
 * Snap Assist (src/lib/snapAssist.ts): after the user snaps a window, the
 * space left empty beside it lists their other windows, and picking one
 * snaps it there. It goes on to the next empty space until the monitor is
 * full or there are no windows left to offer; Escape, or a click anywhere
 * else, puts it away. Rendered in the workspace, over every window.
 */
export function SnapAssist() {
  const request = useSnapAssistRequest();
  const { windows, actions } = useWindowManager();
  const areas = useWorkAreas();
  const { getApp } = useInstalledApps();
  const panelRef = useRef<HTMLDivElement>(null);

  const anchor = request ? windows.find((w) => w.id === request.windowId) : undefined;
  // Still where the user snapped it. Until the snap commits it may not be
  // yet; once it has been, its leaving (or being dragged off) ends the offer.
  const placed =
    !!anchor && !anchor.closing && !anchor.away && !anchor.maximized &&
    anchor.snapped !== null && anchor.monitor === request?.areaId;
  const area = placed ? areas.find((a) => a.id === anchor.monitor) : undefined;
  const group = area && anchor ? snapGroup(windows, area.id, anchor.workspace).filter((w) => !w.minimized) : [];
  const zone = emptyZones(group.map((w) => w.snapped!), anchor?.snapped ?? null)[0];
  const inGroup = new Set(group.map((w) => w.id));
  const candidates = windows
    .filter((w) => !w.closing && !w.away && !w.tiled && !inGroup.has(w.id))
    .sort((a, b) => b.z - a.z);
  const offering = !!area && !!zone && candidates.length > 0;

  const seen = useRef<{ seq: number; placed: boolean }>({ seq: -1, placed: false });
  useEffect(() => {
    if (!request) return;
    if (seen.current.seq !== request.seq) seen.current = { seq: request.seq, placed: false };
    if (placed) seen.current.placed = true;
    if (seen.current.placed && !offering) dismissSnapAssist();
  }, [request, placed, offering]);

  // The first window takes focus, so the keyboard works it at once.
  const zoneKey = offering ? `${request?.seq}:${zone}` : '';
  useEffect(() => {
    if (zoneKey) panelRef.current?.querySelector<HTMLButtonElement>('[data-snap-candidate]')?.focus();
  }, [zoneKey]);

  useEffect(() => {
    if (!offering) return;
    const onKey = (e: globalThis.KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      e.preventDefault();
      e.stopPropagation();
      dismissSnapAssist();
    };
    // A press outside the workspace (the Dock, the menu bar) puts it away too.
    const onPointer = (e: PointerEvent) => {
      if (!panelRef.current?.contains(e.target as Node)) dismissSnapAssist();
    };
    window.addEventListener('keydown', onKey, true);
    window.addEventListener('pointerdown', onPointer, true);
    return () => {
      window.removeEventListener('keydown', onKey, true);
      window.removeEventListener('pointerdown', onPointer, true);
    };
  }, [offering]);

  if (!offering || !anchor) return null;

  const rect = snapRect(area, zone, anchor.split ?? EVEN_SPLIT);
  const pick = (id: string) => {
    actions.tile(id, zone, undefined, area.id);
    actions.focus(id);
  };
  const onKeyDown = (e: KeyboardEvent) => {
    const step = e.key === 'ArrowRight' || e.key === 'ArrowDown' ? 1 : e.key === 'ArrowLeft' || e.key === 'ArrowUp' ? -1 : 0;
    if (!step) return;
    const buttons = [...(panelRef.current?.querySelectorAll<HTMLButtonElement>('[data-snap-candidate]') ?? [])];
    const at = buttons.indexOf(document.activeElement as HTMLButtonElement);
    e.preventDefault();
    buttons[(at + step + buttons.length) % buttons.length]?.focus();
  };

  return (
    <>
      {/* Over every window, so a click anywhere (web pages included) puts it away. */}
      {areas.map((a) => (
        <div key={a.id} aria-hidden className="z-[9000]" style={rectStyle(a.bounds)} />
      ))}
      <div
        ref={panelRef}
        role="dialog"
        aria-label={`Choose a window for the ${ZONE_NAMES[zone]}`}
        onKeyDown={onKeyDown}
        className={cn(
          'absolute z-[9001] flex flex-col gap-3 rounded-xl border border-border/60 p-4',
          'bg-background/70 shadow-2xl ring-1 ring-black/20 backdrop-blur-xl',
          'motion-safe:animate-in motion-safe:fade-in-0 motion-safe:zoom-in-95 motion-safe:animation-duration-150',
        )}
        style={{
          left: rect.x + INSET,
          top: rect.y + INSET,
          width: rect.width - INSET * 2,
          height: rect.height - INSET * 2,
        }}
      >
        <div className="flex items-center gap-2">
          <p className="flex-1 truncate text-sm font-medium text-foreground">Choose a window for this space</p>
          <button
            type="button"
            aria-label="Dismiss"
            onClick={dismissSnapAssist}
            className="rounded-md p-1 text-muted-foreground hover:bg-foreground/10 hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            <X className="size-4" />
          </button>
        </div>
        <ul className="grid min-h-0 grid-cols-[repeat(auto-fill,minmax(7rem,1fr))] content-start gap-2 overflow-y-auto">
          {candidates.map((w) => {
            const app = getApp(w.appId);
            const label = w.title ?? app?.name ?? w.appId;
            return (
              <li key={w.id}>
                <button
                  type="button"
                  data-snap-candidate
                  title={label}
                  onClick={() => pick(w.id)}
                  className={cn(
                    'flex w-full flex-col items-center gap-2 rounded-lg p-3 transition-colors',
                    'hover:bg-foreground/10 focus-visible:bg-foreground/10 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
                  )}
                >
                  {app && <AppIcon icon={w.icon ?? app.icon} web={app.web} className="size-12" />}
                  <span className={cn('w-full truncate text-center text-xs', w.minimized ? 'text-muted-foreground' : 'text-foreground')}>
                    {label}
                  </span>
                </button>
              </li>
            );
          })}
        </ul>
      </div>
    </>
  );
}
