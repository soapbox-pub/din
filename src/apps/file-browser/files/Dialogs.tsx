import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { X } from 'lucide-react';
import { cn } from '@/lib/utils';
import { cleanFsError, formatBytes, getFsBridge, isKnownTime, isValidEntryName, joinPath, parentPath } from '@/lib/fs';
import type { FsEntry } from '@/lib/fs';
import { typeLabel } from '@/lib/fileTypes';
import { useDiskUsage, useFsDetails } from '@/hooks/useFileSystem';
import { FileIcon } from '@/shared/FileIcon';
import { DialogButton, Overlay } from '@/shared/dialogs';
import { FeatureInstallButton } from '@/shared/FeatureInstall';

export { DialogButton, Overlay };

const DATE_FORMAT = new Intl.DateTimeFormat(undefined, { dateStyle: 'long', timeStyle: 'medium' });

/** "Delete these for good?" and similar yes/no questions. */
export function ConfirmDialog({
  title,
  message,
  confirmLabel,
  pending,
  onConfirm,
  onCancel,
}: {
  title: string;
  message?: string;
  confirmLabel: string;
  pending?: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  return (
    <Overlay label={title} onClose={onCancel}>
      <div className="p-4">
        <p className="text-sm font-medium text-foreground">{title}</p>
        {message && <p className="mt-1 text-sm text-muted-foreground">{message}</p>}
        <div className="mt-4 flex justify-end gap-2">
          <DialogButton onClick={onCancel} disabled={pending} autoFocus>
            Cancel
          </DialogButton>
          <DialogButton variant="destructive" onClick={onConfirm} disabled={pending}>
            {pending ? 'Working…' : confirmLabel}
          </DialogButton>
        </div>
      </div>
    </Overlay>
  );
}

const ARCHIVE_FORMATS = [
  { ext: '.zip', label: 'ZIP (.zip)', hint: 'Opens anywhere' },
  { ext: '.tar.gz', label: 'Tarball (.tar.gz)', hint: 'Keeps Linux permissions' },
  { ext: '.tar.xz', label: 'Tarball (.tar.xz)', hint: 'Smaller, slower' },
  { ext: '.tar.zst', label: 'Tarball (.tar.zst)', hint: 'Fast and small' },
];

/** Name and format for a new archive of the selection. */
export function CompressDialog({
  defaultName,
  count,
  pending,
  error,
  onSubmit,
  onCancel,
}: {
  defaultName: string;
  count: number;
  pending: boolean;
  error: string | null;
  onSubmit: (fileName: string) => void;
  onCancel: () => void;
}) {
  const [name, setName] = useState(defaultName);
  const [ext, setExt] = useState('.zip');
  const fileName = `${name.trim()}${ext}`;
  const valid = name.trim() !== '' && isValidEntryName(fileName);

  return (
    <Overlay label="Compress" onClose={onCancel}>
      <form
        className="p-4"
        onSubmit={(e) => {
          e.preventDefault();
          if (valid && !pending) onSubmit(fileName);
        }}
      >
        <p className="text-sm font-medium text-foreground">
          Compress {count === 1 ? '1 item' : `${count} items`}
        </p>
        <label className="mt-3 block text-xs text-muted-foreground" htmlFor="files-archive-name">
          Archive name
        </label>
        <div className="mt-1 flex items-center gap-2">
          <input
            id="files-archive-name"
            value={name}
            onChange={(e) => setName(e.target.value)}
            autoFocus
            onFocus={(e) => e.currentTarget.select()}
            spellCheck={false}
            autoComplete="off"
            className="h-8 min-w-0 flex-1 rounded-lg bg-foreground/[0.06] px-2 text-sm text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          />
          <span className="shrink-0 font-mono text-sm text-muted-foreground">{ext}</span>
        </div>
        <fieldset className="mt-3">
          <legend className="text-xs text-muted-foreground">Format</legend>
          <div className="mt-1 grid gap-1">
            {ARCHIVE_FORMATS.map((f) => (
              <label
                key={f.ext}
                className={cn(
                  'flex cursor-pointer items-center gap-2 rounded-md px-2 py-1.5 text-sm',
                  ext === f.ext ? 'bg-selected text-foreground' : 'text-foreground/80 hover:bg-foreground/5',
                )}
              >
                <input
                  type="radio"
                  name="files-archive-format"
                  checked={ext === f.ext}
                  onChange={() => setExt(f.ext)}
                  className="accent-primary"
                />
                <span className="flex-1">{f.label}</span>
                <span className="text-xs text-muted-foreground">{f.hint}</span>
              </label>
            ))}
          </div>
        </fieldset>
        {error && (
          <p role="alert" className="mt-3 text-sm text-destructive">
            {error}
          </p>
        )}
        {error && <FeatureInstallButton feature="archives" className="mt-2" />}
        <div className="mt-4 flex justify-end gap-2">
          <DialogButton onClick={onCancel} disabled={pending}>
            Cancel
          </DialogButton>
          <DialogButton type="submit" variant="primary" disabled={!valid || pending}>
            {pending ? 'Compressing…' : 'Create'}
          </DialogButton>
        </div>
      </form>
    </Overlay>
  );
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="grid grid-cols-[7rem_1fr] gap-3 py-1 text-sm">
      <dt className="text-muted-foreground">{label}</dt>
      <dd className="min-w-0 break-words text-foreground select-text">{children}</dd>
    </div>
  );
}

const WHO = [
  { label: 'Owner', shift: 6 },
  { label: 'Group', shift: 3 },
  { label: 'Others', shift: 0 },
];
const ACCESS = [
  { label: 'Read', bit: 4 },
  { label: 'Write', bit: 2 },
  { label: 'Run', folderLabel: 'Open', bit: 1 },
];

/** Properties of one item, or totals for several. */
export function PropertiesDialog({
  dir,
  entries,
  onClose,
}: {
  /** The folder the items are in. */
  dir: string;
  /** The items; with none, the folder itself. */
  entries: FsEntry[];
  onClose: () => void;
}) {
  const single = entries.length <= 1;
  const path = entries.length === 1 ? joinPath(dir, entries[0].name) : entries.length === 0 ? dir : null;
  return (
    <Overlay label="Properties" onClose={onClose} className="max-w-lg">
      <div className="flex items-center justify-between border-b border-border/60 px-4 py-2">
        <p className="text-sm font-medium text-foreground">Properties</p>
        <button
          type="button"
          aria-label="Close"
          onClick={onClose}
          className="grid size-7 place-items-center rounded-md text-foreground/70 hover:bg-foreground/10 hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          <X className="size-4" />
        </button>
      </div>
      <div className="min-h-0 overflow-y-auto p-4">
        {single && path ? <SingleProperties path={path} /> : <MultiProperties dir={dir} entries={entries} />}
      </div>
    </Overlay>
  );
}

function SingleProperties({ path }: { path: string }) {
  const queryClient = useQueryClient();
  const details = useFsDetails(path);
  const d = details.data;
  const usage = useDiskUsage(d?.kind === 'directory' ? path : null);
  const [chmodError, setChmodError] = useState<string | null>(null);
  const name = path === '/' ? '/' : path.slice(path.lastIndexOf('/') + 1);

  if (details.isLoading) return <p className="text-sm text-muted-foreground">Loading…</p>;
  if (details.isError || !d) {
    return <p className="text-sm text-muted-foreground">Couldn’t read this: {cleanFsError(details.error)}</p>;
  }

  const setMode = async (mode: number) => {
    setChmodError(null);
    try {
      await getFsBridge()!.chmod(path, mode);
    } catch (error) {
      setChmodError(cleanFsError(error));
    }
    void queryClient.invalidateQueries({ queryKey: ['fs', 'details', path] });
  };

  return (
    <>
      <div className="mb-3 flex items-center gap-3">
        <FileIcon path={path} name={name} kind={d.kind} size={d.size} mtimeMs={d.mtimeMs} symlink={d.symlink} px={56} />
        <div className="min-w-0">
          <p className="break-words text-base font-medium text-foreground select-text">{name}</p>
          <p className="text-sm text-muted-foreground">{typeLabel(name, d.kind)}</p>
        </div>
      </div>
      <dl>
        <Row label="Size">
          {d.kind === 'directory'
            ? usage.data
              ? `${(usage.data.files + usage.data.dirs).toLocaleString()} items, ${formatBytes(usage.data.bytes)}${usage.data.truncated ? ' (or more)' : ''}`
              : usage.isError
                ? '—'
                : 'Counting…'
            : `${formatBytes(d.size)} (${d.size.toLocaleString()} bytes)`}
        </Row>
        <Row label="Location">{parentPath(path)}</Row>
        {d.symlink && <Row label="Link to">{d.linkTarget ?? 'Unknown'}</Row>}
        {d.trashOrigin && (
          <>
            <Row label="Came from">{d.trashOrigin.path}</Row>
            {d.trashOrigin.deletedAt && <Row label="Trashed">{DATE_FORMAT.format(new Date(d.trashOrigin.deletedAt))}</Row>}
          </>
        )}
        <Row label="Modified">{isKnownTime(d.mtimeMs) ? DATE_FORMAT.format(d.mtimeMs) : '—'}</Row>
        <Row label="Accessed">{isKnownTime(d.atimeMs) ? DATE_FORMAT.format(d.atimeMs) : '—'}</Row>
        {d.birthtimeMs !== null && (
          <Row label="Created">{isKnownTime(d.birthtimeMs) ? DATE_FORMAT.format(d.birthtimeMs) : '—'}</Row>
        )}
        {d.free !== null && d.total !== null && (
          <Row label="Free space">
            {formatBytes(d.free)} of {formatBytes(d.total)}
          </Row>
        )}
        <Row label="Owner">
          {d.owner} <span className="text-muted-foreground">· group {d.group}</span>
        </Row>
      </dl>

      <div className="mt-3 rounded-xl bg-card clay p-3">
        <div className="mb-2 flex items-baseline justify-between">
          <p className="text-sm font-medium text-foreground">Permissions</p>
          <span className="font-mono text-xs text-muted-foreground">{d.mode.toString(8).padStart(4, '0')}</span>
        </div>
        <table className="w-full text-sm">
          <thead>
            <tr className="text-xs text-muted-foreground">
              <th className="text-left font-normal" />
              {ACCESS.map((a) => (
                <th key={a.bit} className="w-16 font-normal">
                  {d.kind === 'directory' && a.folderLabel ? a.folderLabel : a.label}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {WHO.map((w) => (
              <tr key={w.shift}>
                <td className="py-1 text-foreground/80">{w.label}</td>
                {ACCESS.map((a) => {
                  const bit = a.bit << w.shift;
                  return (
                    <td key={a.bit} className="text-center">
                      <input
                        type="checkbox"
                        aria-label={`${w.label} ${a.label}`}
                        checked={(d.mode & bit) !== 0}
                        disabled={!d.isOwner}
                        onChange={(e) => void setMode(e.target.checked ? d.mode | bit : d.mode & ~bit)}
                        className="size-4 accent-primary disabled:opacity-50"
                      />
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
        {!d.isOwner && (
          <p className="mt-2 text-xs text-muted-foreground">Only its owner ({d.owner}) can change these.</p>
        )}
        {chmodError && (
          <p role="alert" className="mt-2 text-xs text-destructive">
            {chmodError}
          </p>
        )}
      </div>
    </>
  );
}

function MultiProperties({ dir, entries }: { dir: string; entries: FsEntry[] }) {
  const folders = entries.filter((e) => e.kind === 'directory');
  const fileBytes = entries.reduce((sum, e) => sum + (e.kind === 'file' ? (e.size ?? 0) : 0), 0);
  const usage = useQuery({
    queryKey: ['fs', 'du-many', dir, folders.map((f) => f.name)],
    queryFn: async () => {
      const results = await Promise.all(folders.map((f) => getFsBridge()!.du(joinPath(dir, f.name))));
      return results.reduce(
        (acc, r) => ({ items: acc.items + r.files + r.dirs, bytes: acc.bytes + r.bytes, truncated: acc.truncated || r.truncated }),
        { items: 0, bytes: 0, truncated: false },
      );
    },
    enabled: folders.length > 0,
    retry: false,
  });

  return (
    <dl>
      <Row label="Selected">
        {entries.length.toLocaleString()} items
        {folders.length > 0 && ` (${folders.length} folder${folders.length === 1 ? '' : 's'})`}
      </Row>
      <Row label="Total size">
        {folders.length === 0
          ? formatBytes(fileBytes)
          : usage.data
            ? `${formatBytes(fileBytes + usage.data.bytes)}${usage.data.truncated ? ' (or more)' : ''}, ${(entries.length - folders.length + usage.data.items).toLocaleString()} files and folders inside`
            : 'Counting…'}
      </Row>
      <Row label="Location">{dir}</Row>
    </dl>
  );
}

const SHORTCUTS: [string, string][] = [
  ['Open', 'Enter · double-click'],
  ['Quick Look', 'Space'],
  ['Go up', 'Backspace · Alt+↑'],
  ['Back / forward', 'Alt+← / Alt+→'],
  ['Home folder', 'Alt+Home'],
  ['Type a location', 'Ctrl+L'],
  ['Search this folder and subfolders', 'Start typing · Ctrl+F'],
  ['Select all', 'Ctrl+A'],
  ['Copy / cut / paste', 'Ctrl+C / Ctrl+X / Ctrl+V'],
  ['Undo', 'Ctrl+Z'],
  ['Rename', 'F2'],
  ['Move to Trash', 'Delete'],
  ['Delete permanently', 'Shift+Delete'],
  ['New folder', 'Ctrl+Shift+N'],
  ['Properties', 'Alt+Enter'],
  ['Show hidden files', 'Ctrl+H'],
  ['Add to Favorites', 'Ctrl+D'],
  ['List / grid view', 'Ctrl+1 / Ctrl+2'],
  ['Bigger / smaller icons', 'Ctrl+= / Ctrl+-'],
  ['Show sidebar', 'F9'],
  ['Refresh', 'F5 · Ctrl+R'],
  ['New tab / window', 'Ctrl+T / Ctrl+N'],
  ['Close tab', 'Ctrl+W'],
  ['Next / previous tab', 'Ctrl+Tab / Ctrl+Shift+Tab'],
];

export function ShortcutsDialog({ onClose }: { onClose: () => void }) {
  return (
    <Overlay label="Keyboard shortcuts" onClose={onClose} className="max-w-lg">
      <div className="flex items-center justify-between border-b border-border/60 px-4 py-2">
        <p className="text-sm font-medium text-foreground">Keyboard shortcuts</p>
        <button
          type="button"
          aria-label="Close"
          onClick={onClose}
          autoFocus
          className="grid size-7 place-items-center rounded-md text-foreground/70 hover:bg-foreground/10 hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          <X className="size-4" />
        </button>
      </div>
      <dl className="min-h-0 overflow-y-auto px-4 py-2">
        {SHORTCUTS.map(([what, keys]) => (
          <div key={what} className="flex items-center justify-between gap-4 py-1 text-sm">
            <dt className="text-foreground/90">{what}</dt>
            <dd className="text-right font-mono text-xs text-muted-foreground">{keys}</dd>
          </div>
        ))}
      </dl>
    </Overlay>
  );
}
