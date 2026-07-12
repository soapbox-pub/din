import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ArrowUp,
  Download,
  File as FileIcon,
  FileArchive,
  Folder,
  HardDrive,
  Home,
  MousePointerClick,
  RotateCw,
} from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import { cn } from '@/lib/utils';
import {
  cleanFsError,
  formatBytes,
  getFsBridge,
  joinPath,
  parentPath,
} from '@/lib/fs';
import type { FsEntry } from '@/lib/fs';
import { useDirectory, useHomeDir } from '@/hooks/useFileSystem';
import type { FilePickerOptions } from '@/contexts/FilePickerContext';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';

interface FilePickerDialogProps {
  options: FilePickerOptions;
  onConfirm: (path: string) => void;
  onCancel: () => void;
}

/** Normalize an extension list to lowercase, dot-prefixed forms. */
function normalizeExtensions(extensions: string[] | undefined): string[] | null {
  if (!extensions || extensions.length === 0) return null;
  return extensions.map((e) => (e.startsWith('.') ? e : `.${e}`).toLowerCase());
}

/** Whether a filename matches one of the allowed extensions. */
function matchesExtensions(name: string, exts: string[] | null): boolean {
  if (!exts) return true;
  const lower = name.toLowerCase();
  return exts.some((ext) => lower.endsWith(ext));
}

/**
 * In-Din modal file picker. Reuses the `window.fs` bridge (via the same
 * TanStack Query hooks as the Files app) to browse the real filesystem, but
 * renders entirely inside Din — no host OS dialog. Selecting a file and
 * confirming calls `onConfirm(absolutePath)`.
 */
export function FilePickerDialog({ options, onConfirm, onCancel }: FilePickerDialogProps) {
  const bridge = getFsBridge();
  const home = useHomeDir();
  const exts = useMemo(() => normalizeExtensions(options.extensions), [options.extensions]);

  const [cwd, setCwd] = useState<string | null>(options.initialPath ?? null);
  const [selected, setSelected] = useState<string | null>(null);

  // Until the user navigates, browse the home directory (once it resolves).
  const effectiveCwd = cwd ?? home.data ?? null;

  const listing = useDirectory(effectiveCwd);

  const entries = useMemo(() => {
    const items = (listing.data?.entries ?? []).filter((e) => !e.name.startsWith('.'));
    return [...items].sort((a, b) => {
      if ((a.kind === 'directory') !== (b.kind === 'directory')) {
        return a.kind === 'directory' ? -1 : 1;
      }
      return a.name.localeCompare(b.name, undefined, { numeric: true });
    });
  }, [listing.data]);

  const places = useMemo(() => {
    const list: { name: string; path: string; icon: LucideIcon }[] = [];
    if (home.data) {
      list.push({ name: 'Home', path: home.data, icon: Home });
      list.push({ name: 'Downloads', path: joinPath(home.data, 'Downloads'), icon: Download });
      list.push({ name: 'Desktop', path: joinPath(home.data, 'Desktop'), icon: Folder });
    }
    list.push({ name: 'System', path: '/', icon: HardDrive });
    return list;
  }, [home.data]);

  const navigate = useCallback((target: string) => {
    setSelected(null);
    setCwd(target.length > 1 ? target.replace(/\/+$/, '') : '/');
  }, []);

  const openEntry = useCallback(
    (entry: FsEntry) => {
      if (effectiveCwd === null) return;
      const target = joinPath(effectiveCwd, entry.name);
      if (entry.kind === 'directory') {
        navigate(target);
      } else if (entry.kind === 'file' && matchesExtensions(entry.name, exts)) {
        // Double-click a selectable file → confirm immediately.
        onConfirm(target);
      }
    },
    [effectiveCwd, navigate, exts, onConfirm],
  );

  // Escape cancels.
  const dialogRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = dialogRef.current;
    el?.focus();
  }, []);

  const canConfirm = selected !== null;
  const confirm = () => {
    if (selected) onConfirm(selected);
  };

  return (
    <div
      className="fixed inset-0 z-[1000] grid place-items-center bg-black/50 p-6"
      onPointerDown={(e) => {
        // Click on the backdrop (not the dialog) cancels.
        if (e.target === e.currentTarget) onCancel();
      }}
    >
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-label={options.title ?? 'Choose a file'}
        tabIndex={-1}
        className="flex h-[520px] max-h-full w-[760px] max-w-full flex-col overflow-hidden rounded-xl border border-border/60 bg-background shadow-2xl outline-none"
        onKeyDown={(e) => {
          if (e.key === 'Escape') {
            e.stopPropagation();
            onCancel();
          }
        }}
      >
        {/* Header / toolbar */}
        <header className="flex items-center gap-2 border-b border-border/60 bg-muted/30 px-3 py-2">
          <h2 className="mr-2 text-sm font-semibold text-foreground">
            {options.title ?? 'Choose a file'}
          </h2>
          <Button
            type="button"
            variant="ghost"
            size="icon"
            className="size-7"
            aria-label="Parent folder"
            disabled={!effectiveCwd || effectiveCwd === '/'}
            onClick={() => effectiveCwd && navigate(parentPath(effectiveCwd))}
          >
            <ArrowUp className="size-4" aria-hidden />
          </Button>
          <Button
            type="button"
            variant="ghost"
            size="icon"
            className="size-7"
            aria-label="Refresh"
            onClick={() => listing.refetch()}
          >
            <RotateCw className={cn('size-4', listing.isFetching && 'animate-spin')} aria-hidden />
          </Button>
          <div className="ml-1 flex-1 truncate rounded-md bg-muted px-2 py-1 text-xs text-muted-foreground">
            {effectiveCwd ?? 'Loading…'}
          </div>
        </header>

        <div className="flex min-h-0 flex-1">
          {/* Places sidebar */}
          <nav className="w-40 shrink-0 space-y-0.5 overflow-y-auto border-r border-border/60 bg-muted/20 p-2">
            {places.map((place) => (
              <button
                key={place.path}
                type="button"
                onClick={() => navigate(place.path)}
                className={cn(
                  'flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm',
                  'text-muted-foreground hover:bg-foreground/5 hover:text-foreground',
                  'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
                  effectiveCwd === place.path && 'bg-primary/10 text-foreground',                )}
              >
                <place.icon className="size-4 shrink-0" aria-hidden />
                <span className="truncate">{place.name}</span>
              </button>
            ))}
          </nav>

          {/* File list */}
          <div className="min-w-0 flex-1 overflow-y-auto p-1">
            {!bridge ? (
              <FallbackMessage>
                The file picker needs the Din desktop shell and isn't available
                in a plain browser.
              </FallbackMessage>
            ) : listing.isError ? (
              <FallbackMessage>{cleanFsError(listing.error)}</FallbackMessage>
            ) : listing.isLoading ? (
              <div className="space-y-1 p-2">
                {Array.from({ length: 8 }).map((_, i) => (
                  <Skeleton key={i} className="h-8 w-full" />
                ))}
              </div>
            ) : entries.length === 0 ? (
              <FallbackMessage>This folder is empty.</FallbackMessage>
            ) : (
              <ul className="p-1">
                {entries.map((entry) => {
                  const path = effectiveCwd ? joinPath(effectiveCwd, entry.name) : entry.name;
                  const selectable =
                    entry.kind === 'directory' || matchesExtensions(entry.name, exts);
                  const isSelected = selected === path;
                  return (
                    <li key={entry.name}>
                      <button
                        type="button"
                        disabled={!selectable}
                        onClick={() => {
                          if (entry.kind === 'file' && selectable) setSelected(path);
                          else if (entry.kind === 'directory') setSelected(null);
                        }}
                        onDoubleClick={() => openEntry(entry)}
                        className={cn(
                          'flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm',
                          'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
                          isSelected
                            ? 'bg-primary/15 text-foreground'
                            : 'text-foreground hover:bg-foreground/5',
                          !selectable && 'opacity-40',
                        )}
                      >
                        <EntryIcon entry={entry} />
                        <span className="min-w-0 flex-1 truncate">{entry.name}</span>
                        {entry.kind === 'file' && entry.size !== null && (
                          <span className="shrink-0 text-xs text-muted-foreground">
                            {formatBytes(entry.size)}
                          </span>
                        )}
                      </button>
                    </li>
                  );
                })}
              </ul>
            )}
          </div>
        </div>

        {/* Footer */}
        <footer className="flex items-center justify-between gap-3 border-t border-border/60 bg-muted/30 px-3 py-2">
          <p className="min-w-0 flex-1 truncate text-xs text-muted-foreground">
            {selected ? (
              <span className="text-foreground">{selected.split('/').pop()}</span>
            ) : exts ? (
              `Select a ${exts.join(', ')} file`
            ) : (
              'Select a file'
            )}
          </p>
          <div className="flex items-center gap-2">
            <Button type="button" variant="ghost" size="sm" onClick={onCancel}>
              Cancel
            </Button>
            <Button type="button" size="sm" disabled={!canConfirm} onClick={confirm}>
              {options.confirmLabel ?? 'Open'}
            </Button>
          </div>
        </footer>
      </div>
    </div>
  );
}

function EntryIcon({ entry }: { entry: FsEntry }) {
  const className = cn(
    'size-4 shrink-0',
    entry.kind === 'directory' ? 'text-primary' : 'text-muted-foreground',
  );
  if (entry.kind === 'directory') return <Folder className={className} aria-hidden />;
  const name = entry.name.toLowerCase();
  if (name.endsWith('.curxptheme') || name.endsWith('.zip')) {
    return <FileArchive className={className} aria-hidden />;
  }
  if (name.endsWith('.cur') || name.endsWith('.ani')) {
    return <MousePointerClick className={className} aria-hidden />;
  }
  return <FileIcon className={className} aria-hidden />;
}

function FallbackMessage({ children }: { children: React.ReactNode }) {
  return (
    <div className="grid h-full place-items-center p-6">
      <p className="max-w-xs text-center text-sm text-muted-foreground">{children}</p>
    </div>
  );
}
