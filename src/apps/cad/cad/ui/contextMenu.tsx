import { ContextMenu as CM } from 'radix-ui';
import { cn } from '@/lib/utils';

/** Right-click menus for CAD's palettes, styled like its dropdowns (`./chrome`). */

export function ContextMenu(props: React.ComponentProps<typeof CM.Root>) {
  return <CM.Root {...props} />;
}

export function ContextMenuTrigger(props: React.ComponentProps<typeof CM.Trigger>) {
  return <CM.Trigger {...props} />;
}

export function ContextMenuContent({ className, children, ...props }: React.ComponentProps<typeof CM.Content>) {
  return (
    <CM.Portal>
      <CM.Content
        collisionPadding={8}
        onCloseAutoFocus={(e) => e.preventDefault()}
        className={cn(
          'z-[60] max-h-[min(80vh,640px)] min-w-48 overflow-y-auto rounded-[3px] border border-[#15191e] bg-[#2f3640] p-1 text-[12px] text-[#e3e8ef] shadow-[0_6px_18px_rgba(0,0,0,0.45)] outline-none',
          className,
        )}
        style={{ fontFamily: "'Inter Variable', 'Segoe UI', sans-serif" }}
        {...props}
        onPointerUpCapture={(e) => {
          // The right-button release that opened the menu mustn't pick an item (see ui/context-menu).
          if (e.button !== 0) e.stopPropagation();
          props.onPointerUpCapture?.(e);
        }}
      >
        {children}
      </CM.Content>
    </CM.Portal>
  );
}

export function ContextMenuItem({
  icon,
  children,
  shortcut,
  destructive,
  className,
  ...props
}: React.ComponentProps<typeof CM.Item> & { icon?: React.ReactNode; shortcut?: string; destructive?: boolean }) {
  return (
    <CM.Item
      className={cn(
        'relative flex h-7 cursor-default items-center gap-2 rounded-[2px] pr-3 pl-2 outline-none select-none data-[disabled]:text-[#737c89] data-[highlighted]:bg-[#0b6aa8] data-[highlighted]:text-white',
        destructive && 'text-[#ff8c8c] data-[highlighted]:bg-[#b3261e]',
        className,
      )}
      data-variant={destructive ? 'destructive' : undefined}
      {...props}
    >
      <span className="grid size-4 shrink-0 place-items-center [&>svg]:size-4">{icon}</span>
      <span className="flex-1 whitespace-nowrap">{children}</span>
      {shortcut && <span className="pl-6 text-[11px] text-[#9aa4b1]">{shortcut}</span>}
    </CM.Item>
  );
}

export const ContextMenuSeparator = () => <CM.Separator className="mx-1 my-1 h-px bg-[#454e5b]" />;
