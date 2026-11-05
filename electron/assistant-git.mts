// Git for the Assistant's side panel (`assistant:git`, see assistant.mts):
// what the repository a conversation works in is on (its branch, how far it
// is from its remote, what's uncommitted), its commits, and the few things
// the panel does with them - fetch, pull, push, and their forced forms.
//
// Only the Assistant app reaches it (din-apps.mts refuses `assistant:git` to
// any other app granted `assistant`), and it's no more than that app already
// has: its conversations run commands, and it has `fs`. Still, nothing here
// takes a git argument from the caller: the operations are fixed, the
// directory is checked to be absolute, a commit is a hex hash.
//
// git runs with the agent's environment (serverEnvironment), so remotes reach
// what they would from a Terminal (ngit's git-remote-nostr and its signer in
// the keyring, the ssh agent), and never asks anything: no terminal prompt,
// no editor, ssh in batch mode. A failure comes back as one of a few kinds
// the panel explains, with git's own last lines.
//
// Runs as TypeScript directly via Node's native type stripping - erasable
// syntax only, like the rest of electron/.

import { execFile } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const LOCAL_TIMEOUT_MS = 20_000;
/** Fetching, pulling and pushing: a nostr remote signs and talks to several servers. */
const NETWORK_TIMEOUT_MS = 3 * 60_000;
const MAX_BUFFER = 16 * 1024 * 1024;
/** Commits a page of the log holds, at most. */
const MAX_LOG_PAGE = 200;
/** Commits on the remote not yet pulled, shown above the log. */
const MAX_INCOMING = 50;
/** How many commits are checked for whether they've been pushed. */
const MAX_UNPUSHED = 1000;
/** Files of a commit listed, at most. */
const MAX_FILES = 500;

const FIELD = '\x1f';
const RECORD = '\x1e';
const LOG_FORMAT = ['%H', '%h', '%P', '%an', '%ae', '%at', '%D', '%s'].join('%x1f') + '%x1e';

export interface GitRemote {
  name: string;
  url: string;
}

export type GitStatus =
  | { repo: false; error?: string }
  | {
      repo: true;
      /** The working tree's top. */
      root: string;
      /** The branch checked out, or null with a detached HEAD. */
      branch: string | null;
      /** HEAD's commit, or null before the first one. */
      head: string | null;
      /** The remote branch compared against (`origin/main`), when the remote has one. */
      upstream: string | null;
      /** The branch's remote: its upstream's, else origin, else the only one. */
      remote: GitRemote | null;
      ahead: number;
      behind: number;
      /** Files changed, staged or not, untracked ones included. */
      changes: number;
      conflicts: number;
      /** Something git is in the middle of. */
      state: 'merging' | 'rebasing' | 'cherry-picking' | 'reverting' | null;
    };

export interface GitCommit {
  hash: string;
  short: string;
  parents: string[];
  author: string;
  email: string;
  /** Unix seconds. */
  time: number;
  /** Branches and tags pointing at it, as `git log --decorate` says them. */
  refs: string[];
  subject: string;
  /** Whether it's on the remote: null when there's no remote to be on. */
  pushed: boolean | null;
}

export interface GitLog {
  commits: GitCommit[];
  /** On the remote branch and not here yet (first page only). */
  incoming: GitCommit[];
  more: boolean;
}

export interface GitCommitDetails {
  hash: string;
  /** The whole message. */
  message: string;
  files: { path: string; from?: string; additions: number | null; deletions: number | null }[];
  moreFiles: boolean;
}

export type GitFailureKind =
  | 'conflict'
  | 'diverged'
  | 'rejected'
  | 'dirty'
  | 'auth'
  | 'forbidden'
  | 'notFound'
  | 'network'
  | 'noRemote'
  | 'noRemoteBranch'
  | 'detached'
  | 'busy'
  | 'other';

export type GitResult = { ok: true } | { ok: false; kind: GitFailureKind; message: string };

class GitError extends Error {
  stderr: string;
  constructor(message: string, stderr: string) {
    super(message);
    this.stderr = stderr;
  }
}

/** PATH with the places a user's git helpers live (git-remote-nostr in ~/.local/bin), which a desktop session may not have. */
function withUserPath(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const user = os.userInfo().username;
  const have = (env.PATH ?? '').split(path.delimiter).filter(Boolean);
  const extra = [
    path.join(os.homedir(), '.local/bin'),
    path.join(os.homedir(), '.nix-profile/bin'),
    `/etc/profiles/per-user/${user}/bin`,
    '/run/current-system/sw/bin',
    '/usr/local/bin',
    '/usr/bin',
    '/bin',
  ].filter((dir) => !have.includes(dir));
  return { ...env, PATH: [...have, ...extra].join(path.delimiter) };
}

function gitEnvironment(base: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const env = withUserPath(base);
  return {
    ...env,
    // Messages to match, in any locale.
    LC_ALL: 'C',
    LANGUAGE: 'C',
    // Never wait on an answer nobody can give.
    GIT_TERMINAL_PROMPT: '0',
    GCM_INTERACTIVE: 'never',
    GIT_EDITOR: 'true',
    GIT_SEQUENCE_EDITOR: 'true',
    GIT_MERGE_AUTOEDIT: 'no',
    GIT_PAGER: 'cat',
    GIT_SSH_COMMAND: env.GIT_SSH_COMMAND || 'ssh -o BatchMode=yes',
    SSH_ASKPASS_REQUIRE: 'never',
  };
}

function git(
  env: NodeJS.ProcessEnv,
  cwd: string,
  args: string[],
  { timeout = LOCAL_TIMEOUT_MS, optionalLocks = true }: { timeout?: number; optionalLocks?: boolean } = {},
): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      'git',
      ['-c', 'color.ui=never', '-c', 'core.quotePath=off', '-c', 'log.showSignature=false', ...args],
      // Reading mustn't take the index's lock from the agent's own git.
      { cwd, env: optionalLocks ? env : { ...env, GIT_OPTIONAL_LOCKS: '0' }, timeout, maxBuffer: MAX_BUFFER },
      (error, stdout, stderr) => {
        if (!error) return resolve(stdout);
        const text = `${stderr}\n${stdout}`.trim();
        const killed = (error as { killed?: boolean }).killed;
        reject(new GitError(killed ? 'git took too long and was stopped' : lastLines(text) || error.message, text));
      },
    );
  });
}

/** git's own words, without its hints. */
function lastLines(text: string, count = 4): string {
  return text
    .split('\n')
    .map((line) => line.trimEnd())
    .filter((line) => line && !/^hint:/.test(line))
    .slice(-count)
    .join('\n');
}

const read = (env: NodeJS.ProcessEnv, cwd: string, args: string[]) => git(env, cwd, args, { optionalLocks: false });

async function tryRead(env: NodeJS.ProcessEnv, cwd: string, args: string[]): Promise<string | null> {
  try {
    return (await read(env, cwd, args)).trim();
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Status
// ---------------------------------------------------------------------------

interface Branch {
  root: string;
  gitDir: string;
  head: string | null;
  branch: string | null;
  /** The configured upstream (`origin/main`), whether or not its ref is here. */
  configured: string | null;
  ab: { ahead: number; behind: number } | null;
  changes: number;
  conflicts: number;
}

async function branchStatus(env: NodeJS.ProcessEnv, directory: string): Promise<Branch | null> {
  const top = await tryRead(env, directory, ['rev-parse', '--show-toplevel', '--absolute-git-dir']);
  if (!top) return null;
  const [root, gitDir] = top.split('\n');
  const out = await read(env, root, ['status', '--porcelain=v2', '--branch', '-z']);
  const tokens = out.split('\0');
  const status: Branch = { root, gitDir, head: null, branch: null, configured: null, ab: null, changes: 0, conflicts: 0 };
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i];
    if (!token) continue;
    if (token.startsWith('# branch.oid ')) {
      const oid = token.slice('# branch.oid '.length);
      status.head = oid === '(initial)' ? null : oid;
    } else if (token.startsWith('# branch.head ')) {
      const head = token.slice('# branch.head '.length);
      status.branch = head === '(detached)' ? null : head;
    } else if (token.startsWith('# branch.upstream ')) {
      status.configured = token.slice('# branch.upstream '.length);
    } else if (token.startsWith('# branch.ab ')) {
      const [, a, b] = /^# branch\.ab \+(\d+) -(\d+)/.exec(token) ?? [];
      status.ab = { ahead: Number(a) || 0, behind: Number(b) || 0 };
    } else if (token.startsWith('u ')) {
      status.changes++;
      status.conflicts++;
    } else if (token.startsWith('2 ')) {
      status.changes++;
      // A rename's original path is the next token.
      i++;
    } else if (token.startsWith('1 ') || token.startsWith('? ')) {
      status.changes++;
    }
  }
  return status;
}

/** The remote a branch syncs with, and its remote-tracking ref for the branch if it has one. */
async function remoteOf(
  env: NodeJS.ProcessEnv,
  b: Branch,
): Promise<{ remote: GitRemote | null; upstream: string | null; mergeBranch: string | null }> {
  const names = ((await tryRead(env, b.root, ['remote'])) ?? '').split('\n').filter(Boolean);
  let name: string | null = null;
  let mergeBranch: string | null = null;
  if (b.branch) {
    name = await tryRead(env, b.root, ['config', '--get', `branch.${b.branch}.remote`]);
    const merge = await tryRead(env, b.root, ['config', '--get', `branch.${b.branch}.merge`]);
    if (merge) mergeBranch = merge.replace(/^refs\/heads\//, '');
    if (name === '.') name = null;
  }
  if (!name || !names.includes(name)) {
    mergeBranch = null;
    name = names.includes('origin') ? 'origin' : names.length === 1 ? names[0] : null;
  }
  if (!name) return { remote: null, upstream: null, mergeBranch: null };
  const url = (await tryRead(env, b.root, ['remote', 'get-url', name])) ?? '';
  const target = mergeBranch ?? b.branch;
  let upstream: string | null = null;
  if (target) {
    const ref = `refs/remotes/${name}/${target}`;
    if ((await tryRead(env, b.root, ['rev-parse', '--verify', '--quiet', ref])) !== null) upstream = `${name}/${target}`;
  }
  return { remote: { name, url }, upstream, mergeBranch };
}

function inProgress(gitDir: string): Extract<GitStatus, { repo: true }>['state'] {
  const has = (name: string) => fs.existsSync(path.join(gitDir, name));
  if (has('rebase-merge') || has('rebase-apply')) return 'rebasing';
  if (has('MERGE_HEAD')) return 'merging';
  if (has('CHERRY_PICK_HEAD')) return 'cherry-picking';
  if (has('REVERT_HEAD')) return 'reverting';
  return null;
}

async function status(env: NodeJS.ProcessEnv, directory: string): Promise<GitStatus> {
  if (!fs.existsSync(directory)) return { repo: false, error: 'This folder isn’t there anymore.' };
  const b = await branchStatus(env, directory);
  if (!b) return { repo: false };
  const { remote, upstream } = await remoteOf(env, b);
  let ab = upstream && b.configured === upstream ? b.ab : null;
  if (upstream && !ab && b.head) {
    // Not the configured upstream (there is none): the remote's branch of the same name.
    const counts = await tryRead(env, b.root, ['rev-list', '--left-right', '--count', `HEAD...${upstream}`]);
    const [ahead, behind] = (counts ?? '0 0').split(/\s+/).map(Number);
    ab = { ahead: ahead || 0, behind: behind || 0 };
  }
  return {
    repo: true,
    root: b.root,
    branch: b.branch,
    head: b.head,
    upstream,
    remote,
    ahead: ab?.ahead ?? 0,
    behind: ab?.behind ?? 0,
    changes: b.changes,
    conflicts: b.conflicts,
    state: inProgress(b.gitDir),
  };
}

// ---------------------------------------------------------------------------
// The log
// ---------------------------------------------------------------------------

function parseLog(out: string): Omit<GitCommit, 'pushed'>[] {
  return out
    .split(RECORD)
    .map((record) => record.replace(/^\n/, ''))
    .filter(Boolean)
    .map((record) => {
      const [hash, short, parents, author, email, time, refs, subject] = record.split(FIELD);
      return {
        hash,
        short,
        parents: parents ? parents.split(' ') : [],
        author,
        email,
        time: Number(time),
        refs: refs ? refs.split(', ').filter(Boolean) : [],
        subject: subject ?? '',
      };
    });
}

async function log(env: NodeJS.ProcessEnv, directory: string, options: unknown): Promise<GitLog> {
  const { skip = 0, limit = 50 } = (options ?? {}) as { skip?: unknown; limit?: unknown };
  const from = Math.max(0, Math.floor(Number(skip) || 0));
  const count = Math.min(MAX_LOG_PAGE, Math.max(1, Math.floor(Number(limit) || 50)));
  const b = await branchStatus(env, directory);
  if (!b || !b.head) return { commits: [], incoming: [], more: false };
  const { remote, upstream } = await remoteOf(env, b);
  const out = await read(env, b.root, ['log', `--format=${LOG_FORMAT}`, `--skip=${from}`, `--max-count=${count + 1}`, 'HEAD', '--']);
  const page = parseLog(out);
  // Pushed: on the branch's remote branch, or with none there, on any of the remote's.
  let unpushed: Set<string> | null = null;
  if (remote) {
    const range = upstream ? [`${upstream}..HEAD`] : ['HEAD', '--not', `--remotes=${remote.name}`];
    const ids = await tryRead(env, b.root, ['rev-list', `--max-count=${MAX_UNPUSHED}`, ...range, '--']);
    unpushed = new Set((ids ?? '').split('\n').filter(Boolean));
  }
  const pushed = (hash: string) => (unpushed ? !unpushed.has(hash) : null);
  let incoming: GitCommit[] = [];
  if (from === 0 && upstream) {
    const ahead = await tryRead(env, b.root, ['log', `--format=${LOG_FORMAT}`, `--max-count=${MAX_INCOMING}`, `HEAD..${upstream}`, '--']);
    incoming = parseLog(ahead ?? '').map((c) => ({ ...c, pushed: true }));
  }
  return {
    commits: page.slice(0, count).map((c) => ({ ...c, pushed: pushed(c.hash) })),
    incoming,
    more: page.length > count,
  };
}

async function commitDetails(env: NodeJS.ProcessEnv, directory: string, hash: unknown): Promise<GitCommitDetails> {
  if (typeof hash !== 'string' || !/^[0-9a-f]{4,64}$/i.test(hash)) throw new Error('That isn’t a commit');
  const message = await read(env, directory, ['log', '-1', '--format=%B', hash, '--']);
  const stat = await read(env, directory, ['show', '--format=', '--numstat', '-z', '-M', '--diff-merges=first-parent', hash, '--']);
  const tokens = stat.split('\0');
  const files: GitCommitDetails['files'] = [];
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i].replace(/^\n/, '');
    if (!token) continue;
    const [added, deleted, file] = token.split('\t');
    const count = (n: string) => (n === '-' ? null : Number(n));
    if (file) files.push({ path: file, additions: count(added), deletions: count(deleted) });
    else {
      // A rename: its old path and new one follow.
      files.push({ from: tokens[i + 1], path: tokens[i + 2], additions: count(added), deletions: count(deleted) });
      i += 2;
    }
  }
  return { hash, message: message.trimEnd(), files: files.slice(0, MAX_FILES), moreFiles: files.length > MAX_FILES };
}

// ---------------------------------------------------------------------------
// Fetch, pull, push
// ---------------------------------------------------------------------------

function failure(kind: GitFailureKind, message: string): GitResult {
  return { ok: false, kind, message };
}

/** What a failed fetch, pull or push came to, from git's words. */
function classify(error: unknown): GitResult {
  const text = error instanceof GitError ? error.stderr : '';
  const message = error instanceof Error ? error.message : String(error);
  const has = (pattern: RegExp) => pattern.test(text);
  if (has(/Authentication failed|could not read (Username|Password)|terminal prompts disabled|HTTP Basic: Access denied|returned error: 401|invalid credentials|Permission denied \(publickey|Host key verification failed/i)) {
    return failure('auth', message);
  }
  if (has(/returned error: 403|Permission to .* denied|not allowed to push|You don't have permission|protected branch|pre-receive hook declined/i)) {
    return failure('forbidden', message);
  }
  if (has(/Repository not found|does not appear to be a git repository|returned error: 404|repository .* not found|couldn't find remote ref/i)) {
    return failure('notFound', message);
  }
  if (has(/\[rejected\]|non-fast-forward|fetch first|stale info|Updates were rejected/i)) return failure('rejected', message);
  if (has(/Could not resolve host|unable to access|Connection (timed out|refused)|Network is unreachable|Operation timed out|Could not read from remote repository/i)) {
    return failure('network', message);
  }
  if (has(/index\.lock|Unable to create .*\.lock/i)) return failure('busy', message);
  return failure('other', message);
}

/** Pull's way of joining: the user's (a rebase, fast-forward only), else a merge, never git's question about it. */
async function pullArgs(env: NodeJS.ProcessEnv, root: string, branch: string): Promise<string[]> {
  const rebase = (await tryRead(env, root, ['config', '--get', `branch.${branch}.rebase`])) ?? (await tryRead(env, root, ['config', '--get', 'pull.rebase']));
  const ff = await tryRead(env, root, ['config', '--get', 'pull.ff']);
  if (rebase !== null) return [];
  return ff === 'only' ? ['--ff-only'] : ['--no-rebase'];
}

interface Target {
  b: Branch & { branch: string };
  remote: GitRemote;
  upstream: string | null;
  /** The remote's branch to pull from and push to. */
  remoteBranch: string;
  /** Whether the branch has an upstream set. */
  tracked: boolean;
}

async function target(env: NodeJS.ProcessEnv, directory: string): Promise<Target | GitResult> {
  const b = await branchStatus(env, directory);
  if (!b) return failure('other', 'This folder isn’t in a git repository.');
  if (!b.branch) return failure('detached', 'No branch is checked out (a detached HEAD), so there’s nothing to sync.');
  const { remote, upstream, mergeBranch } = await remoteOf(env, b);
  if (!remote) return failure('noRemote', 'This repository has no remote to sync with.');
  return { b: { ...b, branch: b.branch }, remote, upstream, remoteBranch: mergeBranch ?? b.branch, tracked: mergeBranch !== null };
}

const isTarget = (t: Target | GitResult): t is Target => 'b' in t;

async function fetchRemote(env: NodeJS.ProcessEnv, t: Target): Promise<void> {
  await git(env, t.b.root, ['fetch', '--quiet', t.remote.name], { timeout: NETWORK_TIMEOUT_MS });
}

/** Put a pull that stopped on a conflict back as it was, so the repository isn't left half merged. */
async function abortJoin(env: NodeJS.ProcessEnv, root: string, gitDir: string): Promise<void> {
  const state = inProgress(gitDir);
  if (state === 'rebasing') await git(env, root, ['rebase', '--abort']).catch(() => {});
  else if (state === 'merging') await git(env, root, ['merge', '--abort']).catch(() => {});
}

async function pull(env: NodeJS.ProcessEnv, t: Target): Promise<GitResult> {
  const before = inProgress(t.b.gitDir);
  if (before) return failure('other', `The repository is in the middle of ${before === 'merging' ? 'a merge' : before.replace(/ing$/, 'e')}. Finish or abort it first.`);
  await fetchRemote(env, t);
  const ref = `refs/remotes/${t.remote.name}/${t.remoteBranch}`;
  if ((await tryRead(env, t.b.root, ['rev-parse', '--verify', '--quiet', ref])) === null) {
    return failure('noRemoteBranch', `${t.remoteBranch} isn’t on ${t.remote.name} yet. Push to put it there.`);
  }
  try {
    await git(env, t.b.root, ['pull', '--no-edit', ...(await pullArgs(env, t.b.root, t.b.branch)), t.remote.name, t.remoteBranch], {
      timeout: NETWORK_TIMEOUT_MS,
    });
    return { ok: true };
  } catch (error) {
    const text = error instanceof GitError ? error.stderr : '';
    const message = error instanceof Error ? error.message : String(error);
    if (/CONFLICT|Automatic merge failed|could not apply|Resolve all conflicts/i.test(text)) {
      await abortJoin(env, t.b.root, t.b.gitDir);
      return failure('conflict', message);
    }
    if (/would be overwritten by|Please commit your changes or stash them|You have unstaged changes|contains uncommitted changes|untracked working tree files would be/i.test(text)) {
      return failure('dirty', message);
    }
    if (/Not possible to fast-forward|Need to specify how to reconcile|diverg/i.test(text)) return failure('diverged', message);
    return classify(error);
  }
}

async function push(env: NodeJS.ProcessEnv, t: Target, force: boolean): Promise<GitResult> {
  try {
    const args = ['push', ...(force ? ['--force'] : []), ...(t.tracked ? [] : ['--set-upstream']), t.remote.name, `HEAD:refs/heads/${t.remoteBranch}`];
    await git(env, t.b.root, args, { timeout: NETWORK_TIMEOUT_MS });
    return { ok: true };
  } catch (error) {
    return classify(error);
  }
}

/** The branch made what the remote's is, its commits and changes to tracked files gone (untracked files stay). */
async function forcePull(env: NodeJS.ProcessEnv, t: Target): Promise<GitResult> {
  await fetchRemote(env, t);
  const ref = `refs/remotes/${t.remote.name}/${t.remoteBranch}`;
  if ((await tryRead(env, t.b.root, ['rev-parse', '--verify', '--quiet', ref])) === null) {
    return failure('noRemoteBranch', `${t.remoteBranch} isn’t on ${t.remote.name}.`);
  }
  await abortJoin(env, t.b.root, t.b.gitDir);
  await git(env, t.b.root, ['reset', '--hard', ref]);
  return { ok: true };
}

// ---------------------------------------------------------------------------
// The channel
// ---------------------------------------------------------------------------

/** One operation at a time in a repository: the panel's own, queued. */
const locks = new Map<string, Promise<unknown>>();

function serialized<T>(key: string, run: () => Promise<T>): Promise<T> {
  const previous = locks.get(key) ?? Promise.resolve();
  const next = previous.catch(() => {}).then(run);
  locks.set(key, next);
  void next.finally(() => locks.get(key) === next && locks.delete(key)).catch(() => {});
  return next;
}

async function syncOperation(env: NodeJS.ProcessEnv, op: string, directory: string): Promise<GitResult> {
  const t = await target(env, directory);
  if (!isTarget(t)) return t;
  return serialized(t.b.root, async () => {
    try {
      switch (op) {
        case 'fetch':
          await fetchRemote(env, t);
          return { ok: true };
        case 'pull':
          return await pull(env, t);
        case 'push':
          return await push(env, t, false);
        case 'sync': {
          // As Shakespeare's Sync: pull, then push if that went.
          const pulled = t.upstream ? await pull(env, t) : ({ ok: true } as const);
          return pulled.ok ? await push(env, t, false) : pulled;
        }
        case 'forcePull':
          return await forcePull(env, t);
        case 'forcePush':
          return await push(env, t, true);
        default:
          throw new Error('Unknown git operation');
      }
    } catch (error) {
      return classify(error);
    }
  });
}

/**
 * `assistant:git`: `op` on the repository `directory` is in. Reading
 * (`status`, `log`, `commit`) throws on failure; syncing returns a GitResult.
 */
export async function assistantGit(baseEnv: NodeJS.ProcessEnv, op: unknown, directory: unknown, arg: unknown): Promise<unknown> {
  if (typeof directory !== 'string' || !path.isAbsolute(directory)) throw new Error('Not a folder');
  const dir = path.resolve(directory);
  const env = gitEnvironment(baseEnv);
  switch (op) {
    case 'status':
      return status(env, dir);
    case 'log':
      return log(env, dir, arg);
    case 'commit':
      return commitDetails(env, dir, arg);
    case 'fetch':
    case 'pull':
    case 'push':
    case 'sync':
    case 'forcePull':
    case 'forcePush':
      return syncOperation(env, op, dir);
    default:
      throw new Error('Unknown git operation');
  }
}
