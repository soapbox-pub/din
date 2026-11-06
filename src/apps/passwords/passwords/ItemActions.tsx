import { Copy, ExternalLink, Folder, FolderInput, KeyRound, KeySquare, Pencil, RotateCcw, ShieldCheck, Star, StarOff, Trash2, User } from 'lucide-react';
import {
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuSub,
  ContextMenuSubContent,
  ContextMenuSubTrigger,
} from '@/components/ui/context-menu';
import {
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
} from '@/components/ui/dropdown-menu';
import type { CopyField, PasswordList, PasswordSummary } from '@/lib/passwords';
import { openableUrl } from './vault';

/** What can be done to an item, from its ⋯ menu and its right-click menu alike. */
export interface ItemActions {
  copy(id: string, field: CopyField): void;
  openUrl(url: string): void;
  edit(id: string): void;
  setFavorite(id: string, favorite: boolean): void;
  move(id: string, groupId: string): void;
  trash(id: string): void;
  restore(id: string): void;
  /** Asks first. */
  removePasskey(id: string): void;
  /** Asks first. */
  deleteForever(id: string): void;
}

/** The menu's items, for a DropdownMenu or a ContextMenu. */
export function ItemMenuItems({
  kind,
  item,
  list,
  actions,
}: {
  kind: 'dropdown' | 'context';
  item: PasswordSummary;
  list: PasswordList;
  actions: ItemActions;
}) {
  const Item = kind === 'dropdown' ? DropdownMenuItem : ContextMenuItem;
  const Separator = kind === 'dropdown' ? DropdownMenuSeparator : ContextMenuSeparator;
  const Sub = kind === 'dropdown' ? DropdownMenuSub : ContextMenuSub;
  const SubTrigger = kind === 'dropdown' ? DropdownMenuSubTrigger : ContextMenuSubTrigger;
  const SubContent = kind === 'dropdown' ? DropdownMenuSubContent : ContextMenuSubContent;

  if (item.trashed) {
    return (
      <>
        <Item onSelect={() => actions.restore(item.id)}>
          <RotateCcw className="size-4.5" strokeWidth={1.75} aria-hidden />
          Restore
        </Item>
        <Separator />
        <Item variant="destructive" onSelect={() => actions.deleteForever(item.id)}>
          <Trash2 className="size-4.5" strokeWidth={1.75} aria-hidden />
          Delete Now…
        </Item>
      </>
    );
  }

  const url = openableUrl(item.url);
  const folders = list.groups.filter((g) => !g.trash);
  return (
    <>
      {item.username && (
        <Item onSelect={() => actions.copy(item.id, 'username')}>
          <User className="size-4.5" strokeWidth={1.75} aria-hidden />
          Copy Username
        </Item>
      )}
      {item.kind === 'login' && (
        <Item onSelect={() => actions.copy(item.id, 'password')}>
          <KeyRound className="size-4.5" strokeWidth={1.75} aria-hidden />
          Copy Password
        </Item>
      )}
      {item.otp && (
        <Item onSelect={() => actions.copy(item.id, 'otp')}>
          <ShieldCheck className="size-4.5" strokeWidth={1.75} aria-hidden />
          Copy Verification Code
        </Item>
      )}
      {item.kind === 'note' && (
        <Item onSelect={() => actions.copy(item.id, 'notes')}>
          <Copy className="size-4.5" strokeWidth={1.75} aria-hidden />
          Copy Note
        </Item>
      )}
      {url && (
        <Item onSelect={() => actions.openUrl(url)}>
          <ExternalLink className="size-4.5" strokeWidth={1.75} aria-hidden />
          Open Website
        </Item>
      )}
      <Separator />
      <Item onSelect={() => actions.edit(item.id)}>
        <Pencil className="size-4.5" strokeWidth={1.75} aria-hidden />
        Edit
      </Item>
      <Item onSelect={() => actions.setFavorite(item.id, !item.favorite)}>
        {item.favorite ? <StarOff className="size-4.5" strokeWidth={1.75} aria-hidden /> : <Star className="size-4.5" strokeWidth={1.75} aria-hidden />}
        {item.favorite ? 'Remove from Favorites' : 'Add to Favorites'}
      </Item>
      <Sub>
        <SubTrigger>
          <FolderInput className="size-4.5" strokeWidth={1.75} aria-hidden />
          Move to Folder
        </SubTrigger>
        <SubContent className="max-h-80 w-52 overflow-y-auto">
          <Item disabled={item.groupId === list.rootId} onSelect={() => actions.move(item.id, list.rootId)}>
            <Folder className="size-4.5" strokeWidth={1.75} aria-hidden />
            No Folder
          </Item>
          {folders.map((folder) => (
            <Item key={folder.id} disabled={item.groupId === folder.id} onSelect={() => actions.move(item.id, folder.id)}>
              <Folder className="size-4" aria-hidden style={{ marginLeft: folder.depth * 12 }} />
              <span className="truncate">{folder.name}</span>
            </Item>
          ))}
        </SubContent>
      </Sub>
      <Separator />
      {item.passkey && (
        <Item variant="destructive" onSelect={() => actions.removePasskey(item.id)}>
          <KeySquare className="size-4.5" strokeWidth={1.75} aria-hidden />
          Remove Passkey…
        </Item>
      )}
      <Item variant="destructive" onSelect={() => actions.trash(item.id)}>
        <Trash2 className="size-4.5" strokeWidth={1.75} aria-hidden />
        Delete
      </Item>
    </>
  );
}
