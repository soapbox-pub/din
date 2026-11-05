import { ContextMenuItem, ContextMenuSeparator } from '@/components/ui/context-menu';
import { DropdownMenuItem, DropdownMenuSeparator } from '@/components/ui/dropdown-menu';
import { itemEntries, type ItemAction } from './actions';
import type { CameraItem } from './library';

export function ItemContextItems({ item, onAction }: { item: CameraItem; onAction: (item: CameraItem, action: ItemAction) => void }) {
  return itemEntries(item).map((e) => [
    e.separated ? <ContextMenuSeparator key={`${e.id}-sep`} /> : null,
    <ContextMenuItem key={e.id} variant={e.destructive ? 'destructive' : 'default'} onSelect={() => onAction(item, e.id)}>
      {e.icon}
      {e.label}
    </ContextMenuItem>,
  ]);
}

export function ItemDropdownItems({ item, onAction }: { item: CameraItem; onAction: (item: CameraItem, action: ItemAction) => void }) {
  return itemEntries(item).map((e) => [
    e.separated ? <DropdownMenuSeparator key={`${e.id}-sep`} /> : null,
    <DropdownMenuItem key={e.id} variant={e.destructive ? 'destructive' : 'default'} onSelect={() => onAction(item, e.id)}>
      {e.icon}
      {e.label}
    </DropdownMenuItem>,
  ]);
}
