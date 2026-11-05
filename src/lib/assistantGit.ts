/**
 * Git for the Assistant's side panel, through the assistant bridge's `git`
 * (electron/assistant-git.mts, whose types these mirror): the repository a
 * conversation works in, its commits, and fetching, pulling and pushing.
 * Only the Assistant app (and the desktop) reaches it.
 */
import { getAssistantBridge } from '@/lib/assistant';

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

export type GitRepoStatus = Extract<GitStatus, { repo: true }>;

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

export type GitSyncOperation = 'fetch' | 'pull' | 'push' | 'sync' | 'forcePull' | 'forcePush';

function bridge(): (op: string, directory: string, arg?: unknown) => Promise<unknown> {
  const assistant = getAssistantBridge();
  if (!assistant) throw new Error('Git isn’t available here');
  return (op, directory, arg) => assistant.git(op, directory, arg);
}

export const gitStatus = (directory: string) => bridge()('status', directory) as Promise<GitStatus>;

export const gitLog = (directory: string, page: { skip: number; limit: number }) =>
  bridge()('log', directory, page) as Promise<GitLog>;

export const gitCommit = (directory: string, hash: string) => bridge()('commit', directory, hash) as Promise<GitCommitDetails>;

export const gitSync = (directory: string, op: GitSyncOperation) => bridge()(op, directory) as Promise<GitResult>;

/**
 * Where a remote's URL opens in a browser: http(s) as it is, scp-style and
 * ssh ones as their host's https page, nostr ones on gitworkshop.dev. Null
 * for what has no page (a path on this computer).
 */
export function remoteWebUrl(url: string): string | null {
  const trimmed = url.trim();
  const scp = /^(?:[\w.-]+@)?([\w.-]+):(?!\/\/)(.+?)(?:\.git)?\/?$/.exec(trimmed);
  if (scp && !/^[a-z]:\\/i.test(trimmed)) return `https://${scp[1]}/${scp[2]}`;
  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    return null;
  }
  if (parsed.protocol === 'http:' || parsed.protocol === 'https:') {
    parsed.username = '';
    parsed.password = '';
    return parsed.href.replace(/\.git\/?$/, '');
  }
  if (parsed.protocol === 'ssh:' || parsed.protocol === 'git+ssh:') {
    return `https://${parsed.hostname}${parsed.pathname.replace(/\.git\/?$/, '')}`;
  }
  if (parsed.protocol === 'nostr:') {
    // nostr://<npub or nip05>/<relay hint>/<identifier>
    const parts = `${parsed.host}${parsed.pathname}`.split('/').filter(Boolean);
    if (parts.length < 2) return null;
    return `https://gitworkshop.dev/${parts[0]}/${parts.at(-1)}`;
  }
  return null;
}

/** What to call where a remote lives: its host, or Nostr. */
export function remoteHostName(url: string): string {
  if (/^nostr:/i.test(url)) return 'Nostr';
  const scp = /^(?:[\w.-]+@)?([\w.-]+):(?!\/\/)/.exec(url);
  if (scp) return scp[1];
  try {
    return new URL(url).hostname || 'This computer';
  } catch {
    return 'This computer';
  }
}

/** A commit's ref names, made readable: `HEAD -> main` is `main`, `tag: v1` is `v1`. */
export interface RefLabel {
  name: string;
  kind: 'head' | 'branch' | 'remote' | 'tag';
}

export function refLabels(refs: string[]): RefLabel[] {
  return refs.flatMap((ref): RefLabel[] => {
    if (ref === 'HEAD') return [];
    if (ref.startsWith('HEAD -> ')) return [{ name: ref.slice(8), kind: 'head' }];
    if (ref.startsWith('tag: ')) return [{ name: ref.slice(5), kind: 'tag' }];
    if (/\/HEAD$/.test(ref)) return [];
    return [{ name: ref, kind: ref.includes('/') ? 'remote' : 'branch' }];
  });
}
