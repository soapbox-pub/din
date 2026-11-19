import { useMemo, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { Check, ChevronRight, FileIcon, Folder, FolderSearch, Minus } from 'lucide-react';
import { Checkbox as CheckboxPrimitive } from 'radix-ui';
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuRadioGroup,
  ContextMenuRadioItem,
  ContextMenuSeparator,
  ContextMenuSub,
  ContextMenuSubContent,
  ContextMenuSubTrigger,
  ContextMenuTrigger,
} from '@/components/ui/context-menu';
import { cn } from '@/lib/utils';
import { cleanTorrentsError, type TorrentDetail, type TorrentPriority } from '@/lib/torrents';
import { focusRing } from '@/shared/appChromeStyles';
import { toast } from '@/shared/toast';
import { KEY, useBridge } from './bridge';
import { formatBytes, formatPercent } from '@/shared/torrentFormat';

/** A file of the tree: its index in the torrent, and what's known of it. */
export interface TreeFile {
  index: number;
  path: string;
  bytes: number;
  doneBytes?: number;
  wanted: boolean;
  priority?: TorrentPriority;
}

interface Node {
  name: string;
  /** Its path from the tree's top, for keeping it open. */
  key: string;
  children: Node[];
  file: TreeFile | null;
  /** The files in it, by index. */
  indexes: number[];
  bytes: number;
  doneBytes: number;
  wanted: number;
}

function buildTree(files: TreeFile[]): Node {
  const root: Node = { name: '', key: '', children: [], file: null, indexes: [], bytes: 0, doneBytes: 0, wanted: 0 };
  // A torrent of several files keeps them in a folder named for it: the tree starts inside it.
  const parts = files.map((f) => f.path.split('/'));
  const strip = files.length > 1 && parts.every((p) => p.length > 1 && p[0] === parts[0][0]) ? 1 : 0;
  files.forEach((f, i) => {
    const segments = parts[i].slice(strip);
    let node = root;
    segments.forEach((name, depth) => {
      node.indexes.push(f.index);
      node.bytes += f.bytes;
      node.doneBytes += f.doneBytes ?? 0;
      if (f.wanted) node.wanted++;
      const last = depth === segments.length - 1;
      let child = last ? undefined : node.children.find((c) => c.name === name && !c.file);
      if (!child) {
        child = { name, key: `${node.key}/${name}`, children: [], file: last ? f : null, indexes: [], bytes: 0, doneBytes: 0, wanted: 0 };
        node.children.push(child);
      }
      node = child;
    });
    node.indexes.push(f.index);
    node.bytes += f.bytes;
    node.doneBytes += f.doneBytes ?? 0;
    if (f.wanted) node.wanted++;
  });
  const sort = (n: Node) => {
    n.children.sort((a, b) => (a.file ? 1 : 0) - (b.file ? 1 : 0) || a.name.localeCompare(b.name, undefined, { numeric: true }));
    n.children.forEach(sort);
  };
  sort(root);
  return root;
}

function TriCheckbox({ state, onChange, label }: { state: boolean | 'indeterminate'; onChange: (wanted: boolean) => void; label: string }) {
  return (
    <CheckboxPrimitive.Root
      checked={state}
      onCheckedChange={() => onChange(state !== true)}
      aria-label={label}
      onClick={(e) => e.stopPropagation()}
      className={cn(
        'grid size-4 shrink-0 place-items-center rounded-[5px] border border-foreground/25 bg-background',
        'data-[state=checked]:border-transparent data-[state=checked]:bg-pigment data-[state=checked]:text-primary-foreground',
        'data-[state=indeterminate]:border-transparent data-[state=indeterminate]:bg-pigment data-[state=indeterminate]:text-primary-foreground',
        focusRing,
      )}
    >
      <CheckboxPrimitive.Indicator>{state === 'indeterminate' ? <Minus className="size-3" strokeWidth={3} /> : <Check className="size-3" strokeWidth={3} />}</CheckboxPrimitive.Indicator>
    </CheckboxPrimitive.Root>
  );
}

const PRIORITY_LABELS: Record<TorrentPriority, string> = { high: 'High', normal: 'Normal', low: 'Low' };

function TreeRows({
  node,
  depth,
  open,
  onToggleOpen,
  onWanted,
  onPriority,
  onReveal,
  showProgress,
}: {
  node: Node;
  depth: number;
  open: Set<string>;
  onToggleOpen: (key: string) => void;
  onWanted: (indexes: number[], wanted: boolean) => void;
  onPriority?: (indexes: number[], priority: TorrentPriority) => void;
  onReveal?: (index: number) => void;
  showProgress: boolean;
}) {
  return (
    <>
      {node.children.map((child) => {
        const isOpen = open.has(child.key);
        const state: boolean | 'indeterminate' = child.wanted === 0 ? false : child.wanted === child.indexes.length ? true : 'indeterminate';
        const priorities = new Set(child.file ? [child.file.priority ?? 'normal'] : []);
        const row = (
          <div
            role="treeitem"
            aria-selected={false}
            aria-expanded={child.file ? undefined : isOpen}
            aria-level={depth + 1}
            className={cn('flex h-8 items-center gap-1.5 rounded-lg pr-2 text-sm hover:bg-foreground/5', !state && 'text-muted-foreground')}
            style={{ paddingLeft: `${depth * 16 + 4}px` }}
            onClick={() => !child.file && onToggleOpen(child.key)}
          >
            {child.file ? (
              <span className="size-4 shrink-0" />
            ) : (
              <ChevronRight className={cn('size-4 shrink-0 text-muted-foreground transition-transform motion-reduce:transition-none', isOpen && 'rotate-90')} aria-hidden />
            )}
            <TriCheckbox state={state} label={`Download ${child.name}`} onChange={(wanted) => onWanted(child.indexes, wanted)} />
            {child.file ? <FileIcon className="size-4 shrink-0 text-muted-foreground" aria-hidden /> : <Folder className="size-4 shrink-0 text-ink-accent" aria-hidden />}
            <span className="min-w-0 flex-1 truncate" title={child.name}>
              {child.name}
            </span>
            {child.file?.priority && child.file.priority !== 'normal' && (
              <span className="shrink-0 text-[11px] text-muted-foreground">{child.file.priority === 'high' ? 'High' : 'Low'}</span>
            )}
            <span className="shrink-0 text-xs text-muted-foreground tabular-nums">
              {showProgress && child.bytes > 0 && child.doneBytes < child.bytes && state ? `${formatPercent(child.doneBytes / child.bytes)} of ` : ''}
              {formatBytes(child.bytes)}
            </span>
          </div>
        );
        return (
          <div key={child.key} role="none">
            {onPriority ? (
              <ContextMenu>
                <ContextMenuTrigger asChild>{row}</ContextMenuTrigger>
                <ContextMenuContent className="w-56">
                  <ContextMenuItem disabled={state === true} onSelect={() => onWanted(child.indexes, true)}>
                    Download
                  </ContextMenuItem>
                  <ContextMenuItem disabled={state === false} onSelect={() => onWanted(child.indexes, false)}>
                    Don’t Download
                  </ContextMenuItem>
                  <ContextMenuSub>
                    <ContextMenuSubTrigger>Priority</ContextMenuSubTrigger>
                    <ContextMenuSubContent className="w-40">
                      <ContextMenuRadioGroup value={priorities.size === 1 ? [...priorities][0] : ''} onValueChange={(v) => onPriority(child.indexes, v as TorrentPriority)}>
                        {(['high', 'normal', 'low'] as const).map((p) => (
                          <ContextMenuRadioItem key={p} value={p}>
                            {PRIORITY_LABELS[p]}
                          </ContextMenuRadioItem>
                        ))}
                      </ContextMenuRadioGroup>
                    </ContextMenuSubContent>
                  </ContextMenuSub>
                  {onReveal && child.file && (
                    <>
                      <ContextMenuSeparator />
                      <ContextMenuItem disabled={!child.doneBytes} onSelect={() => onReveal(child.file!.index)}>
                        <FolderSearch className="size-4.5" aria-hidden />
                        Show in Files
                      </ContextMenuItem>
                    </>
                  )}
                </ContextMenuContent>
              </ContextMenu>
            ) : (
              row
            )}
            {!child.file && isOpen && (
              <TreeRows
                node={child}
                depth={depth + 1}
                open={open}
                onToggleOpen={onToggleOpen}
                onWanted={onWanted}
                onPriority={onPriority}
                onReveal={onReveal}
                showProgress={showProgress}
              />
            )}
          </div>
        );
      })}
    </>
  );
}

/**
 * A torrent's files as folders that open, each with a box for whether it's
 * downloaded; a folder's box covers what's in it. Right-click for priority.
 */
export function FileTreeView({
  files,
  onWanted,
  onPriority,
  onReveal,
  showProgress = false,
  className,
}: {
  files: TreeFile[];
  onWanted: (indexes: number[], wanted: boolean) => void;
  onPriority?: (indexes: number[], priority: TorrentPriority) => void;
  onReveal?: (index: number) => void;
  showProgress?: boolean;
  className?: string;
}) {
  const tree = useMemo(() => buildTree(files), [files]);
  // Folders start open while there are few of them.
  const [open, setOpen] = useState<Set<string>>(() => {
    const keys = new Set<string>();
    const walk = (n: Node, depth: number) => {
      for (const c of n.children) {
        if (!c.file && depth < 2) {
          keys.add(c.key);
          walk(c, depth + 1);
        }
      }
    };
    if (files.length <= 200) walk(tree, 0);
    return keys;
  });
  const toggle = (key: string) =>
    setOpen((o) => {
      const next = new Set(o);
      if (!next.delete(key)) next.add(key);
      return next;
    });
  return (
    <div role="tree" aria-label="Files" className={cn('select-none', className)}>
      <TreeRows node={tree} depth={0} open={open} onToggleOpen={toggle} onWanted={onWanted} onPriority={onPriority} onReveal={onReveal} showProgress={showProgress} />
    </div>
  );
}

/** The inspector's Files: the transfer's own, changed as they're ticked. */
export function FileTree({ detail, onReveal }: { detail: TorrentDetail; onReveal: (file: number) => void }) {
  const bridge = useBridge();
  const queryClient = useQueryClient();
  const id = detail.torrent.id;
  if (detail.torrent.metadataProgress !== null) {
    return <p className="px-1 py-6 text-center text-sm text-muted-foreground">Its files show once peers have said what’s in it.</p>;
  }
  const done = () => void queryClient.invalidateQueries({ queryKey: [...KEY, 'detail', id] });
  const fail = (err: unknown) => toast('Torrents couldn’t change that', { body: cleanTorrentsError(err), destructive: true });
  return (
    <FileTreeView
      files={detail.files}
      showProgress
      onWanted={(indexes, wanted) => void bridge?.setFiles(id, wanted ? { wanted: indexes } : { unwanted: indexes }).then(done, fail)}
      onPriority={(indexes, priority) => void bridge?.setFiles(id, { priority, files: indexes }).then(done, fail)}
      onReveal={onReveal}
    />
  );
}
