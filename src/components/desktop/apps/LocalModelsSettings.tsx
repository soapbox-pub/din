import { useState } from 'react';
import { BrainCircuit, ChevronDown, CircleAlert, Copy, Download, Loader2, MoreHorizontal, Square, Trash2 } from 'lucide-react';
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
import { Button } from '@/components/ui/button';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible';
import { ContextMenu, ContextMenuContent, ContextMenuItem, ContextMenuSeparator, ContextMenuTrigger } from '@/components/ui/context-menu';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from '@/components/ui/dropdown-menu';
import { Progress } from '@/components/ui/progress';
import { Skeleton } from '@/components/ui/skeleton';
import { useFeatures } from '@/hooks/useFeatures';
import { useLocalModels } from '@/hooks/useLocalModels';
import { useToast } from '@/hooks/useToast';
import { cleanFeaturesError, describeFeature, findFeature, formatFeatureSize, getFeaturesBridge } from '@/lib/features';
import {
  cleanLocalModelsError,
  describePull,
  formatModelSize,
  getLocalModelsBridge,
  LOCAL_AI_FEATURE,
  localModelTitle,
  pullProgress,
  rankLocalModels,
  type LocalModel,
  type LocalModelPick,
  type LocalModelsState,
  type LocalPull,
} from '@/lib/localModels';
import { cn } from '@/lib/utils';
import { settingsEmpty, settingsGroup } from '@/shared/settingsChromeStyles';

/**
 * Settings → Assistant → Models on this computer: Ollama (the `local-ai`
 * optional feature on DinOS) and its models. Until one is downloaded, it
 * offers the best for this computer (src/lib/localModels.ts); the rest of
 * the catalog this Ollama can run is under Other models, each with a word
 * about why it isn't the one. The assistant lists downloaded models with its others, through
 * OpenCode's Ollama provider. `din assistant models` and its siblings do
 * the same from a command.
 */
export function LocalModelsSettings() {
  const bridge = getLocalModelsBridge();
  const local = useLocalModels();
  const { toast } = useToast();
  const [removing, setRemoving] = useState<string | null>(null);
  const [heavy, setHeavy] = useState<LocalModelPick | null>(null);

  if (!bridge) return null;
  const state = local.data;

  const download = (name: string) => {
    bridge.pull(name).then(
      () => toast({ title: `${localModelTitle(name)} is ready`, description: 'Choose it in the assistant’s model list.' }),
      (error: unknown) => {
        const message = cleanLocalModelsError(error);
        if (message !== 'Stopped') toast({ title: `Couldn’t download ${localModelTitle(name)}`, description: message, variant: 'destructive' });
      },
    );
  };
  const stop = (name: string) => void bridge.cancel(name).catch(() => {});
  const remove = (name: string) => {
    bridge.remove(name).catch((error: unknown) =>
      toast({ title: `Couldn’t remove ${localModelTitle(name)}`, description: cleanLocalModelsError(error), variant: 'destructive' }),
    );
  };
  const offer = (pick: LocalModelPick) => (pick.fit.fit === 'good' ? download(pick.name) : setHeavy(pick));

  return (
    <div className="space-y-3">
      <div className="px-1">
        <h3 className="text-sm font-semibold text-foreground/90">Models on this computer</h3>
        <p className="text-xs text-muted-foreground">Private AI that runs here, even offline.</p>
      </div>

      {local.isLoading ? (
        <Skeleton className="h-16 w-full rounded-xl" />
      ) : !state || !state.available ? (
        <NotInstalled />
      ) : !state.running ? (
        <div className={cn(settingsGroup, 'px-4 py-3')}>
          <p role="alert" className="flex items-start gap-2 text-xs text-destructive">
            <CircleAlert className="mt-0.5 size-3.5 shrink-0" aria-hidden />
            <span className="break-words">{state.error ?? 'Ollama isn’t running.'}</span>
          </p>
        </div>
      ) : (
        <Models state={state} onDownload={download} onStop={stop} onRemove={setRemoving} onOffer={offer} />
      )}

      <AlertDialog open={removing !== null} onOpenChange={(open) => !open && setRemoving(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Remove {removing && localModelTitle(removing)}?</AlertDialogTitle>
            <AlertDialogDescription>The assistant can’t use it until you download it again.</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              variant="destructive"
              onClick={() => {
                if (removing) remove(removing);
                setRemoving(null);
              }}
            >
              Remove
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <AlertDialog open={heavy !== null} onOpenChange={(open) => !open && setHeavy(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Download {heavy?.title}?</AlertDialogTitle>
            <AlertDialogDescription>
              {heavy?.fit.reason}. {heavy?.fit.fit === 'too-big' ? 'It may not start at all.' : 'The assistant would take minutes to answer.'}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => {
                if (heavy) download(heavy.name);
                setHeavy(null);
              }}
            >
              Download Anyway
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}

/** Ollama isn't here: on DinOS, its optional feature, on its way or removed; elsewhere, where to get it. */
function NotInstalled() {
  const features = useFeatures();
  const { toast } = useToast();
  const feature = findFeature(features.data, LOCAL_AI_FEATURE);
  const canInstall = feature && (features.data?.source !== 'packages' || feature.command !== null);
  const install = () =>
    getFeaturesBridge()
      ?.install(LOCAL_AI_FEATURE)
      .catch((error: unknown) => toast({ title: 'Couldn’t install Local AI models', description: cleanFeaturesError(error), variant: 'destructive' }));

  return (
    <div className={cn(settingsGroup, 'flex items-center justify-between gap-4 px-4 py-3')}>
      <div className="min-w-0">
        <p className="text-sm">Ollama isn’t installed</p>
        <p className="text-xs text-muted-foreground">
          {feature ? describeFeature(feature, features.data?.live) : 'Install it from ollama.com.'}
        </p>
      </div>
      {canInstall && !feature.installed && !feature.busy && (
        <Button variant="outline" size="sm" className="shrink-0" onClick={install}>
          <Download className="size-4.5" strokeWidth={1.75} aria-hidden />
          Install ({formatFeatureSize(feature.size)})
        </Button>
      )}
      {feature?.busy && <Loader2 className="size-4 shrink-0 animate-spin text-muted-foreground" aria-hidden />}
    </div>
  );
}

/** "qwen3.6" and "qwen3.6:latest" are the same model. */
function normalize(name: string): string {
  return name.includes(':') ? name : `${name}:latest`;
}

function Models({
  state,
  onDownload,
  onStop,
  onRemove,
  onOffer,
}: {
  state: LocalModelsState;
  onDownload: (name: string) => void;
  onStop: (name: string) => void;
  onRemove: (name: string) => void;
  onOffer: (pick: LocalModelPick) => void;
}) {
  const { best, others } = rankLocalModels(state);
  const installed = new Set(state.models.map((m) => normalize(m.name)));
  const pulling = new Map(state.pulls.map((p) => [normalize(p.model), p]));
  const known = new Set([best, ...others].filter((m) => m !== null).map((m) => normalize(m.name)));
  // The best is offered only until there's a model to use; after that it's one of the others.
  const offerBest = best !== null && state.models.length === 0;
  // Those this Ollama can't run aren't offered: they come once it's updated.
  const rest = [...(best && !offerBest ? [best] : []), ...others].filter(
    (m) => !installed.has(normalize(m.name)) && m.fit.fit !== 'unsupported',
  );
  // Downloads of models the catalog doesn't have (`ollama pull`, `din assistant download-model`).
  const otherPulls = state.pulls.filter((p) => !installed.has(normalize(p.model)) && !known.has(normalize(p.model)));

  return (
    <>
      {state.models.length > 0 || otherPulls.length > 0 || offerBest ? (
        <ul className={settingsGroup} aria-label="Models on this computer">
          {state.models.map((model) => (
            <InstalledRow
              key={model.name}
              model={model}
              best={best !== null && normalize(best.name) === normalize(model.name)}
              onRemove={() => onRemove(model.name)}
            />
          ))}
          {otherPulls.map((pull) => (
            <PullRow key={pull.model} pull={pull} onStop={() => onStop(pull.model)} onRetry={() => onDownload(pull.model)} />
          ))}
          {offerBest && (
            <OfferRow pick={best} pull={pulling.get(normalize(best.name))} onDownload={() => onOffer(best)} onStop={() => onStop(best.name)} />
          )}
        </ul>
      ) : (
        <div className={settingsGroup}>
          <p className={settingsEmpty}>None of the models Din knows runs well on this computer.</p>
        </div>
      )}

      {rest.length > 0 && (
        <Collapsible>
          <CollapsibleTrigger asChild>
            <Button variant="ghost" size="sm" className="group text-muted-foreground">
              <ChevronDown className="size-4.5 transition-transform group-data-[state=open]:rotate-180" strokeWidth={1.75} aria-hidden />
              Other models
            </Button>
          </CollapsibleTrigger>
          <CollapsibleContent className="pt-2">
            <ul className={settingsGroup} aria-label="Other models">
              {rest.map((pick) => (
                <OfferRow key={pick.name} pick={pick} pull={pulling.get(normalize(pick.name))} onDownload={() => onOffer(pick)} onStop={() => onStop(pick.name)} />
              ))}
            </ul>
          </CollapsibleContent>
        </Collapsible>
      )}
    </>
  );
}

function ModelIcon({ installed }: { installed: boolean }) {
  return (
    <span
      className={cn(
        'flex size-9 shrink-0 items-center justify-center rounded-full',
        installed ? 'bg-pigment text-primary-foreground clay-pigment' : 'bg-foreground/10 text-foreground/75 clay',
      )}
    >
      <BrainCircuit className="size-4.5" strokeWidth={1.75} aria-hidden />
    </span>
  );
}

function BestBadge() {
  return <span className="rounded-full bg-selected px-2 py-0.5 text-xs font-medium text-ink-accent">Best for this computer</span>;
}

function InstalledRow({ model, best, onRemove }: { model: LocalModel; best: boolean; onRemove: () => void }) {
  const title = localModelTitle(model.name);
  const details = [formatModelSize(model.size), model.loaded ? 'In use' : null, model.tools === false ? 'Can’t use tools' : null].filter(Boolean);
  const copy = () => void navigator.clipboard.writeText(`ollama/${model.name}`).catch(() => {});

  return (
    <li>
      <ContextMenu>
        <ContextMenuTrigger asChild>
          <div className="flex items-center gap-3 py-3 pr-2 pl-4">
            <ModelIcon installed />
            <div className="flex min-w-0 flex-1 flex-col gap-0.5">
              <span className="flex flex-wrap items-center gap-x-2 text-sm font-medium text-foreground" title={model.name}>
                {title}
                {best && <BestBadge />}
              </span>
              <span className="text-xs text-muted-foreground">{details.join(' · ')}</span>
            </div>
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button variant="ghost" size="icon" aria-label={`More for ${title}`}>
                  <MoreHorizontal className="size-4.5" strokeWidth={1.75} aria-hidden />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end">
                <DropdownMenuItem onSelect={copy}>
                  <Copy aria-hidden />
                  Copy Model ID
                </DropdownMenuItem>
                <DropdownMenuSeparator />
                <DropdownMenuItem variant="destructive" onSelect={onRemove}>
                  <Trash2 aria-hidden />
                  Remove…
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          </div>
        </ContextMenuTrigger>
        <ContextMenuContent>
          <ContextMenuItem onSelect={copy}>
            <Copy aria-hidden />
            Copy Model ID
          </ContextMenuItem>
          <ContextMenuSeparator />
          <ContextMenuItem variant="destructive" onSelect={onRemove}>
            <Trash2 aria-hidden />
            Remove…
          </ContextMenuItem>
        </ContextMenuContent>
      </ContextMenu>
    </li>
  );
}

/** Why a model isn't the one, in a word or two. */
function shortReason(pick: LocalModelPick): string | null {
  switch (pick.fit.fit) {
    case 'slow':
      return 'Slow here';
    case 'too-big':
      return 'Too big for this computer';
    default:
      return null;
  }
}

function OfferRow({ pick, pull, onDownload, onStop }: { pick: LocalModelPick; pull?: LocalPull; onDownload: () => void; onStop: () => void }) {
  const reason = shortReason(pick);

  return (
    <li className="flex items-center gap-3 py-3 pr-3 pl-4">
      <ModelIcon installed={false} />
      <div className="flex min-w-0 flex-1 flex-col gap-0.5">
        <span className="flex flex-wrap items-center gap-x-2 text-sm font-medium text-foreground">
          {pick.title}
          {pick.best && <BestBadge />}
        </span>
        {pull ? (
          <PullProgress pull={pull} size={pick.size} />
        ) : (
          <span className="text-xs text-muted-foreground" title={pick.fit.reason ?? undefined}>
            {pick.maker} · {formatModelSize(pick.size)}
            {reason && <span className="text-warning"> · {reason}</span>}
          </span>
        )}
      </div>
      {pull && !pull.error ? (
        <Button variant="outline" size="sm" className="shrink-0" onClick={onStop}>
          <Square className="size-3.5 fill-current" aria-hidden />
          Stop
        </Button>
      ) : (
        <Button variant={pick.best ? 'default' : 'outline'} size="sm" className="shrink-0" onClick={onDownload}>
          <Download className="size-4.5" strokeWidth={1.75} aria-hidden />
          {pull?.error ? 'Try Again' : 'Download'}
        </Button>
      )}
    </li>
  );
}

function PullRow({ pull, onStop, onRetry }: { pull: LocalPull; onStop: () => void; onRetry: () => void }) {
  return (
    <li className="flex items-center gap-3 py-3 pr-3 pl-4">
      <ModelIcon installed={false} />
      <div className="flex min-w-0 flex-1 flex-col gap-0.5">
        <span className="truncate text-sm font-medium text-foreground">{localModelTitle(pull.model)}</span>
        <PullProgress pull={pull} />
      </div>
      <Button variant="outline" size="sm" className="shrink-0" onClick={pull.error ? onRetry : onStop}>
        {pull.error ? <Download className="size-4.5" strokeWidth={1.75} aria-hidden /> : <Square className="size-3.5 fill-current" aria-hidden />}
        {pull.error ? 'Try Again' : 'Stop'}
      </Button>
    </li>
  );
}

function PullProgress({ pull, size }: { pull: LocalPull; size?: number }) {
  const progress = pullProgress(pull, size);
  if (pull.error) {
    return (
      <span role="alert" className="text-xs text-destructive">
        {pull.error}
      </span>
    );
  }
  return (
    <>
      <span className="text-xs text-muted-foreground" aria-live="polite">
        {describePull(pull, size)}
        {pull.total > 0 && ` · ${formatModelSize(pull.completed)} of ${formatModelSize(Math.max(pull.total, size ?? 0))}`}
      </span>
      <Progress
        className={cn('mt-1 h-1.5', progress === null && 'opacity-60 motion-safe:animate-pulse')}
        value={progress !== null ? progress * 100 : 100}
        aria-label={`Downloading ${localModelTitle(pull.model)}`}
      />
    </>
  );
}
