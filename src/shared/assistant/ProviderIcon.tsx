import { useState } from 'react';
import { Bot } from 'lucide-react';
import type { ModelInfo } from '@/lib/assistant';
import { cn } from '@/lib/utils';

/** Where a provider's icon comes from, given the URL its requests go to. */
function iconSource(baseURL: string | undefined): string | null {
  if (!baseURL) return null;
  try {
    const url = new URL(baseURL);
    // Meridian, the local bridge to a Claude subscription.
    if (url.hostname === '127.0.0.1' && url.port === '3456') return '/meridian.svg';
    if (url.protocol !== 'https:') return null;
    // API hosts rarely serve one; the site they belong to does.
    const host = url.hostname.replace(/^(ai\.|api\.|enclave\.)/, '');
    return `https://${host}/favicon.ico`;
  } catch {
    return null;
  }
}

/** A provider's favicon, or a robot when it has none. */
export function ProviderIcon({ baseURL, size = 16, className }: { baseURL?: string; size?: number; className?: string }) {
  const src = iconSource(baseURL);
  const [failed, setFailed] = useState<string | null>(null);

  if (!src || failed === src) {
    return <Bot aria-hidden className={cn('shrink-0', className)} style={{ width: size, height: size }} />;
  }
  return (
    <img
      src={src}
      alt=""
      aria-hidden
      className={cn('shrink-0 object-contain', className)}
      style={{ width: size, height: size }}
      onError={() => setFailed(src)}
    />
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
