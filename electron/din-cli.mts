// The `din` command: everything a user can do on Din, from a shell, as
// `din <area> <command> [arguments]` (docs/din-command.md).
//
// A thin client. The commands, their help and their output live in the
// desktop (src/lib/commands/), which runs them; this sends the command line
// to the running Din over its socket (electron/din-launch.mts) and prints
// the answer, or with --json the answer's data. Two commands run here,
// because they stream and hold a window or an offer open for as long as
// they run: `din apps run` (an app from a folder or a dev server, its
// console printed here) and `din widgets add-folder`.
//
// Run by Electron's own binary as Node (ELECTRON_RUN_AS_NODE=1, see
// os/configuration.nix), so it needs nothing else installed; in
// development, `node electron/din-cli.mts`. Node's builtins only.
//
// Exit codes: 0 done, 1 failed, 2 used wrongly.

import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { parseArgs } from 'node:util';

type Message = Record<string, unknown>;

function fail(message: string, code = 1): never {
  process.stderr.write(`din: ${message}\n`);
  process.exit(code);
}

function socketPath(): string {
  if (process.env.DIN_SOCKET) return process.env.DIN_SOCKET;
  if (process.platform === 'win32') {
    // Untested: Din listens on a named pipe of the user's there.
    const user = os.userInfo().username.replace(/[^A-Za-z0-9_.-]/g, '_');
    return path.win32.join('\\\\.\\pipe', `din-${user}`);
  }
  const runtime = process.env.XDG_RUNTIME_DIR;
  if (runtime) return path.join(runtime, 'din.sock');
  return fail('Din isn’t running here ($DIN_SOCKET and $XDG_RUNTIME_DIR are unset)');
}

/**
 * Send one request and hear each line back. Resolves when Din hangs up;
 * `onLine` returning a number ends the command with that code.
 */
function request(body: Message, onLine: (message: Message) => number | void): Promise<number> {
  const file = socketPath();
  return new Promise((resolve) => {
    const socket = net.connect(file);
    let buffer = '';
    let done = false;
    const finish = (code: number) => {
      if (done) return;
      done = true;
      socket.end();
      resolve(code);
    };
    socket.setEncoding('utf8');
    socket.once('error', (error: NodeJS.ErrnoException) => {
      if (!done) fail(`can’t reach Din at ${file}: ${error.code ?? error.message}`);
    });
    socket.once('connect', () => socket.write(`${JSON.stringify(body)}\n`));
    socket.on('data', (chunk: string) => {
      buffer += chunk;
      for (let newline = buffer.indexOf('\n'); newline >= 0; newline = buffer.indexOf('\n')) {
        const line = buffer.slice(0, newline);
        buffer = buffer.slice(newline + 1);
        let message: unknown;
        try {
          message = JSON.parse(line);
        } catch {
          continue;
        }
        if (typeof message !== 'object' || message === null) continue;
        const code = onLine(message as Message);
        if (typeof code === 'number') finish(code);
      }
    });
    // Din went away.
    socket.once('close', () => finish(1));
    // Hanging up closes a window, or takes back an offer.
    process.once('SIGINT', () => finish(130));
  });
}

// ---------------------------------------------------------------------------
// din apps run
// ---------------------------------------------------------------------------

const COLORS: Record<string, string> = { warning: '33', error: '31', debug: '2' };

function showConsole(message: Message, color: boolean): void {
  const level = String(message.level ?? '');
  let text = String(message.message ?? '');
  let source = String(message.source ?? '');
  if ((level === 'warning' || level === 'error') && source) {
    // din://tmp-1a2b/assets/x.js -> /assets/x.js
    if (source.startsWith('din://')) source = `/${source.slice('din://'.length).split('/').slice(1).join('/')}`;
    text += `  (${source}:${Number(message.line ?? 0)})`;
  }
  const out = level === 'warning' || level === 'error' ? process.stderr : process.stdout;
  const code = COLORS[level];
  if (code && color && out.isTTY) text = `\x1b[${code}m${text}\x1b[0m`;
  out.write(`${text}\n`);
}

/** A built app's folder: one with an index.html, or a project whose dist/ has one. */
function appFolder(arg: string): string {
  const folder = path.resolve(arg);
  if (!fs.existsSync(folder) || !fs.statSync(folder).isDirectory()) fail(`no such folder: ${arg}`);
  if (fs.existsSync(path.join(folder, 'index.html'))) return folder;
  const built = path.join(folder, 'dist');
  if (fs.existsSync(path.join(built, 'index.html'))) return built;
  return fail(`no index.html in ${folder} (or its dist/)`);
}

const RUN_USAGE = 'Usage: din apps run <folder> [<files>…] [--url URL] [--origin NAME] [--detach] [--quiet]';

async function appsRun(argv: string[], color: boolean): Promise<number> {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      url: { type: 'string' },
      origin: { type: 'string' },
      detach: { type: 'boolean', short: 'd' },
      quiet: { type: 'boolean', short: 'q' },
      help: { type: 'boolean', short: 'h' },
    },
  });
  if (values.help) {
    process.stdout.write(`${RUN_USAGE}\n\nRuns a web app in a Din window at din://<origin>/, its console here.\nThe window closes when this ends (Ctrl-C), unless --detach.\n`);
    return 0;
  }
  const body: Message = { detach: values.detach === true };
  const files = [...positionals];
  if (values.url) body.url = values.url;
  else if (files.length > 0) body.dir = appFolder(files.shift()!);
  else fail(`name a folder, or a dev server with --url\n${RUN_USAGE}`, 2);
  if (values.origin) body.origin = values.origin;
  for (const file of files) if (!fs.existsSync(file)) fail(`no such file: ${file}`);
  body.paths = files.map((file) => path.resolve(file));

  return request(body, (message) => {
    if (message.type === 'error') fail(String(message.message ?? 'failed'));
    if (message.type === 'opened') {
      if (!values.quiet) {
        const note = message.ephemeral === false ? ' (keeps its storage)' : '';
        process.stderr.write(`din: ${String(message.source)} at ${String(message.url)}${note}\n`);
      }
      if (values.detach) return 0;
    } else if (message.type === 'console' && !values.quiet) {
      showConsole(message, color);
    } else if (message.type === 'closed') {
      return 0;
    }
  });
}

// ---------------------------------------------------------------------------
// din widgets add-folder
// ---------------------------------------------------------------------------

const WIDGET_USAGE = 'Usage: din widgets add-folder <folder> [--size small|medium|large]';

async function widgetsAddFolder(argv: string[]): Promise<number> {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: { size: { type: 'string' }, help: { type: 'boolean', short: 'h' } },
  });
  if (values.help) {
    process.stdout.write(`${WIDGET_USAGE}\n\nPuts a folder's widget on the desktop. If it asks for permissions, the desktop\nshows them for you to allow, and this waits for your answer. Once added, it\nreloads whenever a file in the folder changes.\n`);
    return 0;
  }
  if (positionals.length !== 1) fail(WIDGET_USAGE, 2);
  if (values.size && !['small', 'medium', 'large'].includes(values.size)) fail('--size takes small, medium or large', 2);
  const folder = path.resolve(positionals[0]);
  if (!fs.existsSync(path.join(folder, 'index.html'))) fail(`no index.html in ${folder}`);
  const widget: Message = { dir: folder };
  if (values.size) widget.size = values.size;

  return request({ widget }, (message) => {
    if (message.type === 'error') fail(String(message.message ?? 'failed'));
    if (message.type === 'asking') process.stderr.write('din: waiting for you to allow it on the desktop…\n');
    if (message.type === 'added') {
      process.stderr.write(`din: added ${folder} to the desktop\n`);
      return 0;
    }
  });
}

// ---------------------------------------------------------------------------
// Everything else: the desktop's
// ---------------------------------------------------------------------------

async function main(): Promise<number> {
  const argv = process.argv.slice(2);
  // Options of the command itself, wherever they are on the line (before a `--`).
  const end = argv.includes('--') ? argv.indexOf('--') : argv.length;
  const own = (flag: string) => {
    const at = argv.indexOf(flag);
    if (at < 0 || at >= end) return false;
    argv.splice(at, 1);
    return true;
  };
  const json = own('--json');
  const color = !own('--no-color') && !('NO_COLOR' in process.env);

  if (argv[0] === 'apps' && argv[1] === 'run') return appsRun(argv.slice(2), color);
  if (argv[0] === 'widgets' && argv[1] === 'add-folder') return widgetsAddFolder(argv.slice(2));

  return request({ command: argv, cwd: process.cwd() }, (message) => {
    if (message.type !== 'answer') return;
    if (message.ok !== true) {
      process.stderr.write(`din: ${String(message.error ?? 'failed')}\n`);
      return message.usage === true ? 2 : 1;
    }
    if (json) process.stdout.write(`${JSON.stringify(message.data ?? null, null, 2)}\n`);
    else if (typeof message.text === 'string' && message.text) process.stdout.write(`${message.text}\n`);
    return 0;
  });
}

process.exitCode = await main();
