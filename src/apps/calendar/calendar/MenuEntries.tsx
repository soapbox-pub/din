import { Check } from 'lucide-react';
import { ContextMenuItem, ContextMenuSeparator } from '@/components/ui/context-menu';
import { DropdownMenuItem, DropdownMenuSeparator } from '@/components/ui/dropdown-menu';
import { cn } from '@/lib/utils';
import type { EventAction, MenuEntry } from './menu';

function Entries({ entries, onPick, context }: { entries: MenuEntry[]; onPick: (a: EventAction) => void; context: boolean }) {
  const Item = context ? ContextMenuItem : DropdownMenuItem;
  const Separator = context ? ContextMenuSeparator : DropdownMenuSeparator;
  return entries.map((e, i) =>
    e.kind === 'separator' ? (
      <Separator key={i} />
    ) : (
      <Item key={i} variant={e.destructive ? 'destructive' : undefined} onSelect={() => onPick(e.action)} className={cn(e.checked && 'font-medium')}>
        <e.icon /> {e.label}
        {e.checked && <Check className="ml-auto" aria-label="(your answer)" />}
      </Item>
    ),
  );
}

export function ContextEntries(props: { entries: MenuEntry[]; onPick: (a: EventAction) => void }) {
  return <Entries {...props} context />;
}

export function DropdownEntries(props: { entries: MenuEntry[]; onPick: (a: EventAction) => void }) {
  return <Entries {...props} context={false} />;
}

