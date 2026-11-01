import { Fragment } from 'react';
import { ContextMenuItem, ContextMenuSeparator } from '@/components/ui/context-menu';
import { DropdownMenuItem, DropdownMenuSeparator } from '@/components/ui/dropdown-menu';
import type { TakeInfo } from '@/lib/capture';
import { takeActions, type TakeAction } from '../takes';

/** A take's actions as menu items, for its ⋯ menu or its right-click one. */
export function TakeActionItems({
  take,
  kind,
  options,
  onAction,
}: {
  take: TakeInfo;
  kind: 'dropdown' | 'context';
  options: { canTranscribe: boolean; canAssist: boolean };
  onAction: (action: TakeAction) => void;
}) {
  const Item = kind === 'dropdown' ? DropdownMenuItem : ContextMenuItem;
  const Separator = kind === 'dropdown' ? DropdownMenuSeparator : ContextMenuSeparator;
  return (
    <>
      {takeActions(take, options).map((group, i) => (
        <Fragment key={i}>
          {i > 0 && <Separator />}
          {group.map(({ id, label, icon: Icon, enabled, destructive }) => (
            <Item key={id} disabled={!enabled} variant={destructive ? 'destructive' : 'default'} onSelect={() => onAction(id)}>
              <Icon className="size-4" aria-hidden />
              {label}
            </Item>
          ))}
        </Fragment>
      ))}
    </>
  );
}

