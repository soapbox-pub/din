import { useState, type ReactNode } from 'react';
import type { LucideIcon } from 'lucide-react';
import { AppWindow, Ban, Boxes, Download, EllipsisVertical, Globe, Loader2, Mic, Monitor, PackagePlus, Trash2, TriangleAlert } from 'lucide-react';
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
import { ContextMenu, ContextMenuContent, ContextMenuItem, ContextMenuTrigger } from '@/components/ui/context-menu';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from '@/components/ui/dropdown-menu';
import { Progress } from '@/components/ui/progress';
import { Skeleton } from '@/components/ui/skeleton';
import { useFeatures } from '@/hooks/useFeatures';
import { useToast } from '@/hooks/useToast';
import {
  cleanFeaturesError,
  describeFeature,
  formatFeatureSize,
  getFeaturesBridge,
  removalConsequence,
  type FeatureState,
} from '@/lib/features';
import { cn } from '@/lib/utils';

const ICONS: Record<string, LucideIcon> = {
  windows: AppWindow,
  vms: Monitor,
  dictation: Mic,
  containers: Boxes,
  webkit: Globe,
};

/**
 * Settings → Optional Features: the parts of DinOS that aren't on the disk
 * until they're wanted (electron/features.mts), each installed or removed
 * here, or all installed at once. `din features` does the same.
 */
export function OptionalFeaturesSection() {
  const bridge = getFeaturesBridge();
  const features = useFeatures();
  const { toast } = useToast();
  const [removing, setRemoving] = useState<FeatureState | null>(null);

  const list = features.data?.features ?? [];
  const missing = list.filter((f) => !f.installed && !f.busy);
  const missingSize = missing.reduce((sum, f) => sum + f.size, 0);

  const failed = (title: string) => (error: unknown) =>
    toast({ title, description: cleanFeaturesError(error), variant: 'destructive' });

  const install = (feature: FeatureState) => {
    bridge?.install(feature.id).catch(failed(`Couldn’t install ${feature.title}`));
  };
  const installAll = () => {
    bridge?.installAll().catch(failed('Couldn’t install everything'));
  };
  const remove = (feature: FeatureState) => {
    bridge?.remove(feature.id).catch(failed(`Couldn’t remove ${feature.title}`));
  };
  // One that comes with the computer and hasn't downloaded: nothing to lose, so no question.
  const decline = (feature: FeatureState) => {
    bridge?.remove(feature.id).catch(failed(`Couldn’t change ${feature.title}`));
  };

  return (
    <section className="mx-auto flex max-w-2xl flex-col gap-4 p-4">
      <header className="flex items-center justify-between gap-2">
        <h2 className="text-lg font-semibold text-foreground">Optional Features</h2>
        {features.data?.available && missing.length > 1 && (
          <Button variant="outline" size="sm" onClick={installAll}>
            <Download className="size-4" aria-hidden />
            Install All ({formatFeatureSize(missingSize)})
          </Button>
        )}
      </header>
      <p className="text-sm text-muted-foreground">
        Parts of DinOS that take a lot of space, kept off the disk until you want them. Each downloads from the
        internet when you install it, and comes back to the size it was when you remove it. Dictation comes with
        DinOS, and downloads in the background once it’s installed.
      </p>

      {!bridge ? (
        <Fallback>Optional features are DinOS’s; they aren’t available in a plain browser.</Fallback>
      ) : features.isLoading ? (
        <ul className="flex flex-col gap-2" aria-hidden>
          {[0, 1, 2].map((i) => (
            <li key={i} className="flex items-center gap-3 rounded-lg border border-border/60 px-3 py-3">
              <Skeleton className="size-8 rounded-md" />
              <div className="flex flex-1 flex-col gap-1.5">
                <Skeleton className="h-4 w-40" />
                <Skeleton className="h-3 w-64" />
              </div>
              <Skeleton className="h-8 w-20" />
            </li>
          ))}
        </ul>
      ) : features.isError ? (
        <Fallback>Couldn’t read the optional features: {cleanFeaturesError(features.error)}</Fallback>
      ) : !features.data?.available ? (
        <Fallback>This computer has no optional features to install: everything Din uses is already part of it.</Fallback>
      ) : (
        <ul className="flex flex-col gap-2" aria-label="Optional features">
          {list.map((feature) => (
            <FeatureRow
              key={feature.id}
              feature={feature}
              live={features.data?.live ?? false}
              onInstall={() => install(feature)}
              onRemove={() => (feature.installed ? setRemoving(feature) : decline(feature))}
            />
          ))}
        </ul>
      )}

      <AlertDialog open={removing !== null} onOpenChange={(open) => !open && setRemoving(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Remove {removing?.title}?</AlertDialogTitle>
            <AlertDialogDescription>
              {removing && removalConsequence(removing)} It frees about {removing && formatFeatureSize(removing.size)}.
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
    </section>
  );
}

function FeatureRow({
  feature,
  live,
  onInstall,
  onRemove,
}: {
  feature: FeatureState;
  live: boolean;
  onInstall: () => void;
  onRemove: () => void;
}) {
  const Icon = ICONS[feature.id] ?? PackagePlus;
  const busy = feature.busy;
  const progress = busy && busy.phase !== 'waiting' && busy.progress !== null ? busy.progress : null;

  return (
    <li>
      <ContextMenu>
        <ContextMenuTrigger asChild>
          <div
            className={cn(
              'flex items-center gap-3 rounded-lg border border-border/60 bg-background/40 px-3 py-3',
              feature.installed && 'border-primary/30',
            )}
          >
            <span
              className={cn(
                'flex size-9 shrink-0 items-center justify-center rounded-md bg-muted text-muted-foreground',
                feature.installed && 'bg-primary/10 text-primary',
              )}
            >
              <Icon className="size-5" aria-hidden />
            </span>
            <div className="flex min-w-0 flex-1 flex-col gap-0.5">
              <span className="text-sm font-medium text-foreground">{feature.title}</span>
              <span className="text-xs text-muted-foreground">{feature.description}</span>
              <span className="text-xs text-muted-foreground" aria-live="polite">
                {describeFeature(feature, live)}
              </span>
              {busy && busy.action === 'install' && (
                <Progress
                  className={cn('mt-1 h-1.5', progress === null && 'opacity-60 motion-safe:animate-pulse')}
                  value={progress !== null ? progress * 100 : 100}
                  aria-label={`Installing ${feature.title}`}
                />
              )}
              {feature.error && !busy && (
                <span role="alert" className="mt-0.5 flex items-start gap-1 text-xs text-destructive">
                  <TriangleAlert className="mt-0.5 size-3 shrink-0" aria-hidden />
                  {feature.error}
                </span>
              )}
            </div>
            {busy ? (
              <Loader2 className="size-4 shrink-0 animate-spin text-muted-foreground" aria-hidden />
            ) : feature.installed || feature.wanted ? (
              <div className="flex shrink-0 items-center gap-1">
                {!feature.installed && (
                  <Button variant="outline" size="sm" onClick={onInstall}>
                    <Download className="size-4" aria-hidden />
                    Download Now
                  </Button>
                )}
                  <DropdownMenu>
                  <DropdownMenuTrigger asChild>
                    <Button variant="ghost" size="icon" aria-label={`More for ${feature.title}`}>
                      <EllipsisVertical className="size-4" aria-hidden />
                    </Button>
                  </DropdownMenuTrigger>
                  <DropdownMenuContent align="end">
                    <FeatureMenuItems feature={feature} Item={DropdownMenuItem} onInstall={onInstall} onRemove={onRemove} />
                  </DropdownMenuContent>
                </DropdownMenu>
              </div>
            ) : (
              <Button variant="outline" size="sm" onClick={onInstall}>
                <Download className="size-4" aria-hidden />
                Install
              </Button>
            )}
          </div>
        </ContextMenuTrigger>
        <ContextMenuContent>
          <FeatureMenuItems feature={feature} Item={ContextMenuItem} onInstall={onInstall} onRemove={onRemove} />
        </ContextMenuContent>
      </ContextMenu>
    </li>
  );
}

/** The row's actions, the same in its ⋯ menu and its right-click menu. */
function FeatureMenuItems({
  feature,
  Item,
  onInstall,
  onRemove,
}: {
  feature: FeatureState;
  Item: typeof ContextMenuItem | typeof DropdownMenuItem;
  onInstall: () => void;
  onRemove: () => void;
}) {
  const busy = feature.busy !== null;
  return (
    <>
      {(!feature.installed || !feature.current) && (
        <Item disabled={busy} onSelect={onInstall}>
          <Download aria-hidden />
          {feature.installed ? 'Update Now' : feature.wanted ? 'Download Now' : 'Install'}
        </Item>
      )}
      {!feature.installed && feature.wanted && (
        <Item disabled={busy} onSelect={onRemove}>
          <Ban aria-hidden />
          Don’t Download
        </Item>
      )}
      {feature.installed && (
        <Item variant="destructive" disabled={busy} onSelect={onRemove}>
          <Trash2 aria-hidden />
          Remove…
        </Item>
      )}
    </>
  );
}

function Fallback({ children }: { children: ReactNode }) {
  return (
    <div className="rounded-xl border border-dashed border-border px-8 py-12 text-center">
      <PackagePlus className="mx-auto mb-4 size-8 text-muted-foreground/80" aria-hidden />
      <p className="mx-auto max-w-sm text-sm text-muted-foreground">{children}</p>
    </div>
  );
}
