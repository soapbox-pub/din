import { ContextMenu as CM } from 'radix-ui';
import { Check, ChevronRight } from 'lucide-react';
import { portalContainer } from '@/lib/portalContainer';
import { cn } from '@/lib/utils';

/** Right-click menus in the creative apps' dark gray, to match their menubars (`./chrome`). */

const CONTENT = 'z-50 min-w-48 rounded-md border border-[#1c1c1c] bg-[#3a3a3a] p-1 text-xs text-[#e0e0e0] shadow-xl shadow-black/40';
const ITEM = cn(
  'relative flex h-6 cursor-default items-center rounded-[3px] pr-2 pl-6 outline-none select-none',
  'data-[highlighted]:bg-[#2d8ceb] data-[highlighted]:text-white data-[disabled]:text-[#7a7a7a]',
);

export function ContextMenu(props: React.ComponentProps<typeof CM.Root>) {
  return <CM.Root {...props} />;
}

export function ContextMenuTrigger(props: React.ComponentProps<typeof CM.Trigger>) {
  return <CM.Trigger {...props} />;
}

export function ContextMenuContent({ className, ...props }: React.ComponentProps<typeof CM.Content>) {
  return (
    <CM.Portal container={portalContainer()}>
      <CM.Content
        className={cn(CONTENT, className)}
        {...props}
        onPointerUpCapture={(e) => {
          // The right-button release that opened the menu mustn't pick an item (see ui/context-menu).
          if (e.button !== 0) e.stopPropagation();
          props.onPointerUpCapture?.(e);
        }}
      />
    </CM.Portal>
  );
}

export function ContextMenuItem({
  shortcut,
  destructive,
  children,
  className,
  ...props
}: React.ComponentProps<typeof CM.Item> & { shortcut?: string; destructive?: boolean }) {
  return (
    <CM.Item
      className={cn(ITEM, destructive && 'text-[#ff8a80] data-[highlighted]:bg-[#c62828]', className)}
      data-variant={destructive ? 'destructive' : undefined}
      {...props}
    >
      {children}
      {shortcut && <span className="ml-auto pl-8 text-[#a0a0a0] [[data-highlighted]_&]:text-white/85">{shortcut}</span>}
    </CM.Item>
  );
}

export function ContextMenuCheckboxItem({ children, ...props }: React.ComponentProps<typeof CM.CheckboxItem>) {
  return (
    <CM.CheckboxItem className={ITEM} {...props}>
      <CM.ItemIndicator className="absolute left-1.5">
        <Check className="size-3.5" />
      </CM.ItemIndicator>
      {children}
    </CM.CheckboxItem>
  );
}

export function ContextMenuSub({ label, disabled, children }: { label: React.ReactNode; disabled?: boolean; children: React.ReactNode }) {
  return (
    <CM.Sub>
      <CM.SubTrigger disabled={disabled} className={cn(ITEM, 'data-[state=open]:bg-[#4a4a4a]')}>
        {label}
        <ChevronRight className="ml-auto size-3.5" />
      </CM.SubTrigger>
      <CM.Portal container={portalContainer()}>
        <CM.SubContent className={cn(CONTENT, 'max-h-[70vh] overflow-y-auto')}>{children}</CM.SubContent>
      </CM.Portal>
    </CM.Sub>
  );
}

export function ContextMenuSeparator() {
  return <CM.Separator className="mx-1 my-1 h-px bg-[#2a2a2a]" />;
}
