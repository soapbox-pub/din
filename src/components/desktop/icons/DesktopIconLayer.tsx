import { useCallback, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { AppWindow, ClipboardCopy, FolderOpen, Pencil, SquareArrowOutUpRight, Trash2 } from 'lucide-react';
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuShortcut,
  ContextMenuSub,
  ContextMenuSubContent,
  ContextMenuSubTrigger,
  ContextMenuTrigger,
} from '@/components/ui/context-menu';
import { AppIcon } from '@/components/desktop/AppIcon';
import { useDesktopIcons, type DesktopIcon, type DesktopIconsContextValue } from '@/contexts/DesktopIconsContext';
import { useInstalledApps } from '@/contexts/InstalledAppsContext';
import { useAppContext } from '@/hooks/useAppContext';
import { useToast } from '@/hooks/useToast';
import { DESKTOP_ICON_SIZES, type Rect } from '@/lib/desktopIcons';
import { dockTakes } from '@/lib/dockDrop';
import { cleanFsError, localFileUrl } from '@/lib/fs';
import { entryApp } from '@/lib/openPath';
import { cn } from '@/lib/utils';
import { FileIcon } from '@/shared/FileIcon';
import { ScreenLayer } from '@/components/desktop/MonitorsProvider';
import { useDragPoint } from '@/lib/dinDrag';
import {
  endIconDrag,
  setIconLayer,
  startIconDrag,
  useDropPreview,
  useFolderDrop,
  useIconDrag,
  useSelectionBand,
  useWallpaper,
  type IconDrag,
} from './wallpaper';

/** The icons a menu or key acts on: the selection, if the icon is in it, else the icon alone. */
function targetsOf(icons: DesktopIconsContextValue, name: string): string[] {
  return icons.selected.has(name) ? [...icons.selected] : [name];
}

/**
 * What's in ~/Desktop, as icons over the wallpaper and under every window
 * (and the widgets' cells). The layer itself takes no clicks, so the bare
 * wallpaper beneath stays DesktopMenu's.
 */
export function DesktopIconLayer() {
  const icons = useDesktopIcons();
  const band = useSelectionBand();
  const drag = useIconDrag();
  const preview = useDropPreview();
  const { toast } = useToast();
  const layerRef = useCallback((el: HTMLDivElement | null) => setIconLayer(el), []);

  const focusIcon = (name: string) => {
    document.querySelector<HTMLElement>(`[data-desktop-icon="${CSS.escape(name)}"]`)?.focus();
  };

  const fail = (title: string) => (error: unknown) => toast({ title, description: cleanFsError(error), variant: 'destructive' });

  const onKeyDown = (e: React.KeyboardEvent) => {
    const el = e.target instanceof HTMLElement ? e.target.closest<HTMLElement>('[data-desktop-icon]') : null;
    const name = el?.dataset.desktopIcon;
    if (!name || icons.renaming) return;
    const targets = targetsOf(icons, name);
    if (e.key === 'Enter') {
      e.preventDefault();
      void icons.open(targets);
    } else if (e.key === 'F2') {
      e.preventDefault();
      icons.setRenaming(name);
    } else if (e.key === 'Delete') {
      e.preventDefault();
      void icons.trash(targets).catch(fail('Couldn’t move to the Trash'));
    } else if (e.key === 'Escape') {
      icons.setSelected(new Set());
    } else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'a') {
      e.preventDefault();
      icons.setSelected(new Set(icons.icons.map((i) => i.name)));
    } else if (e.key.startsWith('Arrow')) {
      e.preventDefault();
      const next = neighbor(icons, name, e.key);
      if (!next) return;
      icons.setSelected(e.shiftKey ? new Set([...icons.selected, next]) : new Set([next]));
      focusIcon(next);
    }
  };

  if (!icons.shown) return <div ref={layerRef} aria-hidden className="pointer-events-none absolute inset-0" />;

  // One icon is in the tab order: the first selected, else the first.
  const tabStop = icons.icons.find((i) => icons.selected.has(i.name))?.name ?? icons.icons[0]?.name;

  return (
    <div
      ref={layerRef}
      role="listbox"
      aria-label="Desktop icons"
      aria-multiselectable
      className="pointer-events-none absolute inset-0"
      onKeyDown={onKeyDown}
    >
      {preview?.map((rect) => (
        <div
          key={`${rect.left},${rect.top}`}
          aria-hidden
          className="absolute rounded-md border border-white/70 bg-white/15 shadow-[0_0_0_1px_rgb(0_0_0/0.25)]"
          style={{ left: rect.left + 2, top: rect.top + 2, width: rect.width - 4, height: rect.height - 4 }}
        />
      ))}
      {drag && <IconDragGhost drag={drag} />}
      {icons.icons.map((icon) => {
        const place = icons.places.get(icon.name);
        return place ? (
          <DesktopIconTile
            key={icon.name}
            icon={icon}
            rect={place.rect}
            selected={icons.selected.has(icon.name)}
            renaming={icons.renaming === icon.name}
            tabbable={tabStop === icon.name}
            lifted={!!drag?.names.includes(icon.name)}
          />
        ) : null;
      })}
      {band && (
        <div
          aria-hidden
          className="absolute rounded-sm border border-primary/80 bg-primary/20"
          style={band}
        />
      )}
    </div>
  );
}

/** The nearest icon in an arrow's direction, by where they sit. */
function neighbor(icons: DesktopIconsContextValue, name: string, key: string): string | null {
  const from = icons.places.get(name)?.rect;
  if (!from) return null;
  const cx = from.left + from.width / 2;
  const cy = from.top + from.height / 2;
  let best: { name: string; score: number } | null = null;
  for (const [other, p] of icons.places) {
    if (other === name) continue;
    const dx = p.rect.left + p.rect.width / 2 - cx;
    const dy = p.rect.top + p.rect.height / 2 - cy;
    const along = key === 'ArrowRight' ? dx : key === 'ArrowLeft' ? -dx : key === 'ArrowDown' ? dy : -dy;
    const across = key === 'ArrowRight' || key === 'ArrowLeft' ? Math.abs(dy) : Math.abs(dx);
    if (along <= 0) continue;
    const score = along + across * 2;
    if (!best || score < best.score) best = { name: other, score };
  }
  return best?.name ?? null;
}

function DesktopIconTile({
  icon,
  rect,
  selected,
  renaming,
  tabbable,
  lifted,
}: {
  icon: DesktopIcon;
  rect: Rect;
  selected: boolean;
  renaming: boolean;
  tabbable: boolean;
  /** Being dragged: its ghost follows the pointer, and it fades where it was. */
  lifted: boolean;
}) {
  const icons = useDesktopIcons();
  const { config } = useAppContext();
  const { apps } = useInstalledApps();
  const { toast } = useToast();
  const wallpaper = useWallpaper();
  const folderDrop = useFolderDrop(icon.name);
  const [dropping, setDropping] = useState(false);
  // Rename keeps focus from going back to the icon as the menu closes.
  const renameChosen = useRef(false);
  const size = DESKTOP_ICON_SIZES[config.desktopIconSize];
  const folder = icon.kind === 'directory';

  const fail = (title: string) => (error: unknown) => toast({ title, description: cleanFsError(error), variant: 'destructive' });
  const targets = () => targetsOf(icons, icon.name);
  const single = !selected || icons.selected.size === 1;
  const openWithApps = single && !icon.entry
    ? apps.filter((a) => !a.hidden && !a.native && dockTakes(a.id, [{ path: icon.path, folder }]))
    : [];

  const onClick = (e: React.MouseEvent) => {
    if (e.ctrlKey || e.metaKey) {
      const next = new Set(icons.selected);
      if (next.has(icon.name)) next.delete(icon.name);
      else next.add(icon.name);
      icons.setSelected(next);
    } else if (e.shiftKey) {
      icons.setSelected(new Set([...icons.selected, icon.name]));
    } else {
      icons.setSelected(new Set([icon.name]));
    }
  };

  const copyPaths = () => {
    const paths = targets().flatMap((name) => icons.icons.find((i) => i.name === name)?.path ?? []);
    void navigator.clipboard?.writeText(paths.join('\n')).catch(() => {});
  };

  return (
    <ContextMenu>
      <ContextMenuTrigger asChild disabled={renaming}>
        <div
          role="option"
          aria-selected={selected}
          aria-label={icon.label}
          data-desktop-icon={icon.name}
          tabIndex={tabbable ? 0 : -1}
          title={icon.entry ? icon.label : icon.name}
          draggable={!renaming}
          onClick={onClick}
          onDoubleClick={() => void icons.open(targets())}
          onContextMenu={() => {
            if (!selected) icons.setSelected(new Set([icon.name]));
          }}
          onDragStart={(e) => {
            if (!selected) icons.setSelected(new Set([icon.name]));
            startIconDrag(e, icons, icon.name);
          }}
          onDragEnd={endIconDrag}
          onDragOver={(e) => {
            if (folder && folderDrop.accepts(e)) {
              e.preventDefault();
              e.stopPropagation();
              e.dataTransfer.dropEffect = e.ctrlKey ? 'copy' : 'move';
              setDropping(true);
            } else {
              wallpaper.onDragOver(e);
            }
          }}
          onDragLeave={() => setDropping(false)}
          onDrop={(e) => {
            setDropping(false);
            if (folder && folderDrop.accepts(e)) void folderDrop.onDrop(e);
            else wallpaper.onDrop(e);
          }}
          className={cn(
            'group pointer-events-auto absolute flex flex-col items-center gap-1 rounded-md border px-1 pt-1.5 pb-1 outline-none select-none',
            'focus-visible:border-white/70',
            selected
              ? 'z-10 border-white/40 bg-white/25 hover:bg-white/30'
              : 'border-transparent hover:border-white/25 hover:bg-white/15',
            dropping && 'border-white/70 bg-white/35',
            lifted && 'opacity-50',
          )}
          style={{ left: rect.left + 2, top: rect.top + 2, width: rect.width - 4, minHeight: rect.height - 4 }}
        >
          {renaming ? (
            <>
              <IconImage icon={icon} px={size.icon} />
              <RenameField
                icon={icon}
                onDone={(to) => {
                  icons.setRenaming(null);
                  if (to !== null && to.trim() && to.trim() !== icon.name) {
                    void icons.rename(icon.name, to).catch(fail(`Couldn’t rename ${icon.name}`));
                  }
                }}
              />
            </>
          ) : (
            <IconFace icon={icon} px={size.icon} full={selected && single} />
          )}
        </div>
      </ContextMenuTrigger>
      <ContextMenuContent
        className="w-56"
        onCloseAutoFocus={(e) => {
          if (!renameChosen.current) return;
          renameChosen.current = false;
          e.preventDefault();
        }}
      >
        <ContextMenuItem onSelect={() => void icons.open(targets())}>
          <SquareArrowOutUpRight aria-hidden /> Open
          <ContextMenuShortcut>Enter</ContextMenuShortcut>
        </ContextMenuItem>
        {openWithApps.length > 0 && (
          <ContextMenuSub>
            <ContextMenuSubTrigger className="gap-2">
              <AppWindow aria-hidden /> Open With
            </ContextMenuSubTrigger>
            <ContextMenuSubContent className="w-52">
              {openWithApps.map((app) => (
                <ContextMenuItem key={app.id} onSelect={() => icons.openWith(app.id, [icon.name])}>
                  <AppIcon icon={app.icon} web={app.web} className="size-4" /> {app.name}
                </ContextMenuItem>
              ))}
            </ContextMenuSubContent>
          </ContextMenuSub>
        )}
        <ContextMenuSeparator />
        <ContextMenuItem onSelect={() => icons.showInFiles(targets())}>
          <FolderOpen aria-hidden /> Show in Files
        </ContextMenuItem>
        <ContextMenuItem onSelect={copyPaths}>
          <ClipboardCopy aria-hidden /> {single ? 'Copy Path' : 'Copy Paths'}
        </ContextMenuItem>
        <ContextMenuSeparator />
        {single && (
          <ContextMenuItem
            onSelect={() => {
              renameChosen.current = true;
              icons.setSelected(new Set([icon.name]));
              icons.setRenaming(icon.name);
            }}
          >
            <Pencil aria-hidden /> Rename…
            <ContextMenuShortcut>F2</ContextMenuShortcut>
          </ContextMenuItem>
        )}
        <ContextMenuItem variant="destructive" onSelect={() => void icons.trash(targets()).catch(fail('Couldn’t move to the Trash'))}>
          <Trash2 aria-hidden /> Move to Trash
          <ContextMenuShortcut>Delete</ContextMenuShortcut>
        </ContextMenuItem>
      </ContextMenuContent>
    </ContextMenu>
  );
}

/** An icon's picture and label; `full` shows the whole label, else two lines of it. */
function IconFace({ icon, px, full = false }: { icon: DesktopIcon; px: number; full?: boolean }) {
  return (
    <>
      <IconImage icon={icon} px={px} />
      <span
        className={cn(
          'max-w-full px-0.5 text-center text-xs leading-tight text-white [overflow-wrap:anywhere]',
          '[text-shadow:0_0_2px_rgb(0_0_0),0_1px_2px_rgb(0_0_0/0.9),0_0_6px_rgb(0_0_0/0.5)]',
          !full && 'line-clamp-2',
        )}
      >
        {icon.label}
      </span>
    </>
  );
}

/**
 * The icons being dragged, following the pointer over everything, as they
 * sit relative to each other. The pointer comes from the desktop's own
 * surfaces and the apps' windows (`useDragPoint`).
 */
function IconDragGhost({ drag }: { drag: IconDrag }) {
  const icons = useDesktopIcons();
  const { config } = useAppContext();
  const at = useDragPoint();
  const from = icons.places.get(drag.anchor)?.rect;
  if (!at || !from) return null;
  const size = DESKTOP_ICON_SIZES[config.desktopIconSize];
  return createPortal(
    // A layer over every monitor, since the point is in viewport coordinates.
    <ScreenLayer aria-hidden className="pointer-events-none z-[2147483647]">
      {drag.names.map((name) => {
        const icon = icons.icons.find((i) => i.name === name);
        const rect = icons.places.get(name)?.rect;
        if (!icon || !rect) return null;
        return (
          <div
            key={name}
            className="absolute left-0 top-0 flex flex-col items-center gap-1 rounded-md border border-white/30 bg-white/15 px-1 pt-1.5 pb-1 opacity-80"
            style={{
              width: rect.width - 4,
              minHeight: rect.height - 4,
              transform: `translate(${at.x - drag.dx + rect.left - from.left}px, ${at.y - drag.dy + rect.top - from.top}px)`,
            }}
          >
            <IconFace icon={icon} px={size.icon} />
          </div>
        );
      })}
    </ScreenLayer>,
    document.getElementById('shell') ?? document.body,
  );
}

/** An icon's picture: a launcher's app, or the file's icon or thumbnail. */
function IconImage({ icon, px }: { icon: DesktopIcon; px: number }) {
  const { getApp } = useInstalledApps();
  const shadow = 'drop-shadow-[0_2px_4px_rgb(0_0_0/0.35)]';
  if (icon.entry) {
    const app = entryApp(icon.entry, icon.name, getApp);
    if (app) {
      return (
        <span className={cn('grid shrink-0 place-items-center text-white', shadow)} style={{ width: px, height: px }} aria-hidden>
          <AppIcon icon={app.icon} web={app.web} className="size-full" />
        </span>
      );
    }
    if (icon.entry.icon?.startsWith('/')) {
      return <img src={localFileUrl(icon.entry.icon)} alt="" draggable={false} className={cn('object-contain', shadow)} style={{ width: px, height: px }} />;
    }
  }
  return (
    <FileIcon
      path={icon.path}
      name={icon.name}
      kind={icon.kind}
      size={icon.size}
      mtimeMs={icon.mtimeMs}
      symlink={icon.symlink}
      px={px}
      className={shadow}
    />
  );
}

/** The label, being renamed: Enter or leaving it renames, Escape doesn't. */
function RenameField({ icon, onDone }: { icon: DesktopIcon; onDone: (to: string | null) => void }) {
  const [value, setValue] = useState(icon.name);
  const done = useRef(false);
  const finish = (to: string | null) => {
    if (done.current) return;
    done.current = true;
    onDone(to);
  };
  const ref = useCallback((el: HTMLTextAreaElement | null) => {
    if (!el) return;
    el.focus();
    // The name without its extension, as Files selects it.
    const dot = icon.kind === 'directory' ? -1 : icon.name.lastIndexOf('.');
    el.setSelectionRange(0, dot > 0 ? dot : icon.name.length);
  }, [icon.kind, icon.name]);

  return (
    <textarea
      ref={ref}
      aria-label={`Rename ${icon.name}`}
      value={value}
      rows={2}
      spellCheck={false}
      onChange={(e) => setValue(e.target.value.replace(/\n/g, ''))}
      onKeyDown={(e) => {
        e.stopPropagation();
        if (e.key === 'Enter') {
          e.preventDefault();
          finish(value);
        } else if (e.key === 'Escape') {
          e.preventDefault();
          finish(null);
        }
      }}
      onBlur={() => finish(value)}
      onClick={(e) => e.stopPropagation()}
      onDoubleClick={(e) => e.stopPropagation()}
      className="w-full resize-none rounded border border-primary bg-background px-1 text-center text-xs leading-tight text-foreground outline-none"
    />
  );
}
