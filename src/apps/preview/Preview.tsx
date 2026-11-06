import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ChevronLeft, ChevronRight, Copy, FolderOpen, Layers, Paintbrush, Printer, Wallpaper } from 'lucide-react';
import { ToolButton } from '@/shared/appChrome';
import { ContextMenu, ContextMenuContent, ContextMenuItem, ContextMenuSeparator, ContextMenuTrigger } from '@/components/ui/context-menu';
import { cleanFsError, extractionWarning, formatBytes, getFsBridge, joinPath, parentPath, sortEntries } from '@/lib/fs';
import { isPhotoEditable, isPlayableVideo, isViewableImage } from '@/lib/fileTypes';
import { cleanPrintingError, isPrintableFile } from '@/lib/printing';
import { printFile } from '@/shared/print';
import { useQueryClient } from '@tanstack/react-query';
import { invalidateListings, useDirectory } from '@/hooks/useFileSystem';
import type { Din } from '@/sdk';
import { useDin, usePermission, useWindowIcon, useWindowTitle } from '@/sdk/react';
import { FileViewerBody } from '@/shared/FileViewerBody';
import { onLaunchFiles, windowLaunchFiles } from '@/shared/fileHandles';
import { appLink } from '@/shared/launch';
import { toast } from '@/shared/toast';

const isMedia = (name: string) => isViewableImage(name) || isPlayableVideo(name);

/** Open an app on a path, as a handle it's granted (paths in params are dropped). */
/** The picture at `url` drawn into a PNG, at its own size. */
async function pngOf(url: string): Promise<Blob> {
  // Read as a blob of this page's own, so the canvas isn't tainted.
  const local = URL.createObjectURL(await (await fetch(url)).blob());
  try {
    const img = new Image();
    img.src = local;
    await img.decode();
    const canvas = document.createElement('canvas');
    canvas.width = img.naturalWidth;
    canvas.height = img.naturalHeight;
    canvas.getContext('2d')!.drawImage(img, 0, 0);
    return await new Promise((resolve, reject) =>
      canvas.toBlob((blob) => (blob ? resolve(blob) : reject(new Error('Couldn’t draw the picture'))), 'image/png'),
    );
  } finally {
    URL.revokeObjectURL(local);
  }
}

async function openWith(din: Din, appId: string, path: string, params: Record<string, unknown> = {}): Promise<void> {
  await din.app.launch(appLink(appId, params), [await din.files.fromPath(path)]);
}

/**
 * Preview - a window for one file, opened from Files: pictures and video
 * (with the arrow keys stepping through the rest of the folder's), music,
 * PDFs, 3D models, archives' contents, cursor themes (to install and use), and text, which
 * can be edited and saved.
 *
 * It has `file-folders`: stepping through the folder, listing and
 * extracting archives and Show in Files all work on the shown file's folder
 * by path, and nowhere else.
 */
export function Preview() {
  const din = useDin();
  const [path, setPath] = useState(() => {
    const [file] = windowLaunchFiles();
    return file ? din.files.path(file) : null;
  });
  const [dirty, setDirty] = useState(false);

  // A new file asked of this window.
  useEffect(() => onLaunchFiles(([file]) => setPath(din.files.path(file))), [din]);

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
  const printable = isPrintableFile(name);
  const print = useCallback(() => {
    if (!path || !printable) return;
    setPrintError(null);
    din.files.fromPath(path)
      .then((handle) => (handle as FileSystemFileHandle).getFile())
      .then(printFile)
      .catch((error) => setPrintError(cleanPrintingError(error)));
  }, [din, path, printable]);
  const extract = useCallback(async () => {
    if (!path || !dir) return;
    setExtractError(null);
    try {
      const out = await getFsBridge()!.extract(path, dir);
      void invalidateListings(queryClient, out.path);
      const warning = extractionWarning(out);
      if (warning) setExtractError(warning);
      await openWith(din, 'file-browser', dir, { select: out.path.slice(out.path.lastIndexOf('/') + 1) });
    } catch (error) {
      setExtractError(`Couldn’t extract: ${cleanFsError(error)}`);
    }
  }, [din, path, dir, queryClient]);

  const canUseCursor = usePermission('cursor') === 'granted';
  const installCursor = useCallback(async () => {
    if (!path) return;
    await din.desktop.setCursor(await din.files.fromPath(path));
  }, [din, path]);

  const image = isViewableImage(name);
  // The picture as it's saved, as a PNG (the one picture type the clipboard takes).
  const copyImage = useCallback(() => {
    if (!path) return;
    const png = pngOf(din.files.pathUrl(path));
    navigator.clipboard.write([new ClipboardItem({ 'image/png': png })]).then(
      () => toast('Image copied'),
      () => toast('Couldn’t copy the image', { destructive: true }),
    );
  }, [din, path]);
  const tools: { label: string; icon: React.ReactNode; run: () => void }[] = path ? [
    ...(image ? [{ label: 'Copy Image', icon: <Copy className="size-4" />, run: copyImage }] : []),
    ...(image ? [{ label: 'Edit in Paint', icon: <Paintbrush className="size-4" />, run: () => void openWith(din, 'paint', path) }] : []),
    ...(isPhotoEditable(name) ? [{ label: 'Edit in Photo Editor', icon: <Layers className="size-4" />, run: () => void openWith(din, 'photo-editor', path) }] : []),
    ...(image ? [{
      label: 'Set as Desktop Background',
      icon: <Wallpaper className="size-4" />,
      run: () => void din.files.fromPath(path).then((handle) => din.desktop.setWallpaper(handle)),
    }] : []),
    ...(printable ? [{ label: 'Print…', icon: <Printer className="size-4" />, run: print }] : []),
    { label: 'Show in Files', icon: <FolderOpen className="size-4" />, run: () => void (dir && openWith(din, 'file-browser', dir, { select: name })) },
  ] : [];

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
          din.window.requestClose();
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
        // Ctrl+C copies the picture, unless some text is selected.
        if (e.ctrlKey && !e.altKey && !e.shiftKey && !e.metaKey && key === 'c' && image && !window.getSelection()?.toString()) {
          e.preventDefault();
          copyImage();
          return;
        }
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
        {tools.map((t) => (
          <BarButton key={t.label} label={t.label} onClick={t.run}>
            {t.icon}
          </BarButton>
        ))}
      </div>
      <ContextMenu>
        <ContextMenuTrigger asChild disabled={!image}>
          <div className="min-h-0 flex-1">
            <FileViewerBody
              path={path}
              size={entry?.size}
              mtimeMs={entry?.mtimeMs}
              editable
              onDirtyChange={setDirty}
              onExtract={() => void extract()}
              onUseCursor={canUseCursor ? installCursor : undefined}
            />
          </div>
        </ContextMenuTrigger>
        <ContextMenuContent>
          {siblings.length > 1 && (
            <>
              <ContextMenuItem onSelect={() => step(-1)}>
                <ChevronLeft /> Previous
              </ContextMenuItem>
              <ContextMenuItem onSelect={() => step(1)}>
                <ChevronRight /> Next
              </ContextMenuItem>
              <ContextMenuSeparator />
            </>
          )}
          {tools.map((t) => (
            <ContextMenuItem key={t.label} onSelect={t.run}>
              {t.icon} {t.label}
            </ContextMenuItem>
          ))}
        </ContextMenuContent>
      </ContextMenu>
      {extractError !== null && (
        <p role="alert" className="shrink-0 border-t border-border/60 px-3 py-1.5 text-xs text-destructive">
          {extractError}
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
    <ToolButton label={label} onClick={onClick}>
      {children}
    </ToolButton>
  );
}
