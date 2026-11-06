import { useEffect, useMemo, useState } from 'react';
import {
  Folder,
  HardDrive,
  Home,
  LoaderCircle,
  Lock,
  MemoryStick,
  Smartphone,
  Star,
  Trash2,
  Usb,
} from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import { cn } from '@/lib/utils';
import { ToolButton } from '@/shared/appChrome';
import { focusRing, sidebarHeadingClass, sidebarWidthClass } from '@/shared/appChromeStyles';
import { joinPath } from '@/lib/fs';
import { cleanVolumesError, getVolumesBridge, type Volume } from '@/lib/volumes';
import { useDirectory } from '@/hooks/useFileSystem';
import type { Bookmark } from '@/hooks/useFileSystem';
import { useVolumeActions, useVolumes } from '@/hooks/useVolumes';
import { EjectIcon } from '@/components/icons/EjectIcon';
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuTrigger,
} from '@/components/ui/context-menu';
import { UnlockVolumeDialog } from '@/shared/UnlockVolumeDialog';
import { USER_DIRS } from '@/shared/userDirs';
import { canDropInto, draggedFiles, dropCopies, takeDrop } from './drag';

interface Place {
  path: string;
  name: string;
  icon: LucideIcon;
  bookmark?: boolean;
  trash?: boolean;
  /** A removable disk; its path is empty until it's mounted (and unlocked). */
  volume?: Volume;
}

export interface SidebarProps {
  home: string | undefined;
  trashDir: string | undefined;
  cwd: string | null;
  bookmarks: Bookmark[];
  onNavigate: (path: string) => void;
  onOpenInNewTab: (path: string) => void;
  onOpenInNewWindow: (path: string) => void;
  onAddBookmark: (path: string) => void;
  onRemoveBookmark: (path: string) => void;
  onDrop: (target: string, paths: string[], copy: boolean) => void;
  onEmptyTrash: () => void;
  onProperties: (path: string) => void;
}

/**
 * Places (home and its standard folders, the Trash), Favorites (GTK
 * bookmarks: right-click a folder, or drag one here), and Devices: the
 * computer, removable disks, and phones plugged in by USB.
 * Every place is also a drop target that moves (Ctrl: copies) into it.
 */
export function Sidebar({
  home,
  trashDir,
  cwd,
  bookmarks,
  onNavigate,
  onOpenInNewTab,
  onOpenInNewWindow,
  onAddBookmark,
  onRemoveBookmark,
  onDrop,
  onEmptyTrash,
  onProperties,
}: SidebarProps) {
  const homeListing = useDirectory(home ?? null);
  const user = home ? home.slice(home.lastIndexOf('/') + 1) : null;
  // Where the volumes bridge is missing (Din on another distro), whatever
  // the desktop there mounted under /run/media still shows.
  const hasVolumes = getVolumesBridge() !== undefined;
  const media = useDirectory(user && !hasVolumes ? `/run/media/${user}` : null);
  const volumes = useVolumes();
  const volumeActions = useVolumeActions();
  const [dragTarget, setDragTarget] = useState<string | null>(null);
  // Whether a drag that could add a favorite is over the sidebar.
  const [offeringFavorite, setOfferingFavorite] = useState(false);
  /** A locked disk being unlocked, and where to open it once it is. */
  const [unlocking, setUnlocking] = useState<{ volume: Volume; open: (path: string) => void } | null>(null);

  useEffect(() => {
    const clear = () => {
      setOfferingFavorite(false);
      setDragTarget(null);
    };
    window.addEventListener('dragend', clear);
    window.addEventListener('drop', clear);
    return () => {
      window.removeEventListener('dragend', clear);
      window.removeEventListener('drop', clear);
    };
  }, []);

  const places = useMemo<Place[]>(() => {
    if (!home) return [];
    const present = new Set(
      (homeListing.data?.entries ?? []).filter((e) => e.kind === 'directory').map((e) => e.name),
    );
    return [
      { path: home, name: 'Home', icon: Home },
      ...USER_DIRS.filter((d) => present.has(d.name)).map((d) => ({
        path: joinPath(home, d.name),
        name: d.name,
        icon: d.icon,
      })),
      ...(trashDir ? [{ path: trashDir, name: 'Trash', icon: Trash2, trash: true }] : []),
    ];
  }, [home, homeListing.data, trashDir]);

  const favorites = bookmarks.map<Place>((b) => ({
    path: b.path,
    name: b.label ?? (b.path === '/' ? '/' : b.path.slice(b.path.lastIndexOf('/') + 1)),
    icon: Folder,
    bookmark: true,
  }));

  const devices: Place[] = [
    { path: '/', name: 'Computer', icon: HardDrive },
    ...(hasVolumes
      ? (volumes.data?.volumes ?? []).map((v) => ({
          path: v.mountPoint ?? '',
          name: v.name,
          icon: v.phone ? Smartphone : v.bus === 'sdio' ? MemoryStick : Usb,
          volume: v,
        }))
      : (media.data?.entries ?? [])
          .filter((e) => e.kind === 'directory')
          .map((e) => ({ path: joinPath(`/run/media/${user}`, e.name), name: e.name, icon: Usb }))),
  ];

  const failed = (title: string, error: unknown) =>
    new Notification(title, { body: cleanVolumesError(error) });

  /** Open a place; a disk that isn't mounted is mounted first, and unlocked before that. */
  const openPlace = (place: Place, open: (path: string) => void) => {
    const volume = place.volume;
    if (!volume || volume.mountPoint) {
      open(place.path);
      return;
    }
    if (volume.busy) return;
    if (volume.locked) {
      setUnlocking({ volume, open });
      return;
    }
    volumeActions.mount.mutate(volume.id, {
      onSuccess: (mountPoint) => open(mountPoint),
      onError: (error) => failed(`Can’t open “${volume.name}”`, error),
    });
  };

  const eject = (volume: Volume) =>
    volumeActions.eject.mutate(volume.id, {
      onError: (error) => failed(`Can’t eject “${volume.name}”`, error),
    });

  const bookmarked = new Set(bookmarks.map((b) => b.path));

  const renderPlace = (place: Place) => (
    <SidebarItem
      key={place.volume ? `v:${place.volume.id}` : `${place.bookmark ? 'b' : 'p'}:${place.path}`}
      place={place}
      active={!!place.path && cwd === place.path}
      dropping={dragTarget === place.path}
      bookmarked={bookmarked.has(place.path)}
      onNavigate={(p) => (p === place.path ? openPlace(place, onNavigate) : onNavigate(p))}
      onOpenInNewTab={() => openPlace(place, onOpenInNewTab)}
      onOpenInNewWindow={() => openPlace(place, onOpenInNewWindow)}
      onEject={eject}
      onAddBookmark={onAddBookmark}
      onRemoveBookmark={onRemoveBookmark}
      onEmptyTrash={onEmptyTrash}
      onProperties={onProperties}
      onDragOver={(e) => {
        const drag = draggedFiles(e);
        if (!drag || !place.path || !canDropInto(drag.paths, place.path, true)) return;
        e.preventDefault();
        e.stopPropagation();
        e.dataTransfer.dropEffect = dropCopies(e) && !place.trash ? 'copy' : 'move';
        setDragTarget(place.path);
      }}
      onDragLeave={() => setDragTarget((t) => (t === place.path ? null : t))}
      onDrop={(e) => {
        const drag = draggedFiles(e);
        setDragTarget(null);
        setOfferingFavorite(false);
        if (!drag || !place.path) return;
        e.preventDefault();
        e.stopPropagation();
        const target = place.path;
        void takeDrop(e, dropCopies(e) && !place.trash).then((dropped) => {
          if (!dropped) return;
          const paths = dropped.paths.filter((p) => canDropInto([p], target, true));
          if (paths.length > 0) onDrop(target, paths, dropped.copy);
        });
      }}
    />
  );

  const favoriteDrop = (e: React.DragEvent) => {
    const drag = draggedFiles(e);
    if (!drag?.anyFolder) return null;
    return drag;
  };

  return (
    <nav
      aria-label="Places"
      className={cn('flex h-full shrink-0 flex-col gap-3 overflow-y-auto px-2 pb-2 [&>*]:shrink-0', sidebarWidthClass)}
      onDragEnter={(e) => {
        if (favoriteDrop(e)) setOfferingFavorite(true);
      }}
      onDragLeave={(e) => {
        if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setOfferingFavorite(false);
      }}
    >
      <Section label="Places">{places.map(renderPlace)}</Section>

      <Section label="Favorites">
        {/* First, so it shows without scrolling past a long list. */}
        {(favorites.length === 0 || offeringFavorite) && (
          <div
            onDragOver={(e) => {
              if (!favoriteDrop(e)) return;
              e.preventDefault();
              e.dataTransfer.dropEffect = 'copy';
              setDragTarget('#favorites');
            }}
            onDragLeave={() => setDragTarget((t) => (t === '#favorites' ? null : t))}
            onDrop={(e) => {
              const drag = favoriteDrop(e);
              setDragTarget(null);
              setOfferingFavorite(false);
              if (!drag) return;
              e.preventDefault();
              // Favorites only link to folders: nothing moves.
              void takeDrop(e, true).then((dropped) => {
                for (const path of dropped?.folders ?? []) onAddBookmark(path);
              });
            }}
            className={cn(
              'flex items-center gap-2 rounded-md px-2 py-2 text-xs',
              dragTarget === '#favorites'
                ? 'bg-selected text-foreground'
                : 'border-border text-muted-foreground',
            )}
          >
            <Star className="size-3.5 shrink-0" aria-hidden />
            {offeringFavorite ? 'Drop to add to Favorites' : 'Drag folders here, or right-click one'}
          </div>
        )}
        {favorites.map(renderPlace)}
      </Section>

      <Section label="Devices">{devices.map(renderPlace)}</Section>

      <UnlockVolumeDialog
        volume={unlocking?.volume ?? null}
        onClose={() => setUnlocking(null)}
        onUnlocked={(mountPoint) => {
          unlocking?.open(mountPoint);
          setUnlocking(null);
        }}
      />
    </nav>
  );
}

function Section({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-0.5">
      <p className={sidebarHeadingClass}>{label}</p>
      {children}
    </div>
  );
}

function SidebarItem({
  place,
  active,
  dropping,
  bookmarked,
  onNavigate,
  onOpenInNewTab,
  onOpenInNewWindow,
  onEject,
  onAddBookmark,
  onRemoveBookmark,
  onEmptyTrash,
  onProperties,
  onDragOver,
  onDragLeave,
  onDrop,
}: {
  place: Place;
  active: boolean;
  dropping: boolean;
  bookmarked: boolean;
  onNavigate: (path: string) => void;
  onOpenInNewTab: (path: string) => void;
  onOpenInNewWindow: (path: string) => void;
  onEject: (volume: Volume) => void;
  onAddBookmark: (path: string) => void;
  onRemoveBookmark: (path: string) => void;
  onEmptyTrash: () => void;
  onProperties: (path: string) => void;
  onDragOver: (e: React.DragEvent) => void;
  onDragLeave: () => void;
  onDrop: (e: React.DragEvent) => void;
}) {
  const volume = place.volume;
  const busy = volume?.busy ?? null;
  return (
    <ContextMenu>
      <ContextMenuTrigger asChild>
        <div
          className={cn(
            'group flex items-center rounded-md',
            dropping
              ? 'bg-selected text-foreground ring-2 ring-ring/60'
              : active
                ? 'bg-foreground/10 font-medium text-foreground'
                : 'hover:bg-foreground/5',
          )}
          onDragOver={onDragOver}
          onDragLeave={onDragLeave}
          onDrop={onDrop}
        >
          <button
            type="button"
            onClick={() => onNavigate(place.path)}
            onAuxClick={(e) => {
              if (e.button === 1) onOpenInNewTab(place.path);
            }}
            title={place.path || volume?.needs || volume?.device}
            aria-current={active ? 'location' : undefined}
            className={cn(
              'flex min-h-8 min-w-0 flex-1 items-center gap-2.5 rounded-md px-2.5 py-1 text-left text-sm',
              focusRing,
              volume && !volume.mountPoint && 'text-muted-foreground',
            )}
          >
            <place.icon className="size-4.5 shrink-0 text-ink-accent" strokeWidth={1.75} aria-hidden />
            {volume?.needs ? (
              <span className="min-w-0">
                <span className="block truncate">{place.name}</span>
                <span className="block text-xs leading-snug text-muted-foreground">{volume.needs}</span>
              </span>
            ) : (
              <span className="truncate">{place.name}</span>
            )}
            {volume?.locked && (
              <>
                <Lock className="ml-auto size-3 shrink-0 text-muted-foreground" aria-hidden />
                <span className="sr-only">(locked)</span>
              </>
            )}
          </button>
          {volume && (busy ? (
            <span className="flex size-6 shrink-0 items-center justify-center" role="status">
              <LoaderCircle className="size-3.5 animate-spin text-muted-foreground" aria-hidden />
              <span className="sr-only">{busy === 'ejecting' ? `Ejecting ${place.name}` : busy === 'unlocking' ? `Unlocking ${place.name}` : `Opening ${place.name}`}</span>
            </span>
          ) : (
            <ToolButton size="xs" label={`Eject ${place.name}`} title={`Eject “${place.name}”`} onClick={() => onEject(volume)} className="mr-0.5">
              <EjectIcon className="size-3.5" />
            </ToolButton>
          ))}
        </div>
      </ContextMenuTrigger>
      <ContextMenuContent>
        <ContextMenuItem onSelect={() => onNavigate(place.path)}>{volume?.locked ? 'Unlock…' : 'Open'}</ContextMenuItem>
        <ContextMenuItem onSelect={() => onOpenInNewTab(place.path)}>Open in New Tab</ContextMenuItem>
        <ContextMenuItem onSelect={() => onOpenInNewWindow(place.path)}>Open in New Window</ContextMenuItem>
        <ContextMenuSeparator />
        {volume ? (
          <ContextMenuItem disabled={busy !== null} onSelect={() => onEject(volume)}>
            Eject “{place.name}”
          </ContextMenuItem>
        ) : place.trash ? (
          <ContextMenuItem variant="destructive" onSelect={onEmptyTrash}>
            Empty Trash…
          </ContextMenuItem>
        ) : bookmarked ? (
          <ContextMenuItem onSelect={() => onRemoveBookmark(place.path)}>Remove from Favorites</ContextMenuItem>
        ) : (
          <ContextMenuItem onSelect={() => onAddBookmark(place.path)}>Add to Favorites</ContextMenuItem>
        )}
        {place.path && <ContextMenuItem onSelect={() => onProperties(place.path)}>Properties</ContextMenuItem>}
      </ContextMenuContent>
    </ContextMenu>
  );
}
