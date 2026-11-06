import { useEffect, useRef, useState } from 'react';
import { Check, CircleAlert, Copy, ExternalLink, LoaderCircle, CloudUpload } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { formatBytes, getFsBridge } from '@/lib/fs';
import { cn } from '@/lib/utils';
import type { BlossomBlob } from '@/sdk';
import { useDin, useWindowTitle } from '@/sdk/react';
import { FormWindow, ToolButton } from '@/shared/appChrome';
import { toolIcon } from '@/shared/appChromeStyles';
import { FileIcon } from '@/shared/FileIcon';
import { settingsGroup } from '@/shared/settingsChromeStyles';

type Row =
  | { state: 'waiting' }
  | { state: 'uploading' }
  | { state: 'done'; blob: BlossomBlob }
  | { state: 'failed'; error: string };

/** Whether a row's link is the one last copied. */
function copiedRow(row: Row, copied: string | null): boolean {
  return row.state === 'done' && row.blob.url === copied;
}

const basename = (path: string) => path.slice(path.lastIndexOf('/') + 1);

function cleanError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.replace(/^Error invoking remote method '[^']+': (Error: )?/, '');
}

/** One file: what it is, then how its upload is going, then its URL to copy. */
function FileRow({ path, size, row, copied, onCopy }: {
  path: string;
  size: number | null;
  row: Row;
  copied: boolean;
  onCopy: (url: string) => void;
}) {
  const name = basename(path);
  return (
    <li className="flex flex-col gap-2 px-4 py-3">
      <div className="flex min-w-0 items-center gap-3">
        <FileIcon path={path} name={name} kind="file" size={size} mtimeMs={null} px={32} />
        <div className="min-w-0 flex-1">
          <p className="truncate text-sm font-medium">{name}</p>
          <p className={cn('truncate text-xs', row.state === 'failed' ? 'text-destructive' : 'text-muted-foreground')}>
            {row.state === 'uploading'
              ? 'Uploading…'
              : row.state === 'failed'
                ? row.error
                : row.state === 'done'
                  ? `${formatBytes(row.blob.size)} · on Blossom`
                  : size !== null ? formatBytes(size) : ' '}
          </p>
        </div>
        {row.state === 'uploading' && <LoaderCircle className="size-4.5 shrink-0 animate-spin text-muted-foreground" aria-label="Uploading" />}
        {row.state === 'failed' && <CircleAlert className="size-4.5 shrink-0 text-destructive" aria-hidden />}
      </div>
      {row.state === 'done' && (
        <div className="flex items-center gap-1">
          <Input
            readOnly
            value={row.blob.url}
            aria-label={`Link to ${name}`}
            className="h-8 flex-1 rounded-full font-mono text-xs"
            onFocus={(e) => e.currentTarget.select()}
          />
          <ToolButton size="sm" label={copied ? 'Copied' : 'Copy Link'} onClick={() => onCopy(row.blob.url)}>
            {copied ? <Check {...toolIcon} /> : <Copy {...toolIcon} />}
          </ToolButton>
          <ToolButton size="sm" label="Open in Web Browser" onClick={() => void window.open(row.blob.url)}>
            <ExternalLink {...toolIcon} />
          </ToolButton>
        </div>
      )}
    </li>
  );
}

/**
 * Upload to Blossom…, in a window of its own (opened with
 * `{ window: 'upload' }`, with the files as its launch's): the files, and a word that they'll be
 * public, then each one's upload through the desktop
 * (`din.files.upload`, to the servers Settings lists) and the link it
 * gets, to copy. One file's link is copied as soon as it's there.
 */
export function UploadWindow({ files }: { files: FileSystemFileHandle[] }) {
  const din = useDin();
  const [paths] = useState(() => files.map((f) => din.files.path(f)));
  useWindowTitle(paths.length === 1 ? `Upload ${basename(paths[0])}` : 'Upload to Blossom');
  const [rows, setRows] = useState<Row[]>(() => paths.map(() => ({ state: 'waiting' })));
  const [sizes, setSizes] = useState<(number | null)[]>(() => paths.map(() => null));
  const [copied, setCopied] = useState<string | null>(null);
  const running = useRef(false);

  useEffect(() => {
    // By stat: reading a file for its size would read all of it.
    const fs = getFsBridge();
    if (!fs) return;
    let live = true;
    void Promise.all(paths.map((p) => fs.stat(p).then((s) => s.size, () => null))).then((s) => live && setSizes(s));
    return () => {
      live = false;
    };
  }, [paths]);

  const copy = (url: string) => {
    void navigator.clipboard?.writeText(url).then(() => setCopied(url), () => {});
  };

  const set = (i: number, row: Row) => setRows((rs) => rs.map((r, j) => (j === i ? row : r)));
  /** Upload these, one at a time: each is read whole, and a signer may ask about each. */
  const run = async (which: number[]) => {
    if (running.current) return;
    running.current = true;
    for (const i of which) set(i, { state: 'waiting' });
    for (const i of which) {
      set(i, { state: 'uploading' });
      try {
        const blob = await din.files.upload(files[i]);
        set(i, { state: 'done', blob });
        if (paths.length === 1) copy(blob.url);
      } catch (error) {
        set(i, { state: 'failed', error: cleanError(error) });
      }
    }
    running.current = false;
  };

  const busy = rows.some((r) => r.state === 'uploading');
  const finished = rows.every((r) => r.state === 'done' || r.state === 'failed');
  const failed = rows.flatMap((r, i) => (r.state === 'failed' ? [i] : []));
  const links = rows.flatMap((r) => (r.state === 'done' ? [r.blob.url] : []));

  const one = paths.length === 1;
  const description = !finished && !busy
    ? `${one ? 'It goes' : 'They go'} to your Blossom servers, signed as you, and anyone with the link can get ${one ? 'it' : 'each one'}. Once a file is uploaded, it can’t be taken back from everyone who has it.`
    : finished && one && links.length === 1 && copied === links[0]
      ? 'The link is copied. Paste it wherever you’d like to share the file.'
      : undefined;

  return (
    <FormWindow
      title={one ? 'Upload to Blossom' : `Upload ${paths.length} Files to Blossom`}
      description={description}
      footer={
        finished ? (
          <>
            {failed.length > 0 && <Button variant="outline" onClick={() => void run(failed)}>Try Again</Button>}
            {links.length > 1 && (
              <Button variant="outline" onClick={() => copy(links.join('\n'))}>
                {copied === links.join('\n') ? <Check {...toolIcon} aria-hidden /> : <Copy {...toolIcon} aria-hidden />}
                Copy All Links
              </Button>
            )}
            <Button onClick={() => window.close()} autoFocus>Done</Button>
          </>
        ) : (
          <>
            <Button variant="outline" onClick={() => window.close()} disabled={busy}>Cancel</Button>
            <Button onClick={() => void run(paths.map((_, i) => i))} disabled={busy || paths.length === 0} autoFocus>
              {busy ? <LoaderCircle className="size-4.5 animate-spin" aria-hidden /> : <CloudUpload className="size-4.5" strokeWidth={1.75} aria-hidden />}
              {busy ? 'Uploading…' : 'Upload'}
            </Button>
          </>
        )
      }
    >
      <ul className={settingsGroup}>
        {paths.map((path, i) => (
          <FileRow key={path} path={path} size={sizes[i]} row={rows[i]} copied={copiedRow(rows[i], copied)} onCopy={copy} />
        ))}
      </ul>
    </FormWindow>
  );
}
