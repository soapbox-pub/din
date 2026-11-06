import { Fragment } from 'react';
import type { LucideIcon } from 'lucide-react';
import { ContextMenuItem, ContextMenuSeparator } from '@/components/ui/context-menu';
import { DropdownMenuItem, DropdownMenuSeparator } from '@/components/ui/dropdown-menu';

export interface MenuAction<T extends string> {
  id: T;
  label: string;
  icon: LucideIcon;
  enabled: boolean;
  destructive?: boolean;
}

/** Actions in groups as menu items, for a ⋯ menu or the matching right-click one. */
export function ActionItems<T extends string>({
  groups,
  kind,
  onAction,
}: {
  groups: MenuAction<T>[][];
  kind: 'dropdown' | 'context';
  onAction: (action: T) => void;
}) {
  const Item = kind === 'dropdown' ? DropdownMenuItem : ContextMenuItem;
  const Separator = kind === 'dropdown' ? DropdownMenuSeparator : ContextMenuSeparator;
  return (
    <>
      {groups.map((group, i) => (
        <Fragment key={i}>
          {i > 0 && <Separator />}
          {group.map(({ id, label, icon: Icon, enabled, destructive }) => (
            <Item key={id} disabled={!enabled} variant={destructive ? 'destructive' : 'default'} onSelect={() => onAction(id)}>
              <Icon className="size-4.5" strokeWidth={1.75} aria-hidden />
              {label}
            </Item>
          ))}
        </Fragment>
      ))}
    </>
  );
}
