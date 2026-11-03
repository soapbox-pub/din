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
// instead, which goes to the command's stdin. Din never sees a token.
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
