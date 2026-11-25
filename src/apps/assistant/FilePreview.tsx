import { lazy, Suspense, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { Skeleton } from '@/components/ui/skeleton';
import { useDin } from '@/sdk/react';
import { useHomeDirectory } from '@/hooks/useAssistant';
import { useDirectory, useFileContent, useWatchDirectory } from '@/hooks/useFileSystem';
import { cleanFsError, parentPath } from '@/lib/fs';
import { cn } from '@/lib/utils';
import { FileViewerBody } from '@/shared/FileViewerBody';
import { Markdown } from '@/shared/assistant/Markdown';
import { FileLinkBaseContext } from '@/shared/assistant/fileLinks';
import { fileView } from '@/shared/assistant/previews';
import { decodeText, isUtf16 } from '@/shared/textEncoding';

/*
 * A file the agent showed beside the conversation (previews.ts): a web page
 * framed through a URL that serves its folder alone (din.files.pageUrl),
 * sandboxed in an origin of its own; Markdown drawn as a document; text and
 * code highlighted as the Text Editor does; anything else as Preview shows
 * it. The page, the Markdown and an SVG show their source when asked. The
 * file's folder is watched, so what the agent changes shows as it's saved.
 */

/** Whether a file is shown drawn, or as its source. */
export type FileMode = 'rendered' | 'source';

/** A file's page: an opaque origin, as the CSP it's served with has it too. */
const FILE_SANDBOX = 'allow-scripts allow-forms allow-popups allow-modals allow-downloads allow-pointer-lock';

/** Cap for reading text; a bigger file shows its beginning. */
const TEXT_MAX_BYTES = 2 * 1024 * 1024;

/** The code view, CodeMirror and its languages, loaded with the first file shown as code. */
const CodeView = lazy(() => import('@/shared/code/CodeView'));

export function FilePreview({ path, title, mode, reload }: { path: string; title: string; mode: FileMode; reload: number }) {
  const view = fileView(path);
  const name = path.slice(path.lastIndexOf('/') + 1);
  const dir = parentPath(path);
  // The folder's listing has the file's size and mtime, kept current by watching it.
  const listing = useDirectory(dir);
  useWatchDirectory(dir);
  const entry = listing.data?.entries.find((e) => e.name === name);
  const mtimeMs = entry?.mtimeMs ?? null;
  const size = entry?.size ?? null;

  const source = mode === 'source' || view === 'text';
  let body: ReactNode;
  if (source) {
    body = <SourceView path={path} name={name} size={size} mtimeMs={mtimeMs} />;
  } else if (view === 'page') {
    body = <PageView path={path} title={title} version={`${reload}:${mtimeMs ?? ''}`} />;
  } else if (view === 'markdown') {
    body = <MarkdownView path={path} mtimeMs={mtimeMs} />;
  } else {
    body = <FileViewerBody key={`${path}#${reload}`} path={path} size={size} mtimeMs={mtimeMs} />;
  }

  return (
    <div
      className={cn(
        'flex min-h-0 flex-1 flex-col overflow-hidden',
        // A page is drawn on white, as a browser would; the rest on the window's own.
        !source && view === 'page' ? 'bg-white' : 'bg-background',
      )}
    >
      {body}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Reading text
// ---------------------------------------------------------------------------

/** A file's text, read again when it changes on disk; null while it loads, or for one that isn't text. */
function useFileText(path: string, mtimeMs: number | null) {
  const content = useFileContent(path, TEXT_MAX_BYTES);
  const queryClient = useQueryClient();
  const seen = useRef({ path, mtimeMs });
  useEffect(() => {
    const before = seen.current;
    seen.current = { path, mtimeMs };
    if (before.path !== path || before.mtimeMs === mtimeMs || before.mtimeMs === null) return;
    void queryClient.invalidateQueries({ queryKey: ['fs', 'readFile', path] });
  }, [path, mtimeMs, queryClient]);

  const text = useMemo(() => {
    if (!content.data) return undefined;
    const bytes = content.data.data;
    // A null byte near the start: it's binary (unless it's UTF-16, as Windows writes).
    if (!isUtf16(bytes) && bytes.subarray(0, Math.min(bytes.length, 8192)).includes(0)) return null;
    return decodeText(bytes).text;
  }, [content.data]);

  return {
    text,
    truncated: content.data?.truncated ?? false,
    error: content.isError ? cleanFsError(content.error) : null,
  };
}

function SourceView({ path, name, size, mtimeMs }: { path: string; name: string; size: number | null; mtimeMs: number | null }) {
  const { text, truncated, error } = useFileText(path, mtimeMs);
  if (error) return <Problem title="Couldn’t read this file" detail={error} />;
  if (text === undefined) return <TextSkeleton />;
  // Not text after all: shown as Preview would (its icon, its kind and size).
  if (text === null) return <FileViewerBody path={path} size={size} mtimeMs={mtimeMs} />;
  return (
    <>
      {truncated && <TruncatedNote />}
      <Suspense fallback={<TextSkeleton />}>
        <CodeView text={text} name={name} className="min-h-0 flex-1" />
      </Suspense>
    </>
  );
}

function MarkdownView({ path, mtimeMs }: { path: string; mtimeMs: number | null }) {
  const { text, truncated, error } = useFileText(path, mtimeMs);
  const home = useHomeDirectory();
  // Its links and pictures are relative to its own folder, not the conversation's.
  const base = useMemo(() => ({ directory: parentPath(path), home }), [path, home]);

  if (error) return <Problem title="Couldn’t read this file" detail={error} />;
  if (text === undefined) return <TextSkeleton />;
  if (text === null) return <Problem title="This isn’t a Markdown file" detail="It isn’t text. Show its source to see what’s in it." />;
  return (
    <div className="min-h-0 flex-1 overflow-y-auto select-text">
      {truncated && <TruncatedNote />}
      <FileLinkBaseContext value={base}>
        <Markdown text={text} asDocument className="mx-auto max-w-3xl px-8 py-8 text-base" />
      </FileLinkBaseContext>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Web pages
// ---------------------------------------------------------------------------

/** URLs of files' pages, by path: one each for as long as the window's page is loaded. */
const pageUrls = new Map<string, Promise<string>>();

/** The URL a file's page is framed from (din.files.pageUrl), or why it can't be. */
function usePageUrl(path: string): { url?: string; error?: string } {
  const din = useDin();
  const [state, setState] = useState<{ path: string; url?: string; error?: string } | null>(null);
  useEffect(() => {
    let live = true;
    let pending = pageUrls.get(path);
    if (!pending) {
      pending = din.files.fromPath(path).then((handle) => {
        if (handle.kind !== 'file') throw new Error(`${path} is a folder`);
        return din.files.pageUrl(handle as FileSystemFileHandle);
      });
      pageUrls.set(path, pending);
      // Tried again the next time it's shown.
      pending.catch(() => pageUrls.delete(path));
    }
    pending.then(
      (url) => live && setState({ path, url }),
      (error: unknown) => live && setState({ path, error: error instanceof Error ? error.message : String(error) }),
    );
    return () => {
      live = false;
    };
  }, [din, path]);
  return state?.path === path ? state : {};
}

/** An HTML file as a web page, framed again when it's reloaded or changes on disk. */
function PageView({ path, title, version }: { path: string; title: string; version: string }) {
  const { url, error } = usePageUrl(path);
  if (error) return <Problem title="Couldn’t show this page" detail={error} />;
  if (!url) return <PageSkeleton />;
  return (
    <iframe
      key={`${url}#${version}`}
      src={url}
      title={title}
      sandbox={FILE_SANDBOX}
      referrerPolicy="no-referrer"
      className="size-full flex-1 border-0 bg-white"
    />
  );
}

// ---------------------------------------------------------------------------
// States
// ---------------------------------------------------------------------------

function Problem({ title, detail }: { title: string; detail: string }) {
  return (
    <div className="grid flex-1 place-items-center bg-background px-6 text-center text-sm text-muted-foreground">
      <p className="max-w-sm">
        <span className="block font-medium text-foreground">{title}</span>
        <span className="mt-1 block">{detail}</span>
      </p>
    </div>
  );
}

function TruncatedNote() {
  return (
    <p className="shrink-0 border-b border-border/60 bg-warning/10 px-4 py-1.5 text-xs text-warning">
      This file is too big to show in full. Here’s the beginning.
    </p>
  );
}

function PageSkeleton() {
  return (
    <div className="flex-1 space-y-3 bg-background p-6" aria-label="Loading the page">
      <Skeleton className="h-6 w-1/2" />
      <Skeleton className="h-4 w-full" />
      <Skeleton className="h-4 w-5/6" />
      <Skeleton className="h-40 w-full rounded-xl" />
    </div>
  );
}

function TextSkeleton() {
  return (
    <div className="flex-1 space-y-2 p-4" aria-label="Loading the file">
      <Skeleton className="h-4 w-3/4" />
      <Skeleton className="h-4 w-full" />
      <Skeleton className="h-4 w-2/3" />
      <Skeleton className="h-4 w-5/6" />
    </div>
  );
}
