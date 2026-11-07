/**
 * A game's actions as menu items, the same in its right-click menu and its
 * ⋯ menu: play (or resume), start over, favorite, the other copies of it,
 * and show its file in Files.
 */
import { Check, FolderOpen, Play, RotateCcw, Star, StarOff } from 'lucide-react';
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
import type { Game } from '@/lib/games';

export type GameAction = { kind: 'play' } | { kind: 'startOver' } | { kind: 'favorite' } | { kind: 'version'; path: string } | { kind: 'show' };

export function GameMenuItems({
  game,
  kind,
  playable,
  onAction,
}: {
  game: Game;
  kind: 'context' | 'dropdown';
  playable: boolean;
  onAction: (action: GameAction) => void;
}) {
  const Item = kind === 'context' ? ContextMenuItem : DropdownMenuItem;
  const Separator = kind === 'context' ? ContextMenuSeparator : DropdownMenuSeparator;
  const Sub = kind === 'context' ? ContextMenuSub : DropdownMenuSub;
  const SubTrigger = kind === 'context' ? ContextMenuSubTrigger : DropdownMenuSubTrigger;
  const SubContent = kind === 'context' ? ContextMenuSubContent : DropdownMenuSubContent;
  return (
    <>
      <Item disabled={!playable} onSelect={() => onAction({ kind: 'play' })}>
        <Play className="size-4" aria-hidden />
        {game.resumable ? 'Resume' : 'Play'}
      </Item>
      {game.resumable && (
        <Item disabled={!playable} onSelect={() => onAction({ kind: 'startOver' })}>
          <RotateCcw className="size-4" aria-hidden />
          Start Over…
        </Item>
      )}
      <Separator />
      <Item onSelect={() => onAction({ kind: 'favorite' })}>
        {game.favorite ? <StarOff className="size-4" aria-hidden /> : <Star className="size-4" aria-hidden />}
        {game.favorite ? 'Remove from Favorites' : 'Add to Favorites'}
      </Item>
      {game.versions.length > 1 && (
        <Sub>
          <SubTrigger>Version</SubTrigger>
          <SubContent className="max-h-80 w-72 overflow-y-auto">
            {game.versions.map((v) => (
              <Item key={v.path} onSelect={() => onAction({ kind: 'version', path: v.path })}>
                <Check className={v.path === game.path ? 'size-4' : 'size-4 opacity-0'} aria-hidden />
                <span className="truncate">{v.label}</span>
              </Item>
            ))}
          </SubContent>
        </Sub>
      )}
      <Separator />
      <Item onSelect={() => onAction({ kind: 'show' })}>
        <FolderOpen className="size-4" aria-hidden />
        Show in Files
      </Item>
    </>
  );
}
