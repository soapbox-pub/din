import { useDeferredValue, useEffect, useMemo, useRef, useState } from 'react';
import { ChevronRight, FileText, Hash, Loader2 } from 'lucide-react';
import { cn } from '@/lib/utils';
import { fuzzyMatch } from './fuzzy';

/** Results drawn at once; typing narrows the rest. */
const MAX_SHOWN = 200;

export interface PaletteCommand {
  id: string;
  title: string;
  /** e.g. "Ctrl+Shift+F". */
  shortcut?: string;
  run: () => void;
}

export interface PaletteFile {
  /** Absolute path. */
  path: string;
  /** What's shown and matched: the path relative to the folder. */
  label: string;
}

export interface PaletteItem {
  id: string;
  label: string;
  detail?: string;
}

/**
 * What the palette is doing. `quick` is VS Code's one box for everything:
 * plain text finds files, `>` commands, `:` a line. `pick` chooses from a
 * list (a language, say).
 */
export type PaletteMode =
  | { kind: 'quick'; initial: string }
  | { kind: 'pick'; placeholder: string; items: PaletteItem[]; currentId?: string; onPick: (id: string) => void };

interface Row {
  key: string;
  label: string;
  positions: number[];
  /** Muted text on the right (a shortcut, a folder). */
  detail?: string;
  /** Show the label as a path: the name first, its folder after. */
  path?: boolean;
  current?: boolean;
  run: () => void;
}

export function Palette({
  mode,
  files,
  filesLoading,
  hasFolder,
  commands,
  lineCount,
  onOpenFile,
  onGotoLine,
  onClose,
}: {
  mode: PaletteMode;
  /** Files to choose from: the folder's, or with no folder, the open ones. */
  files: PaletteFile[];
  filesLoading: boolean;
  hasFolder: boolean;
  commands: PaletteCommand[];
  /** Lines in the current file, or null with none open. */
  lineCount: number | null;
  onOpenFile: (path: string) => void;
  onGotoLine: (line: number, column: number) => void;
  onClose: () => void;
}) {
  const [value, setValue] = useState(mode.kind === 'quick' ? mode.initial : '');
  const [selected, setSelected] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const query = useDeferredValue(value);

  useEffect(() => {
    const input = inputRef.current;
    if (!input) return;
    input.focus();
    // Past the prefix, so typing goes after the ">".
    input.setSelectionRange(input.value.length, input.value.length);
  }, []);

  const kind = mode.kind === 'pick' ? 'pick' : value.startsWith('>') ? 'commands' : value.startsWith(':') ? 'line' : 'files';

  const rows = useMemo((): Row[] => {
    const rank = <T,>(items: T[], text: (item: T) => string, q: string, make: (item: T, positions: number[]) => Row) => {
      if (!q.trim()) return items.slice(0, MAX_SHOWN).map((item) => make(item, []));
      const scored: { item: T; score: number; positions: number[] }[] = [];
      for (const item of items) {
        const match = fuzzyMatch(q, text(item));
        if (match) scored.push({ item, score: match.score, positions: match.positions });
      }
      scored.sort((a, b) => b.score - a.score);
      return scored.slice(0, MAX_SHOWN).map((s) => make(s.item, s.positions));
    };

    if (mode.kind === 'pick') {
      return rank(mode.items, (i) => i.label, query, (item, positions) => ({
        key: item.id,
        label: item.label,
        positions,
        detail: item.detail,
        current: item.id === mode.currentId,
        run: () => mode.onPick(item.id),
      }));
    }
    if (query.startsWith('>')) {
      return rank(commands, (c) => c.title, query.slice(1), (c, positions) => ({
        key: c.id,
        label: c.title,
        positions,
        detail: c.shortcut,
        run: c.run,
      }));
    }
    if (query.startsWith(':')) return [];
    return rank(files, (f) => f.label, query, (f, positions) => ({
      key: f.path,
      label: f.label,
      positions,
      path: true,
      run: () => onOpenFile(f.path),
    }));
  }, [mode, query, commands, files, onOpenFile]);

  const [prevRows, setPrevRows] = useState(rows);
  if (rows !== prevRows) {
    setPrevRows(rows);
    setSelected(0);
  }

  useEffect(() => {
    listRef.current?.querySelector('[aria-selected="true"]')?.scrollIntoView({ block: 'nearest' });
  }, [selected, rows]);

  const target = (() => {
    const match = /^:\s*(\d+)?(?:[:,]\s*(\d+))?\s*$/.exec(value);
    if (!match || lineCount === null) return null;
    const line = match[1] ? Math.min(Math.max(1, Number(match[1])), lineCount) : null;
    return line === null ? null : { line, column: match[2] ? Math.max(1, Number(match[2])) : 1 };
  })();

  const accept = (index: number) => {
    if (kind === 'line') {
      if (target) {
        onClose();
        onGotoLine(target.line, target.column);
      }
      return;
    }
    const row = rows[index];
    if (!row) return;
    onClose();
    row.run();
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    const count = rows.length;
    if (e.key === 'Escape') onClose();
    else if (e.key === 'Enter') accept(selected);
    else if (e.key === 'ArrowDown' || (e.ctrlKey && e.key.toLowerCase() === 'n')) setSelected((s) => (count ? (s + 1) % count : 0));
    else if (e.key === 'ArrowUp' || (e.ctrlKey && e.key.toLowerCase() === 'p' && !e.shiftKey)) setSelected((s) => (count ? (s - 1 + count) % count : 0));
    else if (e.key === 'PageDown') setSelected((s) => Math.min(count - 1, s + 10));
    else if (e.key === 'PageUp') setSelected((s) => Math.max(0, s - 10));
    else return;
    e.preventDefault();
    e.stopPropagation();
  };

  const placeholder =
    mode.kind === 'pick'
      ? mode.placeholder
      : hasFolder
        ? 'Search files by name (type > for commands, : for a line)'
        : 'Search open files (type > for commands, : for a line)';

  let hint: string | null = null;
  if (kind === 'line') {
    hint = lineCount === null
      ? 'Open a file to go to a line.'
      : target
        ? `Go to line ${target.line}${target.column > 1 ? `, column ${target.column}` : ''}.`
        : `Type a line number between 1 and ${lineCount.toLocaleString()}.`;
  } else if (rows.length === 0) {
    hint = kind === 'files' && filesLoading
      ? 'Listing files…'
      : kind === 'files' && files.length === 0
        ? hasFolder ? 'This folder has no files.' : 'Open a folder to find files in it.'
        : kind === 'commands' ? 'No matching commands.' : 'No matches.';
  }

  return (
    <div
      className="absolute inset-0 z-30 flex justify-center bg-black/10 px-4 pt-12"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        role="dialog"
        aria-label={mode.kind === 'pick' ? mode.placeholder : 'Command palette'}
        className="flex h-fit max-h-[70%] w-full max-w-xl flex-col overflow-hidden rounded-xl border border-border bg-popover text-popover-foreground shadow-2xl"
        onKeyDown={onKeyDown}
      >
        <div className="flex items-center gap-2 border-b border-border px-3">
          {kind === 'commands' ? (
            <ChevronRight className="size-4 shrink-0 text-muted-foreground" aria-hidden />
          ) : kind === 'line' ? (
            <Hash className="size-4 shrink-0 text-muted-foreground" aria-hidden />
          ) : filesLoading && kind === 'files' ? (
            <Loader2 className="size-4 shrink-0 animate-spin text-muted-foreground motion-reduce:animate-none" aria-hidden />
          ) : (
            <FileText className="size-4 shrink-0 text-muted-foreground" aria-hidden />
          )}
          <input
            ref={inputRef}
            value={value}
            onChange={(e) => setValue(e.target.value)}
            placeholder={placeholder}
            aria-label={placeholder}
            aria-controls="palette-results"
            aria-activedescendant={rows[selected] ? `palette-${selected}` : undefined}
            spellCheck={false}
            autoComplete="off"
            className="h-11 min-w-0 flex-1 bg-transparent text-sm outline-none placeholder:text-muted-foreground"
          />
        </div>
        {kind !== 'line' && rows.length > 0 && (
          <div ref={listRef} id="palette-results" role="listbox" className="min-h-0 overflow-y-auto p-1">
            {rows.map((row, i) => (
              <div
                key={row.key}
                id={`palette-${i}`}
                role="option"
                aria-selected={i === selected}
                onMouseMove={() => i !== selected && setSelected(i)}
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => accept(i)}
                className={cn(
                  'flex cursor-default items-center gap-3 rounded-md px-3 py-1.5 text-sm',
                  i === selected && 'bg-sidebar-ring/20',
                )}
              >
                {row.path ? <PathLabel label={row.label} positions={row.positions} /> : <Highlighted text={row.label} positions={row.positions} offset={0} className="min-w-0 flex-1 truncate" />}
                {row.current && <span className="shrink-0 text-xs text-muted-foreground">Current</span>}
                {row.detail && <kbd className="shrink-0 font-sans text-xs text-muted-foreground">{row.detail}</kbd>}
              </div>
            ))}
          </div>
        )}
        {hint && <p className="px-4 py-3 text-sm text-muted-foreground">{hint}</p>}
      </div>
    </div>
  );
}

function PathLabel({ label, positions }: { label: string; positions: number[] }) {
  const slash = label.lastIndexOf('/');
  const name = label.slice(slash + 1);
  const dir = slash === -1 ? '' : label.slice(0, slash);
  return (
    <span className="flex min-w-0 flex-1 items-baseline gap-2">
      <Highlighted text={name} positions={positions} offset={slash + 1} className="shrink-0 truncate" />
      {dir && <Highlighted text={dir} positions={positions} offset={0} className="min-w-0 truncate text-xs text-muted-foreground" />}
    </span>
  );
}

/** `text` with the characters at `positions` (minus `offset`) in bold. */
function Highlighted({ text, positions, offset, className }: { text: string; positions: number[]; offset: number; className?: string }) {
  const marks = new Set(positions.map((p) => p - offset).filter((p) => p >= 0 && p < text.length));
  if (marks.size === 0) return <span className={className}>{text}</span>;
  const parts: React.ReactNode[] = [];
  let run = '';
  let bold = false;
  for (let i = 0; i <= text.length; i++) {
    const mark = marks.has(i);
    if (i === text.length || mark !== bold) {
      if (run) parts.push(bold ? <b key={i} className="font-semibold text-sidebar-ring">{run}</b> : run);
      run = '';
      bold = mark;
    }
    if (i < text.length) run += text[i];
  }
  return <span className={className}>{parts}</span>;
}
