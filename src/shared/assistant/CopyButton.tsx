import { useEffect, useState } from 'react';
import { Check, Copy } from 'lucide-react';
import { cn } from '@/lib/utils';

/** A small icon button that copies text and shows a check for a moment. */
export function CopyButton({
  text,
  label = 'Copy',
  showLabel = false,
  className,
}: {
  /** The text, or a function that reads it when clicked. */
  text: string | (() => string);
  label?: string;
  showLabel?: boolean;
  className?: string;
}) {
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    if (!copied) return;
    const timer = setTimeout(() => setCopied(false), 2000);
    return () => clearTimeout(timer);
  }, [copied]);

  const Icon = copied ? Check : Copy;
  return (
    <button
      type="button"
      onClick={() => {
        const value = typeof text === 'function' ? text() : text;
        void navigator.clipboard?.writeText(value).then(() => setCopied(true), () => {});
      }}
      aria-label={copied ? 'Copied' : label}
      title={copied ? 'Copied' : label}
      className={cn(
        'inline-flex items-center gap-1.5 rounded-md text-muted-foreground transition-colors hover:bg-foreground/5 hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
        showLabel ? 'h-7 px-2 text-xs' : 'size-8 justify-center',
        className,
      )}
    >
      <Icon className="size-4" aria-hidden />
      {showLabel && <span>{copied ? 'Copied' : label}</span>}
    </button>
  );
}
