import { useState, type FormEvent } from 'react';
import { AlertTriangle, Check, Copy, Loader2, Share, Store } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Progress } from '@/components/ui/progress';
import { Textarea } from '@/components/ui/textarea';
import { useWindowActions } from '@/contexts/WindowManagerContext';
import { useCurrentUser } from '@/hooks/useCurrentUser';
import { usePublishDeps, useThemePackageActions } from '@/hooks/useThemePackages';
import { packageNaddr, publishThemePackage, type PackageType } from '@/lib/themePackages';

/** A theme to publish: which kind, its directory name, and what it's called. */
export interface PublishTarget {
  type: PackageType;
  id: string;
  name: string;
  /** A description to start from (an extension's own). */
  summary?: string;
}

type State =
  | { state: 'idle' }
  | { state: 'publishing'; step: string; percent?: number }
  | { state: 'done'; naddr: string }
  | { state: 'error'; message: string };

const WHAT: Record<PackageType, string> = { cursor: 'this cursor', icon: 'these icons', skin: 'this skin', extension: 'this extension' };

/** Where people find each once it's published. */
const WHERE: Record<PackageType, string> = { cursor: 'the App Store', icon: 'the App Store', skin: 'the App Store', extension: 'the Web Browser’s Extensions page' };

/**
 * Publish to Nostr…: an installed cursor theme (kind 34628), icon theme
 * (kind 34642), Media Player skin (kind 34675) or browser extension (kind
 * 34639), its files on the user's Blossom servers, signed by the user, for
 * others to find in the App Store, or for an extension the Web Browser's
 * about:extensions (src/lib/themePackages.ts). `onView` shows it once it's
 * published, which is the App Store's page for it unless said otherwise.
 */
export function PublishThemePackage({
  target,
  onClose,
  onView,
}: {
  target: PublishTarget | null;
  onClose: () => void;
  onView?: { label: string; open: (naddr: string) => void };
}) {
  return (
    <Dialog open={target !== null} onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="sm:max-w-md">
        {target && <PublishForm key={`${target.type}:${target.id}`} target={target} onClose={onClose} onView={onView} />}
      </DialogContent>
    </Dialog>
  );
}

function PublishForm({
  target,
  onClose,
  onView,
}: {
  target: PublishTarget;
  onClose: () => void;
  onView?: { label: string; open: (naddr: string) => void };
}) {
  const { user } = useCurrentUser();
  const deps = usePublishDeps();
  const { refreshPublished } = useThemePackageActions();
  const { open } = useWindowActions();
  const [title, setTitle] = useState(target.name);
  const [summary, setSummary] = useState(target.summary ?? '');
  const [state, setState] = useState<State>({ state: 'idle' });
  const [copied, setCopied] = useState(false);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!deps || !user || !title.trim()) return;
    try {
      setState({ state: 'publishing', step: 'Starting…' });
      const identifier = await publishThemePackage(
        target.type,
        target.id,
        { title: title.trim(), summary: summary.trim() || undefined },
        { ...deps, progress: (step, percent) => setState({ state: 'publishing', step, percent }) },
      );
      refreshPublished(target.type);
      setState({ state: 'done', naddr: packageNaddr({ type: target.type, pubkey: user.pubkey, identifier }) });
    } catch (error) {
      const message = error instanceof AggregateError
        ? `None of your Blossom servers would take it: ${error.errors.map((e) => (e instanceof Error ? e.message : String(e))).join('; ')}`
        : error instanceof Error ? error.message.replace(/^Error invoking remote method '[^']+': (Error: )?/, '') : String(error);
      setState({ state: 'error', message });
    }
  };

  const copy = (naddr: string) => {
    void navigator.clipboard.writeText(naddr).then(() => setCopied(true));
  };

  if (state.state === 'done') {
    return (
      <>
        <DialogHeader className="items-center text-center sm:text-center">
          <span className="grid size-14 place-items-center rounded-full bg-emerald-500/15 text-emerald-600 dark:text-emerald-400">
            <Check className="size-7" aria-hidden />
          </span>
          <DialogTitle className="text-xl">{title.trim()} is on Nostr</DialogTitle>
          <DialogDescription>
            People who follow you find it in {WHERE[target.type]}, and anyone can get it with this address. Publishing
            it again updates it.
          </DialogDescription>
        </DialogHeader>
        <div className="flex gap-2">
          <Input readOnly value={state.naddr} aria-label="Address" className="font-mono text-xs" onFocus={(e) => e.currentTarget.select()} />
          <Button type="button" variant="secondary" onClick={() => copy(state.naddr)}>
            {copied ? <Check aria-hidden /> : <Copy aria-hidden />} {copied ? 'Copied' : 'Copy'}
          </Button>
        </div>
        <div className="flex gap-2">
          <Button
            type="button"
            variant="secondary"
            className="flex-1"
            onClick={() => {
              if (onView) onView.open(state.naddr);
              else open('app-store', { package: state.naddr });
              onClose();
            }}
          >
            <Store aria-hidden />
            {onView?.label ?? 'View in App Store'}
          </Button>
          <Button className="flex-1" onClick={onClose}>Done</Button>
        </div>
      </>
    );
  }

  const busy = state.state === 'publishing';
  return (
    <form onSubmit={submit} className="flex flex-col gap-6">
      <DialogHeader>
        <DialogTitle className="text-xl">Publish {target.name} to Nostr</DialogTitle>
        <DialogDescription>
          Shares {WHAT[target.type]} with people who follow you, in {WHERE[target.type]}.
        </DialogDescription>
      </DialogHeader>
      <div className="space-y-2">
        <Label htmlFor="package-title">Name</Label>
        <Input id="package-title" value={title} onChange={(e) => setTitle(e.target.value)} disabled={busy} maxLength={80} />
      </div>
      <div className="space-y-2">
        <Label htmlFor="package-summary">Description</Label>
        <Textarea
          id="package-summary"
          value={summary}
          onChange={(e) => setSummary(e.target.value)}
          disabled={busy}
          maxLength={500}
          rows={3}
          placeholder="Optional"
        />
      </div>
      {busy && (
        <div className="space-y-2" aria-live="polite">
          <Progress value={state.percent ?? 0} />
          <p className="text-sm text-muted-foreground">{state.step}</p>
        </div>
      )}
      {!user && <p className="text-sm text-muted-foreground">Sign in to publish.</p>}
      {state.state === 'error' && (
        <p className="flex gap-2 text-sm text-destructive" role="alert">
          <AlertTriangle className="mt-0.5 size-4 shrink-0" aria-hidden /> {state.message}
        </p>
      )}
      <Button type="submit" size="lg" className="w-full rounded-full" disabled={busy || !user || !title.trim()}>
        {busy ? <Loader2 className="animate-spin" aria-hidden /> : <Share aria-hidden />}
        {busy ? 'Publishing…' : 'Publish'}
      </Button>
    </form>
  );
}
