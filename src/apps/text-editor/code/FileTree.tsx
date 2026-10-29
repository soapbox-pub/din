import { useEffect, useRef, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { ChevronRight } from 'lucide-react';
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuShortcut,
  ContextMenuTrigger,
} from '@/components/ui/context-menu';
import { Skeleton } from '@/components/ui/skeleton';
import { invalidateListings, useDirectory, useWatchDirectory } from '@/hooks/useFileSystem';
import { cleanFsError, getFsBridge, isValidEntryName, joinPath, parentPath, sortEntries, type FsEntry } from '@/lib/fs';
import { cn } from '@/lib/utils';
import { FileIcon } from '@/shared/FileIcon';

/** Entries a project never needs to see. */
const HIDDEN = new Set(['.git', '.hg', '.svn', '.DS_Store']);
const ROW_HEIGHT = 24;
const INDENT = 12;

type Editing =
  | { kind: 'file' | 'folder'; dir: string }
  | { kind: 'rename'; path: string };

export interface FileTreeActions {
  open(path: string): void;
  /** Something was renamed or moved: tabs on it (or inside it) follow. */
  renamed(from: string, to: string): void;
  /** Something went to the Trash. */
  removed(path: string): void;
  revealInFiles(path: string): void;
  openTerminal(dir: string): void;
  copyText(text: string): void;
  status(text: string): void;
}

/**
 * The open folder as a tree: folders expand in place and follow changes on
 * disk, files open on click. Arrow keys move through it like VS Code's
 * explorer; the context menu makes, renames and trashes things.
 */
export function FileTree({
  root,
  expanded,
  onToggle,
  activePath,
  actions,
  request,
}: {
  root: string;
  expanded: ReadonlySet<string>;
  onToggle: (dir: string, open?: boolean) => void;
  activePath: string | null;
  actions: FileTreeActions;
  /** A new file or folder asked for from outside (the sidebar's buttons), in the selected folder. */
  request: { kind: 'file' | 'folder'; token: number } | null;
}) {
  const [selected, setSelected] = useState<string | null>(null);
  const [editing, setEditing] = useState<Editing | null>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const queryClient = useQueryClient();
  const fs = getFsBridge();

  // The open file shows as selected, its folders opened up to it.
  const [prevActive, setPrevActive] = useState(activePath);
  if (activePath !== prevActive) {
    setPrevActive(activePath);
    if (activePath?.startsWith(`${root}/`)) setSelected(activePath);
  }
  useEffect(() => {
    if (!activePath?.startsWith(`${root}/`)) return;
    for (let dir = parentPath(activePath); dir.length > root.length; dir = parentPath(dir)) {
      if (!expanded.has(dir)) onToggle(dir, true);
    }
    // Only when the file changes, not each time a folder is opened or shut.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activePath, root]);

  useEffect(() => {
    if (!selected) return;
    const row = containerRef.current?.querySelector<HTMLElement>(`[data-path="${CSS.escape(selected)}"]`);
    row?.scrollIntoView({ block: 'nearest' });
  }, [selected]);

  const startNew = (kind: 'file' | 'folder', dir: string) => {
    if (dir !== root) onToggle(dir, true);
    setEditing({ kind, dir });
  };

  const lastRequest = useRef(request?.token ?? 0);
  useEffect(() => {
    if (!request || request.token === lastRequest.current) return;
    lastRequest.current = request.token;
    const row = selected ? containerRef.current?.querySelector<HTMLElement>(`[data-path="${CSS.escape(selected)}"]`) : null;
    const dir = !selected || !row ? root : row.dataset.kind === 'directory' ? selected : parentPath(selected);
    if (dir !== root) onToggle(dir, true);
    setEditing({ kind: request.kind, dir });
    // Only for a new request.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [request]);

  const finishEdit = async (name: string) => {
    const edit = editing;
    setEditing(null);
    containerRef.current?.focus();
    if (!edit || !fs) return;
    name = name.trim();
    if (!name) return;
    const parts = name.split('/').filter(Boolean);
    if (parts.length === 0 || !parts.every(isValidEntryName)) {
      actions.status(`“${name}” isn’t a valid name.`);
      return;
    }
    try {
      if (edit.kind === 'rename') {
        if (parts.length > 1) throw new Error('A new name can’t contain “/”');
        const to = joinPath(parentPath(edit.path), name);
        if (to === edit.path) return;
        await fs.move(edit.path, to);
        void invalidateListings(queryClient, edit.path, to);
        actions.renamed(edit.path, to);
        setSelected(to);
      } else {
        // "src/new.ts" makes the folders on the way, like VS Code.
        const target = parts.reduce((dir, part) => joinPath(dir, part), edit.dir);
        const dir = parentPath(target);
        if (dir !== edit.dir) await fs.mkdir(dir);
        if (edit.kind === 'folder') {
          await fs.mkdir(target);
        } else {
          const exists = await fs.stat(target).then(() => true, () => false);
          if (exists) throw new Error(`“${parts.at(-1)}” already exists`);
          await fs.writeFile(target, '');
        }
        for (let d = dir; d.length > root.length; d = parentPath(d)) onToggle(d, true);
        void invalidateListings(queryClient, target);
        setSelected(target);
        if (edit.kind === 'file') actions.open(target);
      }
    } catch (error) {
      actions.status(`Couldn’t ${edit.kind === 'rename' ? 'rename' : 'create'} it: ${cleanFsError(error)}`);
    }
  };

  const trash = async (path: string) => {
    if (!fs || path === root) return;
    try {
      await fs.trash(path);
      void invalidateListings(queryClient, path);
      actions.removed(path);
      actions.status(`Moved “${path.slice(path.lastIndexOf('/') + 1)}” to the Trash`);
    } catch (error) {
      actions.status(`Couldn’t move it to the Trash: ${cleanFsError(error)}`);
    }
  };

  const rows = () => [...(containerRef.current?.querySelectorAll<HTMLElement>('[data-path]') ?? [])];

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (editing || e.ctrlKey || e.altKey || e.metaKey) return;
    const all = rows();
    const index = all.findIndex((r) => r.dataset.path === selected);
    const row = all[index];
    const isDir = row?.dataset.kind === 'directory';
    const move = (i: number) => {
      const next = all[Math.max(0, Math.min(all.length - 1, i))];
      if (next) setSelected(next.dataset.path!);
    };
    if (e.key === 'ArrowDown') move(index + 1);
    else if (e.key === 'ArrowUp') move(index === -1 ? 0 : index - 1);
    else if (e.key === 'Home') move(0);
    else if (e.key === 'End') move(all.length - 1);
    else if (e.key === 'ArrowRight' && selected && isDir) {
      if (!expanded.has(selected)) onToggle(selected, true);
      else move(index + 1);
    } else if (e.key === 'ArrowLeft' && selected) {
      if (isDir && expanded.has(selected)) onToggle(selected, false);
      else if (parentPath(selected).length > root.length) setSelected(parentPath(selected));
    } else if ((e.key === 'Enter' || e.key === ' ') && selected) {
      if (isDir) onToggle(selected);
      else actions.open(selected);
    } else if (e.key === 'F2' && selected) setEditing({ kind: 'rename', path: selected });
    else if (e.key === 'Delete' && selected) void trash(selected);
    else return;
    e.preventDefault();
    e.stopPropagation();
  };

  const menuFor = (path: string, kind: 'directory' | 'file' | 'root') => {
    const dir = kind === 'file' ? parentPath(path) : path;
    return (
      <ContextMenuContent className="w-56">
        {kind === 'file' && <ContextMenuItem onSelect={() => actions.open(path)}>Open</ContextMenuItem>}
        {kind === 'file' && <ContextMenuSeparator />}
        <ContextMenuItem onSelect={() => startNew('file', dir)}>New File…</ContextMenuItem>
        <ContextMenuItem onSelect={() => startNew('folder', dir)}>New Folder…</ContextMenuItem>
        <ContextMenuSeparator />
        <ContextMenuItem onSelect={() => actions.revealInFiles(path)}>Reveal in Files</ContextMenuItem>
        <ContextMenuItem onSelect={() => actions.openTerminal(dir)}>Open in Terminal</ContextMenuItem>
        <ContextMenuSeparator />
        <ContextMenuItem onSelect={() => actions.copyText(path)}>Copy Path</ContextMenuItem>
        {kind !== 'root' && (
          <ContextMenuItem onSelect={() => actions.copyText(path.slice(root.length + 1))}>Copy Relative Path</ContextMenuItem>
        )}
        {kind !== 'root' && (
          <>
            <ContextMenuSeparator />
            <ContextMenuItem onSelect={() => setEditing({ kind: 'rename', path })}>
              Rename… <ContextMenuShortcut>F2</ContextMenuShortcut>
            </ContextMenuItem>
            <ContextMenuItem variant="destructive" onSelect={() => void trash(path)}>
              Move to Trash <ContextMenuShortcut>Delete</ContextMenuShortcut>
            </ContextMenuItem>
          </>
        )}
      </ContextMenuContent>
    );
  };

  const ctx: TreeContext = {
    root,
    expanded,
    selected,
    activePath,
    editing,
    select: setSelected,
    toggle: onToggle,
    open: actions.open,
    finishEdit: (name) => void finishEdit(name),
    cancelEdit: () => {
      setEditing(null);
      containerRef.current?.focus();
    },
    menuFor,
  };

  return (
    <ContextMenu>
      <ContextMenuTrigger asChild>
        <div
          ref={containerRef}
          role="tree"
          aria-label="Files"
          tabIndex={0}
          onKeyDown={onKeyDown}
          onFocus={(e) => {
            if (e.target === e.currentTarget && !selected) setSelected(rows()[0]?.dataset.path ?? null);
          }}
          className="min-h-0 flex-1 overflow-auto pb-4 text-sm outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
        >
          <Children dir={root} depth={0} ctx={ctx} />
        </div>
      </ContextMenuTrigger>
      {menuFor(root, 'root')}
    </ContextMenu>
  );
}

interface TreeContext {
  root: string;
  expanded: ReadonlySet<string>;
  selected: string | null;
  activePath: string | null;
  editing: Editing | null;
  select(path: string): void;
  toggle(dir: string, open?: boolean): void;
  open(path: string): void;
  finishEdit(name: string): void;
  cancelEdit(): void;
  menuFor(path: string, kind: 'directory' | 'file' | 'root'): React.ReactNode;
}

function Children({ dir, depth, ctx }: { dir: string; depth: number; ctx: TreeContext }) {
  const listing = useDirectory(dir);
  useWatchDirectory(dir);
  const creating = ctx.editing && ctx.editing.kind !== 'rename' && ctx.editing.dir === dir ? ctx.editing : null;

  if (listing.isPending) {
    return (
      <div className="space-y-1.5 py-1" style={{ paddingLeft: 16 + depth * INDENT }} aria-hidden>
        <Skeleton className="h-3.5 w-28 bg-foreground/10" />
        <Skeleton className="h-3.5 w-20 bg-foreground/10" />
      </div>
    );
  }
  if (listing.isError) {
    return (
      <p className="py-1 pr-2 text-xs text-muted-foreground" style={{ paddingLeft: 16 + depth * INDENT }}>
        {cleanFsError(listing.error)}
      </p>
    );
  }
  const entries = sortEntries(listing.data.entries.filter((e) => !HIDDEN.has(e.name)));
  return (
    <div role="group">
      {creating && (
        <NameInput
          depth={depth}
          kind={creating.kind === 'folder' ? 'directory' : 'file'}
          initial=""
          onDone={ctx.finishEdit}
          onCancel={ctx.cancelEdit}
        />
      )}
      {entries.map((entry) => (
        <Node key={entry.name} entry={entry} path={joinPath(dir, entry.name)} depth={depth} ctx={ctx} />
      ))}
      {entries.length === 0 && !creating && depth === 0 && (
        <p className="px-4 py-2 text-xs text-muted-foreground">This folder is empty.</p>
      )}
    </div>
  );
}

function Node({ entry, path, depth, ctx }: { entry: FsEntry; path: string; depth: number; ctx: TreeContext }) {
  const isDir = entry.kind === 'directory';
  const open = isDir && ctx.expanded.has(path);
  if (ctx.editing?.kind === 'rename' && ctx.editing.path === path) {
    return <NameInput depth={depth} kind={entry.kind} initial={entry.name} onDone={ctx.finishEdit} onCancel={ctx.cancelEdit} />;
  }
  return (
    <>
      <ContextMenu>
        <ContextMenuTrigger asChild>
          <div
            role="treeitem"
            aria-expanded={isDir ? open : undefined}
            aria-selected={ctx.selected === path}
            data-path={path}
            data-kind={entry.kind}
            title={path.slice(ctx.root.length + 1)}
            onClick={() => {
              ctx.select(path);
              if (isDir) ctx.toggle(path);
              else ctx.open(path);
            }}
            onContextMenu={() => ctx.select(path)}
            className={cn(
              'flex cursor-default select-none items-center gap-1.5 pr-2 text-foreground/85 hover:bg-foreground/[0.06]',
              ctx.selected === path && 'bg-foreground/10 text-foreground',
              ctx.activePath === path && 'font-medium text-foreground',
              entry.name.startsWith('.') && 'text-foreground/60',
            )}
            style={{ height: ROW_HEIGHT, paddingLeft: 4 + depth * INDENT }}
          >
            <ChevronRight
              className={cn(
                'size-3.5 shrink-0 text-muted-foreground transition-transform motion-reduce:transition-none',
                !isDir && 'invisible',
                open && 'rotate-90',
              )}
              aria-hidden
            />
            <FileIcon
              path={path}
              name={entry.name}
              kind={entry.kind}
              size={entry.size}
              mtimeMs={entry.mtimeMs}
              symlink={entry.symlink}
              px={16}
              thumbnail={false}
            />
            <span className="min-w-0 truncate">{entry.name}</span>
          </div>
        </ContextMenuTrigger>
        {ctx.menuFor(path, isDir ? 'directory' : 'file')}
      </ContextMenu>
      {open && <Children dir={path} depth={depth + 1} ctx={ctx} />}
    </>
  );
}

function NameInput({
  depth,
  kind,
  initial,
  onDone,
  onCancel,
}: {
  depth: number;
  kind: FsEntry['kind'];
  initial: string;
  onDone: (name: string) => void;
  onCancel: () => void;
}) {
  const ref = useRef<HTMLInputElement>(null);
  const done = useRef(false);
  useEffect(() => {
    const input = ref.current;
    if (!input) return;
    input.focus();
    // Select the name without its extension, like Files does.
    const dot = kind === 'file' ? initial.lastIndexOf('.') : -1;
    input.setSelectionRange(0, dot > 0 ? dot : initial.length);
  }, [initial, kind]);
  const finish = (name: string | null) => {
    if (done.current) return;
    done.current = true;
    if (name === null) onCancel();
    else onDone(name);
  };
  return (
    <div className="flex items-center gap-1.5 pr-2" style={{ height: ROW_HEIGHT, paddingLeft: 4 + depth * INDENT + 14 + 6 }}>
      <FileIcon path="" name={initial || (kind === 'directory' ? 'folder' : 'file')} kind={kind} size={null} mtimeMs={null} px={16} thumbnail={false} />
      <input
        ref={ref}
        defaultValue={initial}
        aria-label={initial ? `Rename ${initial}` : kind === 'directory' ? 'New folder name' : 'New file name'}
        spellCheck={false}
        onKeyDown={(e) => {
          e.stopPropagation();
          if (e.key === 'Enter') finish(e.currentTarget.value);
          else if (e.key === 'Escape') finish(null);
        }}
        onBlur={(e) => finish(e.currentTarget.value)}
        className="h-5 min-w-0 flex-1 rounded-sm border border-sidebar-ring bg-background px-1 text-sm outline-none"
      />
    </div>
  );
}
