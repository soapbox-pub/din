// The printing bridge (window.printing, for Din's print dialog and Settings →
// Printers): CUPS, through its command-line tools.
//
// Printers need no setup. DinOS runs CUPS with Avahi and ipp-usb
// (os/configuration.nix), so a printer on the network, or one plugged in
// that speaks IPP over USB (most made since about 2015), shows up in
// `lpstat -e` as soon as it's on, and printing to it makes the queue on the
// spot (a CUPS temporary queue, driverless). Older USB printers need a
// driver: Settings finds them with `lpinfo` and adds them with the best one
// installed (`addPrinter`).
//
// Everything printed goes to CUPS as a PDF. A page (a browser tab, a web
// app) is laid out by Chromium with printToPDF; a frame that called print()
// on its own (the hidden iframe sites print receipts through), a picture, a
// text file, and the test page are drawn as HTML in a hidden offscreen
// window with JavaScript off and laid out the same way; a PDF is printed as
// it is. The dialog shows the PDF's pages, drawn by poppler's pdftoppm, so
// what it previews is what's sent. Chromium's own print path is never used:
// it would open a GTK dialog, which under cage replaces the whole screen.
//
// Pages that call window.print() reach here through print-preload.cjs; the
// shell is told (`printing:open`) and shows the dialog. Jobs Din sends are
// followed until they leave the queue, and a printer that stops with one
// waiting (out of paper, offline) is reported once (`printing:event`).
//
// Runs as TypeScript directly via Node's native type stripping - erasable
// syntax only, like the rest of electron/.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { BrowserWindow, ipcMain, type WebContents } from 'electron';
import { CommandError, runCommand } from './system.mts';

const TIMEOUT_MS = 20_000;
/** `lpinfo -v` asks every backend, the network ones included. */
const DISCOVER_TIMEOUT_MS = 60_000;
const RENDER_TIMEOUT_MS = 60_000;
const JOB_POLL_MS = 3000;
/** The dialog shows this many pages; the rest are counted. */
const PREVIEW_PAGES = 30;
const PREVIEW_PIXELS = 480;
const MAX_TEXT_BYTES = 4 * 1024 * 1024;
const MAX_FRAME_HTML = 16 * 1024 * 1024;

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
  /**
   * False for a printer CUPS found on the network (or through ipp-usb) that
   * has no queue of its own yet; it gets one the first time it's used.
   */
  configured: boolean;
}

export interface PrinterCapabilities {
  /** Null when the printer doesn't say, before its queue exists. */
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
  /** Whether the printer is working on it now. */
  active: boolean;
}

export interface PrintersState {
  /** False when CUPS isn't installed or isn't running. */
  available: boolean;
  printers: Printer[];
  jobs: PrintJob[];
}

export type PrintKind = 'page' | 'pdf' | 'image' | 'text';

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

export interface FoundDevice {
  uri: string;
  name: string;
  /** "usb" or "network". */
  connection: string;
}

export type PrintEvent =
  | { type: 'problem'; printer: string; title: string; problem: string }
  | { type: 'printed'; printer: string; title: string };

/** Something to print, kept between the dialog's previews and its Print. */
type Source =
  | { kind: 'page'; contents: WebContents }
  | { kind: 'html'; html: string; baseUrl?: string }
  | { kind: 'file'; path: string; type: 'pdf' | 'image' | 'text' };

interface Document {
  title: string;
  source: Source;
  /** The page that asked for it with print(), if one did. */
  owner: number | null;
  /** The last PDF rendered for it, and the layout it was rendered with. */
  pdf: string | null;
  layout: string | null;
}

const IMAGE_EXTENSIONS = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp', '.svg', '.avif']);
const TEXT_EXTENSIONS = new Set([
  '.txt', '.md', '.markdown', '.log', '.csv', '.tsv', '.json', '.xml', '.yaml', '.yml', '.toml', '.ini',
  '.conf', '.cfg', '.sh', '.py', '.js', '.mjs', '.cjs', '.ts', '.tsx', '.jsx', '.css', '.html', '.htm',
  '.c', '.h', '.cpp', '.hpp', '.rs', '.go', '.java', '.rb', '.php', '.lua', '.nix', '.sql', '.diff',
]);

let sendToShell: (channel: string, payload?: unknown) => void = () => {};
let tempDir: string | null = null;
let nextDocument = 1;
const documents = new Map<string, Document>();
/** Devices from the last `discover`, the only ones `addPrinter` takes. */
let found: (FoundDevice & { makeModel: string })[] = [];

/** What printing can do with a file, by its name; null for nothing. */
export function printableKind(file: string): 'pdf' | 'image' | 'text' | null {
  const ext = path.extname(file).toLowerCase();
  if (ext === '.pdf') return 'pdf';
  if (IMAGE_EXTENSIONS.has(ext)) return 'image';
  if (TEXT_EXTENSIONS.has(ext)) return 'text';
  return null;
}

function temp(): string {
  tempDir ??= fs.mkdtempSync(path.join(os.tmpdir(), 'din-print-'));
  return tempDir;
}

/** A CUPS tool, in the C locale so its output can be read. */
function cups(tool: string, args: string[], timeout = TIMEOUT_MS) {
  return runCommand('env', ['LC_ALL=C', tool, ...args], { timeout, maxBuffer: 4 * 1024 * 1024 });
}

/** CUPS's complaint, without the tool's name in front. */
function explain(error: unknown): Error {
  if (error instanceof CommandError) {
    if (error.code === 'ENOENT' || error.code === 127) return new Error('Printing isn’t available on this computer.');
    const message = error.stderr.trim().split('\n').pop()?.replace(/^\w+:\s*/, '') ?? '';
    if (/scheduler is not running|connection refused|no such file/i.test(message)) {
      return new Error('The printing service isn’t running.');
    }
    if (/forbidden|not authorized/i.test(message)) return new Error('This computer doesn’t allow it.');
    return new Error(message || error.message);
  }
  return error instanceof Error ? error : new Error(String(error));
}

function displayName(name: string, description?: string): string {
  if (description && description !== name) return description;
  return name.replace(/_+/g, ' ').trim() || name;
}

/** printer-state-reasons, as the person at the printer would put them. */
const REASONS: [RegExp, string][] = [
  [/^media-empty|^media-needed|^input-tray-missing/, 'Out of paper'],
  [/^media-jam/, 'Paper jam'],
  [/^(toner|marker-supply)-empty/, 'Out of ink or toner'],
  [/^(cover|door|interlock)-open/, 'A cover is open'],
  [/^output-area-full/, 'The output tray is full'],
  [/^offline|^connecting-to-device|^timed-out|^shutdown/, 'Not responding'],
  [/^paused/, 'Paused'],
];

function describeReasons(alerts: string): string | null {
  for (const reason of alerts.split(/[\s,]+/)) {
    if (!reason || reason === 'none' || reason.endsWith('-warning')) continue;
    if (reason.endsWith('-report') && !reason.startsWith('offline')) continue;
    for (const [pattern, words] of REASONS) if (pattern.test(reason)) return words;
  }
  return null;
}

/** `lpstat -l -p`: the printers that have queues, with their state. */
function parsePrinters(text: string): Map<string, Omit<Printer, 'isDefault' | 'configured'>> {
  const printers = new Map<string, Omit<Printer, 'isDefault' | 'configured'>>();
  let current: (Omit<Printer, 'isDefault' | 'configured'> & { message: string | null; description: string }) | null = null;
  let afterHeader = false;
  const finish = () => {
    if (!current) return;
    const { message, description, ...printer } = current;
    printer.displayName = displayName(printer.name, description);
    if (printer.state === 'stopped' && !printer.problem) printer.problem = message && message !== 'Paused' ? message : 'Paused';
    printers.set(printer.name, printer);
  };
  for (const line of text.split('\n')) {
    const header = /^printer (\S+) (?:is (idle)|now (printing)|(disabled))/.exec(line);
    if (header) {
      finish();
      current = {
        name: header[1],
        displayName: header[1],
        location: '',
        state: header[2] ? 'idle' : header[3] ? 'printing' : 'stopped',
        problem: null,
        message: null,
        description: '',
      };
      afterHeader = true;
      continue;
    }
    if (!current) continue;
    const field = /^\t(Description|Location|Alerts): ?(.*)$/.exec(line);
    if (field) {
      if (field[1] === 'Description') current.description = field[2].trim();
      else if (field[1] === 'Location') current.location = field[2].trim();
      else current.problem = describeReasons(field[2]);
    } else if (afterHeader && /^\t\S/.test(line) && !line.startsWith('\tForm mounted:')) {
      current.message = line.trim();
    }
    afterHeader = false;
  }
  finish();
  return printers;
}

/** `lpstat -o` plus `lpq -a` (which has the titles): the waiting jobs. */
function parseJobs(lpstat: string, lpq: string): PrintJob[] {
  const titles = new Map<string, { title: string; active: boolean }>();
  for (const line of lpq.split('\n')) {
    const match = /^(\S+)\s+\S+\s+(\d+)\s+(.+?)\s+\d+ bytes$/.exec(line);
    if (match) titles.set(match[2], { title: match[3], active: match[1] === 'active' });
  }
  const jobs: PrintJob[] = [];
  for (const line of lpstat.split('\n')) {
    const match = /^(\S+)-(\d+)\s+\S+\s+(\d+)\s/.exec(line);
    if (!match) continue;
    const info = titles.get(match[2]);
    jobs.push({
      id: `${match[1]}-${match[2]}`,
      printer: match[1],
      title: info?.title ?? 'Untitled',
      sizeBytes: Number(match[3]),
      active: info?.active ?? false,
    });
  }
  return jobs;
}

async function state(): Promise<PrintersState> {
  let names: string[];
  try {
    names = (await cups('lpstat', ['-e'])).stdout.split('\n').map((n) => n.trim()).filter(Boolean);
  } catch (error) {
    // No printers at all is an error to lpstat; no CUPS is ENOENT or a
    // refused connection.
    const reason = explain(error).message;
    if (/isn’t available|isn’t running/.test(reason)) return { available: false, printers: [], jobs: [] };
    names = [];
  }
  const [details, defaults, queued, ranked] = await Promise.all([
    cups('lpstat', ['-l', '-p']).then((r) => r.stdout, () => ''),
    cups('lpstat', ['-d']).then((r) => r.stdout, () => ''),
    cups('lpstat', ['-o']).then((r) => r.stdout, () => ''),
    cups('lpq', ['-a']).then((r) => r.stdout, () => ''),
  ]);
  const queues = parsePrinters(details);
  const defaultName = /destination: (\S+)/.exec(defaults)?.[1] ?? null;
  const printers: Printer[] = [...new Set([...names, ...queues.keys()])].map((name) => {
    const queue = queues.get(name);
    return {
      name,
      displayName: queue?.displayName ?? displayName(name),
      location: queue?.location ?? '',
      state: queue?.state ?? 'idle',
      problem: queue?.problem ?? null,
      isDefault: name === defaultName,
      configured: queue !== undefined,
    };
  });
  printers.sort((a, b) => Number(b.isDefault) - Number(a.isDefault) || a.displayName.localeCompare(b.displayName));
  return { available: true, printers, jobs: parseJobs(queued, ranked) };
}

async function capabilities(printer: string): Promise<PrinterCapabilities> {
  let text: string;
  try {
    text = (await cups('lpoptions', ['-p', printer, '-l'])).stdout;
  } catch {
    // A printer that has no queue yet has nothing to read options from.
    return { color: null, duplex: null, paperSizes: [...PAPER_SIZES], defaultPaper: null };
  }
  const options = new Map<string, { values: string[]; default: string | null }>();
  for (const line of text.split('\n')) {
    const match = /^([^/:]+)(?:\/[^:]*)?:\s*(.*)$/.exec(line);
    if (!match) continue;
    const values = match[2].split(/\s+/).filter(Boolean);
    const chosen = values.find((v) => v.startsWith('*'))?.slice(1) ?? null;
    options.set(match[1], { values: values.map((v) => v.replace(/^\*/, '')), default: chosen });
  }
  const colorModel = options.get('ColorModel') ?? options.get('print-color-mode');
  const duplex = options.get('Duplex') ?? options.get('sides');
  const pageSize = options.get('PageSize') ?? options.get('media');
  const known = (value: string | null | undefined) =>
    PAPER_SIZES.find((size) => size.toLowerCase() === value?.toLowerCase()) ?? null;
  const paperSizes = pageSize ? PAPER_SIZES.filter((size) => pageSize.values.some((v) => known(v) === size)) : [];
  return {
    color: colorModel ? colorModel.values.some((v) => !/^(gray|grey|black|mono|monochrome|kgray|bi-level)/i.test(v)) : null,
    duplex: duplex ? duplex.values.some((v) => /^duplex|^two-sided/i.test(v)) : false,
    paperSizes: paperSizes.length > 0 ? paperSizes : [...PAPER_SIZES],
    defaultPaper: known(pageSize?.default),
  };
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

function escapeHtml(text: string): string {
  return text.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
}

/** HTML laid out to PDF in a window nobody sees, with no script running. */
async function htmlToPdf(html: string, layout: PrintLayout, baseUrl?: string): Promise<Buffer> {
  const win = new BrowserWindow({
    show: false,
    webPreferences: {
      offscreen: true,
      javascript: false,
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      // Its own in-memory session: nothing of the shell's, nothing kept.
      partition: 'din-print',
    },
  });
  // Nothing in it may go anywhere else.
  win.webContents.on('will-navigate', (event) => event.preventDefault());
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  const file = path.join(temp(), `page-${process.hrtime.bigint()}.html`);
  try {
    // A file has no HTTP header to give its encoding, and outerHTML is UTF-16
    // made UTF-8 here, whatever the page's own meta said.
    const base = `<meta charset="utf-8">${baseUrl ? `<base href="${escapeHtml(baseUrl)}">` : ''}`;
    const withBase = /<head(\s[^>]*)?>/i.test(html) ? html.replace(/<head(\s[^>]*)?>/i, (head) => `${head}${base}`) : base + html;
    fs.writeFileSync(file, withBase, 'utf8');
    await withTimeout(win.loadFile(file), RENDER_TIMEOUT_MS);
    return await withTimeout(win.webContents.printToPDF(pdfOptions(layout)), RENDER_TIMEOUT_MS);
  } finally {
    win.destroy();
    fs.rmSync(file, { force: true });
  }
}

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  return Promise.race([
    promise,
    new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error('Preparing it took too long.')), ms);
    }),
  ]).finally(() => clearTimeout(timer));
}

function pdfOptions(layout: PrintLayout): Electron.PrintToPDFOptions {
  return {
    landscape: layout.landscape,
    pageSize: layout.paper,
    printBackground: layout.background,
    margins: { marginType: 'default' },
  };
}

function fileHtml(file: string, type: 'image' | 'text'): string {
  const title = escapeHtml(path.basename(file));
  if (type === 'image') {
    const src = escapeHtml(new URL(`file://${file.split('/').map(encodeURIComponent).join('/')}`).href);
    return `<!doctype html><html><head><meta charset="utf-8"><title>${title}</title><style>
      @page { margin: 0.4in } html, body { margin: 0; height: 100% }
      body { display: flex; align-items: center; justify-content: center }
      img { max-width: 100%; max-height: 100vh; object-fit: contain }
    </style></head><body><img src="${src}"></body></html>`;
  }
  const size = fs.statSync(file).size;
  if (size > MAX_TEXT_BYTES) throw new Error('This file is too big to print.');
  const bytes = fs.readFileSync(file);
  if (bytes.subarray(0, 8192).includes(0)) throw new Error('Din can’t print this kind of file.');
  const text = bytes.toString('utf8');
  return `<!doctype html><html><head><meta charset="utf-8"><title>${title}</title><style>
    pre { margin: 0; white-space: pre-wrap; overflow-wrap: anywhere; font: 10pt/1.4 "DejaVu Sans Mono", monospace }
  </style></head><body><pre>${escapeHtml(text)}</pre></body></html>`;
}

function layoutKey(layout: PrintLayout): string {
  return `${layout.paper}:${layout.landscape}:${layout.background}`;
}

/** The document as a PDF in the given layout (a PDF file is itself). */
async function pdfFor(id: string, document: Document, layout: PrintLayout): Promise<string> {
  const { source } = document;
  if (source.kind === 'file' && source.type === 'pdf') return source.path;
  const key = layoutKey(layout);
  if (document.pdf && document.layout === key && fs.existsSync(document.pdf)) return document.pdf;
  let pdf: Buffer;
  if (source.kind === 'page') {
    if (source.contents.isDestroyed()) throw new Error('That page was closed.');
    pdf = await withTimeout(source.contents.printToPDF(pdfOptions(layout)), RENDER_TIMEOUT_MS);
  } else if (source.kind === 'html') {
    pdf = await htmlToPdf(source.html, layout, source.baseUrl);
  } else if (source.type !== 'pdf') {
    pdf = await htmlToPdf(fileHtml(source.path, source.type), layout);
  } else {
    return source.path;
  }
  if (!documents.has(id)) throw new Error('Printing was cancelled.');
  const file = path.join(temp(), `${id}-${Date.now()}.pdf`);
  fs.writeFileSync(file, pdf);
  if (document.pdf && document.pdf !== file) fs.rmSync(document.pdf, { force: true });
  document.pdf = file;
  document.layout = key;
  return file;
}

/** The first pages as small PNGs, and how many there are. */
async function previewPdf(pdf: string): Promise<{ pageCount: number | null; pages: string[] }> {
  const pageCount = await runCommand('pdfinfo', [pdf], { timeout: TIMEOUT_MS }).then(
    ({ stdout }) => Number(/^Pages:\s+(\d+)/m.exec(stdout)?.[1]) || null,
    () => null,
  );
  const dir = fs.mkdtempSync(path.join(temp(), 'preview-'));
  try {
    await runCommand(
      'pdftoppm',
      ['-png', '-scale-to', String(PREVIEW_PIXELS), '-f', '1', '-l', String(PREVIEW_PAGES), pdf, path.join(dir, 'p')],
      { timeout: RENDER_TIMEOUT_MS },
    );
    const files = fs
      .readdirSync(dir)
      .filter((f) => f.endsWith('.png'))
      .sort((a, b) => Number(/(\d+)\.png$/.exec(a)?.[1]) - Number(/(\d+)\.png$/.exec(b)?.[1]));
    const pages = files.map((f) => `data:image/png;base64,${fs.readFileSync(path.join(dir, f)).toString('base64')}`);
    return { pageCount: pageCount ?? (pages.length || null), pages };
  } catch {
    // Without poppler there's no preview, but printing still works.
    return { pageCount, pages: [] };
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

function addDocument(
  title: string,
  source: Source,
  owner: number | null = null,
): { id: string; title: string; kind: PrintKind } {
  const id = `doc${nextDocument++}`;
  documents.set(id, { title, source, owner, pdf: null, layout: null });
  const kind = source.kind === 'file' ? source.type : 'page';
  return { id, title, kind };
}

function discard(id: string): void {
  const document = documents.get(id);
  if (!document) return;
  documents.delete(id);
  if (document.pdf) fs.rmSync(document.pdf, { force: true });
}

// ---------------------------------------------------------------------------
// Jobs
// ---------------------------------------------------------------------------

interface Tracked {
  printer: string;
  title: string;
  /** The problem last reported, so each is said once. */
  reported: string | null;
}

const tracked = new Map<string, Tracked>();
let pollTimer: NodeJS.Timeout | null = null;

function follow(job: string, printer: string, title: string): void {
  tracked.set(job, { printer, title, reported: null });
  pollTimer ??= setTimeout(poll, JOB_POLL_MS);
}

async function poll(): Promise<void> {
  pollTimer = null;
  const current = await state().catch(() => null);
  if (current) {
    const waiting = new Set(current.jobs.map((j) => j.id));
    for (const [job, info] of tracked) {
      if (!waiting.has(job)) {
        tracked.delete(job);
        // It's out; say so only to someone who was told it was stuck.
        if (info.reported) sendToShell('printing:event', { type: 'printed', printer: info.printer, title: info.title } satisfies PrintEvent);
        continue;
      }
      const printer = current.printers.find((p) => p.name === info.printer);
      const problem = printer?.problem ?? null;
      if (problem && problem !== info.reported) {
        info.reported = problem;
        sendToShell('printing:event', {
          type: 'problem',
          printer: printer?.displayName ?? info.printer,
          title: info.title,
          problem,
        } satisfies PrintEvent);
      }
    }
  }
  if (tracked.size > 0) pollTimer = setTimeout(poll, JOB_POLL_MS);
}

const PAGE_RANGES = /^\s*\d+(\s*-\s*\d+)?(\s*,\s*\d+(\s*-\s*\d+)?)*\s*$/;

function jobOptions(value: unknown): JobOptions {
  const v = (value ?? {}) as Record<string, unknown>;
  const copies = Number(v.copies);
  if (typeof v.printer !== 'string' || !v.printer || v.printer.startsWith('-')) throw new Error('Choose a printer.');
  if (!Number.isInteger(copies) || copies < 1 || copies > 999) throw new Error('Copies must be between 1 and 999.');
  const pages = typeof v.pages === 'string' && v.pages.trim() ? v.pages.trim() : null;
  if (pages !== null && !PAGE_RANGES.test(pages)) throw new Error('Pages should look like “1-3, 5”.');
  return {
    printer: v.printer,
    copies,
    pages: pages && pages.replace(/\s+/g, ''),
    twoSided: v.twoSided === true,
    color: typeof v.color === 'boolean' ? v.color : null,
    paper: paperSize(v.paper),
  };
}

function paperSize(value: unknown): PaperSize {
  return PAPER_SIZES.find((size) => size === value) ?? 'Letter';
}

function printLayout(value: unknown): PrintLayout {
  const v = (value ?? {}) as Record<string, unknown>;
  return { landscape: v.landscape === true, paper: paperSize(v.paper), background: v.background === true };
}

async function print(id: string, layout: PrintLayout, options: JobOptions): Promise<string> {
  const document = documents.get(id);
  if (!document) throw new Error('Nothing to print.');
  const pdf = await pdfFor(id, document, layout);
  const args = ['-d', options.printer, '-n', String(options.copies), '-t', document.title || 'Untitled'];
  if (options.copies > 1) args.push('-o', 'collate=true');
  if (options.pages) args.push('-P', options.pages);
  args.push('-o', `media=${options.paper}`);
  args.push('-o', `sides=${options.twoSided ? (layout.landscape ? 'two-sided-short-edge' : 'two-sided-long-edge') : 'one-sided'}`);
  if (options.color !== null) args.push('-o', `print-color-mode=${options.color ? 'color' : 'monochrome'}`);
  // The PDF is laid out for the paper already; don't let CUPS scale it again.
  if (document.source.kind !== 'file' || document.source.type !== 'pdf') args.push('-o', 'print-scaling=none');
  args.push('--', pdf);
  try {
    const { stdout } = await cups('lp', args);
    const job = /request id is (\S+)/.exec(stdout)?.[1] ?? null;
    if (job) follow(job, options.printer, document.title);
    return job ?? '';
  } catch (error) {
    throw explain(error);
  }
}

// ---------------------------------------------------------------------------
// Printers that need a driver
// ---------------------------------------------------------------------------

/** `lpinfo -l -v`: the devices the backends found. */
function parseDevices(text: string): (FoundDevice & { makeModel: string })[] {
  const devices: (FoundDevice & { makeModel: string; info: string })[] = [];
  let current: (FoundDevice & { makeModel: string; info: string }) | null = null;
  for (const line of text.split('\n')) {
    const uri = /^Device: uri = (\S+)/.exec(line);
    if (uri) {
      current = { uri: uri[1], name: '', connection: '', makeModel: '', info: '' };
      devices.push(current);
      continue;
    }
    const field = /^\s+(class|info|make-and-model) = (.*)$/.exec(line);
    if (!current || !field) continue;
    if (field[1] === 'class') current.connection = field[2].trim() === 'direct' ? 'usb' : 'network';
    else if (field[1] === 'info') current.info = field[2].trim();
    else current.makeModel = field[2].trim();
  }
  return devices
    .filter((d) => d.uri.includes('://') && /^(usb|dnssd|socket|lpd|ipp|ipps):/.test(d.uri))
    .map(({ info, ...d }) => ({ ...d, name: info || (d.makeModel !== 'Unknown' ? d.makeModel : '') || d.uri }));
}

async function discover(): Promise<FoundDevice[]> {
  const [devices, queues] = await Promise.all([
    cups('lpinfo', ['-l', '-v'], DISCOVER_TIMEOUT_MS).then((r) => r.stdout),
    cups('lpstat', ['-v']).then((r) => r.stdout, () => ''),
  ]).catch((error) => {
    throw explain(error);
  });
  const known = new Set(queues.split('\n').map((l) => /^device for \S+: (\S+)/.exec(l)?.[1]).filter(Boolean));
  const listed = new Set((await state()).printers.map((p) => p.displayName.toLowerCase()));
  // Network printers that speak IPP are on the list already, queue or not.
  found = parseDevices(devices).filter(
    (d) => !known.has(d.uri) && !(d.connection === 'network' && listed.has(d.name.toLowerCase())),
  );
  return found.map(({ uri, name, connection }) => ({ uri, name, connection }));
}

/** The best driver installed for a printer, as lpadmin's -m takes it. */
async function driverFor(device: FoundDevice & { makeModel: string }): Promise<string> {
  if (/^(ipp|ipps|dnssd):/.test(device.uri) && !/_pdl-datastream|_printer\./.test(device.uri)) return 'everywhere';
  if (!device.makeModel || device.makeModel === 'Unknown') throw new Error('This printer didn’t say what model it is.');
  const { stdout } = await cups('lpinfo', ['--make-and-model', device.makeModel, '-m'], DISCOVER_TIMEOUT_MS).catch(
    (error) => {
      throw explain(error);
    },
  );
  const drivers = stdout
    .split('\n')
    .map((line) => {
      const space = line.indexOf(' ');
      return space > 0 ? { ppd: line.slice(0, space), name: line.slice(space + 1) } : null;
    })
    .filter((d): d is { ppd: string; name: string } => d !== null);
  const best =
    drivers.find((d) => /recommended/i.test(d.name)) ??
    drivers.find((d) => !/\/expert\b/.test(d.ppd)) ??
    drivers[0];
  if (!best) throw new Error('There’s no driver for this printer on this computer.');
  return best.ppd;
}

/** A queue name CUPS accepts, from a printer's name. */
function queueName(name: string, taken: Set<string>): string {
  const base = name.replace(/[^A-Za-z0-9_.-]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 100) || 'Printer';
  let candidate = base;
  for (let n = 2; taken.has(candidate); n++) candidate = `${base}_${n}`;
  return candidate;
}

async function addPrinter(uri: string): Promise<string> {
  const device = found.find((d) => d.uri === uri);
  if (!device) throw new Error('That printer isn’t connected any more.');
  const driver = await driverFor(device);
  const current = await state();
  const name = queueName(device.name, new Set(current.printers.map((p) => p.name)));
  try {
    await cups('lpadmin', ['-p', name, '-E', '-v', device.uri, '-m', driver, '-D', device.name, '-o', 'printer-is-shared=false'], DISCOVER_TIMEOUT_MS);
  } catch (error) {
    throw explain(error);
  }
  if (!current.printers.some((p) => p.isDefault)) await cups('lpoptions', ['-d', name]).catch(() => {});
  found = found.filter((d) => d.uri !== uri);
  return name;
}

// ---------------------------------------------------------------------------
// The test page
// ---------------------------------------------------------------------------

function testPageHtml(printer: string): string {
  const swatches = ['#e11d48', '#f59e0b', '#16a34a', '#0ea5e9', '#7c3aed', '#00bcd4', '#e91e63', '#ffeb3b', '#000']
    .map((c) => `<div style="background:${c}"></div>`)
    .join('');
  const ramp = Array.from({ length: 11 }, (_, i) => `<div style="background:hsl(0 0% ${100 - i * 10}%)"></div>`).join('');
  const when = new Date().toLocaleString();
  return `<!doctype html><html><head><meta charset="utf-8"><title>Test page</title><style>
    @page { margin: 0.5in }
    html { -webkit-print-color-adjust: exact; print-color-adjust: exact }
    body { margin: 0; font: 12pt/1.5 Inter, "DejaVu Sans", sans-serif; color: #111 }
    .frame { border: 2pt solid #111; border-radius: 12pt; padding: 28pt; height: calc(100vh - 60pt) }
    h1 { font-size: 30pt; margin: 0 0 6pt } p { margin: 0 0 16pt; color: #444 }
    .row { display: grid; grid-template-columns: repeat(9, 1fr); gap: 6pt; margin-bottom: 16pt }
    .row div { height: 44pt; border-radius: 6pt }
    .ramp { grid-template-columns: repeat(11, 1fr) } .ramp div { border: 0.5pt solid #999 }
    dl { display: grid; grid-template-columns: max-content 1fr; gap: 4pt 16pt; margin: 24pt 0 0 }
    dt { color: #666 } dd { margin: 0 }
  </style></head><body><div class="frame">
    <h1>Your printer works</h1>
    <p>This is a test page from Din. If the colors below are bright, the grey steps are even, and the frame is whole, everything is set up right.</p>
    <div class="row">${swatches}</div>
    <div class="row ramp">${ramp}</div>
    <dl><dt>Printer</dt><dd>${escapeHtml(printer)}</dd><dt>Printed</dt><dd>${escapeHtml(when)}</dd></dl>
  </div></body></html>`;
}

// ---------------------------------------------------------------------------
// IPC
// ---------------------------------------------------------------------------

function requireString(value: unknown, what: string): string {
  if (typeof value !== 'string' || !value || value.startsWith('-')) throw new Error(`No such ${what}.`);
  return value;
}

/** One dialog per page at a time, however often it calls print(). */
function hasDialog(contents: WebContents): boolean {
  return [...documents.values()].some((d) => d.owner === contents.id);
}

/** Tell the shell a page asked to print (window.print(), or Ctrl+P). */
export function requestPagePrint(contents: WebContents): void {
  if (hasDialog(contents)) return;
  const document = addDocument(contents.getTitle() || 'Untitled', { kind: 'page', contents }, contents.id);
  contents.once('destroyed', () => discard(document.id));
  sendToShell('printing:open', document);
}

export function registerPrintingHandlers(options: {
  assertShellSender: (event: Electron.IpcMainInvokeEvent) => void;
  sendToShell: (channel: string, payload?: unknown) => void;
  /** A <webview> guest of the shell, from a renderer-supplied id. */
  guestFromId: (wcId: unknown) => WebContents | null;
}): void {
  const { assertShellSender, guestFromId } = options;
  sendToShell = options.sendToShell;

  // print() from a page, through print-preload.cjs. A frame inside the page
  // prints just itself: what it shows, drawn again without its scripts.
  ipcMain.on('printing:request', (event, frame: unknown) => {
    const contents = event.sender;
    if (!guestFromId(contents.id)) return;
    if (hasDialog(contents)) return;
    const f = (frame ?? null) as { html?: unknown; baseUrl?: unknown; title?: unknown } | null;
    if (!f || typeof f.html !== 'string' || f.html.length > MAX_FRAME_HTML) {
      requestPagePrint(contents);
      return;
    }
    const baseUrl = typeof f.baseUrl === 'string' && /^https?:/.test(f.baseUrl) ? f.baseUrl : contents.getURL();
    const title = (typeof f.title === 'string' && f.title.trim()) || contents.getTitle() || 'Untitled';
    const document = addDocument(title, { kind: 'html', html: f.html, baseUrl }, contents.id);
    contents.once('destroyed', () => discard(document.id));
    sendToShell('printing:open', document);
  });

  // The shell started (or reloaded): any dialog it had is gone.
  ipcMain.handle('printing:reset', (event) => {
    assertShellSender(event);
    for (const id of [...documents.keys()]) discard(id);
  });

  ipcMain.handle('printing:state', async (event) => {
    assertShellSender(event);
    return state();
  });

  ipcMain.handle('printing:capabilities', async (event, printer: unknown) => {
    assertShellSender(event);
    return capabilities(requireString(printer, 'printer'));
  });

  ipcMain.handle('printing:openPage', (event, wcId: unknown) => {
    assertShellSender(event);
    const guest = guestFromId(wcId);
    if (!guest) throw new Error('That page was closed.');
    const document = addDocument(guest.getTitle() || 'Untitled', { kind: 'page', contents: guest });
    guest.once('destroyed', () => discard(document.id));
    return document;
  });

  ipcMain.handle('printing:openFile', (event, file: unknown) => {
    assertShellSender(event);
    if (typeof file !== 'string' || !path.isAbsolute(file)) throw new Error('No such file.');
    const type = printableKind(file);
    if (!type) throw new Error('Din can’t print this kind of file.');
    if (!fs.statSync(file).isFile()) throw new Error('No such file.');
    return addDocument(path.basename(file), { kind: 'file', path: file, type });
  });

  ipcMain.handle('printing:preview', async (event, id: unknown, layout: unknown) => {
    assertShellSender(event);
    const document = documents.get(requireString(id, 'document'));
    if (!document) throw new Error('Nothing to print.');
    return previewPdf(await pdfFor(id as string, document, printLayout(layout)));
  });

  ipcMain.handle('printing:print', async (event, id: unknown, layout: unknown, job: unknown) => {
    assertShellSender(event);
    const doc = requireString(id, 'document');
    const jobId = await print(doc, printLayout(layout), jobOptions(job));
    discard(doc);
    return jobId;
  });

  ipcMain.handle('printing:savePdf', async (event, id: unknown, layout: unknown, target: unknown) => {
    assertShellSender(event);
    const doc = requireString(id, 'document');
    const document = documents.get(doc);
    if (!document) throw new Error('Nothing to print.');
    if (typeof target !== 'string' || !path.isAbsolute(target)) throw new Error('Choose where to save it.');
    fs.copyFileSync(await pdfFor(doc, document, printLayout(layout)), target);
    discard(doc);
  });

  ipcMain.handle('printing:close', (event, id: unknown) => {
    assertShellSender(event);
    if (typeof id === 'string') discard(id);
  });

  ipcMain.handle('printing:cancelJob', async (event, job: unknown) => {
    assertShellSender(event);
    await cups('cancel', [requireString(job, 'job')]).catch((error) => {
      throw explain(error);
    });
    tracked.delete(job as string);
  });

  ipcMain.handle('printing:setDefault', async (event, printer: unknown) => {
    assertShellSender(event);
    await cups('lpoptions', ['-d', requireString(printer, 'printer')]).catch((error) => {
      throw explain(error);
    });
  });

  ipcMain.handle('printing:testPage', async (event, printer: unknown) => {
    assertShellSender(event);
    const name = requireString(printer, 'printer');
    const current = await state();
    const shown = current.printers.find((p) => p.name === name)?.displayName ?? name;
    const document = addDocument('Test page', { kind: 'html', html: testPageHtml(shown) });
    try {
      const capabilitiesNow = await capabilities(name);
      const paper = capabilitiesNow.defaultPaper ?? 'Letter';
      return await print(document.id, { landscape: false, paper, background: true }, {
        printer: name,
        copies: 1,
        pages: null,
        twoSided: false,
        color: null,
        paper,
      });
    } finally {
      discard(document.id);
    }
  });

  // A printer CUPS stopped after an error, or someone paused, starts again.
  ipcMain.handle('printing:resume', async (event, printer: unknown) => {
    assertShellSender(event);
    const name = requireString(printer, 'printer');
    try {
      await cups('cupsenable', [name]);
      await cups('cupsaccept', [name]);
    } catch (error) {
      throw explain(error);
    }
  });

  ipcMain.handle('printing:remove', async (event, printer: unknown) => {
    assertShellSender(event);
    await cups('lpadmin', ['-x', requireString(printer, 'printer')]).catch((error) => {
      throw explain(error);
    });
  });

  ipcMain.handle('printing:discover', async (event) => {
    assertShellSender(event);
    return discover();
  });

  ipcMain.handle('printing:add', async (event, uri: unknown) => {
    assertShellSender(event);
    return addPrinter(requireString(uri, 'printer'));
  });
}

export function cleanUpPrinting(): void {
  if (tempDir) fs.rmSync(tempDir, { recursive: true, force: true });
  tempDir = null;
}
