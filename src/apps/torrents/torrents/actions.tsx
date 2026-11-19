import { Fragment } from 'react';
import { ContextMenuItem, ContextMenuSeparator } from '@/components/ui/context-menu';
import { DropdownMenuItem, DropdownMenuSeparator } from '@/components/ui/dropdown-menu';
import type { Torrent } from '@/lib/torrents';
import { transferActions, type TransferAction } from './model';

/** The actions as menu items, for a ⋯ menu or a right-click menu. */
export function TransferActionItems({ targets, kind, onAction }: { targets: Torrent[]; kind: 'dropdown' | 'context'; onAction: (action: TransferAction) => void }) {
  const Item = kind === 'dropdown' ? DropdownMenuItem : ContextMenuItem;
  const Separator = kind === 'dropdown' ? DropdownMenuSeparator : ContextMenuSeparator;
  return (
    <>
      {transferActions(targets).map((group, i) => (
        <Fragment key={i}>
          {i > 0 && <Separator />}
          {group.map(({ id, label, icon: Icon, enabled, destructive }) => (
            <Item key={id} disabled={!enabled} variant={destructive ? 'destructive' : 'default'} onSelect={() => onAction(id)}>
              <Icon className="size-4.5" aria-hidden />
              {label}
            </Item>
          ))}
        </Fragment>
      ))}
    </>
  );
}
