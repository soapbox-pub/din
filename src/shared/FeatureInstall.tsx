import { useEffect, useRef, type ReactNode } from 'react';
import { Download, Loader2, TriangleAlert } from 'lucide-react';
import { useFeatures, useInstallableFeature } from '@/hooks/useFeatures';
import { describeFeature, findFeature, formatFeatureSize, getAppFeaturesBridge, listMissing } from '@/lib/features';
import { cn } from '@/lib/utils';
import { PillButton } from '@/shared/appChrome';

/**
 * Installing an optional feature where something can't work without it
 * (electron/features.mts: DinOS's own, or the system's packages
 * elsewhere), on the desktop or in an app granted `features`: a button that
 * installs it right there, its progress while it does, and why it failed.
 * Nothing where it's installed, or isn't one Din can install here, so it
 * can go beside any failure of something that needs the feature: where it's
 * installed, the failure was something else.
 */

/** Call `onInstalled` once the feature goes from missing to installed. */
function useOnInstalled(key: string | null | undefined, onInstalled: (() => void) | undefined): void {
  const features = useFeatures();
  // Unknown until the features have loaded, so their first answer isn't taken for a change.
  const installed = features.data === undefined ? null : (findFeature(features.data, key)?.installed ?? false);
  const was = useRef(installed);
  useEffect(() => {
    if (installed && was.current === false) onInstalled?.();
    if (installed !== null) was.current = installed;
  }, [installed, onInstalled]);
}

/**
 * Install (450 MB), or how installing is going, and why it failed. A feature
 * that's partly there (the system has some of its packages: bsdtar but not
 * unar) says what's missing, and installs the rest: what failed beside it
 * may have failed for something else, which the rest might still fix.
 */
export function FeatureInstallButton({
  feature: key,
  onInstalled,
  size = 'md',
  inline = false,
  className,
  fallback = null,
}: {
  /** The feature's id ("archives"), or null for none. */
  feature: string | null | undefined;
  /** Once it's installed, for what has to look again. */
  onInstalled?: () => void;
  size?: 'md' | 'sm';
  /** In a row, as small as a status bar's text: Files' status bar. */
  inline?: boolean;
  className?: string;
  /** What to show instead where Din can't install it from here. */
  fallback?: ReactNode;
}) {
  const feature = useInstallableFeature(key);
  useOnInstalled(key, onInstalled);
  if (!feature) return fallback;

  const partial = feature.missing.length > 0;
  const missing = listMissing(feature);

  const install = () => {
    // A failure is the feature's own error, shown below until the next try.
    getAppFeaturesBridge()?.install(feature.id).catch(() => {});
  };

  return (
    <span className={cn('inline-flex items-center', inline ? 'min-w-0 gap-2' : 'flex-col gap-1.5', className)}>
      {partial && !inline && !feature.busy && (
        <span className="text-xs text-muted-foreground">
          Part of {feature.title} is missing ({missing}). Installing it may fix this.
        </span>
      )}
      {feature.busy ? (
        <span className={cn('flex items-center gap-2 text-muted-foreground', inline ? 'text-xs' : 'text-sm')} aria-live="polite">
          <Loader2 className={cn('motion-safe:animate-spin', inline ? 'size-3' : 'size-4')} aria-hidden />
          {describeFeature(feature)}
        </span>
      ) : (
        <PillButton
          size={inline ? 'sm' : size}
          className={cn(inline && 'h-5 px-2')}
          onClick={install}
          aria-label={partial ? `Install what’s missing of ${feature.title}: ${missing}` : `Install ${feature.title}`}
          title={partial ? `${missing} ${feature.missing.length === 1 ? 'isn’t' : 'aren’t'} installed` : (feature.command ?? undefined)}
        >
          <Download strokeWidth={1.75} aria-hidden />
          {partial ? 'Install Missing' : `Install (${formatFeatureSize(feature.size)})`}
        </PillButton>
      )}
      {feature.error && !feature.busy && (
        <span role="alert" className={cn('flex items-start gap-1 text-xs text-destructive', inline && 'min-w-0 truncate')}>
          <TriangleAlert className="mt-0.5 size-3 shrink-0" aria-hidden />
          {feature.error}
        </span>
      )}
    </span>
  );
}

/** What's missing, in a sentence, with the button that installs it. */
export function FeatureInstallNote({
  feature: key,
  children,
  onInstalled,
  className,
}: {
  feature: string;
  children: ReactNode;
  onInstalled?: () => void;
  className?: string;
}) {
  const feature = useInstallableFeature(key);
  useOnInstalled(key, onInstalled);
  if (!feature) return null;
  return (
    <div className={cn('flex flex-col items-center gap-2 text-center', className)}>
      <p className="text-sm text-muted-foreground">{children}</p>
      <FeatureInstallButton feature={key} />
    </div>
  );
}
