// Din as nostrd's approver: programs asking to sign as the user.
//
// On DinOS nostrd runs with an approver (services.nostrd.approverUnit,
// os/configuration.nix): a program of the user's that isn't Din - ngit in
// the Terminal, a script the Assistant runs, nak - has to be allowed before
// nostrd signs, encrypts or decrypts for it, or changes the accounts. nostrd
// trusts only Din's main process to answer (the one child of din-shell's
// compositor, which nothing else the user runs can become), sends it each
// request (approval_request) over the connection electron/nostrd.mts keeps,
// and waits for `approve`.
//
// nostrd only enforces; this decides. It reads who's asking from /proc, which
// it can as the same user, after checking the process is the one that
// connected (its start time, which nostrd read through a pidfd):
//
// - Din Drive, the system's din-drive run by the user's systemd (its mount)
//   or by Din itself (`din-drive init`, electron/drive.mts), is let through
//   for what a drive does: signing its own kinds and NIP-44 to the account
//   itself. Anything running as the user can read ~/Drive anyway, so letting
//   something that passes for it do that gives little. Nothing else Din
//   starts is let through for being Din's: the Assistant's OpenCode server
//   is one of them.
// - What the user allowed "until it quits" (a process, by pid and start
//   time), "for this conversation" (an Assistant conversation, while its
//   OpenCode server runs, as sudo's grants are), or "always" (a program and
//   what it may do, as sites' grants are kept: signing per kind, encrypting
//   and decrypting per method, or all of that at once, ANY: "Always allow
//   ngit").
// - Everything else is asked, from a notification that opens the desktop's
//   prompt (ProgramSignerHost). Spending bitcoin and changing the accounts
//   are asked every time.
//
// "Always" rules are kept in nostrd (approver_get_state/approver_set_state),
// which only this process can read or write: anywhere the user's files are,
// the programs they're about could add a rule for themselves.
//
// A program is named for an "always" rule by what it runs: one of the
// system's programs (in /run/current-system/sw/bin) by its name, so the rule
// survives updates, and anything else by its path. A script is named by the
// script, not its interpreter, and one with no script file (node -e) can't
// be allowed always. None of this stops a program of the user's that starts
// one that's allowed and traces it (ptrace lets a parent do that), so the
// prompt shows the whole command.
//
// Runs as TypeScript directly via Node's native type stripping - erasable
// syntax only, like the rest of electron/.

import fs from 'node:fs';
import path from 'node:path';
import { ipcMain } from 'electron';

type Reply = { result: unknown } | { error: { code: number; message: string } };

/** What nostrd sends (its README, "Approval"). */
interface NostrdApprovalRequest {
  id: string;
  uid: number;
  pid: number | null;
  pid_start: number | null;
  client: string | null;
  method: string;
  params: unknown[];
  account: string | null;
}

/** What the desktop shows (src/lib/programSigner.ts). */
export interface ProgramSignerRequest {
  requestId: number;
  /** The program, by name: "ngit", "nak", "sync.py". */
  program: string;
  /** Where it runs from, for the user to tell it from another of the name. */
  path: string;
  /** What it was started from: "Assistant", "Terminal", or another program. */
  via: string | null;
  /** Its command line. */
  command: string;
  /** The name the program gave itself, if any (nostrd's hello). */
  client: string | null;
  /** nostrd's method: sign_event, nip44_decrypt, sign_psbt, set_active... */
  method: string;
  params: unknown[];
  /** The account it would use (hex). */
  account: string | null;
  /** sign_event's kind. */
  kind: number | null;
  /** Whether "Always allow" this kind (or method) is offered. */
  canAlways: boolean;
  /** Whether "Always allow" the program is offered: signing, encrypting and decrypting anything. */
  canAlwaysProgram: boolean;
  /** Whether "Until it quits" is offered. */
  canProcess: boolean;
  /** Whether "For this conversation" is offered: an Assistant conversation's. */
  canConversation: boolean;
}

export type ProgramSignerAnswer = 'once' | 'process' | 'conversation' | 'always' | 'program' | 'deny';

/** A program allowed always (Settings → Connected apps). */
export interface ProgramGrant {
  /** What it's called. */
  name: string;
  /** Where it was running from when allowed. */
  path: string;
  /** nostrd methods allowed, other than sign_event; ANY for everything in SIGNING. */
  methods: string[];
  /** sign_event, by kind. */
  kinds: number[];
  /** Unix ms. */
  createdAt: number;
  lastUsed: number;
}

interface State {
  version: 1;
  programs: Record<string, ProgramGrant>;
}

interface Client {
  pid: number;
  start: string;
  exe: string;
  argv: string[];
  name: string;
  /** The "always" rule's key, or null when it can't have one. */
  key: string | null;
  label: string;
  via: string | null;
  sessionID: string | null;
  /** The OpenCode server above it: pid and start time. */
  server: { pid: number; start: string } | null;
}

interface Pending {
  nostrdId: string;
  request: ProgramSignerRequest;
  nostrd: NostrdApprovalRequest;
  client: Client;
}

interface Options {
  call: (method: string, params: unknown[]) => Promise<Reply>;
  sendToShell: (channel: string, payload?: unknown) => void;
  assertShellSender: (event: Electron.IpcMainInvokeEvent) => void;
}

const SYSTEM_BIN = '/run/current-system/sw/bin';
const SESSION_ID = /^ses_[A-Za-z0-9]{1,64}$/;
const HEX64 = /^[0-9a-f]{64}$/;
/** Runs a script it's given; the script is the program. */
const INTERPRETER = /^(node|bun|deno|python[0-9.]*|perl[0-9.]*|ruby[0-9.]*|php[0-9.]*|lua[0-9.]*|bash|sh|zsh|dash|fish)$/;
const SHELLS = new Set(['sh', 'bash', 'zsh', 'dash', 'fish', 'env', 'timeout', 'nohup']);
/** What Din Drive signs (din-drive's src/model.rs): nodes, keys, info, versions, Blossom auth. */
const DRIVE_KINDS = new Set([30440, 30441, 30442, 1440, 24242]);
const SIGNING = new Set(['sign_event', 'nip04_encrypt', 'nip04_decrypt', 'nip44_encrypt', 'nip44_decrypt']);
/** In a grant's methods: everything in SIGNING, of any kind ("Always allow ngit"). */
const ANY = '*';
/** Each one is asked: different money, or a different account, each time. */
const EVERY_TIME = new Set(['sign_psbt', 'generate_account', 'import_account', 'set_active', 'set_password']);
const CHECK_GONE_MS = 3000;
const SAVE_DELAY_MS = 30_000;

let options: Options | null = null;
let state: State = { version: 1, programs: {} };
let stateLoaded = false;
let saveTimer: NodeJS.Timeout | null = null;
let goneTimer: NodeJS.Timeout | null = null;
let nextId = 1;
const pending = new Map<number, Pending>();
/** Processes allowed until they quit: "pid:start". */
const processGrants = new Set<string>();
/** Conversations allowed while their server runs: session id → server. */
const sessionGrants = new Map<string, { pid: number; start: string }>();

function statOf(pid: number): string[] {
  try {
    const stat = fs.readFileSync(`/proc/${pid}/stat`, 'utf8');
    return stat.slice(stat.lastIndexOf(')') + 2).split(' ');
  } catch {
    return [];
  }
}

function parentOf(pid: number): number {
  return Number(statOf(pid)[1]) || 0;
}

function startOf(pid: number): string {
  return statOf(pid)[19] ?? '';
}

function argvOf(pid: number): string[] {
  try {
    return fs.readFileSync(`/proc/${pid}/cmdline`, 'utf8').split('\0').filter((arg, i, all) => arg || i < all.length - 1);
  } catch {
    return [];
  }
}

function nameOf(pid: number): string {
  try {
    return fs.readFileSync(`/proc/${pid}/comm`, 'utf8').trim();
  } catch {
    return '';
  }
}

function realpath(file: string): string | null {
  try {
    return fs.realpathSync(file);
  } catch {
    return null;
  }
}

function environ(pid: number, name: string): string | null {
  try {
    const prefix = `${name}=`;
    const entry = fs.readFileSync(`/proc/${pid}/environ`, 'utf8').split('\0').find((e) => e.startsWith(prefix));
    return entry ? entry.slice(prefix.length) : null;
  } catch {
    return null;
  }
}

function ancestors(pid: number): { pid: number; start: string; name: string; argv: string[] }[] {
  const list = [];
  for (let at = parentOf(pid), steps = 0; at > 1 && steps < 64; at = parentOf(at), steps++) {
    list.push({ pid: at, start: startOf(at), name: nameOf(at), argv: argvOf(at) });
  }
  return list;
}

function quote(arg: string): string {
  return /^[\w@%+=:,./-]+$/.test(arg) ? arg : `'${arg.replace(/'/g, `'\\''`)}'`;
}

/** The system program `exe` is, by name, if it's one. */
function systemName(exe: string, argv0: string): string | null {
  const candidates = new Set([path.basename(exe), path.basename(argv0), path.basename(exe).replace(/^\.(.+)-wrapped$/, '$1')]);
  for (const name of candidates) {
    if (name && !name.includes('/') && realpath(path.join(SYSTEM_BIN, name)) === exe) return name;
  }
  return null;
}

/** A program as an "always" rule names it, and in words. */
function programKey(pid: number, exe: string, argv: string[]): { key: string | null; label: string; shown: string } {
  const system = systemName(exe, argv[0] ?? '');
  if (INTERPRETER.test(path.basename(exe))) {
    const script = argv.slice(1).find((arg) => !arg.startsWith('-'));
    const interpreter = system ?? exe;
    if (!script || argv.slice(1).some((arg) => arg === '-c' || arg === '-e' || arg === '--eval')) {
      return { key: null, label: system ?? path.basename(exe), shown: exe };
    }
    const file = realpath(path.resolve(realpath(`/proc/${pid}/cwd`) ?? '/', script));
    if (!file) return { key: null, label: path.basename(script), shown: script };
    return { key: `script:${interpreter}:${file}`, label: path.basename(file), shown: file };
  }
  if (system) return { key: `system:${system}`, label: system, shown: path.join(SYSTEM_BIN, system) };
  return { key: `path:${exe}`, label: path.basename(exe), shown: exe };
}

/**
 * What started it, in words: the Assistant or the Terminal anywhere above
 * it, or else the first program above that isn't a shell.
 */
function viaOf(above: { name: string; argv: string[] }[]): string | null {
  if (above.some((p) => p.name === 'opencode' || path.basename(p.argv[0] ?? '') === 'opencode')) return 'Assistant';
  if (above.some((p) => p.argv.some((arg) => path.basename(arg) === 'pty-host.py'))) return 'Terminal';
  const first = above.find((p) => !SHELLS.has(p.name) && p.name !== 'systemd' && p.name !== 'electron');
  return first ? first.name : null;
}

/** Who's asking, as /proc has it, or null if it isn't the process that connected. */
function identify(request: NostrdApprovalRequest): Client | null {
  const { pid, pid_start: start } = request;
  if (!pid || start === null || startOf(pid) !== String(start)) return null;
  let exe: string;
  try {
    exe = fs.readlinkSync(`/proc/${pid}/exe`);
  } catch {
    return null;
  }
  const argv = argvOf(pid);
  const { key, label, shown } = programKey(pid, exe, argv);
  const above = ancestors(pid);
  const server = above.find((p) => p.name === 'opencode' || path.basename(p.argv[0] ?? '') === 'opencode');
  const session = environ(pid, 'OPENCODE_SESSION_ID');
  const via = viaOf(above);
  // Still the one that connected, now that everything's read.
  if (startOf(pid) !== String(start)) return null;
  return {
    pid,
    start: String(start),
    exe: shown,
    argv,
    name: label,
    key,
    label,
    via,
    sessionID: server && session && SESSION_ID.test(session) ? session : null,
    server: server ? { pid: server.pid, start: server.start } : null,
  };
}

function kindOf(request: NostrdApprovalRequest): number | null {
  if (request.method !== 'sign_event') return null;
  let event = request.params[0];
  if (typeof event === 'string') {
    try {
      event = JSON.parse(event);
    } catch {
      return null;
    }
  }
  const kind = typeof event === 'object' && event !== null ? (event as { kind?: unknown }).kind : undefined;
  return typeof kind === 'number' && Number.isInteger(kind) && kind >= 0 && kind <= 65535 ? kind : null;
}

/** Din Drive: the system's din-drive, run by the user's systemd or by Din. */
function isDrive(client: Client): boolean {
  if (client.key !== 'system:din-drive') return false;
  const parent = parentOf(client.pid);
  return parent === process.pid || (nameOf(parent) === 'systemd' && parentOf(parent) === 1);
}

function driveMayDo(request: NostrdApprovalRequest, kind: number | null): boolean {
  if (request.method === 'sign_event') return kind !== null && DRIVE_KINDS.has(kind);
  if (request.method === 'nip44_encrypt' || request.method === 'nip44_decrypt') {
    return typeof request.params[0] === 'string' && request.account !== null && request.params[0] === request.account;
  }
  return false;
}

function ruleCovers(grant: ProgramGrant | undefined, method: string, kind: number | null): boolean {
  if (!grant || EVERY_TIME.has(method)) return false;
  if (grant.methods.includes(ANY) && SIGNING.has(method)) return true;
  return method === 'sign_event' ? kind !== null && grant.kinds.includes(kind) : grant.methods.includes(method);
}

function sessionAllowed(client: Client): boolean {
  if (!client.sessionID || !client.server) return false;
  const granted = sessionGrants.get(client.sessionID);
  if (!granted) return false;
  if (startOf(granted.pid) !== granted.start) {
    sessionGrants.delete(client.sessionID);
    return false;
  }
  return granted.pid === client.server.pid && granted.start === client.server.start;
}

/** What to do without asking: allow, or ask. */
function decide(client: Client, request: NostrdApprovalRequest, kind: number | null): 'allow' | 'ask' {
  if (isDrive(client) && driveMayDo(request, kind)) return 'allow';
  if (EVERY_TIME.has(request.method)) return 'ask';
  if (SIGNING.has(request.method)) {
    if (processGrants.has(`${client.pid}:${client.start}`)) return 'allow';
    if (sessionAllowed(client)) return 'allow';
  }
  const grant = client.key ? state.programs[client.key] : undefined;
  if (ruleCovers(grant, request.method, kind)) {
    grant!.lastUsed = Date.now();
    scheduleSave();
    return 'allow';
  }
  return 'ask';
}

function answerNostrd(id: string, allow: boolean): void {
  void options?.call('approve', [id, allow ? 'allow' : 'deny']).catch(() => {});
}

async function loadState(): Promise<void> {
  const reply = await options?.call('approver_get_state', []);
  if (!reply || 'error' in reply) return;
  const value = reply.result as Partial<State> | null;
  if (value && value.version === 1 && typeof value.programs === 'object' && value.programs) {
    const programs: Record<string, ProgramGrant> = {};
    for (const [key, grant] of Object.entries(value.programs)) {
      if (!grant || typeof grant.name !== 'string') continue;
      programs[key] = {
        name: grant.name,
        path: typeof grant.path === 'string' ? grant.path : '',
        methods: Array.isArray(grant.methods) ? grant.methods.filter((m): m is string => typeof m === 'string') : [],
        kinds: Array.isArray(grant.kinds) ? grant.kinds.filter((k): k is number => Number.isInteger(k)) : [],
        createdAt: Number(grant.createdAt) || Date.now(),
        lastUsed: Number(grant.lastUsed) || 0,
      };
    }
    state = { version: 1, programs };
  }
  stateLoaded = true;
}

async function saveState(): Promise<void> {
  if (saveTimer) {
    clearTimeout(saveTimer);
    saveTimer = null;
  }
  // Never over rules not read yet.
  if (!stateLoaded) return;
  await options?.call('approver_set_state', [state]);
}

function scheduleSave(): void {
  if (saveTimer) return;
  saveTimer = setTimeout(() => void saveState().catch(() => {}), SAVE_DELAY_MS);
  saveTimer.unref();
}

function grantsChanged(): void {
  options?.sendToShell('programSigner:grants');
}

function settle(requestId: number, allow: boolean): void {
  const entry = pending.get(requestId);
  if (!entry) return;
  pending.delete(requestId);
  answerNostrd(entry.nostrdId, allow);
  options?.sendToShell('programSigner:cancel', { requestId });
  stopCheckingIfIdle();
}

function stopCheckingIfIdle(): void {
  if (pending.size === 0 && goneTimer) {
    clearInterval(goneTimer);
    goneTimer = null;
  }
}

/** Settle what a new grant now covers. */
function recheckPending(): void {
  for (const [requestId, entry] of pending) {
    if (decide(entry.client, entry.nostrd, entry.request.kind) === 'allow') settle(requestId, true);
  }
}

/** Decline what's waiting on a process that's gone: nobody's there for the answer. */
function checkGone(): void {
  for (const [requestId, entry] of pending) {
    if (startOf(entry.client.pid) !== entry.client.start) settle(requestId, false);
  }
}

/** A request from nostrd (electron/nostrd.mts). */
export function onApprovalRequest(raw: unknown): void {
  const request = parseRequest(raw);
  if (!request) return;
  if (request.uid !== process.getuid?.()) {
    answerNostrd(request.id, false);
    return;
  }
  const client = identify(request);
  if (!client) {
    answerNostrd(request.id, false);
    return;
  }
  const kind = kindOf(request);
  if (decide(client, request, kind) === 'allow') {
    answerNostrd(request.id, true);
    return;
  }
  const requestId = nextId++;
  const shown: ProgramSignerRequest = {
    requestId,
    program: client.name,
    path: client.exe,
    via: client.via,
    command: client.argv.map(quote).join(' '),
    client: request.client,
    method: request.method,
    params: request.params,
    account: request.account,
    kind,
    canAlways: client.key !== null && !EVERY_TIME.has(request.method) && (request.method !== 'sign_event' || kind !== null),
    canAlwaysProgram: client.key !== null && SIGNING.has(request.method),
    canProcess: SIGNING.has(request.method),
    canConversation: SIGNING.has(request.method) && client.sessionID !== null,
  };
  pending.set(requestId, { nostrdId: request.id, request: shown, nostrd: request, client });
  goneTimer ??= setInterval(checkGone, CHECK_GONE_MS);
  options?.sendToShell('programSigner:request', shown);
}

/** nostrd stopped waiting (it timed out). */
export function onApprovalCancelled(id: unknown): void {
  for (const [requestId, entry] of pending) {
    if (entry.nostrdId === id) {
      pending.delete(requestId);
      options?.sendToShell('programSigner:cancel', { requestId });
    }
  }
  stopCheckingIfIdle();
}

/** The connection to nostrd closed: nothing waiting can be answered now. */
export function onApproverGone(): void {
  for (const requestId of [...pending.keys()]) {
    pending.delete(requestId);
    options?.sendToShell('programSigner:cancel', { requestId });
  }
  stopCheckingIfIdle();
}

/** Registered as nostrd's approver: read the rules. */
export function onApproverRegistered(): void {
  void loadState()
    .then(grantsChanged)
    .catch(() => {});
}

function parseRequest(raw: unknown): NostrdApprovalRequest | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const r = raw as Record<string, unknown>;
  if (typeof r.id !== 'string' || typeof r.method !== 'string' || typeof r.uid !== 'number') return null;
  return {
    id: r.id,
    uid: r.uid,
    pid: typeof r.pid === 'number' ? r.pid : null,
    pid_start: typeof r.pid_start === 'number' ? r.pid_start : null,
    client: typeof r.client === 'string' ? r.client.slice(0, 64) : null,
    method: r.method,
    params: Array.isArray(r.params) ? r.params : [],
    account: typeof r.account === 'string' && HEX64.test(r.account) ? r.account : null,
  };
}

function answer(requestId: unknown, decision: unknown): void {
  const entry = typeof requestId === 'number' ? pending.get(requestId) : undefined;
  if (!entry) return;
  const { request, client } = entry;
  switch (decision) {
    case 'once':
      settle(requestId as number, true);
      return;
    case 'deny':
      settle(requestId as number, false);
      return;
    case 'process':
      if (!request.canProcess) return;
      processGrants.add(`${client.pid}:${client.start}`);
      break;
    case 'conversation':
      if (!request.canConversation || !client.sessionID || !client.server) return;
      sessionGrants.set(client.sessionID, client.server);
      break;
    case 'always':
    case 'program': {
      if (!client.key || !(decision === 'program' ? request.canAlwaysProgram : request.canAlways)) return;
      const now = Date.now();
      const grant = state.programs[client.key] ?? { name: client.name, path: client.exe, methods: [], kinds: [], createdAt: now, lastUsed: now };
      if (decision === 'program') {
        // Everything it signs, encrypts and decrypts: the narrower rules ANY covers go.
        grant.methods = [ANY, ...grant.methods.filter((m) => !SIGNING.has(m) && m !== ANY)];
        grant.kinds = [];
      } else if (request.method === 'sign_event' && request.kind !== null) {
        if (!grant.kinds.includes(request.kind)) grant.kinds.push(request.kind);
      } else if (!grant.methods.includes(request.method)) {
        grant.methods.push(request.method);
      }
      grant.lastUsed = now;
      state.programs[client.key] = grant;
      void saveState().catch(() => {});
      grantsChanged();
      break;
    }
    default:
      return;
  }
  settle(requestId as number, true);
  recheckPending();
}

/** Forget a program, or one thing it may do (`kind` for sign_event). */
function revoke(key: unknown, method?: unknown, kind?: unknown): boolean {
  if (typeof key !== 'string' || !state.programs[key]) return false;
  if (method === undefined || method === null) {
    delete state.programs[key];
  } else {
    const grant = state.programs[key];
    if (method === 'sign_event' && typeof kind === 'number') grant.kinds = grant.kinds.filter((k) => k !== kind);
    else if (typeof method === 'string') grant.methods = grant.methods.filter((m) => m !== method);
    if (grant.kinds.length === 0 && grant.methods.length === 0) delete state.programs[key];
  }
  void saveState().catch(() => {});
  grantsChanged();
  return true;
}

/** Forget a conversation's grant (it was deleted), or every one. */
export function revokeSignerSession(sessionID?: string): void {
  if (sessionID === undefined) sessionGrants.clear();
  else sessionGrants.delete(sessionID);
}

export function registerProgramSigner(opts: Options): void {
  options = opts;
  ipcMain.handle('programSigner:pending', (event): ProgramSignerRequest[] => {
    opts.assertShellSender(event);
    return [...pending.values()].map((entry) => entry.request);
  });
  ipcMain.handle('programSigner:answer', (event, requestId: unknown, decision: unknown) => {
    opts.assertShellSender(event);
    answer(requestId, decision);
  });
  ipcMain.handle('programSigner:grants', (event): { available: boolean; programs: Record<string, ProgramGrant> } => {
    opts.assertShellSender(event);
    return { available: stateLoaded, programs: state.programs };
  });
  ipcMain.handle('programSigner:revoke', (event, key: unknown, method: unknown, kind: unknown) => {
    opts.assertShellSender(event);
    return revoke(key, method, kind);
  });
}
