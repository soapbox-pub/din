import { useCallback, useEffect, useRef, useState } from 'react';
import { ChevronDown, ChevronLeft, ChevronRight, ChevronUp, Minus, Plus, Search, X } from 'lucide-react';
import { pdfjs, openPdf } from '@/shared/pdfjs';
import { EventBus, FindState, LinkTarget, PDFFindController, PDFLinkService, PDFViewer } from 'pdfjs-dist/web/pdf_viewer.mjs';
import 'pdfjs-dist/web/pdf_viewer.css';
import { cn } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Select, SelectContent, SelectItem, SelectSeparator, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Skeleton } from '@/components/ui/skeleton';

/** The zoom menu's sizes, after its fits. */
const ZOOMS = [0.5, 0.75, 1, 1.25, 1.5, 2, 3, 4];
const FITS: Record<string, string> = { auto: 'Automatic', 'page-fit': 'Fit Page', 'page-width': 'Fit Width' };

type Status =
  | { kind: 'loading' }
  | { kind: 'ready' }
  | { kind: 'password'; wrong: boolean; answer: (password: string) => void }
  | { kind: 'error'; message: string };

interface Find {
  query: string;
  current: number;
  total: number;
  notFound: boolean;
}

/**
 * A PDF: its pages one under the other, drawn as they scroll into view by
 * pdf.js's viewer, with text to select and copy, links that go where they
 * point, a page number to jump with, zoom (the menu, Ctrl+plus and minus,
 * Ctrl+scroll), and Find (Ctrl+F). A locked PDF asks for its password.
 */
export default function PdfView({ url }: { url: string }) {
  const containerRef = useRef<HTMLDivElement>(null);
  const viewerRef = useRef<HTMLDivElement>(null);
  const findInputRef = useRef<HTMLInputElement>(null);
  const parts = useRef<{ viewer: PDFViewer; eventBus: EventBus } | null>(null);

  const [status, setStatus] = useState<Status>({ kind: 'loading' });
  const [pages, setPages] = useState(0);
  const [page, setPage] = useState(1);
  const [pageInput, setPageInput] = useState('1');
  const [scale, setScale] = useState<{ value: number; preset: string | null }>({ value: 1, preset: 'auto' });
  const [find, setFind] = useState<Find | null>(null);

  useEffect(() => {
    const container = containerRef.current;
    const viewerEl = viewerRef.current;
    if (!container || !viewerEl) return;
    const eventBus = new EventBus();
    const linkService = new PDFLinkService({
      eventBus,
      externalLinkTarget: LinkTarget.BLANK,
      externalLinkRel: 'noopener noreferrer nofollow',
    });
    const findController = new PDFFindController({ eventBus, linkService });
    const viewer = new PDFViewer({
      container,
      viewer: viewerEl,
      eventBus,
      linkService,
      findController,
      // Form fields drawn as they're filled in, not editable: nothing here
      // could save what's typed into them.
      annotationMode: pdfjs.AnnotationMode.ENABLE,
    });
    linkService.setViewer(viewer);
    parts.current = { viewer, eventBus };

    eventBus.on('pagesinit', () => {
      setScaleValue(viewer, 'auto');
      setPages(viewer.pagesCount);
    });
    eventBus.on('pagechanging', ({ pageNumber }: { pageNumber: number }) => {
      setPage(pageNumber);
      setPageInput(String(pageNumber));
    });
    eventBus.on('scalechanging', ({ scale: value, presetValue }: { scale: number; presetValue?: string }) => {
      setScale({ value, preset: presetValue && presetValue in FITS ? presetValue : null });
    });
    const onFindState = ({ state, matchesCount }: { state: number; matchesCount: { current: number; total: number } }) => {
      setFind((f) => f && {
        ...f,
        current: matchesCount.current,
        total: matchesCount.total,
        notFound: state === FindState.NOT_FOUND,
      });
    };
    eventBus.on('updatefindcontrolstate', onFindState);
    eventBus.on('updatefindmatchescount', ({ matchesCount }: { matchesCount: { current: number; total: number } }) => {
      setFind((f) => f && { ...f, current: matchesCount.current, total: matchesCount.total });
    });

    let live = true;
    const task = openPdf(url);
    task.onPassword = (answer: (password: string) => void, reason: number) => {
      if (live) setStatus({ kind: 'password', wrong: reason === pdfjs.PasswordResponses.INCORRECT_PASSWORD, answer });
    };
    task.promise.then(
      (doc) => {
        if (!live) return;
        viewer.setDocument(doc);
        linkService.setDocument(doc, null);
        setStatus({ kind: 'ready' });
        // Keys scroll the pages when nothing else around has asked for them.
        const active = document.activeElement;
        if (!active || active === document.body || active.contains(container)) container.focus({ preventScroll: true });
      },
      (error: unknown) => {
        if (!live) return;
        setStatus({
          kind: 'error',
          message: error instanceof pdfjs.InvalidPDFException
            ? 'This PDF can’t be opened. It may be damaged, or not really a PDF.'
            : 'This PDF can’t be shown.',
        });
      },
    );
    return () => {
      live = false;
      parts.current = null;
      viewer.cleanup();
      void task.destroy();
    };
  }, [url]);

  // Ctrl+scroll zooms about the pointer, as in a browser.
  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    const onWheel = (e: WheelEvent) => {
      if (!e.ctrlKey || !parts.current) return;
      e.preventDefault();
      parts.current.viewer.updateScale({
        drawingDelay: 400,
        scaleFactor: Math.exp(-e.deltaY / (e.deltaMode === WheelEvent.DOM_DELTA_LINE ? 10 : 200)),
        origin: [e.clientX, e.clientY],
      });
    };
    container.addEventListener('wheel', onWheel, { passive: false });
    return () => container.removeEventListener('wheel', onWheel);
  }, []);

  const zoom = useCallback((how: 'in' | 'out' | string) => {
    const viewer = parts.current?.viewer;
    if (!viewer?.pdfDocument) return;
    if (how === 'in') viewer.increaseScale();
    else if (how === 'out') viewer.decreaseScale();
    else setScaleValue(viewer, how);
  }, []);

  const goTo = useCallback((n: number) => {
    const viewer = parts.current?.viewer;
    if (!viewer?.pdfDocument || !Number.isFinite(n)) return;
    setPageNumber(viewer, Math.min(viewer.pagesCount, Math.max(1, Math.round(n))));
  }, []);

  const search = useCallback((query: string, type: '' | 'again', previous = false) => {
    parts.current?.eventBus.dispatch('find', {
      source: null,
      type,
      query,
      caseSensitive: false,
      entireWord: false,
      highlightAll: true,
      findPrevious: previous,
      matchDiacritics: false,
    });
  }, []);

  const openFind = useCallback(() => {
    setFind((f) => f ?? { query: '', current: 0, total: 0, notFound: false });
    requestAnimationFrame(() => {
      findInputRef.current?.focus();
      findInputRef.current?.select();
    });
  }, []);

  const closeFind = useCallback(() => {
    setFind(null);
    parts.current?.eventBus.dispatch('findbarclose', { source: null });
    containerRef.current?.focus({ preventScroll: true });
  }, []);

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (status.kind !== 'ready' || e.altKey || e.metaKey) return;
    const key = e.key.toLowerCase();
    if (e.ctrlKey && key === 'f') {
      e.preventDefault();
      e.stopPropagation();
      openFind();
    } else if (e.ctrlKey && (key === '=' || key === '+')) {
      e.preventDefault();
      zoom('in');
    } else if (e.ctrlKey && (key === '-' || key === '_')) {
      e.preventDefault();
      zoom('out');
    } else if (e.ctrlKey && key === '0') {
      e.preventDefault();
      zoom('auto');
    } else if (e.key === 'Escape' && find) {
      e.preventDefault();
      e.stopPropagation();
      closeFind();
    }
  };

  const ready = status.kind === 'ready';
  const zoomValue = scale.preset ?? String(scale.value);
  const findLabel = !find?.query
    ? ''
    : find.total > 0
      ? `${find.current} of ${find.total}`
      : find.notFound
        ? 'Not found'
        : '';

  return (
    <div className="flex h-full flex-col" onKeyDown={onKeyDown}>
      <div className="flex h-11 shrink-0 items-center gap-1 border-b border-border/60 bg-background px-2 text-sm">
        <div className="flex items-center gap-1">
          <Button variant="ghost" size="icon-sm" disabled={!ready || page <= 1} onClick={() => goTo(page - 1)} aria-label="Previous page">
            <ChevronLeft />
          </Button>
          <form
            className="flex items-center gap-1.5"
            onSubmit={(e) => {
              e.preventDefault();
              goTo(Number(pageInput));
              setPageInput(String(parts.current?.viewer.currentPageNumber ?? page));
            }}
          >
            <Input
              value={pageInput}
              onChange={(e) => setPageInput(e.target.value.replace(/\D/g, ''))}
              onBlur={() => setPageInput(String(page))}
              onFocus={(e) => e.currentTarget.select()}
              disabled={!ready}
              inputMode="numeric"
              aria-label="Page number"
              className="h-8 w-12 px-1 text-center tabular-nums"
            />
            <span className="whitespace-nowrap text-muted-foreground tabular-nums">of {pages || '–'}</span>
          </form>
          <Button variant="ghost" size="icon-sm" disabled={!ready || page >= pages} onClick={() => goTo(page + 1)} aria-label="Next page">
            <ChevronRight />
          </Button>
        </div>
        <div className="flex-1" />
        <Button variant="ghost" size="icon-sm" disabled={!ready} onClick={() => zoom('out')} aria-label="Zoom out" title="Zoom out (Ctrl+−)">
          <Minus />
        </Button>
        <Select value={zoomValue} onValueChange={zoom} disabled={!ready}>
          <SelectTrigger size="sm" className="w-32" aria-label="Zoom">
            <SelectValue>{FITS[zoomValue] ?? `${Math.round(scale.value * 100)}%`}</SelectValue>
          </SelectTrigger>
          <SelectContent>
            {Object.entries(FITS).map(([value, label]) => (
              <SelectItem key={value} value={value}>{label}</SelectItem>
            ))}
            <SelectSeparator />
            {!scale.preset && !ZOOMS.includes(scale.value) && (
              <SelectItem value={String(scale.value)}>{Math.round(scale.value * 100)}%</SelectItem>
            )}
            {ZOOMS.map((z) => (
              <SelectItem key={z} value={String(z)}>{z * 100}%</SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Button variant="ghost" size="icon-sm" disabled={!ready} onClick={() => zoom('in')} aria-label="Zoom in" title="Zoom in (Ctrl+=)">
          <Plus />
        </Button>
        <Button
          variant="ghost"
          size="icon-sm"
          disabled={!ready}
          onClick={() => (find ? closeFind() : openFind())}
          aria-label="Find in document"
          aria-pressed={!!find}
          title="Find (Ctrl+F)"
          className={cn(find && 'bg-accent text-accent-foreground')}
        >
          <Search />
        </Button>
      </div>

      {find && (
        <div className="flex h-11 shrink-0 items-center gap-1 border-b border-border/60 bg-background px-2 text-sm">
          <Input
            ref={findInputRef}
            value={find.query}
            placeholder="Find in document"
            aria-label="Find in document"
            className="h-8 max-w-64 flex-1"
            onChange={(e) => {
              const query = e.target.value;
              setFind((f) => f && { ...f, query, current: 0, total: 0, notFound: false });
              search(query, '');
            }}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault();
                search(find.query, 'again', e.shiftKey);
              }
            }}
          />
          <span className="min-w-20 px-2 whitespace-nowrap text-muted-foreground tabular-nums" role="status">
            {findLabel}
          </span>
          <Button variant="ghost" size="icon-sm" disabled={!find.total} onClick={() => search(find.query, 'again', true)} aria-label="Previous match" title="Previous (Shift+Enter)">
            <ChevronUp />
          </Button>
          <Button variant="ghost" size="icon-sm" disabled={!find.total} onClick={() => search(find.query, 'again')} aria-label="Next match" title="Next (Enter)">
            <ChevronDown />
          </Button>
          <div className="flex-1" />
          <Button variant="ghost" size="icon-sm" onClick={closeFind} aria-label="Close Find" title="Close (Esc)">
            <X />
          </Button>
        </div>
      )}

      <div className="relative min-h-0 flex-1 bg-muted">
        {/* pdf.js's viewer needs its container absolutely positioned. It
            takes focus so the keys scroll it. */}
        <div
          ref={containerRef}
          // eslint-disable-next-line jsx-a11y-x/no-noninteractive-tabindex
          tabIndex={0}
          aria-label="Pages"
          className={cn('din-pdf absolute inset-0 overflow-auto outline-none', !ready && 'invisible')}
        >
          <div ref={viewerRef} className="pdfViewer" />
        </div>
        {status.kind === 'loading' && <PagesSkeleton />}
        {status.kind === 'error' && (
          <p className="absolute inset-0 grid place-items-center p-6 text-center text-sm text-muted-foreground">{status.message}</p>
        )}
        {status.kind === 'password' && (
          <PasswordForm
            wrong={status.wrong}
            onSubmit={(password) => {
              setStatus({ kind: 'loading' });
              status.answer(password);
            }}
          />
        )}
      </div>
    </div>
  );
}

// The viewer is told what to show by setting its properties.
function setScaleValue(viewer: PDFViewer, value: string) {
  viewer.currentScaleValue = value;
}
function setPageNumber(viewer: PDFViewer, n: number) {
  viewer.currentPageNumber = n;
}

function PasswordForm({ wrong, onSubmit }: { wrong: boolean; onSubmit: (password: string) => void }) {
  const [password, setPassword] = useState('');
  return (
    <form
      className="absolute inset-0 flex flex-col items-center justify-center gap-3 p-6 text-center"
      onSubmit={(e) => {
        e.preventDefault();
        if (password) onSubmit(password);
      }}
    >
      <p className="text-base font-medium text-foreground">This PDF is locked</p>
      <p className={cn('text-sm', wrong ? 'text-destructive' : 'text-muted-foreground')} role={wrong ? 'alert' : undefined}>
        {wrong ? 'That password isn’t right. Try again.' : 'Enter its password to open it.'}
      </p>
      <div className="flex w-full max-w-xs gap-2">
        <Input
          type="password"
          autoFocus
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          aria-label="Password"
          aria-invalid={wrong || undefined}
          className="flex-1"
        />
        <Button type="submit" disabled={!password}>Open</Button>
      </div>
    </form>
  );
}

function PagesSkeleton() {
  return (
    <div className="absolute inset-0 flex flex-col items-center gap-4 overflow-hidden p-6" aria-hidden>
      <Skeleton className="aspect-[17/22] w-full max-w-2xl shrink-0 bg-foreground/10" />
      <Skeleton className="aspect-[17/22] w-full max-w-2xl shrink-0 bg-foreground/10" />
    </div>
  );
}
