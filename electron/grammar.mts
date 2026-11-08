// Grammar checking as you type, in every text field on Din: the desktop's,
// built-in apps', widgets' and web pages' (private tabs too; Tor's none, as
// anything a page could notice there sets its visitors apart).
//
// grammar-preload.cjs, in every frame, sends a focused field's text here
// and underlines what comes back; grammar-worker.mts checks it with Harper,
// on this computer. Right-clicking an underline puts its fixes at the top of
// the field's menu (`grammarMenuItems`), the way spelling's are: the preload
// says which issue is under the pointer as the menu opens, and choosing a fix
// sends the replacement back to that frame, which makes it as typing would.
//
// Spelling stays Chromium's. The settings (Settings → Keyboard, `din
// grammar`) live in userData/grammar.json, with the issues the user chose to
// ignore beside it in Harper's own format.
//
// Runs as TypeScript directly via Node's native type stripping - erasable
// syntax only, like the rest of electron/.

import fs from 'node:fs';
import path from 'node:path';
import { Worker } from 'node:worker_threads';
import { app, ipcMain, MenuItem, webContents, type Session, type WebContents, type WebFrameMain } from 'electron';
import type { GrammarDialect, GrammarIssue, WorkerOptions, WorkerRequest } from './grammar-worker.mts';

export type { GrammarDialect, GrammarIssue };

export interface GrammarSettings {
  /** Underline grammar as you type. */
  enabled: boolean;
  /** Style suggestions too: wordiness, redundancy, readability. */
  style: boolean;
  dialect: GrammarDialect;
  /** Rules turned off from a menu's Turn Off This Rule, by Harper's name. */
  disabledRules: string[];
}

export interface GrammarRule {
  name: string;
  description: string;
}

export interface GrammarState extends GrammarSettings {
  /** How many issues the user chose to ignore. */
  ignored: number;
  /** The turned-off rules, with what each looks for. */
  disabledRuleInfo: GrammarRule[];
}

/** What a field's preload gets back for each issue: enough to underline it. */
export interface GrammarMark {
  start: number;
  end: number;
  text: string;
  hash: string;
}

const PRELOAD = path.join(import.meta.dirname, 'grammar-preload.cjs');
const WORKER = path.join(import.meta.dirname, `grammar-worker${path.extname(import.meta.filename)}`);

const DIALECTS: GrammarDialect[] = ['american', 'british', 'australian', 'canadian', 'indian'];
const DEFAULTS: GrammarSettings = { enabled: true, style: true, dialect: 'american', disabledRules: [] };

/** Longer than this, a field isn't checked: a whole book in a text area. */
const MAX_TEXT = 60_000;
/** The worker stops after this long unused, giving its memory back. */
const IDLE_MS = 10 * 60_000;
/** How long a right-click's report waits for its menu. */
const CONTEXT_MS = 2_000;
/** Issues remembered per page, for the menu to look them up by hash. */
const MAX_REMEMBERED = 4_000;

function settingsFile(): string {
  return path.join(app.getPath('userData'), 'grammar.json');
}

function ignoredFile(): string {
  return path.join(app.getPath('userData'), 'grammar-ignored.json');
}

function validDialect(value: unknown): value is GrammarDialect {
  return typeof value === 'string' && (DIALECTS as string[]).includes(value);
}

function validRule(value: unknown): value is string {
  return typeof value === 'string' && /^[A-Za-z0-9_]{1,80}$/.test(value);
}

function readSettings(): GrammarSettings {
  try {
    const raw = JSON.parse(fs.readFileSync(settingsFile(), 'utf8')) as Partial<GrammarSettings>;
    return {
      enabled: typeof raw.enabled === 'boolean' ? raw.enabled : DEFAULTS.enabled,
      style: typeof raw.style === 'boolean' ? raw.style : DEFAULTS.style,
      dialect: validDialect(raw.dialect) ? raw.dialect : DEFAULTS.dialect,
      disabledRules: Array.isArray(raw.disabledRules) ? raw.disabledRules.filter(validRule) : [],
    };
  } catch {
    return { ...DEFAULTS };
  }
}

function readIgnored(): string | null {
  try {
    return fs.readFileSync(ignoredFile(), 'utf8');
  } catch {
    return null;
  }
}

function writeFile(file: string, contents: string): void {
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(`${file}.tmp`, contents);
    fs.renameSync(`${file}.tmp`, file);
  } catch (error) {
    console.error('grammar: could not save', file, error);
  }
}

let settings: GrammarSettings | null = null;

function current(): GrammarSettings {
  settings ??= readSettings();
  return settings;
}

function ignoredCount(json: string | null): number {
  if (!json) return 0;
  try {
    const parsed = JSON.parse(json) as { context_hashes?: unknown };
    return Array.isArray(parsed.context_hashes) ? parsed.context_hashes.length : 0;
  } catch {
    return 0;
  }
}

// ---------------------------------------------------------------------------
// The worker
// ---------------------------------------------------------------------------

type Pending = { resolve: (value: unknown) => void; reject: (error: Error) => void };
type RequestBody = WorkerRequest extends infer R ? (R extends WorkerRequest ? Omit<R, 'id'> : never) : never;

let worker: Worker | null = null;
let nextId = 1;
const pending = new Map<number, Pending>();
let idleTimer: NodeJS.Timeout | null = null;

function workerOptions(): WorkerOptions {
  const { dialect, style, disabledRules } = current();
  return { dialect, style, disabledRules, ignored: readIgnored() };
}

function startWorker(): Worker {
  const started = new Worker(WORKER);
  started.on('message', (message: { id: number; result?: unknown; error?: string }) => {
    const waiting = pending.get(message.id);
    if (!waiting) return;
    pending.delete(message.id);
    if (message.error !== undefined) waiting.reject(new Error(message.error));
    else waiting.resolve(message.result);
  });
  const fail = (error: Error) => {
    if (worker === started) worker = null;
    for (const waiting of pending.values()) waiting.reject(error);
    pending.clear();
  };
  started.on('error', (error) => {
    console.error('grammar: the checker failed:', error);
    fail(error);
  });
  started.on('exit', () => fail(new Error('The grammar checker stopped')));
  // Its first job, which everything after waits behind.
  post(started, { type: 'configure', options: workerOptions() }).catch(() => {});
  return started;
}

function post(target: Worker, body: RequestBody): Promise<unknown> {
  const id = nextId++;
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
    target.postMessage({ ...body, id });
  });
}

function request<T>(body: RequestBody): Promise<T> {
  worker ??= startWorker();
  if (idleTimer) clearTimeout(idleTimer);
  idleTimer = setTimeout(() => {
    idleTimer = null;
    const stopping = worker;
    worker = null;
    void stopping?.terminate();
  }, IDLE_MS);
  return post(worker, body) as Promise<T>;
}

/** Tell a running worker the settings changed; one started later reads them itself. */
async function reconfigure(): Promise<void> {
  if (worker) await request({ type: 'configure', options: workerOptions() });
}

export async function checkText(text: string): Promise<GrammarIssue[]> {
  if (text.length > MAX_TEXT || !text.trim()) return [];
  return request<GrammarIssue[]>({ type: 'lint', text });
}

export async function rules(): Promise<GrammarRule[]> {
  return request<GrammarRule[]>({ type: 'rules' });
}

export async function grammarState(): Promise<GrammarState> {
  const s = current();
  const all = s.disabledRules.length ? await rules() : [];
  return {
    ...s,
    disabledRules: [...s.disabledRules],
    ignored: ignoredCount(readIgnored()),
    disabledRuleInfo: s.disabledRules.map((name) => ({
      name,
      description: all.find((rule) => rule.name === name)?.description ?? '',
    })),
  };
}

export async function configureGrammar(change: Partial<GrammarSettings>): Promise<GrammarState> {
  const next = { ...current() };
  if (typeof change.enabled === 'boolean') next.enabled = change.enabled;
  if (typeof change.style === 'boolean') next.style = change.style;
  if (change.dialect !== undefined) {
    if (!validDialect(change.dialect)) throw new Error(`No such dialect: ${String(change.dialect)}`);
    next.dialect = change.dialect;
  }
  if (change.disabledRules !== undefined) {
    if (!Array.isArray(change.disabledRules) || !change.disabledRules.every(validRule)) throw new Error('Invalid rules');
    next.disabledRules = [...new Set(change.disabledRules)];
  }
  settings = next;
  writeFile(settingsFile(), `${JSON.stringify(next, null, 2)}\n`);
  await reconfigure();
  refreshEverywhere();
  return grammarState();
}

/** Turn a rule off or back on, by Harper's name. */
export async function setRule(name: string, on: boolean): Promise<GrammarState> {
  if (!validRule(name)) throw new Error('Invalid rule');
  const known = await rules();
  if (!known.some((rule) => rule.name === name)) throw new Error(`No rule named ${name}`);
  const disabled = current().disabledRules.filter((rule) => rule !== name);
  return configureGrammar({ disabledRules: on ? disabled : [...disabled, name] });
}

async function ignore(hash: string): Promise<void> {
  const exported = await request<string>({ type: 'ignore', hash });
  writeFile(ignoredFile(), exported);
}

export async function forgetIgnored(): Promise<GrammarState> {
  try {
    fs.rmSync(ignoredFile(), { force: true });
  } catch {
    // Nothing to forget.
  }
  if (worker) await request({ type: 'clearIgnored' });
  refreshEverywhere();
  return grammarState();
}

// ---------------------------------------------------------------------------
// Pages
// ---------------------------------------------------------------------------

/** The issues each page was last told about, by hash, for its menu. */
const remembered = new Map<number, Map<string, GrammarIssue>>();
/** What a right-click in a page last reported, for the menu that follows. */
const contexts = new Map<number, { frame: WebFrameMain; token: number; issue: GrammarIssue; at: number }>();

function remember(contents: WebContents, issues: GrammarIssue[]): void {
  let known = remembered.get(contents.id);
  if (!known) {
    known = new Map();
    remembered.set(contents.id, known);
    contents.once('destroyed', () => {
      remembered.delete(contents.id);
      contexts.delete(contents.id);
    });
  }
  if (known.size + issues.length > MAX_REMEMBERED) known.clear();
  for (const issue of issues) known.set(issue.hash, issue);
}

/** Ask every page's fields to check again: the settings or what's ignored changed. */
function refreshEverywhere(): void {
  for (const contents of webContents.getAllWebContents()) {
    if (contents.isDestroyed()) continue;
    try {
      for (const frame of contents.mainFrame.framesInSubtree) frame.send('grammar:refresh');
    } catch {
      // A frame going away.
    }
  }
}

function sendToFrame(frame: WebFrameMain, channel: string, payload?: unknown): void {
  try {
    if (!frame.isDestroyed()) frame.send(channel, payload);
  } catch {
    // It went away.
  }
}

/** Menus and menu labels take & as a mnemonic marker. */
function menuText(text: string): string {
  return text.replace(/&/g, '&&');
}

/** Harper's message as a menu line: its `code` quoting as curly quotes, and not too long. */
function messageLine(message: string): string {
  const quoted = message.replace(/`([^`]*)`/g, '“$1”');
  return quoted.length > 90 ? `${quoted.slice(0, 89).trimEnd()}…` : quoted;
}

/**
 * The grammar part of a text field's right-click menu: the fixes for the
 * issue under the pointer, what's wrong, and ignoring it. Empty unless the
 * field's page said, as this menu opened, that there was one there.
 */
export function grammarMenuItems(contents: WebContents, params: Electron.ContextMenuParams): MenuItem[] {
  const context = contexts.get(contents.id);
  contexts.delete(contents.id);
  if (!context || !params.isEditable || Date.now() - context.at > CONTEXT_MS) return [];
  const { frame, token, issue } = context;
  const items: MenuItem[] = [];
  for (const suggestion of issue.suggestions) {
    items.push(
      new MenuItem({
        label: menuText(suggestion.label),
        click: () => sendToFrame(frame, 'grammar:apply', { token, replacement: suggestion.replacement }),
      }),
    );
  }
  items.push(new MenuItem({ label: menuText(messageLine(issue.message)), enabled: false }));
  items.push(new MenuItem({ type: 'separator' }));
  items.push(
    new MenuItem({
      label: 'Ignore',
      click: () => {
        ignore(issue.hash).then(
          () => sendToFrame(frame, 'grammar:refresh'),
          (error: unknown) => console.error('grammar: could not ignore:', error),
        );
      },
    }),
  );
  items.push(
    new MenuItem({
      label: 'Turn Off This Rule',
      click: () => {
        setRule(issue.rule, false).catch((error: unknown) => console.error('grammar: could not turn off a rule:', error));
      },
    }),
  );
  items.push(new MenuItem({ type: 'separator' }));
  return items;
}

/** Check fields in every frame of these sessions' pages. */
export function registerGrammarPreload(sessions: Session[]): void {
  for (const s of sessions) s.registerPreloadScript({ id: 'din-grammar', type: 'frame', filePath: PRELOAD });
}

export function registerGrammarHandlers(options: {
  assertShellSender: (event: Electron.IpcMainInvokeEvent) => void;
}): void {
  const { assertShellSender } = options;

  // From any frame's preload: a field's text, to underline what's wrong in it.
  ipcMain.handle('grammar:check', async (event, text: unknown): Promise<GrammarMark[] | null> => {
    if (!current().enabled || typeof text !== 'string') return null;
    const issues = await checkText(text);
    remember(event.sender, issues);
    return issues.map(({ start, end, text: problem, hash }) => ({ start, end, text: problem, hash }));
  });

  // From any frame's preload, synchronously as a right-click's menu opens:
  // the issue under the pointer, which the menu then offers fixes for. Only
  // ones this page was told about count, so a page can't put words of its
  // own in Din's menu.
  ipcMain.on('grammar:context', (event, report: unknown) => {
    event.returnValue = true;
    const { token, hash } = (report ?? {}) as { token?: unknown; hash?: unknown };
    const issue = typeof hash === 'string' ? remembered.get(event.sender.id)?.get(hash) : undefined;
    if (!issue || typeof token !== 'number' || !event.senderFrame) {
      contexts.delete(event.sender.id);
      return;
    }
    contexts.set(event.sender.id, { frame: event.senderFrame, token, issue, at: Date.now() });
  });

  // The desktop's: Settings → Keyboard and `din grammar`.
  ipcMain.handle('grammar:state', (event) => {
    assertShellSender(event);
    return grammarState();
  });
  ipcMain.handle('grammar:configure', (event, change: unknown) => {
    assertShellSender(event);
    if (!change || typeof change !== 'object') throw new Error('Invalid settings');
    return configureGrammar(change as Partial<GrammarSettings>);
  });
  ipcMain.handle('grammar:setRule', (event, name: unknown, on: unknown) => {
    assertShellSender(event);
    if (typeof name !== 'string' || typeof on !== 'boolean') throw new Error('Invalid rule');
    return setRule(name, on);
  });
  ipcMain.handle('grammar:rules', (event) => {
    assertShellSender(event);
    return rules();
  });
  ipcMain.handle('grammar:checkText', (event, text: unknown) => {
    assertShellSender(event);
    if (typeof text !== 'string') throw new Error('Invalid text');
    if (text.length > MAX_TEXT) throw new Error(`That’s too long to check (${MAX_TEXT.toLocaleString()} characters at most)`);
    return checkText(text);
  });
  ipcMain.handle('grammar:forgetIgnored', (event) => {
    assertShellSender(event);
    return forgetIgnored();
  });
}
