import { memo, useCallback, useEffect, useRef, useState } from 'react';
import { AppIcon } from '@/components/desktop/AppIcon';
import { NATIVE_APP_ICON } from '@/lib/appIcons';
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Skeleton } from '@/components/ui/skeleton';
import { useInstalledApps } from '@/contexts/InstalledAppsContext';
import { useBarSide } from '@/contexts/BarSideContext';
import { useTrayItems } from '@/hooks/useTray';
import { getTrayBridge, type TrayItem, type TrayMenuEntry } from '@/lib/tray';

/** Wheel travel per scroll step sent to an app, in the units apps expect. */
const SCROLL_STEP = 120;

/**
 * Apps' status icons (system tray), in the menu bar: one button per item.
 * A click activates the app (usually: shows its window); a right click opens
 * the item's menu, drawn by Din. Renders nothing outside the Electron shell
 * or while no app has an item.
 */
export const TrayItems = memo(function TrayItems() {
  const { data: items } = useTrayItems();
  // Passive items have nothing to say right now; the spec lets hosts hide them.
  const visible = (items ?? []).filter((item) => item.status !== 'Passive');
  if (visible.length === 0) return null;
  return (
    <div className="flex items-center gap-0.5" role="group" aria-label="Status icons">
      {visible.map((item) => (
        <TrayButton key={item.id} item={item} />
      ))}
    </div>
  );
});

function TrayButton({ item }: { item: TrayItem }) {
  const { getApp } = useInstalledApps();
  const app = item.appId ? getApp(item.appId) : undefined;
  const [open, setOpen] = useState(false);
  const label = item.title || item.tooltip.split('\n')[0] || app?.name || 'Status icon';
  const hint = item.tooltip && item.tooltip !== label ? `${label}\n${item.tooltip}` : label;

  const openMenu = useCallback(
    (x: number, y: number) => {
      const tray = getTrayBridge();
      if (item.menu) setOpen(true);
      // No menu Din can draw: the app may pop up its own.
      else void tray?.contextMenu(item.id, x, y);
    },
    [item.id, item.menu],
  );

  const activate = (x: number, y: number) => {
    const tray = getTrayBridge();
    if (!tray) return;
    if (item.itemIsMenu && item.menu) {
      setOpen(true);
      return;
    }
    // Apps that only have a menu (libappindicator's) refuse Activate.
    void tray.activate(item.id, x, y).then((taken) => {
      if (!taken && item.menu) setOpen(true);
    });
  };

  // Scroll needs a non-passive listener to keep the page from scrolling.
  const buttonRef = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    const button = buttonRef.current;
    if (!button) return;
    const onWheel = (event: WheelEvent) => {
      event.preventDefault();
      const horizontal = Math.abs(event.deltaX) > Math.abs(event.deltaY);
      const delta = horizontal ? event.deltaX : event.deltaY;
      if (delta === 0) return;
      // DOM wheel down is positive; apps take scrolling up as positive.
      void getTrayBridge()?.scroll(item.id, delta > 0 ? -SCROLL_STEP : SCROLL_STEP, horizontal ? 'horizontal' : 'vertical');
    };
    button.addEventListener('wheel', onWheel, { passive: false });
    return () => button.removeEventListener('wheel', onWheel);
  }, [item.id]);

  return (
    <DropdownMenu open={open} onOpenChange={setOpen} modal={false}>
      <DropdownMenuTrigger asChild>
        <button
          ref={buttonRef}
          type="button"
          aria-label={label}
          title={hint}
          // The trigger would open the menu on any press; clicks are the
          // app's to take first (handled below).
          onPointerDown={(event) => event.preventDefault()}
          // From the keyboard: Enter/Space activate like a click, the menu
          // key, Shift+F10 or Down open the menu. (The trigger would open the
          // menu on all of them; preventing default keeps it out.)
          onKeyDown={(event) => {
            const rect = event.currentTarget.getBoundingClientRect();
            const menuKey = event.key === 'ContextMenu' || event.key === 'ArrowDown' || (event.shiftKey && event.key === 'F10');
            if (menuKey) openMenu(rect.left, rect.bottom);
            else if (event.key === 'Enter' || event.key === ' ') activate(rect.left, rect.bottom);
            else return;
            event.preventDefault();
          }}
          onClick={(event) => activate(event.clientX, event.clientY)}
          onAuxClick={(event) => {
            if (event.button === 1) void getTrayBridge()?.secondaryActivate(item.id, event.clientX, event.clientY);
          }}
          onContextMenu={(event) => {
            event.preventDefault();
            openMenu(event.clientX, event.clientY);
          }}
          className="relative grid size-7 place-items-center rounded-md text-foreground/90 hover:bg-foreground/10 hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring data-[state=open]:bg-foreground/10"
        >
          <AppIcon icon={item.icon ?? app?.icon ?? NATIVE_APP_ICON} className="size-4.5 object-contain" />
          {item.status === 'NeedsAttention' && (
            <span aria-hidden className="absolute top-1 right-1 size-1.5 rounded-full bg-primary ring-2 ring-background" />
          )}
          {item.status === 'NeedsAttention' && <span className="sr-only">(needs attention)</span>}
        </button>
      </DropdownMenuTrigger>
      {open && <TrayMenuContent item={item} />}
    </DropdownMenu>
  );
}

/** An item's menu, read when it opens and again whenever the app changes it. */
function TrayMenuContent({ item }: { item: TrayItem }) {
  const side = useBarSide();
  const [entries, setEntries] = useState<TrayMenuEntry[] | null>(null);

  useEffect(() => {
    const tray = getTrayBridge();
    if (!tray) return;
    let live = true;
    const load = () =>
      void tray
        .menu(item.id)
        .then((menu) => live && setEntries(menu ?? []))
        .catch(() => live && setEntries([]));
    load();
    const off = tray.onMenuChanged((id) => {
      if (id === item.id) load();
    });
    return () => {
      live = false;
      off();
    };
  }, [item.id]);

  const pick = (entry: TrayMenuEntry) => void getTrayBridge()?.menuEvent(item.id, entry.id);

  return (
    <DropdownMenuContent side={side} align="end" sideOffset={8} className="min-w-48 max-w-80">
      {entries === null ? (
        <div className="space-y-2 p-2" aria-label="Loading menu">
          <Skeleton className="h-4 w-32" />
          <Skeleton className="h-4 w-24" />
          <Skeleton className="h-4 w-28" />
        </div>
      ) : entries.length === 0 ? (
        <p className="px-2 py-1 text-[13px] text-muted-foreground">No actions</p>
      ) : (
        <MenuEntries entries={entries} onPick={pick} />
      )}
    </DropdownMenuContent>
  );
}

function MenuEntries({ entries, onPick }: { entries: TrayMenuEntry[]; onPick: (entry: TrayMenuEntry) => void }) {
  // Once one entry has an icon or a check, the others' labels line up with its.
  const inset = entries.some((e) => e.type !== 'separator' && (e.icon || e.toggle === 'checkmark' || e.toggle === 'radio'));
  return (
    <>
      {entries.map((entry, index) => {
        if (entry.type === 'separator') {
          // Leading, trailing and doubled separators are noise.
          const previous = entries[index - 1];
          if (index === 0 || index === entries.length - 1 || previous?.type === 'separator') return null;
          return <DropdownMenuSeparator key={entry.id} />;
        }
        const content = (
          <>
            {entry.icon && <AppIcon icon={entry.icon} className="size-4 shrink-0 object-contain" />}
            <span className="truncate">{entry.label}</span>
          </>
        );
        if (entry.children.length > 0) {
          return (
            <DropdownMenuSub key={entry.id}>
              <DropdownMenuSubTrigger inset={inset && !entry.icon} disabled={!entry.enabled}>{content}</DropdownMenuSubTrigger>
              <DropdownMenuSubContent className="min-w-48 max-w-80">
                <MenuEntries entries={entry.children} onPick={onPick} />
              </DropdownMenuSubContent>
            </DropdownMenuSub>
          );
        }
        if (entry.toggle === 'checkmark') {
          return (
            <DropdownMenuCheckboxItem
              key={entry.id}
              checked={entry.checked}
              disabled={!entry.enabled}
              onSelect={() => onPick(entry)}
            >
              {content}
            </DropdownMenuCheckboxItem>
          );
        }
        if (entry.toggle === 'radio') {
          return (
            <DropdownMenuRadioGroup key={entry.id} value={entry.checked ? String(entry.id) : ''}>
              <DropdownMenuRadioItem value={String(entry.id)} disabled={!entry.enabled} onSelect={() => onPick(entry)}>
                {content}
              </DropdownMenuRadioItem>
            </DropdownMenuRadioGroup>
          );
        }
        return (
          <DropdownMenuItem
            key={entry.id}
            inset={inset && !entry.icon}
            disabled={!entry.enabled}
            onSelect={() => onPick(entry)}
          >
            {content}
          </DropdownMenuItem>
        );
      })}
    </>
  );
}
