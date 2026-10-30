import { createElement } from 'react';
import { LayoutGrid } from 'lucide-react';
import { Switch } from '@/components/ui/switch';
import type { FileSource, NappletSource, PermissionDomain } from '@/lib/widgets';
import { cn } from '@/lib/utils';
import { PERMISSIONS, useNappletIcon, WIDGET_ICONS } from './widgetMeta';

/** One permission, Android-style: its icon, what it means, and a switch. */
export function PermissionRow({
  domain,
  allowed,
  required,
  onChange,
}: {
  domain: PermissionDomain;
  allowed: boolean;
  /** The widget says it needs this to work. */
  required?: boolean;
  onChange: (allowed: boolean) => void;
}) {
  const { icon: Icon, title, description } = PERMISSIONS[domain];
  const id = `permission-${domain}`;
  return (
    <div className="flex items-start gap-4 py-3">
      <span
        className={cn(
          'grid size-10 shrink-0 place-items-center rounded-full transition-colors',
          allowed ? 'bg-primary/15 text-primary' : 'bg-muted text-muted-foreground',
        )}
      >
        <Icon className="size-5" aria-hidden />
      </span>
      <div className="min-w-0 flex-1">
        <label htmlFor={id} className="block font-medium">{title}</label>
        <p className="text-sm text-muted-foreground">{description}</p>
        {required && !allowed && (
          <p className="mt-1 text-sm text-amber-600 dark:text-amber-400">It says it needs this, so it may not work without it.</p>
        )}
      </div>
      <Switch id={id} checked={allowed} onCheckedChange={onChange} className="mt-2" />
    </div>
  );
}

/** A widget from Nostr's or a folder's icon, or its initial on a tile. */
export function NappletIcon({ source, className }: { source: NappletSource | FileSource; className?: string }) {
  const fetched = useNappletIcon(source.type === 'napplet' ? source : null);
  const url = source.type === 'file' ? (source.icon ?? null) : fetched;
  return url ? (
    <img src={url} alt="" className={cn('rounded-2xl object-cover', className)} />
  ) : (
    <span
      aria-hidden
      className={cn('grid place-items-center rounded-2xl bg-gradient-to-br from-primary to-primary/60 font-semibold text-primary-foreground', className)}
    >
      {[...source.title][0]?.toUpperCase() ?? '?'}
    </span>
  );
}

/** A built-in widget's icon, by its manifest's `icon`. */
export function BuiltinIcon({ name, className }: { name: string; className?: string }) {
  return createElement(WIDGET_ICONS[name] ?? LayoutGrid, { className, 'aria-hidden': true });
}
