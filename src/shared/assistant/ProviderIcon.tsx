import { useState } from 'react';
import { Bot } from 'lucide-react';
import type { ModelInfo } from '@/lib/assistant';
import { cn } from '@/lib/utils';

/** Icons of Din's own, in color, for providers models.dev has none for. */
const OWN_ICONS: Record<string, string> = { 'claude-agent': '/claude.svg' };

/**
 * Where a provider's icon comes from: Din's own for a few, else the logo
 * models.dev (the catalog OpenCode's providers come from) has for its id,
 * one color, drawn in the text's. One it has none for is a sparkle there.
 */
function iconSource(providerID: string | undefined, baseURL: string | undefined): { src: string; tint: boolean } | null {
  try {
    // Meridian, the local bridge to a Claude subscription.
    const url = baseURL ? new URL(baseURL) : null;
    if (url?.hostname === '127.0.0.1' && url.port === '3456') return { src: '/meridian.svg', tint: false };
  } catch {
    // Not a URL: go by the id.
  }
  if (!providerID) return null;
  if (OWN_ICONS[providerID]) return { src: OWN_ICONS[providerID], tint: false };
  if (!/^[a-z0-9][a-z0-9._-]*$/.test(providerID)) return null;
  return { src: `https://models.dev/logos/${providerID}.svg`, tint: true };
}

/** A provider's logo, or a robot when it can't be shown. */
export function ProviderIcon({
  providerID,
  baseURL,
  size = 16,
  className,
}: {
  providerID?: string;
  baseURL?: string;
  size?: number;
  className?: string;
}) {
  const icon = iconSource(providerID, baseURL);
  const [failed, setFailed] = useState<string | null>(null);
  const style = { width: size, height: size };

  if (!icon || failed === icon.src) {
    return <Bot aria-hidden className={cn('shrink-0', className)} style={style} />;
  }
  if (!icon.tint) {
    return (
      <img src={icon.src} alt="" aria-hidden className={cn('shrink-0 object-contain', className)} style={style} onError={() => setFailed(icon.src)} />
    );
  }
  // One-color logos take the text's color through a mask, so they show in dark themes too.
  const mask = `url("${icon.src}") center / contain no-repeat`;
  return (
    <span aria-hidden className={cn('relative inline-block shrink-0', className)} style={style}>
      <span className="absolute inset-0 bg-current" style={{ mask, WebkitMask: mask }} />
      {/* Loaded only to find out whether it can be: a mask says nothing when it can't. */}
      <img src={icon.src} alt="" className="hidden" onError={() => setFailed(icon.src)} />
    </span>
  );
}

/**
 * A model's price at a glance, as Shakespeare shows it: free, or one to four
 * dollar signs for a blend of input and output per million tokens, weighted
 * the way agent work spends them (mostly output).
 */
export function ModelPrice({ cost, className }: { cost: ModelInfo['cost']; className?: string }) {
  const tier = cost?.[0];
  if (!tier) return null;
  const blended = tier.input * 0.2 + tier.output * 0.8;
  const [label, tone] =
    blended === 0
      ? ['Free', 'text-emerald-600 dark:text-emerald-400']
      : blended < 10
        ? ['$', 'text-emerald-600 dark:text-emerald-400']
        : blended < 15
          ? ['$$', 'text-amber-600 dark:text-amber-400']
          : blended < 50
            ? ['$$$', 'text-red-600 dark:text-red-400']
            : ['$$$$', 'text-red-800 dark:text-red-300'];
  return (
    <span
      className={cn('shrink-0 text-xs font-semibold', tone, className)}
      title={`$${tier.input} in / $${tier.output} out per million tokens`}
    >
      {label}
    </span>
  );
}
