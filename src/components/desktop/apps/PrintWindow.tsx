import { useEffect, useMemo, useRef, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { FileText, Loader2, Minus, Plus, Printer as PrinterIcon, TriangleAlert } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectSeparator, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Skeleton } from '@/components/ui/skeleton';
import { Switch } from '@/components/ui/switch';
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group';
import { useFilePicker } from '@/contexts/FilePickerContext';
import { useWindowActions } from '@/contexts/WindowManagerContext';
import { useWindowTitle } from '@/contexts/WindowTitleContext';
import type { AppComponentProps } from '@/lib/apps';
import { notify } from '@/lib/notificationCenter';
import { useDebouncedValue } from '@/hooks/useDebouncedValue';
import { useLocalStorage } from '@/hooks/useLocalStorage';
import { usePrinterCapabilities, usePrinters } from '@/hooks/usePrinting';
import { useToast } from '@/hooks/useToast';
import {
  cleanPrintingError,
  getPrintingBridge,
  localPaperSize,
  PAPER_SIZES,
  type PaperSize,
  type Printer,
  type PrintDocument,
  type PrintLayout,
} from '@/lib/printing';
import { cn } from '@/lib/utils';

/** The destination that isn't a printer. */
const SAVE_AS_PDF = '\u0000pdf';
const PAGE_RANGES = /^\s*\d+(\s*-\s*\d+)?(\s*,\s*\d+(\s*-\s*\d+)?)*\s*$/;

const PAPER_LABELS: Record<PaperSize, string> = {
  Letter: 'US Letter',
  Legal: 'US Legal',
  Tabloid: 'Tabloid',
  A3: 'A3',
  A4: 'A4',
  A5: 'A5',
};

const SOURCE = { appId: 'settings', name: 'Printing' };

/** The document a print window's launch params name, or null. */
function paramDocument(params: AppComponentProps['params']): PrintDocument | null {
  const d = params?.document as Partial<PrintDocument> | undefined;
  if (!d || typeof d.id !== 'string' || typeof d.title !== 'string' || typeof d.kind !== 'string') return null;
  return { id: d.id, title: d.title, kind: d.kind };
}

/**
 * Din's print window (PRINT_WINDOW_APP_ID, opened by PrintHost), one per
 * document: a window, not a dialog, so the rest of the desktop stays usable
 * while a printer is chosen or a job is being sent. Its launch params'
 * `document` is what's printed; closing the window lets it go, unless a
 * job is on its way, which then finishes on its own and says how it went.
 */
export function PrintWindow({ windowId, params }: AppComponentProps) {
  const { close } = useWindowActions();
  const document = useMemo(() => paramDocument(params), [params]);
  useWindowTitle(document ? `Print “${document.title}”` : 'Print');
  if (!document || !getPrintingBridge()) {
    return <PreviewMessage>Nothing to print.</PreviewMessage>;
  }
  return <PrintForm key={document.id} document={document} onClose={() => close(windowId)} />;
}

/**
 * The print form, for a page, a frame, or a file: where it goes (a printer,
 * or a PDF file), how many, which pages, and how it's laid out, next to a
 * preview of the very PDF that will be sent (see electron/printing.mts).
 * Printers on the network appear in the list on their own.
 */
function PrintForm({ document, onClose }: { document: PrintDocument; onClose: () => void }) {
  const bridge = getPrintingBridge()!;
  const { toast } = useToast();
  const { pickFiles } = useFilePicker();
  const printers = usePrinters({ refetchInterval: 5000 });
  const list = useMemo(() => printers.data?.printers ?? [], [printers.data]);

  const [lastDestination, setLastDestination] = useLocalStorage<string | null>('din:print:destination', null);
  const [chosen, setChosen] = useState<string | null>(null);
  const destination = useMemo(() => {
    if (chosen) return chosen;
    if (!printers.data) return null;
    if (lastDestination === SAVE_AS_PDF) return SAVE_AS_PDF;
    const remembered = list.find((p) => p.name === lastDestination);
    return (remembered ?? list.find((p) => p.isDefault) ?? list[0])?.name ?? SAVE_AS_PDF;
  }, [chosen, printers.data, list, lastDestination]);
  const toPdf = destination === SAVE_AS_PDF;
  const printer = toPdf ? null : (list.find((p) => p.name === destination) ?? null);
  const capabilities = usePrinterCapabilities(printer?.name ?? null);
  const caps = capabilities.data;

  const [copies, setCopies] = useState(1);
  const [allPages, setAllPages] = useState(true);
  const [pages, setPages] = useState('');
  const [landscape, setLandscape] = useState(false);
  const [paperChoice, setPaperChoice] = useState<PaperSize | null>(null);
  const [color, setColor] = useState(true);
  const [twoSided, setTwoSided] = useState(false);
  const [background, setBackground] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const printButton = useRef<HTMLButtonElement>(null);
  /** A job (or save) under way, and whether the window closed meanwhile. */
  const sending = useRef(false);
  const gone = useRef(false);

  // Enter prints, as soon as the window is up.
  useEffect(() => {
    printButton.current?.focus();
  }, []);

  // The window closing (its close button, Escape, Cancel) lets the document
  // go, unless it's being sent: then the job finishes and submit cleans up.
  useEffect(
    () => () => {
      gone.current = true;
      if (!sending.current) void bridge.close(document.id);
    },
    [bridge, document.id],
  );

  const paperSizes = toPdf || !caps ? [...PAPER_SIZES] : caps.paperSizes;
  const paper: PaperSize =
    paperChoice && paperSizes.includes(paperChoice) ? paperChoice : (caps?.defaultPaper ?? localPaperSize());
  const canColor = !toPdf && caps?.color !== false;
  const canTwoSide = !toPdf && caps?.duplex !== false;
  const laysOut = document.kind !== 'pdf';

  const layoutLandscape = laysOut && landscape;
  const layoutBackground = document.kind === 'page' && background;
  const layout = useMemo<PrintLayout>(
    () => ({ landscape: layoutLandscape, paper, background: layoutBackground }),
    [layoutLandscape, paper, layoutBackground],
  );
  const settled = useDebouncedValue(layout, 250);
  const preview = useQuery({
    queryKey: ['printing', 'preview', document.id, settled.paper, settled.landscape, settled.background],
    queryFn: () => bridge.preview(document.id, settled),
    staleTime: Infinity,
    gcTime: 0,
    retry: false,
  });

  const pagesValid = allPages || PAGE_RANGES.test(pages);
  const ready = destination !== null && pagesValid && !busy && (toPdf || printer !== null);

  const submit = async () => {
    if (!ready) return;
    setError(null);
    setBusy(true);
    sending.current = true;
    try {
      if (toPdf) {
        const base = (document.title || 'Untitled').replace(/\.pdf$/i, '').replace(/[/\\:*?"<>|]+/g, ' ').trim();
        const name = `${base.slice(0, 120) || 'Untitled'}.pdf`;
        const result = await pickFiles({
          mode: 'save',
          title: 'Save as PDF',
          confirmLabel: 'Save',
          currentName: name,
          extensions: ['.pdf'],
        });
        const target = result?.paths[0];
        if (!target) {
          if (gone.current) void bridge.close(document.id);
          return;
        }
        await bridge.savePdf(document.id, layout, target);
        setLastDestination(SAVE_AS_PDF);
        toast({ title: 'Saved as PDF', description: target.slice(target.lastIndexOf('/') + 1) });
      } else {
        await bridge.print(document.id, layout, {
          printer: printer!.name,
          copies,
          pages: allPages ? null : pages,
          twoSided: canTwoSide && twoSided,
          color: canColor ? color : null,
          paper,
        });
        setLastDestination(printer!.name);
        toast({ title: `Sent to ${printer!.displayName}`, description: document.title });
      }
      if (!gone.current) onClose();
    } catch (e) {
      const message = cleanPrintingError(e);
      if (gone.current) {
        // The window was closed while it was sending: say so where it's seen.
        void bridge.close(document.id);
        notify({ source: SOURCE, title: `Couldn’t print “${document.title}”`, body: message });
      } else {
        setError(message);
      }
    } finally {
      sending.current = false;
      if (!gone.current) setBusy(false);
    }
  };

  return (
    <div
      className="flex h-full flex-col overflow-hidden bg-background md:flex-row"
      onKeyDown={(e) => {
        // Not an Escape that closes a menu (portalled, so outside this div).
        if (e.key === 'Escape' && !busy && e.currentTarget.contains(e.target as Node)) {
          e.preventDefault();
          onClose();
        }
      }}
    >
        <PreviewPane
          pages={preview.data?.pages ?? null}
          pageCount={preview.data?.pageCount ?? null}
          loading={preview.isFetching && !preview.data}
          error={preview.isError ? cleanPrintingError(preview.error) : null}
          landscape={layout.landscape}
          paper={paper}
        />

        <form
          className="flex min-h-0 w-full shrink-0 flex-col border-t border-border/60 md:w-80 md:border-t-0 md:border-l"
          onSubmit={(e) => {
            e.preventDefault();
            void submit();
          }}
        >
          <div className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto p-4 [&>*]:shrink-0">
            <div className="min-w-0">
              <h2 className="text-lg font-semibold">Print</h2>
              <p className="truncate text-sm text-muted-foreground" title={document.title}>
                {document.title}
                {preview.data?.pageCount ? ` · ${preview.data.pageCount} ${preview.data.pageCount === 1 ? 'page' : 'pages'}` : ''}
              </p>
            </div>

            <Field label="Printer" htmlFor="print-destination">
              {printers.isLoading ? (
                <Skeleton className="h-9 w-full" />
              ) : (
                <Select value={destination ?? undefined} onValueChange={setChosen}>
                  <SelectTrigger id="print-destination" className="w-full">
                    <SelectValue placeholder="Choose a printer" />
                  </SelectTrigger>
                  <SelectContent>
                    {list.map((p) => (
                      <SelectItem key={p.name} value={p.name}>
                        <PrinterRowLabel printer={p} />
                      </SelectItem>
                    ))}
                    {list.length > 0 && <SelectSeparator />}
                    <SelectItem value={SAVE_AS_PDF}>
                      <span className="flex items-center gap-2">
                        <FileText className="size-4 text-muted-foreground" aria-hidden />
                        Save as PDF
                      </span>
                    </SelectItem>
                  </SelectContent>
                </Select>
              )}
              {printers.data && list.length === 0 && (
                <p className="text-xs text-muted-foreground">
                  {printers.data.available
                    ? 'No printers yet. Turn your printer on and connect it to the same Wi-Fi as this computer, or plug it in with USB. It shows up here by itself.'
                    : 'Printing isn’t set up on this computer, but you can still save a PDF.'}
                </p>
              )}
              {printer?.problem && (
                <p className="flex items-center gap-1.5 text-xs text-warning">
                  <TriangleAlert className="size-3.5 shrink-0" aria-hidden />
                  {printer.problem}
                </p>
              )}
            </Field>

            {!toPdf && (
              <Field label="Copies" htmlFor="print-copies">
                <div className="flex items-center gap-2">
                  <Button
                    type="button"
                    variant="outline"
                    size="icon"
                    aria-label="Fewer copies"
                    disabled={copies <= 1}
                    onClick={() => setCopies((c) => Math.max(1, c - 1))}
                  >
                    <Minus className="size-4" />
                  </Button>
                  <Input
                    id="print-copies"
                    inputMode="numeric"
                    className="w-16 text-center tabular-nums"
                    value={copies}
                    onChange={(e) => {
                      const n = Number(e.target.value.replace(/\D/g, ''));
                      setCopies(Math.min(999, Math.max(1, n || 1)));
                    }}
                  />
                  <Button
                    type="button"
                    variant="outline"
                    size="icon"
                    aria-label="More copies"
                    disabled={copies >= 999}
                    onClick={() => setCopies((c) => Math.min(999, c + 1))}
                  >
                    <Plus className="size-4" />
                  </Button>
                </div>
              </Field>
            )}

            {!toPdf && (
              <Field label="Pages" htmlFor="print-pages">
                <ToggleGroup
                  type="single"
                  variant="outline"
                  className="w-full"
                  value={allPages ? 'all' : 'some'}
                  onValueChange={(v) => v && setAllPages(v === 'all')}
                >
                  <ToggleGroupItem value="all" className="flex-1">All</ToggleGroupItem>
                  <ToggleGroupItem value="some" className="flex-1">Some</ToggleGroupItem>
                </ToggleGroup>
                {!allPages && (
                  <>
                    <Input
                      id="print-pages"
                      placeholder="e.g. 1-3, 5"
                      value={pages}
                      autoFocus
                      aria-invalid={pages !== '' && !pagesValid}
                      onChange={(e) => setPages(e.target.value)}
                    />
                    {pages !== '' && !pagesValid && (
                      <p className="text-xs text-destructive">Pages should look like “1-3, 5”.</p>
                    )}
                  </>
                )}
              </Field>
            )}

            {laysOut && (
              <Field label="Layout">
                <ToggleGroup
                  type="single"
                  variant="outline"
                  className="w-full"
                  value={landscape ? 'landscape' : 'portrait'}
                  onValueChange={(v) => v && setLandscape(v === 'landscape')}
                  aria-label="Layout"
                >
                  <ToggleGroupItem value="portrait" className="flex-1">Portrait</ToggleGroupItem>
                  <ToggleGroupItem value="landscape" className="flex-1">Landscape</ToggleGroupItem>
                </ToggleGroup>
              </Field>
            )}

            <Field label="Paper size" htmlFor="print-paper">
              <Select value={paper} onValueChange={(v) => setPaperChoice(v as PaperSize)}>
                <SelectTrigger id="print-paper" className="w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {paperSizes.map((size) => (
                    <SelectItem key={size} value={size}>
                      {PAPER_LABELS[size]}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </Field>

            {canColor && (
              <Field label="Color">
                <ToggleGroup
                  type="single"
                  variant="outline"
                  className="w-full"
                  value={color ? 'color' : 'bw'}
                  onValueChange={(v) => v && setColor(v === 'color')}
                  aria-label="Color"
                >
                  <ToggleGroupItem value="color" className="flex-1">Color</ToggleGroupItem>
                  <ToggleGroupItem value="bw" className="flex-1">Black &amp; white</ToggleGroupItem>
                </ToggleGroup>
              </Field>
            )}

            {canTwoSide && (
              <SwitchRow id="print-two-sided" label="Print on both sides" checked={twoSided} onChange={setTwoSided} />
            )}
            {document.kind === 'page' && (
              <SwitchRow
                id="print-background"
                label="Background colors and images"
                checked={background}
                onChange={setBackground}
              />
            )}
          </div>

          <div className="flex flex-col gap-2 border-t border-border/60 p-4">
            {error && (
              <p role="alert" className="text-xs text-destructive">
                {error}
              </p>
            )}
            <div className="flex justify-end gap-2">
              <Button type="button" variant="ghost" disabled={busy} onClick={onClose}>
                Cancel
              </Button>
              <Button ref={printButton} type="submit" disabled={!ready}>
                {busy && <Loader2 className="size-4 animate-spin" aria-hidden />}
                {toPdf ? 'Save…' : 'Print'}
              </Button>
            </div>
          </div>
        </form>
    </div>
  );
}

function PrinterRowLabel({ printer }: { printer: Printer }) {
  const status =
    printer.problem ?? (printer.state === 'printing' ? 'Printing' : printer.state === 'stopped' ? 'Paused' : null);
  return (
    <span className="flex min-w-0 items-center gap-2">
      <PrinterIcon className="size-4 shrink-0 text-muted-foreground" aria-hidden />
      <span className="truncate">{printer.displayName}</span>
      {status && <span className="shrink-0 text-xs text-muted-foreground">· {status}</span>}
    </span>
  );
}

function Field({ label, htmlFor, children }: { label: string; htmlFor?: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-2">
      {htmlFor ? (
        <Label htmlFor={htmlFor} className="text-xs font-medium text-muted-foreground">
          {label}
        </Label>
      ) : (
        <span className="text-xs font-medium text-muted-foreground">{label}</span>
      )}
      {children}
    </div>
  );
}

function SwitchRow({
  id,
  label,
  checked,
  onChange,
}: {
  id: string;
  label: string;
  checked: boolean;
  onChange: (checked: boolean) => void;
}) {
  return (
    <div className="flex items-center justify-between gap-3">
      <Label htmlFor={id} className="text-sm font-normal">
        {label}
      </Label>
      <Switch id={id} checked={checked} onCheckedChange={onChange} />
    </div>
  );
}

/** Width over height of each paper size, portrait. */
const PAPER_ASPECT: Record<PaperSize, number> = {
  Letter: 8.5 / 11,
  Legal: 8.5 / 14,
  Tabloid: 11 / 17,
  A3: 297 / 420,
  A4: 210 / 297,
  A5: 148 / 210,
};

function PreviewPane({
  pages,
  pageCount,
  loading,
  error,
  landscape,
  paper,
}: {
  pages: string[] | null;
  pageCount: number | null;
  loading: boolean;
  error: string | null;
  landscape: boolean;
  paper: PaperSize;
}) {
  const aspect = landscape ? 1 / PAPER_ASPECT[paper] : PAPER_ASPECT[paper];
  const more = pages && pageCount !== null ? pageCount - pages.length : 0;

  // Back to the top when the layout changes the pages under the reader.
  const [scroller, setScroller] = useState<HTMLDivElement | null>(null);
  useEffect(() => {
    scroller?.scrollTo({ top: 0 });
  }, [scroller, pages]);

  return (
    <div
      ref={setScroller}
      className="min-h-48 flex-1 overflow-y-auto bg-muted/60"
      aria-label="Preview"
      aria-busy={loading}
    >
      {error ? (
        <PreviewMessage>Couldn’t prepare the preview: {error}</PreviewMessage>
      ) : loading || !pages ? (
        <div className="mx-auto flex max-w-sm flex-col items-center gap-6 p-8">
          <Skeleton className="w-full rounded-sm bg-background/80 shadow-sm" style={{ aspectRatio: aspect }} />
        </div>
      ) : pages.length === 0 ? (
        <PreviewMessage>
          {pageCount ? `${pageCount} ${pageCount === 1 ? 'page' : 'pages'}. ` : ''}A preview isn’t available, but it
          will print as usual.
        </PreviewMessage>
      ) : (
        <ol className="mx-auto flex max-w-sm flex-col items-center gap-6 p-8">
          {pages.map((src, i) => (
            <li key={i} className="flex w-full flex-col items-center gap-2">
              <img
                src={src}
                alt={`Page ${i + 1}`}
                className="w-full rounded-sm bg-white shadow-md ring-1 ring-black/5"
                draggable={false}
              />
              <span className="text-xs tabular-nums text-muted-foreground">{i + 1}</span>
            </li>
          ))}
          {more > 0 && (
            <li className="text-xs text-muted-foreground">
              and {more} more {more === 1 ? 'page' : 'pages'}
            </li>
          )}
        </ol>
      )}
    </div>
  );
}

function PreviewMessage({ children }: { children: React.ReactNode }) {
  return (
    <div className="grid h-full place-items-center p-8">
      <p className={cn('max-w-xs text-center text-sm text-muted-foreground')}>{children}</p>
    </div>
  );
}
