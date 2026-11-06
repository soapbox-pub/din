import { lazy, Suspense, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { FileArchive, Folder } from 'lucide-react';
import { cn } from '@/lib/utils';
import { cleanFsError, fileUrl, formatBytes, getFsBridge } from '@/lib/fs';
import {
  fileCategory,
  isCursorTheme,
  isExtractable,
  isPlayableAudio,
  isPlayableVideo,
  isViewableImage,
  isViewableModel,
  typeLabel,
} from '@/lib/fileTypes';
import { useFileContent } from '@/hooks/useFileSystem';
import { Skeleton } from '@/components/ui/skeleton';
import { CursorThemeView } from '@/shared/CursorThemeView';
import { FileIcon } from '@/shared/FileIcon';

/** Cap for text reads; bigger files show read-only, truncated. */
const TEXT_MAX_BYTES = 1024 * 1024;
/** Never render more text than this (keeps the DOM responsive). */
const TEXT_MAX_CHARS = 512 * 1024;

/** pdf.js is big: it's loaded the first time a PDF is shown. */
const PdfView = lazy(() => import('@/shared/PdfView'));
/** So is three.js: it's loaded the first time a 3D model is shown. */
const ModelView = lazy(() => import('@/shared/model/ModelView'));

export interface FileViewerBodyProps {
  path: string;
  /** Size and mtime from the listing, when known (for thumbnails, headers). */
  size?: number | null;
  mtimeMs?: number | null;
  /** Let text files be edited and saved (Ctrl+S). */
  editable?: boolean;
  /** Reports unsaved changes in the text editor. */
  onDirtyChange?: (dirty: boolean) => void;
  /** Extract an archive being shown. */
  onExtract?: () => void;
  /** Install a cursor theme being shown and make it the pointer. */
  onUseCursor?: () => Promise<void>;
}

/**
 * What a file looks like inside: the picture, the video, the song, the
 * PDF, the 3D model, the text, the archive's listing, the cursor theme's cursors. Shared by the Preview window and Files'
 * Quick Look (Space).
 */
export function FileViewerBody({
  path,
  size = null,
  mtimeMs = null,
  editable,
  onDirtyChange,
  onExtract,
  onUseCursor,
}: FileViewerBodyProps) {
  const name = path.slice(path.lastIndexOf('/') + 1);
  const category = fileCategory(name, 'file');
  const base = useFileUrl(isViewableImage(name) || isPlayableVideo(name) || isPlayableAudio(name) || category === 'pdf' || isViewableModel(name) ? path : null);
  // Bust Chromium's media cache when the file changes under the same name.
  const url = base && `${base}${mtimeMs ? `?v=${Math.floor(mtimeMs)}` : ''}`;

  if (isViewableImage(name)) return url ? <ImageView key={url} url={url} name={name} /> : null;
  if (isPlayableVideo(name)) {
    if (!url) return <div className="h-full bg-black" />;
    return (
      <div className="grid h-full place-items-center bg-black">
        <video key={url} src={url} controls autoPlay className="max-h-full max-w-full" />
      </div>
    );
  }
  if (isPlayableAudio(name)) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-6 p-6">
        <FileIcon path={path} name={name} kind="file" size={size} mtimeMs={mtimeMs} px={96} />
        <p className="max-w-full truncate text-lg font-medium text-foreground">{name}</p>
        {url && <audio key={url} src={url} controls autoPlay className="w-full max-w-md" />}
      </div>
    );
  }
  if (category === 'pdf') {
    return (
      <Suspense fallback={null}>
        {url && <PdfView key={url} url={url} />}
      </Suspense>
    );
  }
  if (isViewableModel(name)) {
    return (
      <Suspense fallback={null}>
        {url && <ModelView key={url} url={url} name={name} />}
      </Suspense>
    );
  }
  if (isCursorTheme(name)) return <CursorThemeView key={path} path={path} mtimeMs={mtimeMs} onUse={onUseCursor} />;
  if (isExtractable(name)) return <ArchiveView path={path} onExtract={onExtract} />;
  if (category === 'document' || category === 'disk' || category === 'model' || category === 'program' || category === 'image' || category === 'video') {
    return <NoPreview path={path} name={name} size={size} mtimeMs={mtimeMs} />;
  }
  return (
    <TextView
      path={path}
      name={name}
      size={size}
      mtimeMs={mtimeMs}
      editable={editable}
      onDirtyChange={onDirtyChange}
    />
  );
}

/** A URL to load the file at `path` from, once there is one (fileUrl). */
function useFileUrl(path: string | null): string | null {
  const [got, setGot] = useState<{ path: string; url: string } | null>(null);
  useEffect(() => {
    if (!path) return;
    let live = true;
    // A file that can't be reached gets a URL that fails, so the view says so.
    fileUrl(path).then((url) => live && setGot({ path, url }), () => live && setGot({ path, url: 'din-file://invalid/' }));
    return () => {
      live = false;
    };
  }, [path]);
  return got && got.path === path ? got.url : null;
}

/** Each press of + or - zooms by this factor. */
const ZOOM_STEP = 1.25;
const MIN_ZOOM = 0.05;
const MAX_ZOOM = 32;
/** Padding around the picture when fit to the window (Tailwind p-4). */
const FIT_PADDING = 16;

function ImageView({ url, name }: { url: string; name: string }) {
  // Fit to the window (null), or a scale of the picture's own size. Click
  // switches between fit and actual size; + and - zoom in and out, 0 fits.
  const [zoom, setZoom] = useState<number | null>(null);
  const [failed, setFailed] = useState(false);
  const [natural, setNatural] = useState<{ width: number; height: number } | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  // The point of the picture at the middle of the view, as fractions of the
  // scrolled area, kept there across a zoom.
  const anchor = useRef<{ x: number; y: number } | null>(null);

  const zoomTo = useCallback((next: (current: number) => number | null) => {
    const scroller = scrollRef.current;
    if (!scroller || !natural) return;
    anchor.current = {
      x: (scroller.scrollLeft + scroller.clientWidth / 2) / scroller.scrollWidth,
      y: (scroller.scrollTop + scroller.clientHeight / 2) / scroller.scrollHeight,
    };
    setZoom((z) => {
      // Zooming from fit starts at the scale fit was showing.
      const current = z ?? Math.min(
        (scroller.clientWidth - 2 * FIT_PADDING) / natural.width,
        (scroller.clientHeight - 2 * FIT_PADDING) / natural.height,
      );
      const value = next(current);
      return value === null ? null : Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, value));
    });
  }, [natural]);

  useLayoutEffect(() => {
    const scroller = scrollRef.current;
    const a = anchor.current;
    anchor.current = null;
    if (!scroller || !a) return;
    scroller.scrollLeft = a.x * scroller.scrollWidth - scroller.clientWidth / 2;
    scroller.scrollTop = a.y * scroller.scrollHeight - scroller.clientHeight / 2;
  }, [zoom]);

  // The keys arrive wherever focus sits around the picture (the Preview
  // window keeps it on its own root), so listen on the document and take
  // the ones aimed at an element holding this view.
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      const scroller = scrollRef.current;
      const target = e.target;
      if (!scroller || !(target instanceof Element) || e.altKey || e.metaKey) return;
      if (!target.contains(scroller) && !scroller.contains(target)) return;
      if (target.closest('input, textarea, select, [contenteditable="true"]')) return;
      let step: ((z: number) => number | null) | undefined;
      if (e.key === '+' || e.key === '=') step = (z) => z * ZOOM_STEP;
      else if (e.key === '-' || e.key === '_') step = (z) => z / ZOOM_STEP;
      else if (e.key === '0') step = () => null;
      if (!step) return;
      e.preventDefault();
      zoomTo(step);
    };
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [zoomTo]);

  if (failed) {
    return (
      <p className="grid h-full place-items-center p-6 text-sm text-muted-foreground">
        This image can’t be shown.
      </p>
    );
  }
  return (
    <div className="relative h-full">
      <div
        ref={scrollRef}
        className={cn(
          'h-full overflow-auto bg-[repeating-conic-gradient(var(--color-muted)_0_25%,transparent_0_50%)] bg-[length:16px_16px]',
          zoom === null ? 'cursor-zoom-in p-4' : 'cursor-zoom-out',
        )}
        onClick={() => zoomTo(() => (zoom === null ? 1 : null))}
      >
        <div className={cn(zoom === null ? 'size-full' : 'grid min-h-full w-max min-w-full place-items-center')}>
          <img
            key={url}
            src={url}
            alt={name}
            draggable={false}
            onLoad={(e) => setNatural({ width: e.currentTarget.naturalWidth, height: e.currentTarget.naturalHeight })}
            onError={() => setFailed(true)}
            style={zoom !== null && natural ? { width: natural.width * zoom, height: natural.height * zoom } : undefined}
            className={cn(zoom === null ? 'size-full object-contain' : 'max-w-none')}
          />
        </div>
      </div>
      {zoom !== null && (
        <span className="pointer-events-none absolute right-3 bottom-3 rounded-md bg-background/80 px-2 py-0.5 text-xs tabular-nums text-foreground shadow-sm backdrop-blur">
          {Math.round(zoom * 100)}%
        </span>
      )}
    </div>
  );
}

function ArchiveView({ path, onExtract }: { path: string; onExtract?: () => void }) {
  const listing = useQuery({
    queryKey: ['fs', 'listArchive', path],
    queryFn: () => getFsBridge()!.listArchive(path),
    enabled: getFsBridge() !== undefined,
    retry: false,
  });

  return (
    <div className="flex h-full flex-col">
      <div className="flex shrink-0 items-center gap-3 border-b border-border/60 px-4 py-3">
        <FileArchive className="size-8 shrink-0 text-warning" strokeWidth={1.5} aria-hidden />
        <div className="min-w-0 flex-1">
          <p className="truncate text-sm font-medium text-foreground">
            {path.slice(path.lastIndexOf('/') + 1)}
          </p>
          <p className="text-xs text-muted-foreground">
            {listing.data
              ? `${listing.data.total.toLocaleString()} item${listing.data.total === 1 ? '' : 's'} inside`
              : listing.isError
                ? 'Can’t read this archive'
                : 'Reading…'}
          </p>
        </div>
        {onExtract && (
          <button
            type="button"
            onClick={onExtract}
            className="h-8 shrink-0 rounded-md bg-pigment clay-pigment px-3 text-sm font-medium text-primary-foreground hover:brightness-110 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            Extract Here
          </button>
        )}
      </div>
      <div className="min-h-0 flex-1 overflow-auto py-1">
        {listing.isLoading ? (
          <TextSkeleton />
        ) : listing.isError ? (
          <p className="p-4 text-sm text-muted-foreground">{cleanFsError(listing.error)}</p>
        ) : (
          <ul>
            {listing.data!.entries.map((entry, i) => {
              const dir = entry.endsWith('/');
              const label = dir ? entry.slice(0, -1) : entry;
              return (
                <li key={i} className="flex items-center gap-2 px-4 py-0.5 font-mono text-xs text-foreground/90">
                  {dir ? (
                    <Folder className="size-3.5 shrink-0 text-ink-accent" aria-hidden />
                  ) : (
                    <span className="size-3.5 shrink-0" />
                  )}
                  <span className="truncate">{label}</span>
                </li>
              );
            })}
            {listing.data!.total > listing.data!.entries.length && (
              <li className="px-4 py-1 text-xs text-muted-foreground">
                …and {(listing.data!.total - listing.data!.entries.length).toLocaleString()} more
              </li>
            )}
          </ul>
        )}
      </div>
    </div>
  );
}

function NoPreview({
  path,
  name,
  size,
  mtimeMs,
}: {
  path: string;
  name: string;
  size: number | null;
  mtimeMs: number | null;
}) {
  return (
    <div className="flex h-full flex-col items-center justify-center gap-3 p-6 text-center">
      <FileIcon path={path} name={name} kind="file" size={size} mtimeMs={mtimeMs} px={96} thumbnail={false} />
      <p className="max-w-full truncate text-base font-medium text-foreground">{name}</p>
      <p className="text-sm text-muted-foreground">
        {typeLabel(name, 'file')}
        {size !== null && ` · ${formatBytes(size)}`}
      </p>
      <p className="text-sm text-muted-foreground">There’s no preview for this kind of file.</p>
    </div>
  );
}

function TextView({
  path,
  name,
  size,
  mtimeMs,
  editable,
  onDirtyChange,
}: {
  path: string;
  name: string;
  size: number | null;
  mtimeMs: number | null;
  editable?: boolean;
  onDirtyChange?: (dirty: boolean) => void;
}) {
  const content = useFileContent(path, TEXT_MAX_BYTES);

  const text = useMemo(() => {
    if (!content.data) return null;
    const bytes = content.data.data;
    // A null byte near the start: it's binary.
    if (bytes.subarray(0, Math.min(bytes.length, 8192)).includes(0)) return null;
    return new TextDecoder('utf-8', { fatal: false }).decode(bytes).slice(0, TEXT_MAX_CHARS);
  }, [content.data]);

  if (content.isLoading) return <TextSkeleton />;
  if (content.isError) {
    return (
      <p className="p-4 text-sm text-muted-foreground">
        Couldn’t read this file: {cleanFsError(content.error)}
      </p>
    );
  }
  if (text === null) return <NoPreview path={path} name={name} size={size} mtimeMs={mtimeMs} />;

  const truncated = content.data!.truncated || text.length >= TEXT_MAX_CHARS;
  if (editable && !truncated) {
    return <TextEditor key={path} path={path} initial={text} onDirtyChange={onDirtyChange} />;
  }
  return (
    <div className="h-full overflow-auto">
      {truncated && (
        <p className="border-b border-border/60 bg-warning/10 px-4 py-1.5 text-xs text-warning">
          This file is too big to show in full - here’s the beginning.
        </p>
      )}
      <pre className="whitespace-pre-wrap break-words p-4 font-mono text-xs leading-relaxed text-foreground/90 select-text">
        {text}
      </pre>
    </div>
  );
}

/** A plain text editor: Ctrl+S saves. */
function TextEditor({
  path,
  initial,
  onDirtyChange,
}: {
  path: string;
  initial: string;
  onDirtyChange?: (dirty: boolean) => void;
}) {
  const queryClient = useQueryClient();
  const [saved, setSaved] = useState(initial);
  const [value, setValue] = useState(initial);
  const [status, setStatus] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const dirty = value !== saved;

  useEffect(() => {
    onDirtyChange?.(dirty);
  }, [dirty, onDirtyChange]);
  useEffect(() => () => onDirtyChange?.(false), [onDirtyChange]);

  const save = async () => {
    if (saving) return;
    setSaving(true);
    setStatus(null);
    const contents = value;
    try {
      await getFsBridge()!.writeFile(path, contents);
      setSaved(contents);
      setStatus('Saved');
      void queryClient.invalidateQueries({ queryKey: ['fs', 'readFile', path] });
    } catch (error) {
      setStatus(`Couldn’t save: ${cleanFsError(error)}`);
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="flex h-full flex-col">
      <textarea
        value={value}
        onChange={(e) => {
          setValue(e.target.value);
          setStatus(null);
        }}
        onKeyDown={(e) => {
          if ((e.ctrlKey || e.metaKey) && !e.altKey && e.key.toLowerCase() === 's') {
            e.preventDefault();
            e.stopPropagation();
            void save();
          } else if (e.key === 'Tab' && !e.ctrlKey && !e.altKey && !e.metaKey && !e.shiftKey) {
            // Tab indents, as in any text editor.
            e.preventDefault();
            const el = e.currentTarget;
            el.setRangeText('\t', el.selectionStart, el.selectionEnd, 'end');
            setValue(el.value);
          }
        }}
        spellCheck={false}
        aria-label="File contents"
        className="min-h-0 flex-1 resize-none bg-transparent p-4 font-mono text-sm leading-relaxed text-foreground outline-none [tab-size:4]"
      />
      <div className="flex shrink-0 items-center gap-3 border-t border-border/60 bg-background/50 px-3 py-1.5 text-xs text-muted-foreground">
        <span className="min-w-0 flex-1 truncate" role="status">
          {status ?? (dirty ? 'Edited' : '')}
        </span>
        <span className="hidden sm:inline">Ctrl+S to save</span>
        <button
          type="button"
          disabled={!dirty || saving}
          onClick={() => void save()}
          className="h-7 rounded-md bg-pigment clay-pigment px-3 font-medium text-primary-foreground hover:brightness-110 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-40"
        >
          {saving ? 'Saving…' : 'Save'}
        </button>
      </div>
    </div>
  );
}

function TextSkeleton() {
  return (
    <div className="space-y-2 p-4" aria-hidden>
      <Skeleton className="h-4 w-3/4 bg-foreground/10" />
      <Skeleton className="h-4 w-full bg-foreground/10" />
      <Skeleton className="h-4 w-2/3 bg-foreground/10" />
    </div>
  );
}
