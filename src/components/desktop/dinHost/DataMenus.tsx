import { useEffect, useRef } from 'react';
import type { ReactNode } from 'react';
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuShortcut,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import {
  ContextMenu,
  ContextMenuCheckboxItem,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuLabel,
  ContextMenuRadioGroup,
  ContextMenuRadioItem,
  ContextMenuSeparator,
  ContextMenuShortcut,
  ContextMenuSub,
  ContextMenuSubContent,
  ContextMenuSubTrigger,
  ContextMenuTrigger,
} from '@/components/ui/context-menu';
import { MenuBarMenus } from '@/components/desktop/MenuBarMenus';
import { MENU_BAR_TRIGGER_CLASS } from '@/lib/menuBarSlot';
import type { Menu, MenuItem } from '@/sdk/din';
import { sanitizeImageUrl } from '@/components/desktop/dinHost/urls';

/** The two families of menu primitives, which share their shape. */
const KITS = {
  dropdown: {
    Item: DropdownMenuItem,
    Checkbox: DropdownMenuCheckboxItem,
    RadioGroup: DropdownMenuRadioGroup,
    Radio: DropdownMenuRadioItem,
    Separator: DropdownMenuSeparator,
    Label: DropdownMenuLabel,
    Shortcut: DropdownMenuShortcut,
    Sub: DropdownMenuSub,
    SubTrigger: DropdownMenuSubTrigger,
    SubContent: DropdownMenuSubContent,
  },
  context: {
    Item: ContextMenuItem,
    Checkbox: ContextMenuCheckboxItem,
    RadioGroup: ContextMenuRadioGroup,
    Radio: ContextMenuRadioItem,
    Separator: ContextMenuSeparator,
    Label: ContextMenuLabel,
    Shortcut: ContextMenuShortcut,
    Sub: ContextMenuSub,
    SubTrigger: ContextMenuSubTrigger,
    SubContent: ContextMenuSubContent,
  },
} as const;

type Kit = (typeof KITS)[keyof typeof KITS];

function Label({ item }: { item: Extract<MenuItem, { id: string }> }) {
  const icon = item.icon ? sanitizeImageUrl(item.icon) : null;
  return (
    <>
      {icon && <img src={icon} alt="" className="size-4" />}
      {item.label}
    </>
  );
}

/** An app's menu items, as data, drawn with the desktop's menu components. */
function Items({ items, kit, onAction }: { items: MenuItem[]; kit: Kit; onAction: (id: string) => void }) {
  const out: ReactNode[] = [];
  for (let i = 0; i < items.length; i++) {
    const item = items[i];
    if (item.type === 'separator') {
      out.push(<kit.Separator key={`s${i}`} />);
    } else if (item.type === 'label') {
      out.push(<kit.Label key={`l${i}`}>{item.label}</kit.Label>);
    } else if (item.type === 'submenu') {
      out.push(
        <kit.Sub key={item.id}>
          <kit.SubTrigger disabled={item.enabled === false}>
            <Label item={item} />
          </kit.SubTrigger>
          <kit.SubContent>
            <Items items={item.items} kit={kit} onAction={onAction} />
          </kit.SubContent>
        </kit.Sub>,
      );
    } else if (item.type === 'checkbox') {
      out.push(
        <kit.Checkbox key={item.id} checked={item.checked} disabled={item.enabled === false} onCheckedChange={() => onAction(item.id)}>
          <Label item={item} />
          {item.accelerator && <kit.Shortcut>{item.accelerator}</kit.Shortcut>}
        </kit.Checkbox>,
      );
    } else if (item.type === 'radio') {
      // A run of radios in one group is one RadioGroup.
      const group: Extract<MenuItem, { type: 'radio' }>[] = [item];
      while (i + 1 < items.length) {
        const next = items[i + 1];
        if (next.type !== 'radio' || next.group !== item.group) break;
        group.push(next);
        i++;
      }
      const checked = group.find((r) => r.checked);
      out.push(
        <kit.RadioGroup key={`g${item.id}`} value={checked?.id ?? ''} onValueChange={(id: string) => onAction(id)}>
          {group.map((r) => (
            <kit.Radio key={r.id} value={r.id} disabled={r.enabled === false}>
              <Label item={r} />
              {r.accelerator && <kit.Shortcut>{r.accelerator}</kit.Shortcut>}
            </kit.Radio>
          ))}
        </kit.RadioGroup>,
      );
    } else {
      out.push(
        <kit.Item
          key={item.id}
          disabled={item.enabled === false}
          variant={item.destructive ? 'destructive' : 'default'}
          onSelect={() => onAction(item.id)}
        >
          <Label item={item} />
          {item.accelerator && <kit.Shortcut>{item.accelerator}</kit.Shortcut>}
        </kit.Item>,
      );
    }
  }
  return <>{out}</>;
}

/** An app's menus in the menu bar, while its window is focused. */
export function DataMenuBar({ menus, onAction }: { menus: Menu[]; onAction: (id: string) => void }) {
  return (
    <MenuBarMenus>
      {menus.map((menu, i) => (
        <DropdownMenu key={`${i}:${menu.label}`}>
          <DropdownMenuTrigger className={MENU_BAR_TRIGGER_CLASS}>{menu.label}</DropdownMenuTrigger>
          <DropdownMenuContent align="start" className="min-w-56">
            <Items items={menu.items} kit={KITS.dropdown} onAction={onAction} />
          </DropdownMenuContent>
        </DropdownMenu>
      ))}
    </MenuBarMenus>
  );
}

/**
 * A right-click-style menu the desktop opens at a point (in the desktop's
 * viewport) on an app's behalf, free of the app window's edges. `children`
 * renders custom content instead of data items (the window menu).
 */
export function PointMenu({
  at,
  items,
  onAction,
  onClose,
  onCloseAutoFocus,
  children,
}: {
  at: { x: number; y: number };
  items?: MenuItem[];
  onAction?: (id: string) => void;
  onClose: () => void;
  /** Once it has closed and gone, when it would give focus back (preventDefault to place it yourself). */
  onCloseAutoFocus?: (event: Event) => void;
  children?: ReactNode;
}) {
  const trigger = useRef<HTMLDivElement>(null);
  // Radix opens a context menu from a contextmenu event at its coordinates.
  useEffect(() => {
    trigger.current?.dispatchEvent(
      new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: at.x, clientY: at.y, button: 2 }),
    );
  }, [at.x, at.y]);
  return (
    <ContextMenu onOpenChange={(open) => !open && onClose()}>
      <ContextMenuTrigger asChild>
        <div ref={trigger} aria-hidden className="pointer-events-none fixed left-0 top-0 size-0" />
      </ContextMenuTrigger>
      <ContextMenuContent className="min-w-56" onCloseAutoFocus={onCloseAutoFocus}>
        {children ?? <Items items={items ?? []} kit={KITS.context} onAction={(id) => onAction?.(id)} />}
      </ContextMenuContent>
    </ContextMenu>
  );
}
