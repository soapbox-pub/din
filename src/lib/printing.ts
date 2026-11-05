/**
 * Typed access to the printing bridge exposed by the Electron preload
 * (`window.dinos.printing`, see electron/preload.cjs + electron/printing.mts).
 *
 * Backed by CUPS: the printers it knows (network ones it found on its own
 * included), Din's print dialog's previews and jobs, and the print queue.
 * Absent in a plain browser; callers feature-detect via `getPrintingBridge()`.
 */

export const PAPER_SIZES = ['Letter', 'Legal', 'Tabloid', 'A3', 'A4', 'A5'] as const;
export type PaperSize = (typeof PAPER_SIZES)[number];

export type PrinterState = 'idle' | 'printing' | 'stopped';

export interface Printer {
  /** The CUPS destination name, which every action takes. */
  name: string;
  displayName: string;
  location: string;
  isDefault: boolean;
  state: PrinterState;
  /** What's wrong, in words (out of paper, offline), or null. */
  problem: string | null;
  /** False for a printer found on the network that has no queue yet. */
  configured: boolean;
}

export interface PrinterCapabilities {
  /** Null when the printer doesn't say. */
  color: boolean | null;
  duplex: boolean | null;
  paperSizes: PaperSize[];
  defaultPaper: PaperSize | null;
}

export interface PrintJob {
  id: string;
  printer: string;
  title: string;
  sizeBytes: number;
  active: boolean;
}

export interface PrintersState {
  /** False when CUPS isn't installed or isn't running. */
  available: boolean;
  printers: Printer[];
  jobs: PrintJob[];
}

export type PrintKind = 'page' | 'pdf' | 'image' | 'text';

/** Something being printed, held by the main process until it's done. */
export interface PrintDocument {
  id: string;
  title: string;
  kind: PrintKind;
}

export interface PrintLayout {
  landscape: boolean;
  paper: PaperSize;
  /** Background colours and images (pages only). */
  background: boolean;
}

export interface JobOptions {
  printer: string;
  copies: number;
  /** "1-3, 5", or null for every page. */
  pages: string | null;
  twoSided: boolean;
  /** False for black and white; null leaves it to the printer. */
  color: boolean | null;
  paper: PaperSize;
}

export interface PrintPreview {
  pageCount: number | null;
  /** The first pages as image data URLs; empty when they can't be drawn. */
  pages: string[];
}

export interface FoundDevice {
  uri: string;
  name: string;
  /** "usb" or "network". */
  connection: string;
}

export type PrintEvent =
  | { type: 'problem'; printer: string; title: string; problem: string }
  | { type: 'printed'; printer: string; title: string };

export interface PrintingBridge {
  state(): Promise<PrintersState>;
  capabilities(printer: string): Promise<PrinterCapabilities>;
  openPage(wcId: number): Promise<PrintDocument>;
  openFile(path: string): Promise<PrintDocument>;
  preview(id: string, layout: PrintLayout): Promise<PrintPreview>;
  /** Resolves to the job id. */
  print(id: string, layout: PrintLayout, job: JobOptions): Promise<string>;
  savePdf(id: string, layout: PrintLayout, path: string): Promise<void>;
  close(id: string): Promise<void>;
  reset(): Promise<void>;
  cancelJob(job: string): Promise<void>;
  setDefault(printer: string): Promise<void>;
  /** Resolves to the job id. */
  testPage(printer: string): Promise<string>;
  /** Start a stopped printer again. */
  resume(printer: string): Promise<void>;
  remove(printer: string): Promise<void>;
  discover(): Promise<FoundDevice[]>;
  /** Resolves to the new printer's name. */
  add(uri: string): Promise<string>;
  onOpen(callback: (document: PrintDocument) => void): () => void;
  onEvent(callback: (event: PrintEvent) => void): () => void;
}

declare global {
  interface Dinos {
    /** Present only inside the Electron shell. */
    printing?: PrintingBridge;
  }
}

/** The printing bridge, or undefined outside the Electron shell. */
export function getPrintingBridge(): PrintingBridge | undefined {
  if (typeof window === 'undefined') return undefined;
  return window.dinos?.printing;
}

/** Strip Electron's IPC error prefix so users see just the underlying message. */
export function cleanPrintingError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.replace(/^Error invoking remote method '[^']*':\s*(?:Error:\s*)?/, '');
}

const IMAGE_EXTENSIONS = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'svg', 'avif']);
const TEXT_EXTENSIONS = new Set([
  'txt', 'md', 'markdown', 'log', 'csv', 'tsv', 'json', 'xml', 'yaml', 'yml', 'toml', 'ini',
  'conf', 'cfg', 'sh', 'py', 'js', 'mjs', 'cjs', 'ts', 'tsx', 'jsx', 'css', 'html', 'htm',
  'c', 'h', 'cpp', 'hpp', 'rs', 'go', 'java', 'rb', 'php', 'lua', 'nix', 'sql', 'diff',
]);

/** Whether Din can print a file, by its name (mirrors printableKind in printing.mts). */
export function isPrintableFile(name: string): boolean {
  const dot = name.lastIndexOf('.');
  if (dot <= 0) return false;
  const ext = name.slice(dot + 1).toLowerCase();
  return ext === 'pdf' || IMAGE_EXTENSIONS.has(ext) || TEXT_EXTENSIONS.has(ext);
}

/** Regions that use US paper sizes; everywhere else uses A4. */
const LETTER_REGIONS = new Set(['US', 'CA', 'MX', 'PH', 'CL', 'CO', 'VE', 'CR', 'GT', 'PR', 'BZ', 'SV', 'DO', 'PA', 'NI']);

/** The paper most likely in the printer here, from the language's region. */
export function localPaperSize(): PaperSize {
  try {
    const region = new Intl.Locale(navigator.language).maximize().region;
    return region && LETTER_REGIONS.has(region) ? 'Letter' : 'A4';
  } catch {
    return 'Letter';
  }
}

/**
 * The print window (src/components/desktop/apps/PrintWindow.tsx), one per
 * document, its launch params `{ document }`. Under Settings in the Dock.
 */
export const PRINT_WINDOW_APP_ID = 'print';

/** Pages a print dialog was asked for, by whoever asked. */
type OpenListener = (document: PrintDocument) => void;
const openListeners = new Set<OpenListener>();

/** Show the print dialog for a document the shell started. */
export function showPrintDialog(document: PrintDocument): void {
  for (const listener of openListeners) listener(document);
}

/** Subscribe to the shell's own print requests (for PrintHost). */
export function onShowPrintDialog(listener: OpenListener): () => void {
  openListeners.add(listener);
  return () => openListeners.delete(listener);
}

/** Open the print dialog for a page (a <webview> guest). */
export async function printPage(wcId: number): Promise<void> {
  const bridge = getPrintingBridge();
  if (!bridge) return;
  showPrintDialog(await bridge.openPage(wcId));
}

/** Open the print dialog for a file (`din printers print`). */
export async function printFile(path: string): Promise<void> {
  const bridge = getPrintingBridge();
  if (!bridge) return;
  showPrintDialog(await bridge.openFile(path));
}
