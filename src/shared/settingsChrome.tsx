import type { ComponentType } from 'react';
import { cn } from '@/lib/utils';
import { settingsTokenClass } from './settingsChromeStyles';

/**
 * A radio's mark for a row or card that's the radio itself (its role and
 * aria-checked are the row's): a clay lump of the primary with a light
 * center when checked, as a raised dimple when not.
 */
export function RadioMark({ checked, className }: { checked: boolean; className?: string }) {
  return (
    <span
      aria-hidden
      className={cn(
        'grid size-4 shrink-0 place-items-center rounded-full',
        checked ? 'bg-pigment clay-pigment' : 'border border-input bg-background clay dark:bg-input/30',
        className,
      )}
    >
      {checked && <span className="size-1.5 rounded-full bg-primary-foreground" />}
    </span>
  );
}

/** A row's icon in a round clay token (settingsTokenClass): the primary's when `active`. */
export function SettingsToken({
  icon: Icon,
  active = false,
  className,
}: {
  icon: ComponentType<{ className?: string; strokeWidth?: number }>;
  active?: boolean;
  className?: string;
}) {
  return (
    <span aria-hidden className={cn(settingsTokenClass(active), className)}>
      <Icon strokeWidth={1.75} />
    </span>
  );
}
