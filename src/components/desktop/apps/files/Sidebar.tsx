import { useEffect, useMemo, useState } from 'react';
import {
  Download,
  FileText,
  Folder,
  HardDrive,
  Home,
  Image,
  Monitor,
  Music,
  Star,
  Trash2,
  Usb,
  Video,
} from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import { cn } from '@/lib/utils';
import { joinPath } from '@/lib/fs';
import { useDirectory } from '@/hooks/useFileSystem';
import type { Bookmark } from '@/hooks/useFileSystem';
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuTrigger,
} from '@/components/ui/context-menu';
import { activeFileDrag, dropCopies } from './dnd';

/** The XDG user folders, shown under Home when they exist. */
const USER_DIRS: { name: string; icon: LucideIcon }[] = [
  { name: 'Desktop', icon: Monitor },
  { name: 'Documents', icon: FileText },
  { name: 'Downloads', icon: Download },
  { name: 'Music', icon: Music },
  { name: 'Pictures', icon: Image },
  { name: 'Videos', icon: Video },
];

interface Place {
  path: string;
  name: string;
  icon: LucideIcon;
  bookmark?: boolean;
  trash?: boolean;
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
 * bookmarks: right-click a folder, or drag one here), and Devices.
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
  const media = useDirectory(user ? `/run/media/${user}` : null);
  const [dragTarget, setDragTarget] = useState<string | null>(null);
  // Whether a drag that could add a favorite is over the sidebar.
  const [offeringFavorite, setOfferingFavorite] = useState(false);

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
    ...(media.data?.entries ?? [])
      .filter((e) => e.kind === 'directory')
      .map((e) => ({ path: joinPath(`/run/media/${user}`, e.name), name: e.name, icon: Usb })),
  ];

  const bookmarked = new Set(bookmarks.map((b) => b.path));

  const renderPlace = (place: Place) => (
    <SidebarItem
      key={`${place.bookmark ? 'b' : 'p'}:${place.path}`}
      place={place}
      active={cwd === place.path}
      dropping={dragTarget === place.path}
      bookmarked={bookmarked.has(place.path)}
      onNavigate={onNavigate}
      onOpenInNewTab={onOpenInNewTab}
      onOpenInNewWindow={onOpenInNewWindow}
      onAddBookmark={onAddBookmark}
      onRemoveBookmark={onRemoveBookmark}
      onEmptyTrash={onEmptyTrash}
      onProperties={onProperties}
      onDragOver={(e) => {
        const drag = activeFileDrag(e);
        if (!drag || drag.paths.some((p) => place.path === p || place.path.startsWith(`${p}/`))) return;
        e.preventDefault();
        e.stopPropagation();
        e.dataTransfer.dropEffect = dropCopies(e) && !place.trash ? 'copy' : 'move';
        setDragTarget(place.path);
      }}
      onDragLeave={() => setDragTarget((t) => (t === place.path ? null : t))}
      onDrop={(e) => {
        const drag = activeFileDrag(e);
        setDragTarget(null);
        setOfferingFavorite(false);
        if (!drag) return;
        e.preventDefault();
        e.stopPropagation();
        onDrop(place.path, drag.paths, dropCopies(e) && !place.trash);
      }}
    />
  );

  const favoriteDrop = (e: React.DragEvent) => {
    const drag = activeFileDrag(e);
    if (!drag || drag.folders.size === 0) return null;
    return drag;
  };

  return (
    <nav
      aria-label="Places"
      className="flex h-full w-48 shrink-0 flex-col gap-4 overflow-y-auto border-r border-border/60 bg-background/30 px-2 py-3"
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
              for (const path of drag.folders) onAddBookmark(path);
            }}
            className={cn(
              'flex items-center gap-2 rounded-md border border-dashed px-2 py-2 text-xs',
              dragTarget === '#favorites'
                ? 'border-primary bg-primary/10 text-foreground'
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
    </nav>
  );
}

function Section({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-0.5">
      <p className="px-2 pb-1 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
        {label}
      </p>
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
  onAddBookmark: (path: string) => void;
  onRemoveBookmark: (path: string) => void;
  onEmptyTrash: () => void;
  onProperties: (path: string) => void;
  onDragOver: (e: React.DragEvent) => void;
  onDragLeave: () => void;
  onDrop: (e: React.DragEvent) => void;
}) {
  return (
    <ContextMenu>
      <ContextMenuTrigger asChild>
        <button
          type="button"
          onClick={() => onNavigate(place.path)}
          onAuxClick={(e) => {
            if (e.button === 1) onOpenInNewTab(place.path);
          }}
          onDragOver={onDragOver}
          onDragLeave={onDragLeave}
          onDrop={onDrop}
          title={place.path}
          aria-current={active ? 'location' : undefined}
          className={cn(
            'flex items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm',
            'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
            dropping
              ? 'bg-primary/20 text-foreground ring-2 ring-primary'
              : active
                ? 'bg-primary/15 font-medium text-foreground'
                : 'text-foreground/80 hover:bg-foreground/10 hover:text-foreground',
          )}
        >
          <place.icon className={cn('size-4 shrink-0', active ? 'text-primary' : 'text-muted-foreground')} aria-hidden />
          <span className="truncate">{place.name}</span>
        </button>
      </ContextMenuTrigger>
      <ContextMenuContent>
        <ContextMenuItem onSelect={() => onNavigate(place.path)}>Open</ContextMenuItem>
        <ContextMenuItem onSelect={() => onOpenInNewTab(place.path)}>Open in New Tab</ContextMenuItem>
        <ContextMenuItem onSelect={() => onOpenInNewWindow(place.path)}>Open in New Window</ContextMenuItem>
        <ContextMenuSeparator />
        {place.trash ? (
          <ContextMenuItem variant="destructive" onSelect={onEmptyTrash}>
            Empty Trash…
          </ContextMenuItem>
        ) : bookmarked ? (
          <ContextMenuItem onSelect={() => onRemoveBookmark(place.path)}>Remove from Favorites</ContextMenuItem>
        ) : (
          <ContextMenuItem onSelect={() => onAddBookmark(place.path)}>Add to Favorites</ContextMenuItem>
        )}
        <ContextMenuItem onSelect={() => onProperties(place.path)}>Properties</ContextMenuItem>
      </ContextMenuContent>
    </ContextMenu>
  );
}
