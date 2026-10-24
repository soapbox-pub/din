import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ChevronLeft, ChevronRight, FolderOpen, Layers, Paintbrush, Printer } from 'lucide-react';
import type { AppComponentProps } from '@/lib/apps';
import { cn } from '@/lib/utils';
import { cleanFsError, formatBytes, getFsBridge, joinPath, parentPath, sortEntries } from '@/lib/fs';
import { isPhotoEditable, isPlayableVideo, isViewableImage } from '@/lib/fileTypes';
import { cleanPrintingError, getPrintingBridge, isPrintableFile, printFile } from '@/lib/printing';
import { useQueryClient } from '@tanstack/react-query';
import { invalidateListings, useDirectory } from '@/hooks/useFileSystem';
import { useWindowActions } from '@/contexts/WindowManagerContext';
import { useWindowTitle } from '@/contexts/WindowTitleContext';
import { useWindowIcon } from '@/contexts/WindowIconContext';
import { FileViewerBody } from './files/FileViewerBody';

const isMedia = (name: string) => isViewableImage(name) || isPlayableVideo(name);

/**
 * Preview - a window for one file, opened from Files: pictures and video
 * (with the arrow keys stepping through the rest of the folder's), music,
 * archives' contents, and text, which can be edited and saved.
 *
 * Launch params: `{ path: string }` (absolute).
 */
export function FileViewer({ windowId, params }: AppComponentProps) {
  const initial = typeof params?.path === 'string' ? params.path : null;
  const [path, setPath] = useState(initial);
  const [dirty, setDirty] = useState(false);
  const { open, close } = useWindowActions();

  // A new file asked of this window (launch params merged in).
  const [prevInitial, setPrevInitial] = useState(initial);
  if (initial !== prevInitial) {
    setPrevInitial(initial);
    if (initial) setPath(initial);
  }

  const name = path ? path.slice(path.lastIndexOf('/') + 1) : '';
  useWindowTitle(path ? `${dirty ? '• ' : ''}${name}` : null);
  useWindowIcon(
    isViewableImage(name) ? '/icons/apps/preview-photo.png'
      : isPlayableVideo(name) ? '/icons/apps/preview-video.png'
        : null,
  );

  const dir = path ? parentPath(path) : null;
  const listing = useDirectory(dir);
  const entry = listing.data?.entries.find((e) => e.name === name);
  const siblings = useMemo(() => {
    if (!isMedia(name)) return [];
    return sortEntries(
      (listing.data?.entries ?? []).filter(
        (e) => e.kind === 'file' && !e.name.startsWith('.') && isMedia(e.name),
      ),
    );
  }, [listing.data, name]);
  const index = siblings.findIndex((e) => e.name === name);

  const step = useCallback(
    (delta: number) => {
      if (!dir || siblings.length < 2 || index === -1) return;
      const next = siblings[(index + delta + siblings.length) % siblings.length];
      setPath(joinPath(dir, next.name));
    },
    [dir, siblings, index],
  );

  const queryClient = useQueryClient();
  const rootRef = useRef<HTMLDivElement>(null);
  // Keys (the arrows) work as soon as the window opens.
  useEffect(() => {
    rootRef.current?.focus({ preventScroll: true });
  }, []);
  const [extractError, setExtractError] = useState<string | null>(null);
  const [printError, setPrintError] = useState<string | null>(null);
  // What's printed is what's saved: edits in progress aren't.
  const printable = !!getPrintingBridge() && isPrintableFile(name);
  const print = useCallback(() => {
    if (!path || !printable) return;
    setPrintError(null);
    printFile(path).catch((error) => setPrintError(cleanPrintingError(error)));
  }, [path, printable]);
  const extract = useCallback(async () => {
    if (!path || !dir) return;
    setExtractError(null);
    try {
      const out = await getFsBridge()!.extract(path, dir);
      void invalidateListings(queryClient, out);
      open('file-browser', { path: dir, select: out.slice(out.lastIndexOf('/') + 1) });
    } catch (error) {
      setExtractError(cleanFsError(error));
    }
  }, [path, dir, open, queryClient]);

  if (!getFsBridge()) {
    return (
      <p className="grid h-full place-items-center p-6 text-sm text-muted-foreground">
        Preview needs the Electron shell to read files.
      </p>
    );
  }
  if (!path) {
    return (
      <p className="grid h-full place-items-center p-6 text-sm text-muted-foreground">
        No file to show.
      </p>
    );
  }

  return (
    <div
      className="flex h-full w-full flex-col outline-none"
      onKeyDown={(e) => {
        // Ctrl+W / Ctrl+Q close the window, from anywhere in it.
        const key = e.key.toLowerCase();
        if (e.ctrlKey && !e.altKey && !e.shiftKey && !e.metaKey && (key === 'w' || key === 'q')) {
          e.preventDefault();
          e.stopPropagation();
          close(windowId);
          return;
        }
        if (e.ctrlKey && !e.altKey && !e.shiftKey && !e.metaKey && key === 'p' && printable) {
          e.preventDefault();
          e.stopPropagation();
          print();
          return;
        }
        const target = e.target as HTMLElement;
        if (target.closest('textarea, input, video, audio')) return;
        if (e.ctrlKey || e.altKey || e.metaKey) return;
        if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
          e.preventDefault();
          step(e.key === 'ArrowLeft' ? -1 : 1);
        }
      }}
      tabIndex={-1}
      ref={rootRef}
    >
      <div className="flex shrink-0 items-center gap-1 border-b border-border/60 bg-background/50 px-2 py-1.5">
        {siblings.length > 1 && (
          <>
            <BarButton label="Previous" onClick={() => step(-1)}>
              <ChevronLeft className="size-4" />
            </BarButton>
            <BarButton label="Next" onClick={() => step(1)}>
              <ChevronRight className="size-4" />
            </BarButton>
          </>
        )}
        <span className="min-w-0 flex-1" />
        <span className="shrink-0 text-xs tabular-nums text-muted-foreground">
          {siblings.length > 1 && index !== -1 && `${index + 1} of ${siblings.length} · `}
          {entry?.size != null && formatBytes(entry.size)}
        </span>
        {path && isViewableImage(name) && (
          <BarButton label="Edit in Paint" onClick={() => open('paint', { path })}>
            <Paintbrush className="size-4" />
          </BarButton>
        )}
        {path && isPhotoEditable(name) && (
          <BarButton label="Edit in Photo Editor" onClick={() => open('photo-editor', { path })}>
            <Layers className="size-4" />
          </BarButton>
        )}
        {printable && (
          <BarButton label="Print…" onClick={print}>
            <Printer className="size-4" />
          </BarButton>
        )}
        <BarButton
          label="Show in Files"
          onClick={() => dir && open('file-browser', { path: dir, select: name })}
        >
          <FolderOpen className="size-4" />
        </BarButton>
      </div>
      <div className="min-h-0 flex-1">
        <FileViewerBody
          path={path}
          size={entry?.size}
          mtimeMs={entry?.mtimeMs}
          editable
          onDirtyChange={setDirty}
          onExtract={() => void extract()}
        />
      </div>
      {extractError !== null && (
        <p role="alert" className="shrink-0 border-t border-border/60 px-3 py-1.5 text-xs text-destructive">
          Couldn’t extract: {extractError}
        </p>
      )}
      {printError !== null && (
        <p role="alert" className="shrink-0 border-t border-border/60 px-3 py-1.5 text-xs text-destructive">
          Couldn’t print: {printError}
        </p>
      )}
    </div>
  );
}

function BarButton({
  label,
  onClick,
  children,
}: {
  label: string;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      onClick={onClick}
      className={cn(
        'grid size-8 shrink-0 place-items-center rounded-md text-foreground/80',
        'hover:bg-foreground/10 hover:text-foreground',
        'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
      )}
    >
      {children}
    </button>
  );
}
