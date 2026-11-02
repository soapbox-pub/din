import { Check } from 'lucide-react';
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
import type { ContactAction, MenuEntry } from './menu';

function Entries({ entries, onPick, context }: { entries: MenuEntry[]; onPick: (a: ContactAction) => void; context: boolean }) {
  const Item = context ? ContextMenuItem : DropdownMenuItem;
  const Separator = context ? ContextMenuSeparator : DropdownMenuSeparator;
  const Sub = context ? ContextMenuSub : DropdownMenuSub;
  const SubTrigger = context ? ContextMenuSubTrigger : DropdownMenuSubTrigger;
  const SubContent = context ? ContextMenuSubContent : DropdownMenuSubContent;
  return entries.map((e, i) => {
    if (e.kind === 'separator') return <Separator key={i} />;
    if (e.kind === 'submenu') {
      return (
        <Sub key={i}>
          <SubTrigger className="gap-2">
            <e.icon className="size-4 text-muted-foreground" /> {e.label}
          </SubTrigger>
          <SubContent className="max-h-80 w-52 overflow-y-auto">
            <Entries entries={e.entries} onPick={onPick} context={context} />
          </SubContent>
        </Sub>
      );
    }
    const Icon = e.icon;
    return (
      <Item key={i} variant={e.destructive ? 'destructive' : undefined} onSelect={() => onPick(e.action)}>
        {Icon ? <Icon /> : <span className="size-4" aria-hidden />}
        <span className="min-w-0 flex-1 truncate">{e.label}</span>
        {e.checked && <Check className="ml-auto" aria-label="(in it)" />}
      </Item>
    );
  });
}

export function ContextEntries(props: { entries: MenuEntry[]; onPick: (a: ContactAction) => void }) {
  return <Entries {...props} context />;
}

export function DropdownEntries(props: { entries: MenuEntry[]; onPick: (a: ContactAction) => void }) {
  return <Entries {...props} context={false} />;
}
