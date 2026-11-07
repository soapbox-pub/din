import { Fragment } from 'react';
import { ContextMenuItem, ContextMenuSeparator } from '@/components/ui/context-menu';
import { DropdownMenuItem, DropdownMenuSeparator } from '@/components/ui/dropdown-menu';
import type { VmInfo } from '@/lib/vms';
import { vmActions, type VmAction } from './actions';

/**
 * A machine's actions as menu items, for its ⋯ menu or its right-click one;
 * `only` narrows them to those actions (the power button's menu).
 */
export function VmActionItems({
  vm,
  kind,
  only,
  onAction,
}: {
  vm: VmInfo;
  kind: 'dropdown' | 'context';
  only?: readonly VmAction[];
  onAction: (action: VmAction) => void;
}) {
  const Item = kind === 'dropdown' ? DropdownMenuItem : ContextMenuItem;
  const Separator = kind === 'dropdown' ? DropdownMenuSeparator : ContextMenuSeparator;
  const groups = vmActions(vm)
    .map((group) => (only ? group.filter((item) => only.includes(item.id)) : group))
    .filter((group) => group.length > 0);
  return (
    <>
      {groups.map((group, i) => (
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
