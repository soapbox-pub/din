import { useCallback, useEffect, useRef, useState, type CSSProperties, type ReactNode } from 'react';
import { keepPreviousData, useInfiniteQuery, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  AlertTriangle,
  ArrowDown,
  ArrowUp,
  Check,
  ChevronDown,
  Cloud,
  Copy,
  ExternalLink,
  GitBranch,
  GitCommitHorizontal,
  HardDrive,
  LoaderCircle,
  PanelRightClose,
  RefreshCw,
  X,
  Zap,
} from 'lucide-react';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible';
import { ContextMenu, ContextMenuContent, ContextMenuItem, ContextMenuSeparator, ContextMenuTrigger } from '@/components/ui/context-menu';
import { Skeleton } from '@/components/ui/skeleton';
import { WindowControls, WindowDragRegion } from '@/sdk/react';
import { PillButton, StatusPill, ToolButton } from '@/shared/appChrome';
import { focusRing, sidebarHeadingClass, toolIcon } from '@/shared/appChromeStyles';
import { LoadMore } from '@/shared/assistant/LoadMore';
import { useAssistantHost } from '@/shared/assistant/host';
import { useHomeDirectory } from '@/hooks/useAssistant';
import { cleanAssistantError, relativeTime, tildify } from '@/lib/assistant';
import {
  gitCommit,
  gitLog,
  gitStatus,
  gitSync,
  refLabels,
  remoteHostName,
  remoteWebUrl,
  type GitCommit,
  type GitFailureKind,
  type GitRepoStatus,
  type GitStatus,
  type GitSyncOperation,
} from '@/lib/assistantGit';
import { cn } from '@/lib/utils';

/*
 * The Assistant's Git panel, at the window's right: the branch the active
 * conversation's folder is on, syncing it with its remote (Shakespeare's
 * Sync popover: Sync, and Pull and Push under its chevron, and when one
 * fails, what went wrong and what can be done, Force Pull and Force Push
 * among it, each asked about first), and its commits, those not pushed yet
 * marked and those on the remote not pulled yet above them.
 *
 * Its status is git's local view, read every few seconds; what's on the
 * remote is fetched when the panel opens and every few minutes after, so
 * ahead and behind stay right (electron/assistant-git.mts does the git).
 */

const STATUS_POLL_MS = 5_000;
const FETCH_EVERY_MS = 5 * 60_000;
const LOG_PAGE = 50;
const SUCCESS_MS = 2_500;

const gitKey = (...parts: unknown[]) => ['assistant-git', ...parts];

/** The repository `directory` is in, read every few seconds while shown. */
function useGitStatus(directory: string | undefined, poll = STATUS_POLL_MS) {
  return useQuery<GitStatus>({
    queryKey: gitKey('status', directory),
    queryFn: () => gitStatus(directory!),
    enabled: !!directory,
    refetchInterval: poll,
    staleTime: 2_000,
    retry: false,
  });
}

const plural = (n: number, one: string, many = `${one}s`) => `${n.toLocaleString()} ${n === 1 ? one : many}`;

// ---------------------------------------------------------------------------
// The chip under the composer
// ---------------------------------------------------------------------------

/** The branch, and how far it is from its remote, beside the folder under the composer: shows the Git panel. */
export function GitBranchChip({ directory, open, onToggle }: { directory: string; open: boolean; onToggle: () => void }) {
  const { data: status } = useGitStatus(directory, 10_000);
  if (!status?.repo) return null;
  const name = status.branch ?? (status.head ? status.head.slice(0, 7) : 'No commits');
  return (
    <button
      type="button"
      onClick={onToggle}
      aria-pressed={open}
      title={`${open ? 'Hide' : 'Show'} Git (Ctrl+Shift+G)`}
      className={cn(
        'inline-flex h-4 min-w-0 shrink items-center gap-1 rounded-full px-1 hover:text-foreground',
        focusRing,
        open && 'text-foreground',
      )}
    >
      <GitBranch className="size-3 shrink-0" aria-hidden />
      <span className="min-w-0 truncate">{name}</span>
      {status.ahead > 0 && <span className="shrink-0 tabular-nums" aria-label={`${status.ahead} to push`}>↑{status.ahead}</span>}
      {status.behind > 0 && <span className="shrink-0 tabular-nums" aria-label={`${status.behind} to pull`}>↓{status.behind}</span>}
      {status.changes > 0 && <span className="size-1.5 shrink-0 rounded-full bg-amber-500" aria-label={plural(status.changes, 'uncommitted change')} />}
    </button>
  );
}

// ---------------------------------------------------------------------------
// The panel
// ---------------------------------------------------------------------------

export function GitPanel({
  directory,
  onClose,
  className,
  style,
}: {
  /** The folder the conversation works in; the panel shows the repository it's in. */
  directory: string | undefined;
  onClose: () => void;
  className?: string;
  style?: CSSProperties;
}) {
  const { data: status, isLoading, error } = useGitStatus(directory);
  const scrollRef = useRef<HTMLDivElement>(null);
  const repo = status?.repo ? status : null;
  const sync = useGitOperations(directory, repo);

  return (
    <aside aria-label="Git" style={style} className={cn('flex min-h-0 shrink-0 flex-col text-foreground', className)}>
      <WindowDragRegion className="flex h-12 shrink-0 items-center gap-1 pr-3 pl-3.75">
        <GitCommitHorizontal className="size-6 shrink-0 text-ink-accent" strokeWidth={1.75} aria-hidden />
        <h2 className="ml-1 shrink-0 font-[family-name:var(--font-title)] text-lg font-medium text-foreground/90">Git</h2>
        {repo?.remote && (
          <ToolButton
            label={`Check ${repo.remote.name} for new commits`}
            disabled={sync.running !== null}
            onClick={() => void sync.run('fetch')}
          >
            <RefreshCw {...toolIcon} className={cn(toolIcon.className, sync.running === 'fetch' && 'animate-spin')} aria-hidden />
          </ToolButton>
        )}
        <ToolButton label="Hide Git (Ctrl+Shift+G)" onClick={onClose}>
          <PanelRightClose {...toolIcon} aria-hidden />
        </ToolButton>
        <span className="flex-1" />
        <WindowControls />
      </WindowDragRegion>
      <div ref={scrollRef} className="min-h-0 flex-1 overflow-y-auto px-2 pb-3">
        {!directory ? (
          <EmptyCard>Start a conversation in a folder to see its repository here.</EmptyCard>
        ) : isLoading ? (
          <PanelSkeleton />
        ) : error ? (
          <EmptyCard>Couldn’t read the repository: {cleanAssistantError(error)}</EmptyCard>
        ) : !repo ? (
          <NotARepository directory={directory} reason={status && !status.repo ? status.error : undefined} />
        ) : (
          <>
            <BranchCard status={repo} sync={sync} />
            <Commits directory={directory} status={repo} scrollRef={scrollRef} />
          </>
        )}
      </div>
    </aside>
  );
}

function EmptyCard({ children }: { children: ReactNode }) {
  return (
    <div className="mx-1 mt-1 rounded-xl border border-dashed border-border px-4 py-8 text-center text-sm text-muted-foreground">
      {children}
    </div>
  );
}

function NotARepository({ directory, reason }: { directory: string; reason?: string }) {
  const home = useHomeDirectory();
  return (
    <EmptyCard>
      {reason ?? (
        <>
          <span className="block font-medium text-foreground">Not a git repository</span>
          <span className="mt-1 block break-all">{tildify(directory, home)}</span>
          <span className="mt-3 block">Ask the assistant to set one up, and its commits show here.</span>
        </>
      )}
    </EmptyCard>
  );
}

function PanelSkeleton() {
  return (
    <div className="space-y-3 px-1 pt-1" aria-label="Loading the repository">
      <Skeleton className="h-36 w-full rounded-xl" />
      <Skeleton className="mt-4 h-3 w-20" />
      {[0, 1, 2, 3].map((i) => (
        <div key={i} className="space-y-1.5 py-1">
          <Skeleton className="h-3.5 w-11/12" />
          <Skeleton className="h-3 w-1/2" />
        </div>
      ))}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Syncing
// ---------------------------------------------------------------------------

interface Failure {
  op: GitSyncOperation;
  kind: GitFailureKind;
  message: string;
}

interface GitOperations {
  running: GitSyncOperation | null;
  /** The last one, a moment ago, went. */
  succeeded: boolean;
  failure: Failure | null;
  dismiss: () => void;
  run: (op: GitSyncOperation) => Promise<void>;
}

/** Fetch, pull and push, one at a time, and what came of the last one; and a fetch now and then. */
function useGitOperations(directory: string | undefined, status: GitRepoStatus | null): GitOperations {
  const queryClient = useQueryClient();
  const [running, setRunning] = useState<GitSyncOperation | null>(null);
  const [failure, setFailure] = useState<Failure | null>(null);
  const [succeeded, setSucceeded] = useState(false);
  const busy = useRef(false);

  useEffect(() => {
    if (!succeeded) return;
    const timer = setTimeout(() => setSucceeded(false), SUCCESS_MS);
    return () => clearTimeout(timer);
  }, [succeeded]);

  const refresh = useCallback(() => queryClient.invalidateQueries({ queryKey: gitKey() }), [queryClient]);

  const run = useCallback(
    async (op: GitSyncOperation) => {
      if (!directory || busy.current) return;
      busy.current = true;
      setFailure(null);
      setSucceeded(false);
      setRunning(op);
      try {
        const result = await gitSync(directory, op);
        if (result.ok) setSucceeded(op !== 'fetch');
        else setFailure({ op, kind: result.kind, message: result.message });
      } catch (error) {
        setFailure({ op, kind: 'other', message: cleanAssistantError(error) });
      } finally {
        busy.current = false;
        setRunning(null);
        void refresh();
      }
    },
    [directory, refresh],
  );

  // What's on the remote: when the panel opens, and every few minutes.
  const remote = status?.remote?.name;
  useQuery({
    queryKey: gitKey('fetch', status?.root, remote),
    queryFn: async () => {
      if (busy.current) return null;
      const result = await gitSync(directory!, 'fetch').catch(() => null);
      void refresh();
      return result;
    },
    enabled: !!directory && !!remote && !!status?.branch,
    refetchInterval: FETCH_EVERY_MS,
    staleTime: 60_000,
    refetchOnWindowFocus: false,
    retry: false,
  });

  return { running, succeeded, failure, dismiss: () => setFailure(null), run };
}

const RUNNING_LABELS: Record<GitSyncOperation, string> = {
  fetch: 'Fetching',
  pull: 'Pulling',
  forcePull: 'Pulling',
  push: 'Pushing',
  forcePush: 'Pushing',
  sync: 'Syncing',
};

/** The remote as sentences name it: Nostr, its host, or (on this computer) its name. */
function remoteLabel(remote: { name: string; url: string }): string {
  return remoteWebUrl(remote.url) || /^nostr:/i.test(remote.url) ? remoteHostName(remote.url) : remote.name;
}

function RemoteIcon({ url, className }: { url: string; className?: string }) {
  const Icon = /^nostr:/i.test(url) ? Zap : remoteWebUrl(url) ? Cloud : HardDrive;
  return <Icon className={cn('size-4.5 shrink-0 text-ink-accent', className)} strokeWidth={1.75} aria-hidden />;
}

/** The branch, its remote and syncing with it. */
function BranchCard({ status, sync }: { status: GitRepoStatus; sync: GitOperations }) {
  const { openUrl } = useAssistantHost();
  const home = useHomeDirectory();
  const [forcing, setForcing] = useState<'forcePull' | 'forcePush' | null>(null);
  const [more, setMore] = useState(false);
  const remote = status.remote;
  const web = remote ? remoteWebUrl(remote.url) : null;
  const upstream = status.upstream ?? (remote && status.branch ? `${remote.name}/${status.branch}` : null);
  const canSync = !!remote && !!status.branch && !status.state;
  const busy = sync.running !== null;

  return (
    <section aria-label="Branch" className="mx-1 mt-1 rounded-xl bg-background/60 p-3 clay">
      <div className="flex min-w-0 items-center gap-2">
        <GitBranch className="size-4.5 shrink-0 text-ink-accent" strokeWidth={1.75} aria-hidden />
        <span className="min-w-0 flex-1 truncate text-sm font-semibold" title={status.branch ?? status.head ?? undefined}>
          {status.branch ?? (status.head ? `Detached at ${status.head.slice(0, 7)}` : 'No commits yet')}
        </span>
        {status.upstream && (status.ahead > 0 || status.behind > 0) && (
          <StatusPill className="tabular-nums" title={`${plural(status.ahead, 'commit')} to push, ${plural(status.behind, 'commit')} to pull`}>
            {status.ahead > 0 && <span>↑{status.ahead}</span>}
            {status.behind > 0 && <span>↓{status.behind}</span>}
          </StatusPill>
        )}
      </div>
      <p className="mt-1 truncate pl-6.5 text-xs text-muted-foreground" title={status.root}>
        {tildify(status.root, home)}
      </p>

      {(status.changes > 0 || status.state) && (
        <p className="mt-2 flex items-center gap-2 pl-0.5 text-xs text-muted-foreground">
          <span className="size-2 shrink-0 rounded-full bg-amber-500" aria-hidden />
          {status.state
            ? `In the middle of ${status.state === 'merging' ? 'a merge' : status.state === 'rebasing' ? 'a rebase' : status.state === 'reverting' ? 'a revert' : 'a cherry-pick'}${status.conflicts ? `, ${plural(status.conflicts, 'conflict')}` : ''}`
            : plural(status.changes, 'uncommitted change')}
        </p>
      )}

      {remote ? (
        <div className="mt-3 space-y-1.5">
          <div className="flex min-w-0 items-center gap-2">
            <RemoteIcon url={remote.url} />
            <span className="min-w-0 flex-1 truncate text-sm font-medium">{remoteHostName(remote.url)}</span>
            <span className="shrink-0 text-xs text-muted-foreground">{remote.name}</span>
          </div>
          <div className="flex items-center gap-1">
            <input
              readOnly
              value={remote.url}
              aria-label="Repository URL"
              onFocus={(e) => e.currentTarget.select()}
              className={cn('h-7 min-w-0 flex-1 rounded-full border border-border/70 bg-background px-2.5 font-mono text-xs text-muted-foreground', focusRing)}
            />
            <CopyToolButton text={remote.url} label="Copy the URL" />
            {web && (
              <ToolButton size="sm" label="Open in the browser" onClick={() => openUrl(web)}>
                <ExternalLink className="size-3.5" strokeWidth={1.75} aria-hidden />
              </ToolButton>
            )}
          </div>
        </div>
      ) : (
        <p className="mt-3 text-xs text-muted-foreground">
          No remote to sync with. Add one with <code className="font-mono">git remote add</code>, or ask the assistant to.
        </p>
      )}

      {sync.failure && (
        <SyncFailure
          failure={sync.failure}
          remote={remote ? remoteLabel(remote) : 'the remote'}
          busy={busy}
          onDismiss={sync.dismiss}
          onPull={() => void sync.run('pull')}
          onForce={setForcing}
        />
      )}

      {!sync.failure && remote && status.branch && !status.state && <AheadBehind status={status} upstream={upstream} />}
      {!sync.failure && remote && (!status.branch || status.state) && (
        <p className="mt-3 rounded-lg border border-border/70 bg-foreground/[0.03] p-2.5 text-xs text-muted-foreground">
          {status.state
            ? 'Finish or abort what git is in the middle of before syncing.'
            : 'No branch is checked out (a detached HEAD), so there’s nothing to sync. Check out a branch to pull and push.'}
        </p>
      )}

      {remote && (
        <Collapsible open={more} onOpenChange={setMore} className="mt-3">
          <div className={cn('flex h-9 overflow-hidden rounded-full bg-pigment text-primary-foreground clay-pigment', !canSync && 'opacity-50')}>
            <button
              type="button"
              disabled={!canSync || busy}
              onClick={() => void sync.run('sync')}
              className={cn('flex min-w-0 flex-1 items-center justify-center gap-2 text-sm font-medium hover:brightness-110 disabled:pointer-events-none', focusRing)}
            >
              {sync.succeeded && !busy ? (
                <Check className="size-4" aria-hidden />
              ) : (
                <RefreshCw className={cn('size-4', busy && 'animate-spin')} aria-hidden />
              )}
              {busy ? RUNNING_LABELS[sync.running!] : sync.succeeded ? 'Synced' : 'Sync'}
            </button>
            <span aria-hidden className="my-2 w-px bg-primary-foreground/30" />
            <CollapsibleTrigger asChild>
              <button
                type="button"
                aria-label={more ? 'Hide Pull and Push' : 'Pull or Push'}
                title="Pull or Push"
                className={cn('grid w-9 shrink-0 place-items-center hover:brightness-110', focusRing)}
              >
                <ChevronDown className={cn('size-4 transition-transform motion-reduce:transition-none', more && 'rotate-180')} aria-hidden />
              </button>
            </CollapsibleTrigger>
          </div>
          <CollapsibleContent className="mt-2 grid grid-cols-2 gap-2">
            <PillButton size="sm" disabled={!canSync || busy || !status.upstream} onClick={() => void sync.run('pull')}>
              {sync.running === 'pull' || sync.running === 'forcePull' ? <LoaderCircle className="animate-spin" aria-hidden /> : <ArrowDown aria-hidden />}
              Pull
            </PillButton>
            <PillButton size="sm" disabled={!canSync || busy} onClick={() => void sync.run('push')}>
              {sync.running === 'push' || sync.running === 'forcePush' ? <LoaderCircle className="animate-spin" aria-hidden /> : <ArrowUp aria-hidden />}
              Push
            </PillButton>
          </CollapsibleContent>
        </Collapsible>
      )}

      {remote && (
        <ForceDialog
          op={forcing}
          remote={remoteLabel(remote)}
          upstream={upstream ?? remote.name}
          onOpenChange={(open) => !open && setForcing(null)}
          onConfirm={(op) => void sync.run(op)}
        />
      )}
    </section>
  );
}

/** How far the branch is from the remote's, as Shakespeare says it. */
function AheadBehind({ status, upstream }: { status: GitRepoStatus; upstream: string | null }) {
  if (!status.upstream) {
    return (
      <p className="mt-3 rounded-lg border border-border/70 bg-foreground/[0.03] p-2.5 text-xs text-muted-foreground">
        <strong className="font-semibold text-foreground">{status.branch}</strong> isn’t on {status.remote?.name} yet. Sync or Push to put it
        there.
      </p>
    );
  }
  if (!status.ahead && !status.behind) return null;
  return (
    <p className="mt-3 rounded-lg border border-amber-500/25 bg-amber-500/10 p-2.5 text-xs">
      This branch is{' '}
      {status.ahead > 0 && <strong className="font-semibold">{plural(status.ahead, 'commit')} ahead of</strong>}
      {status.ahead > 0 && status.behind > 0 && ' and '}
      {status.behind > 0 && <strong className="font-semibold">{plural(status.behind, 'commit')} behind</strong>}{' '}
      <strong className="font-semibold">{upstream}</strong>.
    </p>
  );
}

/** What went wrong, in words, and what can be done about it (Shakespeare's SyncStepError). */
function failureText(failure: Failure, remote: string): { text: string; pull?: boolean; force?: boolean } {
  switch (failure.kind) {
    case 'conflict':
      return {
        text: 'Can’t merge the changes automatically: your commits and the remote’s conflict. The pull was undone, so nothing here changed.',
        force: true,
      };
    case 'diverged':
      return { text: 'Can’t fast-forward: the remote has commits that conflict with your local ones.', force: true };
    case 'rejected':
      return { text: 'Push rejected: the remote has changes you don’t have here. Try pulling first.', pull: true, force: true };
    case 'dirty':
      return { text: 'Your uncommitted changes would be overwritten by the pull. Commit them first, or ask the assistant to.' };
    case 'auth':
      return { text: `${remote} didn’t accept your credentials. Check that you’re signed in to it: a git push from a Terminal will ask.` };
    case 'forbidden':
      return { text: `You don’t have permission to push to this repository on ${remote}. Make sure you have write access to it.` };
    case 'notFound':
      return { text: `The repository wasn’t found on ${remote}. Make sure it exists and the remote’s URL is right.` };
    case 'network':
      return { text: `Couldn’t reach ${remote}. Check the connection and try again.` };
    case 'busy':
      return { text: 'Another git command is using the repository right now. Try again in a moment.' };
    default:
      return { text: failure.message };
  }
}

function SyncFailure({
  failure,
  remote,
  busy,
  onDismiss,
  onPull,
  onForce,
}: {
  failure: Failure;
  remote: string;
  busy: boolean;
  onDismiss: () => void;
  onPull: () => void;
  onForce: (op: 'forcePull' | 'forcePush') => void;
}) {
  const { text, pull, force } = failureText(failure, remote);
  const raw = text !== failure.message && failure.message;
  return (
    <div role="alert" className="mt-3 rounded-lg border border-destructive/30 bg-destructive/10 p-2.5 text-xs text-destructive">
      <div className="flex items-start gap-2">
        <AlertTriangle className="mt-px size-3.5 shrink-0" aria-hidden />
        <p className="min-w-0 flex-1 break-words">{text}</p>
        <button type="button" aria-label="Dismiss" title="Dismiss" onClick={onDismiss} className={cn('-m-1 rounded-full p-1 hover:bg-destructive/10', focusRing)}>
          <X className="size-3.5" aria-hidden />
        </button>
      </div>
      {raw && (
        <details className="mt-1.5 pl-5.5">
          <summary className="cursor-pointer text-destructive/80 select-none">What git said</summary>
          <pre className="mt-1 max-h-40 overflow-auto font-mono text-[11px] whitespace-pre-wrap break-all text-foreground/80">{raw}</pre>
        </details>
      )}
      {(pull || force) && (
        <div className="mt-2 grid gap-1.5">
          {pull && (
            <PillButton size="sm" disabled={busy} onClick={onPull} className="w-full">
              <ArrowDown aria-hidden /> Pull
            </PillButton>
          )}
          {force && (
            <>
              {!pull && (
                <PillButton size="sm" disabled={busy} onClick={() => onForce('forcePull')} className="w-full">
                  <ArrowDown aria-hidden /> Force Pull
                </PillButton>
              )}
              <PillButton size="sm" disabled={busy} onClick={() => onForce('forcePush')} className="w-full">
                <ArrowUp aria-hidden /> Force Push
              </PillButton>
            </>
          )}
        </div>
      )}
    </div>
  );
}

/** Force Pull and Force Push ask first, saying what's lost. */
function ForceDialog({
  op,
  remote,
  upstream,
  onOpenChange,
  onConfirm,
}: {
  op: 'forcePull' | 'forcePush' | null;
  remote: string;
  upstream: string;
  onOpenChange: (open: boolean) => void;
  onConfirm: (op: 'forcePull' | 'forcePush') => void;
}) {
  // Kept while the dialog animates closed.
  const [shown, setShown] = useState(op);
  if (op && op !== shown) setShown(op);
  const pull = shown === 'forcePull';
  return (
    <AlertDialog open={op !== null} onOpenChange={onOpenChange}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle className="flex items-center gap-2">
            <AlertTriangle className="size-5 text-destructive" aria-hidden />
            {pull ? 'Force Pull: discard local changes?' : `Force Push to ${remote}?`}
          </AlertDialogTitle>
          <AlertDialogDescription asChild>
            <div className="space-y-3">
              {pull ? (
                <p>
                  This <strong>resets this branch to match {upstream}</strong>, permanently deleting all its commits and changes that
                  aren’t on {remote}.
                </p>
              ) : (
                <p>
                  This <strong>overwrites the commit history of {upstream}</strong> with this branch’s, permanently deleting any commits
                  and changes on {remote} that aren’t here.
                </p>
              )}
              <div className="rounded-lg border border-destructive/25 bg-destructive/10 p-3 text-sm text-foreground">
                <p className="font-medium">{pull ? 'What will be deleted:' : `What will be deleted from ${remote}:`}</p>
                <ul className="mt-1.5 list-disc space-y-0.5 pl-5 text-muted-foreground">
                  {pull ? (
                    <>
                      <li>All local commits that haven’t been pushed to {remote}</li>
                      <li>Any work not on {remote}</li>
                      <li>All uncommitted changes to tracked files (untracked files stay)</li>
                    </>
                  ) : (
                    <>
                      <li>All commits on {remote} that aren’t in this branch</li>
                      <li>Any work by other contributors not in your copy</li>
                      <li>The branch’s history there, replaced with yours</li>
                    </>
                  )}
                </ul>
              </div>
            </div>
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>Cancel</AlertDialogCancel>
          <AlertDialogAction
            variant="destructive"
            onClick={() => shown && onConfirm(shown)}
          >
            <AlertTriangle aria-hidden /> {pull ? 'Force Pull' : 'Force Push'}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}

function CopyToolButton({ text, label }: { text: string; label: string }) {
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    if (!copied) return;
    const timer = setTimeout(() => setCopied(false), 2000);
    return () => clearTimeout(timer);
  }, [copied]);
  return (
    <ToolButton
      size="sm"
      label={copied ? 'Copied' : label}
      onClick={() => void navigator.clipboard?.writeText(text).then(() => setCopied(true), () => {})}
    >
      {copied ? <Check className="size-3.5" aria-hidden /> : <Copy className="size-3.5" strokeWidth={1.75} aria-hidden />}
    </ToolButton>
  );
}

// ---------------------------------------------------------------------------
// Commits
// ---------------------------------------------------------------------------

function Commits({
  directory,
  status,
  scrollRef,
}: {
  directory: string;
  status: GitRepoStatus;
  scrollRef: React.RefObject<HTMLDivElement | null>;
}) {
  const [open, setOpen] = useState<string | null>(null);
  const log = useInfiniteQuery({
    // A new commit, a pull or a push changes what's listed and what's marked.
    queryKey: gitKey('log', status.root, status.head, status.upstream, status.ahead, status.behind),
    queryFn: ({ pageParam }) => gitLog(directory, { skip: pageParam, limit: LOG_PAGE }),
    initialPageParam: 0,
    getNextPageParam: (last, pages) => (last.more ? pages.reduce((n, page) => n + page.commits.length, 0) : undefined),
    placeholderData: keepPreviousData,
    enabled: status.head !== null,
    retry: false,
  });
  const incoming = log.data?.pages[0]?.incoming ?? [];
  const commits = log.data?.pages.flatMap((page) => page.commits) ?? [];
  const toggle = (hash: string) => setOpen((o) => (o === hash ? null : hash));

  if (status.head === null) return <EmptyCard>No commits yet.</EmptyCard>;

  return (
    <>
      {incoming.length > 0 && (
        <section aria-label="Not pulled yet">
          <h3 className={cn(sidebarHeadingClass, 'mt-3')}>
            On {status.upstream}, not pulled yet
          </h3>
          <ol>
            {incoming.map((commit) => (
              <CommitRow key={commit.hash} commit={commit} incoming directory={directory} open={open === commit.hash} onToggle={() => toggle(commit.hash)} />
            ))}
          </ol>
        </section>
      )}
      <section aria-label="Commits">
        <h3 className={cn(sidebarHeadingClass, 'mt-3')}>Commits</h3>
        {log.isLoading ? (
          <div className="space-y-3 px-2 pt-1">
            {[0, 1, 2, 3, 4].map((i) => (
              <div key={i} className="space-y-1.5">
                <Skeleton className="h-3.5 w-11/12" />
                <Skeleton className="h-3 w-1/2" />
              </div>
            ))}
          </div>
        ) : log.error ? (
          <p className="px-2.5 text-xs text-destructive">Couldn’t read the commits: {cleanAssistantError(log.error)}</p>
        ) : (
          <ol>
            {commits.map((commit, i) => (
              <CommitRow
                key={commit.hash}
                commit={commit}
                directory={directory}
                last={i === commits.length - 1 && !log.hasNextPage}
                open={open === commit.hash}
                onToggle={() => toggle(commit.hash)}
              />
            ))}
          </ol>
        )}
        {log.hasNextPage && (
          <LoadMore
            scrollRef={scrollRef}
            edge="bottom"
            loaded={commits.length}
            loading={log.isFetchingNextPage}
            failed={log.isFetchNextPageError}
            onLoad={() => void log.fetchNextPage()}
            label="Show older commits"
            loadingLabel="Loading older commits…"
            className="mt-1"
          />
        )}
      </section>
    </>
  );
}

/** A commit on the line of them: its subject, and who and when; opened, its message and files. */
function CommitRow({
  commit,
  directory,
  incoming = false,
  last = false,
  open,
  onToggle,
}: {
  commit: GitCommit;
  directory: string;
  incoming?: boolean;
  last?: boolean;
  open: boolean;
  onToggle: () => void;
}) {
  const unpushed = commit.pushed === false;
  const refs = refLabels(commit.refs);
  const when = new Date(commit.time * 1000);
  const copy = (text: string) => void navigator.clipboard?.writeText(text).catch(() => {});
  return (
    <li className={cn('relative rounded-lg', open && 'bg-foreground/5')}>
      {/* The line the commits are on, and this one's dot on it. */}
      <span aria-hidden className={cn('absolute top-0 left-4 w-px bg-border', last ? 'h-3.5' : 'bottom-0', incoming && 'border-l border-dashed border-border bg-transparent')} />
      <span
        aria-hidden
        className={cn(
          'absolute top-2.5 left-[13px] size-[7px] rounded-full',
          incoming ? 'border border-dashed border-muted-foreground bg-transparent' : unpushed ? 'border-[1.5px] border-ink-accent bg-background' : 'bg-muted-foreground/70',
          commit.parents.length > 1 && 'rounded-[2px] rotate-45',
        )}
      />
      <ContextMenu>
        <ContextMenuTrigger asChild>
          <button
            type="button"
            aria-expanded={open}
            onClick={onToggle}
            className={cn('w-full rounded-lg py-1.5 pr-2 pl-8 text-left hover:bg-foreground/5', focusRing, incoming && 'opacity-75')}
          >
            <span className={cn('block text-sm leading-5', open ? 'break-words' : 'truncate')} title={open ? undefined : commit.subject}>
              {commit.subject || <span className="text-muted-foreground italic">No message</span>}
            </span>
            <span className="mt-0.5 flex min-w-0 items-center gap-1.5 text-xs text-muted-foreground">
              <span className="shrink-0 font-mono">{commit.short}</span>
              <span aria-hidden>·</span>
              <span className="min-w-0 truncate" title={`${commit.author} <${commit.email}>`}>{commit.author}</span>
              <span aria-hidden>·</span>
              <time className="shrink-0" dateTime={when.toISOString()} title={when.toLocaleString()}>
                {relativeTime(when.getTime())}
              </time>
              {unpushed && (
                <span className="ml-auto flex shrink-0 items-center text-ink-accent" title="Not pushed yet">
                  <ArrowUp className="size-3" aria-hidden />
                  <span className="sr-only">Not pushed yet</span>
                </span>
              )}
              {incoming && (
                <span className="ml-auto flex shrink-0 items-center" title="Not pulled yet">
                  <ArrowDown className="size-3" aria-hidden />
                  <span className="sr-only">Not pulled yet</span>
                </span>
              )}
            </span>
            {refs.length > 0 && (
              <span className="mt-1 flex flex-wrap gap-1">
                {refs.map((ref) => (
                  <span
                    key={ref.name}
                    className={cn(
                      'max-w-full truncate rounded-full px-1.5 py-px text-[11px] font-medium',
                      ref.kind === 'head' ? 'bg-selected text-foreground' : ref.kind === 'tag' ? 'bg-amber-500/15 text-amber-800 dark:text-amber-300' : 'bg-foreground/[0.07] text-muted-foreground',
                    )}
                    title={ref.kind === 'tag' ? `Tag ${ref.name}` : ref.kind === 'head' ? `${ref.name}, checked out` : ref.name}
                  >
                    {ref.name}
                  </span>
                ))}
              </span>
            )}
          </button>
        </ContextMenuTrigger>
        <ContextMenuContent className="w-52">
          <ContextMenuItem onSelect={onToggle}>{open ? 'Hide Details' : 'Show Details'}</ContextMenuItem>
          <ContextMenuSeparator />
          <ContextMenuItem onSelect={() => copy(commit.hash)}>Copy Hash</ContextMenuItem>
          <ContextMenuItem onSelect={() => copy(commit.subject)}>Copy Subject</ContextMenuItem>
        </ContextMenuContent>
      </ContextMenu>
      {open && <CommitDetails directory={directory} commit={commit} />}
    </li>
  );
}

function CommitDetails({ directory, commit }: { directory: string; commit: GitCommit }) {
  const { data, isLoading, error } = useQuery({
    queryKey: gitKey('commit', directory, commit.hash),
    queryFn: () => gitCommit(directory, commit.hash),
    staleTime: Infinity,
    retry: false,
  });
  const body = data?.message.split('\n').slice(1).join('\n').trim();
  return (
    <div className="pt-1 pr-2 pb-2 pl-8 text-xs">
      {isLoading ? (
        <div className="space-y-1.5">
          <Skeleton className="h-3 w-full" />
          <Skeleton className="h-3 w-2/3" />
        </div>
      ) : error ? (
        <p className="text-destructive">{cleanAssistantError(error)}</p>
      ) : data ? (
        <>
          {body && <p className="mb-2 whitespace-pre-wrap break-words text-muted-foreground">{body}</p>}
          <div className="mb-1.5 flex items-center gap-2 text-muted-foreground">
            <span className="min-w-0 flex-1 truncate font-mono" title={commit.hash}>{commit.hash}</span>
            <CopyToolButton text={commit.hash} label="Copy the hash" />
          </div>
          {data.files.length === 0 ? (
            <p className="text-muted-foreground">No files changed.</p>
          ) : (
            <>
              <p className="mb-1 font-medium text-muted-foreground">{plural(data.files.length, 'file')}{data.moreFiles ? ' and more' : ''}</p>
              <ul className="space-y-0.5 font-mono">
                {data.files.map((file) => (
                  <li key={`${file.from ?? ''}\0${file.path}`} className="flex gap-2">
                    <span className="min-w-0 flex-1 truncate" title={file.from ? `${file.from} → ${file.path}` : file.path} dir="rtl">
                      <bdi>{file.path}</bdi>
                    </span>
                    {file.additions === null ? (
                      <span className="shrink-0 text-muted-foreground">binary</span>
                    ) : (
                      <>
                        {file.additions > 0 && <span className="shrink-0 text-emerald-700 dark:text-emerald-400">+{file.additions}</span>}
                        {(file.deletions ?? 0) > 0 && <span className="shrink-0 text-red-700 dark:text-red-400">−{file.deletions}</span>}
                      </>
                    )}
                  </li>
                ))}
              </ul>
            </>
          )}
        </>
      ) : null}
    </div>
  );
}
