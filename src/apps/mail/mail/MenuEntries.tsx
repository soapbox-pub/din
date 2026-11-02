import { ContextMenuItem, ContextMenuSeparator, ContextMenuSub, ContextMenuSubContent, ContextMenuSubTrigger } from '@/components/ui/context-menu';
import { DropdownMenuItem, DropdownMenuSeparator, DropdownMenuSub, DropdownMenuSubContent, DropdownMenuSubTrigger } from '@/components/ui/dropdown-menu';
import type { MenuEntry, MenuPick } from './menu';

type Parts = {
  Item: typeof ContextMenuItem | typeof DropdownMenuItem;
  Separator: typeof ContextMenuSeparator | typeof DropdownMenuSeparator;
  Sub: typeof ContextMenuSub | typeof DropdownMenuSub;
  SubTrigger: typeof ContextMenuSubTrigger | typeof DropdownMenuSubTrigger;
  SubContent: typeof ContextMenuSubContent | typeof DropdownMenuSubContent;
};

const CONTEXT: Parts = { Item: ContextMenuItem, Separator: ContextMenuSeparator, Sub: ContextMenuSub, SubTrigger: ContextMenuSubTrigger, SubContent: ContextMenuSubContent };
const DROPDOWN: Parts = { Item: DropdownMenuItem, Separator: DropdownMenuSeparator, Sub: DropdownMenuSub, SubTrigger: DropdownMenuSubTrigger, SubContent: DropdownMenuSubContent };

function Entries({ entries, onPick, parts }: { entries: MenuEntry[]; onPick: (pick: MenuPick) => void; parts: Parts }) {
  const { Item: MenuItem, Separator, Sub, SubTrigger, SubContent } = parts;
  return entries.map((e, i) => {
    if (e.kind === 'separator') return <Separator key={i} />;
    if (e.kind === 'sub') {
      return (
        <Sub key={i}>
          <SubTrigger className="gap-2">
            <e.icon /> {e.label}
          </SubTrigger>
          <SubContent className="max-h-80 overflow-y-auto">
            <Entries entries={e.items} onPick={onPick} parts={parts} />
          </SubContent>
        </Sub>
      );
    }
    return (
      <MenuItem key={i} disabled={e.disabled} variant={e.destructive ? 'destructive' : undefined} onSelect={() => onPick(e.pick)}>
        <e.icon /> {e.label}
      </MenuItem>
    );
  });
}

export function ContextEntries(props: { entries: MenuEntry[]; onPick: (pick: MenuPick) => void }) {
  return <Entries {...props} parts={CONTEXT} />;
}

export function DropdownEntries(props: { entries: MenuEntry[]; onPick: (pick: MenuPick) => void }) {
  return <Entries {...props} parts={DROPDOWN} />;
}
