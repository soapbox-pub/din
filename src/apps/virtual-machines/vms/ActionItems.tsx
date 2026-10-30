import { Fragment } from 'react';
import { ContextMenuItem, ContextMenuSeparator } from '@/components/ui/context-menu';
import { DropdownMenuItem, DropdownMenuSeparator } from '@/components/ui/dropdown-menu';
import type { VmInfo } from '@/lib/vms';
import { vmActions, type VmAction } from './actions';

/** A machine's actions as menu items, for its ⋯ menu or its right-click one. */
export function VmActionItems({ vm, kind, onAction }: { vm: VmInfo; kind: 'dropdown' | 'context'; onAction: (action: VmAction) => void }) {
  const Item = kind === 'dropdown' ? DropdownMenuItem : ContextMenuItem;
  const Separator = kind === 'dropdown' ? DropdownMenuSeparator : ContextMenuSeparator;
  return (
    <>
      {vmActions(vm).map((group, i) => (
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
