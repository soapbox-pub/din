import { useEffect, useImperativeHandle, useRef, useState, type Ref, type RefObject } from 'react';
import { ArrowDown, ArrowUp, X } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { cn } from '@/lib/utils';

const MATCHES = 'assistant-find';
const CURRENT = 'assistant-find-current';

/** The elements a match can't run across, so one can't join two paragraphs. */
const BLOCKS = 'p, li, pre, td, th, h1, h2, h3, h4, h5, h6, blockquote, div';

export interface FindBarHandle {
  /** Put focus in the field, its text selected. */
  focus(): void;
}

/**
 * Where `needle` occurs in the text under `root`, case-insensitively, as
 * ranges. A match can cross inline elements (`foo **bar**`) but not blocks.
 */
function findRanges(root: HTMLElement, needle: string): Range[] {
  const ranges: Range[] = [];
  const query = needle.toLowerCase();
  let nodes: Text[] = [];
  let text = '';
  let block: Element | null = null;
  const flush = () => {
    const haystack = text.toLowerCase();
    let node = 0;
    let offset = 0; // Where nodes[node] starts in text.
    const locate = (at: number, end: boolean): [Text, number] => {
      while (node < nodes.length - 1 && at - offset > nodes[node].length - (end ? 0 : 1)) {
        offset += nodes[node].length;
        node++;
      }
      return [nodes[node], at - offset];
    };
    for (let at = haystack.indexOf(query); at !== -1; at = haystack.indexOf(query, at + query.length)) {
      const range = new Range();
      range.setStart(...locate(at, false));
      range.setEnd(...locate(at + query.length, true));
      ranges.push(range);
    }
    nodes = [];
    text = '';
  };
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  for (let next = walker.nextNode(); next; next = walker.nextNode()) {
    const node = next as Text;
    const parent = node.parentElement;
    if (!node.length || !parent || parent.closest('style, script, [aria-hidden="true"]')) continue;
    const own = parent.closest(BLOCKS);
    if (own !== block) {
      flush();
      block = own;
    }
    nodes.push(node);
    text += node.data;
  }
  flush();
  return ranges;
}

/** Scroll a match into view in `pane`, if it isn't. */
function reveal(pane: HTMLElement, range: Range | undefined) {
  if (!range) return;
  const rect = range.getBoundingClientRect();
  const box = pane.getBoundingClientRect();
  if (rect.top >= box.top + 48 && rect.bottom <= box.bottom - 16) return;
  pane.scrollTop += rect.top - box.top - pane.clientHeight / 3;
}

/** The current match, drawn over the others. */
function currentHighlight(range: Range | undefined): Highlight {
  const highlight = new Highlight(...(range ? [range] : []));
  highlight.priority = 1;
  return highlight;
}

/**
 * Find in a conversation (Ctrl+F): highlights where the text occurs in the
 * transcript under `scrollRef`, with the CSS Custom Highlight API so its DOM
 * stays React's, and steps through the matches. It keeps up as the
 * conversation grows (opening it loads the earlier messages, so it covers all
 * of it). Like a browser's find, it searches what is shown, so collapsed tool
 * output is left out.
 */
export function FindBar({
  scrollRef,
  onClose,
  ref,
}: {
  scrollRef: RefObject<HTMLElement | null>;
  onClose: () => void;
  ref?: Ref<FindBarHandle>;
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [query, setQuery] = useState('');
  const [count, setCount] = useState(0);
  const [current, setCurrent] = useState(0);
  const ranges = useRef<Range[]>([]);
  const currentRef = useRef(0);

  useImperativeHandle(ref, () => ({
    focus: () => {
      inputRef.current?.focus();
      inputRef.current?.select();
    },
  }));

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  // Find again as the query changes and as the transcript does.
  useEffect(() => {
    const pane = scrollRef.current;
    if (!pane || typeof Highlight === 'undefined' || !CSS.highlights) return;
    const needle = query.trim() ? query : '';
    let first = true;
    let frame = 0;
    const paint = () => {
      frame = 0;
      const found = needle ? findRanges(pane, needle) : [];
      ranges.current = found;
      setCount(found.length);
      let at = Math.min(currentRef.current, Math.max(0, found.length - 1));
      if (first) {
        // A new query starts at the first match from where the reader is.
        first = false;
        const top = pane.getBoundingClientRect().top;
        const index = found.findIndex((r) => r.getBoundingClientRect().bottom >= top);
        at = index === -1 ? Math.max(0, found.length - 1) : index;
        reveal(pane, found[at]);
      }
      setCurrent(at);
      currentRef.current = at;
      CSS.highlights.set(MATCHES, new Highlight(...found));
      CSS.highlights.set(CURRENT, currentHighlight(found[at]));
    };
    const schedule = () => {
      if (!frame) frame = requestAnimationFrame(paint);
    };
    schedule();
    const observer = new MutationObserver(schedule);
    observer.observe(pane, { childList: true, subtree: true, characterData: true });
    return () => {
      cancelAnimationFrame(frame);
      observer.disconnect();
      CSS.highlights.delete(MATCHES);
      CSS.highlights.delete(CURRENT);
    };
  }, [query, scrollRef]);

  const step = (delta: number) => {
    const found = ranges.current;
    if (found.length === 0) return;
    const at = (currentRef.current + delta + found.length) % found.length;
    setCurrent(at);
    currentRef.current = at;
    CSS.highlights?.set(CURRENT, currentHighlight(found[at]));
    if (scrollRef.current) reveal(scrollRef.current, found[at]);
  };

  const status = !query.trim() ? '' : count === 0 ? 'No results' : `${current + 1} of ${count}`;

  return (
    <div
      role="search"
      className="absolute right-3 top-2 z-10 flex items-center gap-1 rounded-lg border bg-background p-1 shadow-md motion-safe:animate-in motion-safe:fade-in motion-safe:slide-in-from-top-1"
    >
      <Input
        ref={inputRef}
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') step(e.shiftKey ? -1 : 1);
          else if (e.key === 'Escape') onClose();
          else return;
          e.preventDefault();
          e.stopPropagation();
        }}
        placeholder="Find in conversation"
        aria-label="Find in conversation"
        spellCheck={false}
        className="h-7 w-48 border-0 bg-transparent px-2 text-sm shadow-none focus-visible:ring-0 md:text-sm"
      />
      <span
        className={cn('w-20 shrink-0 text-center text-xs tabular-nums text-muted-foreground', status === 'No results' && 'text-destructive')}
        aria-live="polite"
      >
        {status}
      </span>
      <Button
        variant="ghost"
        size="icon"
        className="size-7"
        aria-label="Previous match"
        title="Previous match (Shift+Enter)"
        disabled={count === 0}
        onClick={() => step(-1)}
      >
        <ArrowUp className="size-4" aria-hidden />
      </Button>
      <Button
        variant="ghost"
        size="icon"
        className="size-7"
        aria-label="Next match"
        title="Next match (Enter)"
        disabled={count === 0}
        onClick={() => step(1)}
      >
        <ArrowDown className="size-4" aria-hidden />
      </Button>
      <Button variant="ghost" size="icon" className="size-7" aria-label="Close" title="Close (Escape)" onClick={onClose}>
        <X className="size-4" aria-hidden />
      </Button>
    </div>
  );
}
