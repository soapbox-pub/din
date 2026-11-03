import { X } from 'lucide-react';
import { cn } from '@/lib/utils';
import type { MailLabel } from '@/lib/mail';
import { LABEL_STYLES, labelColor } from './labels';

/** A label on a message, in its color; with `onRemove`, an × to take it off. */
export function LabelChip({ label, onRemove, className }: { label: MailLabel; onRemove?: () => void; className?: string }) {
  return (
    <span className={cn('inline-flex h-5 max-w-40 shrink-0 items-center gap-0.5 rounded-md px-1.5 text-[11px] leading-none font-medium', LABEL_STYLES[labelColor(label)].chip, onRemove && 'pr-0.5', className)}>
      <span className="truncate">{label.name}</span>
      {onRemove && (
        <button
          type="button"
          aria-label={`Remove the label ${label.name}`}
          title="Remove label"
          onClick={onRemove}
          className="grid size-4 shrink-0 place-items-center rounded outline-none hover:bg-foreground/10 focus-visible:ring-2 focus-visible:ring-ring/60"
        >
          <X className="size-3" />
        </button>
      )}
    </span>
  );
}
