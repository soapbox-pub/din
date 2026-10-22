import { useEffect, useMemo, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { FileArchive, Folder } from 'lucide-react';
import { cn } from '@/lib/utils';
import { cleanFsError, formatBytes, getFsBridge, localFileUrl } from '@/lib/fs';
import {
  fileCategory,
  isExtractable,
  isPlayableAudio,
  isPlayableVideo,
  isViewableImage,
  typeLabel,
} from '@/lib/fileTypes';
import { useFileContent } from '@/hooks/useFileSystem';
import { Skeleton } from '@/components/ui/skeleton';
import { FileIcon } from './FileIcon';

/** Cap for text reads; bigger files show read-only, truncated. */
const TEXT_MAX_BYTES = 1024 * 1024;
/** Never render more text than this (keeps the DOM responsive). */
const TEXT_MAX_CHARS = 512 * 1024;

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
}

/**
 * What a file looks like inside: the picture, the video, the song, the
 * text, the archive's listing. Shared by the Preview window and Files'
 * Quick Look (Space).
 */
export function FileViewerBody({
  path,
  size = null,
  mtimeMs = null,
  editable,
  onDirtyChange,
  onExtract,
}: FileViewerBodyProps) {
  const name = path.slice(path.lastIndexOf('/') + 1);
  // Bust Chromium's media cache when the file changes under the same name.
  const url = `${localFileUrl(path)}${mtimeMs ? `?v=${Math.floor(mtimeMs)}` : ''}`;

  if (isViewableImage(name)) return <ImageView key={url} url={url} name={name} />;
  if (isPlayableVideo(name)) {
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
        <audio key={url} src={url} controls autoPlay className="w-full max-w-md" />
      </div>
    );
  }
  if (isExtractable(name)) return <ArchiveView path={path} onExtract={onExtract} />;
  const category = fileCategory(name, 'file');
  if (category === 'pdf' || category === 'document' || category === 'disk' || category === 'program' || category === 'image' || category === 'video') {
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

function ImageView({ url, name }: { url: string; name: string }) {
  // Fit to the window, or actual size (click to switch).
  const [actual, setActual] = useState(false);
  const [failed, setFailed] = useState(false);

  if (failed) {
    return (
      <p className="grid h-full place-items-center p-6 text-sm text-muted-foreground">
        This image can’t be shown.
      </p>
    );
  }
  return (
    <div
      className={cn(
        'h-full overflow-auto bg-[repeating-conic-gradient(var(--color-muted)_0_25%,transparent_0_50%)] bg-[length:16px_16px]',
        actual ? 'cursor-zoom-out' : 'cursor-zoom-in p-4',
      )}
      onClick={() => setActual((a) => !a)}
    >
      <img
        key={url}
        src={url}
        alt={name}
        draggable={false}
        onError={() => setFailed(true)}
        className={cn(actual ? 'max-w-none' : 'size-full object-contain')}
      />
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
        <FileArchive className="size-8 shrink-0 text-orange-500" strokeWidth={1.5} aria-hidden />
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
            className="h-8 shrink-0 rounded-md bg-primary px-3 text-sm font-medium text-primary-foreground hover:bg-primary/90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
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
                    <Folder className="size-3.5 shrink-0 text-primary" aria-hidden />
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
        <p className="border-b border-border/60 bg-amber-500/10 px-4 py-1.5 text-xs text-amber-700 dark:text-amber-300">
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
          className="h-7 rounded-md bg-primary px-3 font-medium text-primary-foreground hover:bg-primary/90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-40"
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
