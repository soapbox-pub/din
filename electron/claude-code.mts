// Claude Code, for the assistant's Claude provider (OpenCode's built-in
// "Claude Agent", which runs the user's own `claude` through the Agent SDK
// and so their Claude plan). Settings → Assistant and the Assistant's Add
// provider do every step for the user: install Claude Code where it's
// missing, sign it in, and connect OpenCode to it.
//
// Claude Code is the user's install in ~/.local/bin, from Anthropic's
// installer, which updates itself, as OpenCode's does in ~/.opencode.
// Signing in is `claude auth login`, run here with no terminal: BROWSER
// names a little script that hands back the sign-in page, which the shell
// opens in Din's browser, and its redirect to Claude Code's own localhost
// listener finishes it. The page printed for other devices gives a code
// instead, which goes to the command's stdin. Din never hands a token on:
// the plan's usage (claudeUsage) reads Claude Code's sign-in here in main and
// sends it to Anthropic alone, as Claude Code's own /usage does, and only the
// percentages leave this process.
//
// Runs as TypeScript directly via Node's native type stripping - erasable
// syntax only, like the rest of electron/.

import { execFile, spawn, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const INSTALLER_URL = 'https://claude.ai/install.sh';
const INSTALL_DIR = path.join(os.homedir(), '.local/bin');
const INSTALL_TIMEOUT_MS = 10 * 60_000;
const LOGIN_TIMEOUT_MS = 15 * 60_000;
/** How long `claude auth login` has to say where to sign in. */
const LOGIN_URL_WAIT_MS = 15_000;

export interface ClaudeLogin {
  state: 'starting' | 'waiting' | 'done' | 'failed';
  /** The sign-in page, which comes back to this computer by itself. */
  url: string | null;
  /** The page for signing in elsewhere, which shows a code to paste. */
  codeUrl: string | null;
  message: string | null;
}

export interface ClaudeCodeStatus {
  /** Where `claude` is, or null where it isn't installed. */
  binary: string | null;
  version: string | null;
  loggedIn: boolean;
  /** Who it's signed in as, when it says. */
  account: string | null;
  installing: boolean;
  /** The sign-in under way or last finished, if any. */
  login: ClaudeLogin | null;
  error: string | null;
}

let installing: Promise<void> | null = null;
let login: ClaudeLogin | null = null;
let loginChild: ChildProcess | null = null;
let lastError: string | null = null;

function isExecutable(file: string): boolean {
  try {
    fs.accessSync(file, fs.constants.X_OK);
    return fs.statSync(file).isFile();
  } catch {
    return false;
  }
}

/** Claude Code's binary: OPENCODE_CLAUDE_PATH, else the user's install, else one on PATH. */
export function findClaude(): string | null {
  const named = process.env.OPENCODE_CLAUDE_PATH;
  if (named) return isExecutable(named) ? named : null;
  const installed = path.join(INSTALL_DIR, 'claude');
  if (isExecutable(installed)) return installed;
  for (const dir of (process.env.PATH ?? '').split(path.delimiter)) {
    if (!dir) continue;
    const candidate = path.join(dir, 'claude');
    if (isExecutable(candidate)) return candidate;
  }
  return null;
}

function stripAnsi(text: string): string {
  // eslint-disable-next-line no-control-regex
  return text.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '');
}

function lastLine(text: string): string {
  return stripAnsi(text).trim().split('\n').pop()?.trim() ?? '';
}

function capture(file: string, args: string[], env: NodeJS.ProcessEnv): Promise<{ code: number; stdout: string }> {
  return new Promise((resolve) => {
    execFile(file, args, { env, timeout: 15_000, maxBuffer: 1024 * 1024 }, (error, stdout) => {
      const code = error ? (typeof error.code === 'number' ? error.code : 1) : 0;
      resolve({ code, stdout });
    });
  });
}

/** Where Claude Code is, its version, and who it's signed in as. */
export async function claudeStatus(env: NodeJS.ProcessEnv): Promise<ClaudeCodeStatus> {
  const binary = findClaude();
  let version: string | null = null;
  let loggedIn = false;
  let account: string | null = null;
  if (binary) {
    const [ver, auth] = await Promise.all([capture(binary, ['--version'], env), capture(binary, ['auth', 'status'], env)]);
    version = /(\d+\.\d+\.\d+[\w.-]*)/.exec(ver.stdout)?.[1] ?? null;
    // It prints JSON either way, and exits 1 when signed out.
    try {
      const parsed = JSON.parse(auth.stdout) as Record<string, unknown>;
      loggedIn = parsed.loggedIn === true;
      const nested = typeof parsed.account === 'object' && parsed.account !== null ? (parsed.account as Record<string, unknown>) : {};
      const who = parsed.email ?? nested.email ?? nested.emailAddress ?? parsed.orgName;
      account = loggedIn && typeof who === 'string' ? who : null;
    } catch {
      loggedIn = false;
    }
  }
  if (loggedIn && login?.state === 'waiting') login = { ...login, state: 'done' };
  return { binary, version, loggedIn, account, installing: installing !== null, login, error: lastError };
}

/** Run Anthropic's installer, which puts `claude` in ~/.local/bin. */
export function installClaude(env: NodeJS.ProcessEnv): Promise<void> {
  installing ??= (async () => {
    lastError = null;
    try {
      await new Promise<void>((resolve, reject) => {
        const child = spawn('bash', ['-c', `curl -fsSL ${INSTALLER_URL} | bash`], { env, stdio: ['ignore', 'pipe', 'pipe'] });
        let tail = '';
        const keep = (chunk: Buffer) => {
          tail = (tail + chunk.toString()).slice(-2000);
        };
        child.stdout.on('data', keep);
        child.stderr.on('data', keep);
        const timer = setTimeout(() => child.kill('SIGTERM'), INSTALL_TIMEOUT_MS);
        child.on('error', (error) => {
          clearTimeout(timer);
          reject(error);
        });
        child.on('exit', (code) => {
          clearTimeout(timer);
          if (code === 0) resolve();
          else reject(new Error(lastLine(tail) || `Claude Code’s installer failed (${code})`));
        });
      });
      if (!findClaude()) throw new Error('Claude Code was installed but can’t be found');
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
      throw error;
    } finally {
      installing = null;
    }
  })();
  return installing;
}

/**
 * Start `claude auth login` for a Claude plan, resolving once it has said
 * where to sign in. An earlier sign-in still under way is stopped first.
 */
export async function startClaudeLogin(env: NodeJS.ProcessEnv): Promise<ClaudeLogin> {
  const binary = findClaude();
  if (!binary) throw new Error('Claude Code isn’t installed');
  cancelClaudeLogin();
  lastError = null;

  // BROWSER gets the sign-in page; this script writes it where it's read back.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'din-claude-login-'));
  const urlFile = path.join(dir, 'url');
  const script = path.join(dir, 'browser');
  fs.writeFileSync(script, '#!/bin/sh\nprintf \'%s\\n\' "$1" > "$DIN_CLAUDE_LOGIN_URL"\n', { mode: 0o700 });

  const current: ClaudeLogin = { state: 'starting', url: null, codeUrl: null, message: null };
  login = current;
  const child = spawn(binary, ['auth', 'login', '--claudeai'], {
    env: { ...env, BROWSER: script, DIN_CLAUDE_LOGIN_URL: urlFile },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  loginChild = child;
  // A later sign-in replaces `login`; this one's ending changes only its own.
  const set = (patch: Partial<ClaudeLogin>) => Object.assign(current, patch);

  let output = '';
  const read = (chunk: Buffer) => {
    output = (output + chunk.toString()).slice(-8000);
    const codeUrl = /visit:\s*(https:\/\/\S+)/.exec(stripAnsi(output))?.[1];
    if (codeUrl && !current.codeUrl) set({ codeUrl });
  };
  child.stdout?.on('data', read);
  child.stderr?.on('data', read);

  const timer = setTimeout(() => child.kill('SIGTERM'), LOGIN_TIMEOUT_MS);
  const cleanUp = () => {
    clearTimeout(timer);
    fs.rmSync(dir, { recursive: true, force: true });
    if (loginChild === child) loginChild = null;
  };
  child.on('error', (error) => {
    cleanUp();
    set({ state: 'failed', message: error.message });
  });
  child.on('exit', (code, signal) => {
    cleanUp();
    if (current.state === 'done' || current.state === 'failed') return;
    if (code === 0) set({ state: 'done', message: null });
    else {
      const said = stripAnsi(output).match(/Login failed:\s*(.+)/)?.[1]?.trim();
      set({
        state: 'failed',
        message: said || (signal ? 'The sign-in was stopped.' : lastLine(output) || `Claude Code couldn’t sign in (${code})`),
      });
    }
  });

  // Wait for the page to open: the script's, else the one printed for other devices.
  const deadline = Date.now() + LOGIN_URL_WAIT_MS;
  while (Date.now() < deadline && current.state === 'starting') {
    try {
      const url = fs.readFileSync(urlFile, 'utf8').trim();
      if (/^https:\/\//.test(url)) {
        set({ state: 'waiting', url });
        break;
      }
    } catch {
      // Not written yet.
    }
    if (current.codeUrl && Date.now() > deadline - LOGIN_URL_WAIT_MS / 2) {
      set({ state: 'waiting' });
      break;
    }
    await new Promise((resolve) => setTimeout(resolve, 150));
  }
  if (current.state === 'starting') {
    child.kill('SIGTERM');
    throw new Error('Claude Code didn’t say where to sign in');
  }
  if (current.state === 'failed') throw new Error(current.message ?? 'Claude Code couldn’t sign in');
  return { ...current };
}

/** Give the sign-in under way the code its page for other devices showed. */
export function sendClaudeLoginCode(code: string): void {
  const trimmed = code.trim();
  if (!trimmed || /[\r\n]/.test(trimmed)) throw new Error('That isn’t a sign-in code');
  if (!loginChild?.stdin || login?.state !== 'waiting') throw new Error('No sign-in is waiting for a code');
  loginChild.stdin.write(`${trimmed}\n`);
}

export function cancelClaudeLogin(): void {
  loginChild?.kill('SIGTERM');
  loginChild = null;
  if (login && login.state !== 'done') login = null;
}

// ---------------------------------------------------------------------------
// The plan's usage
// ---------------------------------------------------------------------------

const USAGE_URL = 'https://api.anthropic.com/api/oauth/usage';
/** Asked again at most this often, however many windows show it. */
const USAGE_CACHE_MS = 30_000;

/** One of the plan's limits: how much of it is used, and when it starts over. */
export interface ClaudeUsageLimit {
  /** "Current session", "This week", "This week, Opus"… */
  label: string;
  /** 0 to 100. */
  percent: number;
  /** When it resets, as an ISO time, or null where it doesn't say. */
  resetsAt: string | null;
  /** Anthropic's say on how close it is: "normal", "warning", "critical"… */
  severity: string | null;
}

/** The Claude plan's usage, as Claude Code's /usage shows it. */
export interface ClaudeUsage {
  /** The plan, "pro" or "max", when the sign-in says. */
  plan: string | null;
  limits: ClaudeUsageLimit[];
  /** Pay-as-you-go usage past the plan's limits, where it's turned on. */
  extra: { used: number; limit: number | null; currency: string } | null;
  /** When Anthropic was asked, as an ISO time. */
  checkedAt: string;
}

let usageCache: { at: number; usage: Promise<ClaudeUsage> } | null = null;

/** Claude Code's version, for when it can't be asked: any recent one will do. */
const FALLBACK_CLAUDE_VERSION = '2.1.317';
let claudeVersion: { binary: string; mtime: number; version: Promise<string> } | null = null;

/**
 * The installed Claude Code's version, asked once per binary. The usage
 * endpoint answers 429 to every User-Agent but `claude-code/<version>`.
 */
function installedClaudeVersion(): Promise<string> {
  const binary = findClaude();
  if (!binary) return Promise.resolve(FALLBACK_CLAUDE_VERSION);
  let mtime = 0;
  try {
    mtime = fs.statSync(binary).mtimeMs;
  } catch {
    // Asked anyway; it falls back if it can't run.
  }
  if (claudeVersion?.binary === binary && claudeVersion.mtime === mtime) return claudeVersion.version;
  const version = capture(binary, ['--version'], process.env).then(
    ({ stdout }) => /(\d+\.\d+\.\d+[\w.-]*)/.exec(stdout)?.[1] ?? FALLBACK_CLAUDE_VERSION,
  );
  claudeVersion = { binary, mtime, version };
  return version;
}

function credentialsFile(): string {
  const dir = process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude');
  return path.join(dir, '.credentials.json');
}

function readOAuth(): { token: string; expiresAt: number | null; plan: string | null } {
  let raw: string;
  try {
    raw = fs.readFileSync(credentialsFile(), 'utf8');
  } catch {
    throw new Error('Claude Code isn’t signed in to a Claude plan');
  }
  const oauth = (JSON.parse(raw) as { claudeAiOauth?: Record<string, unknown> }).claudeAiOauth;
  if (!oauth || typeof oauth.accessToken !== 'string') throw new Error('Claude Code isn’t signed in to a Claude plan');
  return {
    token: oauth.accessToken,
    expiresAt: typeof oauth.expiresAt === 'number' ? oauth.expiresAt : null,
    plan: typeof oauth.subscriptionType === 'string' ? oauth.subscriptionType : null,
  };
}

type Json = Record<string, unknown>;
const isObject = (value: unknown): value is Json => typeof value === 'object' && value !== null && !Array.isArray(value);
const num = (value: unknown): number | null => (typeof value === 'number' && Number.isFinite(value) ? value : null);
const str = (value: unknown): string | null => (typeof value === 'string' && value ? value : null);

/** What a limit in the reply's `limits` is called, from its kind, group and scope. */
function limitLabel(limit: Json): string {
  const kind = str(limit.kind) ?? '';
  const group = str(limit.group) ?? '';
  const scope = isObject(limit.scope) ? limit.scope : {};
  const model = isObject(scope.model) ? str(scope.model.display_name) : null;
  const surface = isObject(scope.surface) ? str(scope.surface.display_name) : str(scope.surface);
  const span = /week/.test(kind + group)
    ? 'This week'
    : /session|five_hour|5h/.test(kind + group)
      ? 'Current session'
      : /day/.test(kind + group)
        ? 'Today'
        : /month/.test(kind + group)
          ? 'This month'
          : (group || kind).replace(/_/g, ' ').replace(/^./, (c) => c.toUpperCase()) || 'Usage';
  const of = model ?? surface;
  return of ? `${span}, ${of}` : span;
}

/** The reply's limits: its `limits` list, else the older five_hour, seven_day… windows. */
function parseLimits(reply: Json): ClaudeUsageLimit[] {
  if (Array.isArray(reply.limits) && reply.limits.length > 0) {
    return reply.limits.filter(isObject).flatMap((limit) => {
      const percent = num(limit.percent);
      if (percent === null) return [];
      return [{ label: limitLabel(limit), percent, resetsAt: str(limit.resets_at), severity: str(limit.severity) }];
    });
  }
  const windows: [string, string][] = [
    ['five_hour', 'Current session'],
    ['seven_day', 'This week'],
    ['seven_day_opus', 'This week, Opus'],
    ['seven_day_sonnet', 'This week, Sonnet'],
  ];
  return windows.flatMap(([key, label]) => {
    const window = reply[key];
    const percent = isObject(window) ? num(window.utilization) : null;
    if (!isObject(window) || percent === null) return [];
    return [{ label, percent, resetsAt: str(window.resets_at), severity: null }];
  });
}

/** An amount as `spend` has it: { amount_minor, currency, exponent }. */
function money(value: unknown): { amount: number; currency: string } | null {
  if (!isObject(value)) return null;
  const minor = num(value.amount_minor);
  if (minor === null) return null;
  return { amount: minor / 10 ** (num(value.exponent) ?? 2), currency: str(value.currency) ?? 'USD' };
}

function parseExtra(reply: Json): ClaudeUsage['extra'] {
  const spend = reply.spend;
  if (isObject(spend)) {
    const used = money(spend.used);
    if (spend.enabled !== true || !used) return null;
    return { used: used.amount, limit: money(spend.limit)?.amount ?? null, currency: used.currency };
  }
  const extra = reply.extra_usage;
  if (!isObject(extra) || extra.is_enabled !== true) return null;
  const places = num(extra.decimal_places) ?? 2;
  const scale = 10 ** places;
  const used = num(extra.used_credits) ?? 0;
  const limit = num(extra.monthly_limit);
  return { used: used / scale, limit: limit === null ? null : limit / scale, currency: str(extra.currency) ?? 'USD' };
}

async function fetchUsage(): Promise<ClaudeUsage> {
  const { token, expiresAt, plan } = readOAuth();
  if (expiresAt !== null && expiresAt < Date.now()) {
    throw new Error('Claude Code’s sign-in has expired; it renews the next time the assistant uses Claude');
  }
  const version = await installedClaudeVersion();
  const response = await fetch(USAGE_URL, {
    headers: { Authorization: `Bearer ${token}`, 'anthropic-beta': 'oauth-2025-04-20', 'User-Agent': `claude-code/${version}` },
    signal: AbortSignal.timeout(15_000),
  });
  if (response.status === 401 || response.status === 403) {
    throw new Error('Anthropic didn’t accept Claude Code’s sign-in; sign in to Claude again');
  }
  if (response.status === 429) throw new Error('Anthropic is asked about the plan’s usage too often; try again in a minute');
  if (!response.ok) throw new Error(`Anthropic couldn’t say how much of the plan is used (${response.status})`);
  const reply = (await response.json()) as unknown;
  if (!isObject(reply)) throw new Error('Anthropic’s answer about the plan’s usage couldn’t be read');
  return { plan, limits: parseLimits(reply), extra: parseExtra(reply), checkedAt: new Date().toISOString() };
}

/**
 * How much of the Claude plan Claude Code is signed in to is used: its
 * session and weekly limits, as Claude Code's /usage shows them. Asked of
 * Anthropic with Claude Code's own sign-in, at most every 30 seconds unless
 * `fresh`.
 */
export function claudeUsage(fresh = false): Promise<ClaudeUsage> {
  if (!fresh && usageCache && Date.now() - usageCache.at < USAGE_CACHE_MS) return usageCache.usage;
  const usage = fetchUsage();
  const entry = { at: Date.now(), usage };
  usageCache = entry;
  // A failure isn't kept: the next ask tries again.
  usage.catch(() => {
    if (usageCache === entry) usageCache = null;
  });
  return usage;
}
