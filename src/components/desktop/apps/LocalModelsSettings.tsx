import { useState, type FormEvent } from 'react';
import { BrainCircuit, ChevronDown, CircleAlert, Copy, Download, Loader2, MoreHorizontal, Square, Trash2, TriangleAlert } from 'lucide-react';
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
import { Input } from '@/components/ui/input';
import { Progress } from '@/components/ui/progress';
import { Skeleton } from '@/components/ui/skeleton';
import { useFeatures } from '@/hooks/useFeatures';
import { useLocalModels } from '@/hooks/useLocalModels';
import { useToast } from '@/hooks/useToast';
import { cleanFeaturesError, describeFeature, findFeature, formatFeatureSize, getFeaturesBridge } from '@/lib/features';
import {
  catalogEntry,
  cleanLocalModelsError,
  describeHardware,
  describePull,
  describeSpeed,
  fitLocalModel,
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
 * optional feature on DinOS), the models it has, and the ones worth
 * downloading here, best first, from what the GPU and memory allow
 * (src/lib/localModels.ts). The assistant lists whatever is downloaded
 * with its other models, through OpenCode's Ollama provider. `din
 * assistant models` and its siblings do the same from a command.
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
        <p className="text-xs text-muted-foreground">
          AI models that run here, with nothing sent anywhere, and that work offline. They’re slower and less capable than the
          big providers’, and the best ones take a lot of memory.
        </p>
      </div>

      {local.isLoading ? (
        <Skeleton className="h-32 w-full rounded-xl" />
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
            <AlertDialogDescription>
              It’s deleted from this computer, and the assistant can’t use it until you download it again.
            </AlertDialogDescription>
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
            <AlertDialogTitle>{heavy?.fit.fit === 'too-big' ? `${heavy.title} is too big for this computer` : `${heavy?.title} will be slow here`}</AlertDialogTitle>
            <AlertDialogDescription>
              {heavy?.fit.fit === 'too-big'
                ? `It needs about ${formatModelSize(heavy.fit.memory)} of memory to run, more than this computer can give it. It may not start at all, or make everything else slow while it runs.`
                : `It would write only a few words a second here, so the assistant would take minutes to answer. A recommended model is faster.`}{' '}
              The download is {heavy && formatModelSize(heavy.size)}.
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
      <div className="flex min-w-0 items-center gap-3">
        <span className="flex size-9 shrink-0 items-center justify-center rounded-full bg-foreground/10 text-foreground/75 clay">
          <BrainCircuit className="size-4.5" strokeWidth={1.75} aria-hidden />
        </span>
        <div className="min-w-0">
          <p className="text-sm">Ollama isn’t installed</p>
          <p className="text-xs text-muted-foreground">
            {feature
              ? `It runs the models. ${describeFeature(feature, features.data?.live)}.`
              : 'It runs the models. Install it from ollama.com, and Din starts it and lists its models here.'}
          </p>
        </div>
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
  const { picks, others } = rankLocalModels(state);
  const installed = new Set(state.models.map((m) => normalize(m.name)));
  const pulling = new Map(state.pulls.map((p) => [normalize(p.model), p]));
  const notHere = (m: LocalModelPick) => !installed.has(normalize(m.name));
  const offeredPicks = picks.filter(notHere);
  const offeredOthers = others.filter(notHere);
  // Downloads that aren't one of the catalog's offers: "Other model…"'s.
  const otherPulls = state.pulls.filter((p) => !installed.has(normalize(p.model)) && !picks.concat(others).some((m) => normalize(m.name) === normalize(p.model)));

  return (
    <>
      <p className="px-1 text-xs text-muted-foreground">
        {describeHardware(state)}
      </p>

      {(state.models.length > 0 || otherPulls.length > 0) && (
        <>
          <h4 className={subheading}>Downloaded · the assistant lists them under Ollama</h4>
          <ul className={settingsGroup} aria-label="Downloaded models">
            {state.models.map((model) => (
              <InstalledRow
                key={model.name}
                model={model}
                state={state}
                best={picks[0] !== undefined && normalize(picks[0].name) === normalize(model.name)}
                onRemove={() => onRemove(model.name)}
              />
            ))}
            {otherPulls.map((pull) => (
              <PullRow key={pull.model} pull={pull} onStop={() => onStop(pull.model)} onRetry={() => onDownload(pull.model)} />
            ))}
          </ul>
        </>
      )}

      {offeredPicks.length > 0 ? (
        <>
          <h4 className={subheading}>Recommended for this computer</h4>
          <ul className={settingsGroup} aria-label="Recommended for this computer">
            {offeredPicks.map((pick) => (
              <OfferRow key={pick.name} pick={pick} pull={pulling.get(normalize(pick.name))} onDownload={() => onOffer(pick)} onStop={() => onStop(pick.name)} />
            ))}
          </ul>
        </>
      ) : (
        picks.length === 0 && (
          <div className={settingsGroup}>
            <p className={settingsEmpty}>
              None of the models Din knows runs well on this computer. A smaller one below still works, slowly.
            </p>
          </div>
        )
      )}

      <Collapsible>
        <CollapsibleTrigger asChild>
          <Button variant="ghost" size="sm" className="group text-muted-foreground">
            <ChevronDown className="size-4.5 transition-transform group-data-[state=open]:rotate-180" strokeWidth={1.75} aria-hidden />
            More models
          </Button>
        </CollapsibleTrigger>
        <CollapsibleContent className="space-y-3 pt-2">
          {offeredOthers.length > 0 && (
            <ul className={settingsGroup} aria-label="Other models">
              {offeredOthers.map((pick) => (
                <OfferRow key={pick.name} pick={pick} pull={pulling.get(normalize(pick.name))} onDownload={() => onOffer(pick)} onStop={() => onStop(pick.name)} />
              ))}
            </ul>
          )}
          <OtherModel onDownload={onDownload} />
        </CollapsibleContent>
      </Collapsible>
    </>
  );
}

const subheading = 'px-1 pt-1 text-xs font-semibold text-muted-foreground';

/** "qwen3.6" and "qwen3.6:latest" are the same model. */
function normalize(name: string): string {
  return name.includes(':') ? name : `${name}:latest`;
}

function InstalledRow({ model, state, best, onRemove }: { model: LocalModel; state: LocalModelsState; best: boolean; onRemove: () => void }) {
  const entry = catalogEntry(model.name);
  const fit = entry ? fitLocalModel(entry, state) : null;
  const details = [
    formatModelSize(model.size),
    model.parameters,
    model.loaded ? 'In memory now' : null,
    fit && fit.fit !== 'good' ? fit.reason : null,
  ].filter(Boolean);
  const copy = () => void navigator.clipboard.writeText(`ollama/${model.name}`).catch(() => {});

  return (
    <li>
      <ContextMenu>
        <ContextMenuTrigger asChild>
          <div className="flex items-center gap-3 py-3 pr-2 pl-4">
            <span className="flex size-9 shrink-0 items-center justify-center rounded-full bg-pigment text-primary-foreground clay-pigment">
              <BrainCircuit className="size-4.5" strokeWidth={1.75} aria-hidden />
            </span>
            <div className="flex min-w-0 flex-1 flex-col gap-0.5">
              <span className="flex flex-wrap items-center gap-x-2 text-sm font-medium text-foreground" title={model.name}>
                {localModelTitle(model.name)}
                {best && <BestBadge />}
              </span>
              <span className="text-xs text-muted-foreground">{details.join(' · ')}</span>
              {model.tools === false && (
                <span className="flex items-start gap-1 text-xs text-warning">
                  <TriangleAlert className="mt-0.5 size-3 shrink-0" aria-hidden />
                  It can’t use tools, so the assistant can only chat with it.
                </span>
              )}
            </div>
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button variant="ghost" size="icon" aria-label={`More for ${localModelTitle(model.name)}`}>
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

function OfferRow({ pick, pull, onDownload, onStop }: { pick: LocalModelPick; pull?: LocalPull; onDownload: () => void; onStop: () => void }) {
  const good = pick.fit.fit === 'good';
  const details = [
    formatModelSize(pick.size),
    pick.active < pick.parameters ? `${pick.parameters}B, ${pick.active}B at a time` : `${pick.parameters}B`,
    good ? `${describeSpeed(pick.fit.speed)}${pick.fit.where === 'cpu' ? ' on the processor' : ''}` : null,
  ].filter(Boolean);

  return (
    <li className="flex items-center gap-3 py-3 pr-3 pl-4">
      <span
        className={cn(
          'flex size-9 shrink-0 items-center justify-center rounded-full clay',
          good ? 'bg-foreground/10 text-ink-accent' : 'bg-foreground/5 text-muted-foreground',
        )}
      >
        <BrainCircuit className="size-4.5" strokeWidth={1.75} aria-hidden />
      </span>
      <div className="flex min-w-0 flex-1 flex-col gap-0.5">
        <span className="flex flex-wrap items-center gap-x-2 text-sm font-medium text-foreground">
          {pick.title}
          <span className="text-xs font-normal text-muted-foreground">{pick.maker}</span>
          {pick.best && <BestBadge />}
        </span>
        <span className="text-xs text-muted-foreground">{pick.blurb}</span>
        <span className="text-xs text-muted-foreground">{details.join(' · ')}</span>
        {!good && (
          <span className="flex items-start gap-1 text-xs text-warning">
            <TriangleAlert className="mt-0.5 size-3 shrink-0" aria-hidden />
            {pick.fit.reason}
          </span>
        )}
        {pull && <PullProgress pull={pull} size={pick.size} />}
      </div>
      {pick.fit.fit === 'unsupported' ? null : pull && !pull.error ? (
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

function BestBadge() {
  return <span className="rounded-full bg-selected px-2 py-0.5 text-xs font-medium text-ink-accent">Best for this computer</span>;
}

function PullRow({ pull, onStop, onRetry }: { pull: LocalPull; onStop: () => void; onRetry: () => void }) {
  return (
    <li className="flex items-center gap-3 py-3 pr-3 pl-4">
      <span className="flex size-9 shrink-0 items-center justify-center rounded-full bg-foreground/10 text-foreground/75 clay">
        <BrainCircuit className="size-4.5" strokeWidth={1.75} aria-hidden />
      </span>
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
      <span role="alert" className="flex items-start gap-1 text-xs text-destructive">
        <TriangleAlert className="mt-0.5 size-3 shrink-0" aria-hidden />
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

/** Any model in Ollama's library, by its name. */
function OtherModel({ onDownload }: { onDownload: (name: string) => void }) {
  const [name, setName] = useState('');
  const submit = (event: FormEvent) => {
    event.preventDefault();
    const trimmed = name.trim();
    if (!trimmed) return;
    onDownload(trimmed);
    setName('');
  };
  return (
    <form onSubmit={submit} className={cn(settingsGroup, 'flex flex-col gap-2 px-4 py-3')}>
      <label htmlFor="local-model-name" className="text-sm">
        Another model
      </label>
      <p className="text-xs text-muted-foreground">
        Any model in Ollama’s library, by its name and tag, as ollama.com/library shows it. The assistant needs one that can use
        tools.
      </p>
      <div className="flex gap-2">
        <Input
          id="local-model-name"
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="gemma4:12b"
          spellCheck={false}
          autoCapitalize="off"
          autoCorrect="off"
          className="h-8 flex-1 font-mono text-sm"
        />
        <Button type="submit" variant="outline" size="sm" disabled={!name.trim()}>
          <Download className="size-4.5" strokeWidth={1.75} aria-hidden />
          Download
        </Button>
      </div>
    </form>
  );
}
