import { Minus } from 'lucide-react';
import { ContextMenuCheckboxItem, ContextMenuItem, ContextMenuSeparator, ContextMenuSub, ContextMenuSubContent, ContextMenuSubTrigger } from '@/components/ui/context-menu';
import { DropdownMenuCheckboxItem, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuSub, DropdownMenuSubContent, DropdownMenuSubTrigger } from '@/components/ui/dropdown-menu';
import { cn } from '@/lib/utils';
import type { MenuEntry, MenuPick } from './menu';
import { LABEL_STYLES } from './labels';

type Parts = {
  Item: typeof ContextMenuItem | typeof DropdownMenuItem;
  CheckboxItem: typeof ContextMenuCheckboxItem | typeof DropdownMenuCheckboxItem;
  Separator: typeof ContextMenuSeparator | typeof DropdownMenuSeparator;
  Sub: typeof ContextMenuSub | typeof DropdownMenuSub;
  SubTrigger: typeof ContextMenuSubTrigger | typeof DropdownMenuSubTrigger;
  SubContent: typeof ContextMenuSubContent | typeof DropdownMenuSubContent;
};

const CONTEXT: Parts = { Item: ContextMenuItem, CheckboxItem: ContextMenuCheckboxItem, Separator: ContextMenuSeparator, Sub: ContextMenuSub, SubTrigger: ContextMenuSubTrigger, SubContent: ContextMenuSubContent };
const DROPDOWN: Parts = { Item: DropdownMenuItem, CheckboxItem: DropdownMenuCheckboxItem, Separator: DropdownMenuSeparator, Sub: DropdownMenuSub, SubTrigger: DropdownMenuSubTrigger, SubContent: DropdownMenuSubContent };

function Entries<P>({ entries, onPick, parts }: { entries: MenuEntry<P>[]; onPick: (pick: P) => void; parts: Parts }) {
  const { Item: MenuItem, CheckboxItem, Separator, Sub, SubTrigger, SubContent } = parts;
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
    if (e.kind === 'check') {
      return (
        <CheckboxItem
          key={i}
          checked={e.checked}
          // A dash, not the check, for some.
          className="[&[data-state=indeterminate]>span:first-child]:hidden"
          onSelect={(ev) => {
            ev.preventDefault();
            onPick(e.pick);
          }}
        >
          {e.checked === 'indeterminate' && <Minus aria-hidden className="absolute left-2 size-3.5" />}
          {e.color && <span aria-hidden className={cn('size-2.5 shrink-0 rounded-full', LABEL_STYLES[e.color].dot)} />}
          <span className="truncate">{e.label}</span>
        </CheckboxItem>
      );
    }
    return (
      <MenuItem key={i} disabled={e.disabled} variant={e.destructive ? 'destructive' : undefined} onSelect={() => onPick(e.pick)}>
        <e.icon /> {e.label}
      </MenuItem>
    );
  });
}

export function ContextEntries<P = MenuPick>(props: { entries: MenuEntry<P>[]; onPick: (pick: P) => void }) {
  return <Entries {...props} parts={CONTEXT} />;
}

export function DropdownEntries<P = MenuPick>(props: { entries: MenuEntry<P>[]; onPick: (pick: P) => void }) {
  return <Entries {...props} parts={DROPDOWN} />;
}
