import { useEffect, useRef } from 'react';
import { Menubar as MenubarPrimitive } from 'radix-ui';
import { portalContainer } from '@/lib/portalContainer';
import { cn } from '@/lib/utils';
import { FOCUS, RAISED, RETRO_FONT, SUNKEN } from './styles';

/** Windows 98 widgets for Paint: buttons, dialogs and the menu bar. */

export function RetroButton({
  className,
  pressed,
  ...props
}: React.ComponentProps<'button'> & { pressed?: boolean }) {
  return (
    <button
      type="button"
      className={cn(
        'min-w-[75px] bg-[#c0c0c0] px-3 py-1 text-black active:shadow-[inset_-1px_-1px_#ffffff,inset_1px_1px_#0a0a0a,inset_-2px_-2px_#dfdfdf,inset_2px_2px_#808080] disabled:text-[#808080] disabled:[text-shadow:1px_1px_#fff]',
        pressed ? SUNKEN : RAISED,
        FOCUS,
        className,
      )}
      {...props}
    />
  );
}

/** A little window inside Paint's window, for questions and settings. */
export function RetroDialog({
  title,
  onClose,
  children,
  className,
}: {
  title: string;
  onClose: () => void;
  children: React.ReactNode;
  className?: string;
}) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = ref.current;
    if (el && !el.contains(document.activeElement)) {
      (el.querySelector<HTMLElement>('[autofocus],[data-autofocus]') ?? el).focus();
    }
  }, []);
  return (
    <div
      className="absolute inset-0 z-30 grid place-items-center bg-black/10 p-4"
      onPointerDown={(e) => {
        if (e.target === e.currentTarget) e.preventDefault();
      }}
    >
      <div
        ref={ref}
        role="dialog"
        aria-modal
        aria-label={title}
        tabIndex={-1}
        onKeyDown={(e) => {
          e.stopPropagation();
          if (e.key === 'Escape') {
            e.preventDefault();
            onClose();
          }
        }}
        className={cn('max-w-full bg-[#c0c0c0] p-[3px] outline-none', RAISED, className)}
      >
        <div className="flex h-[18px] items-center bg-gradient-to-r from-[#000080] to-[#1084d0] pr-0.5 pl-1">
          <span className="min-w-0 flex-1 truncate text-xs font-bold text-white">{title}</span>
          <button
            type="button"
            aria-label="Close"
            onClick={onClose}
            className={cn('grid h-[14px] w-4 place-items-center bg-[#c0c0c0] text-[10px] leading-none font-bold text-black', RAISED, FOCUS)}
          >
            ✕
          </button>
        </div>
        <div className="p-3">{children}</div>
      </div>
    </div>
  );
}

export function Menubar(props: React.ComponentProps<typeof MenubarPrimitive.Root>) {
  return <MenubarPrimitive.Root {...props} />;
}

export function MenubarMenu(props: React.ComponentProps<typeof MenubarPrimitive.Menu>) {
  return <MenubarPrimitive.Menu {...props} />;
}

export function MenubarRadioGroup(props: React.ComponentProps<typeof MenubarPrimitive.RadioGroup>) {
  return <MenubarPrimitive.RadioGroup {...props} />;
}

export function MenubarSub(props: React.ComponentProps<typeof MenubarPrimitive.Sub>) {
  return <MenubarPrimitive.Sub {...props} />;
}

export function MenubarTrigger({ className, ...props }: React.ComponentProps<typeof MenubarPrimitive.Trigger>) {
  return (
    <MenubarPrimitive.Trigger
      className={cn(
        'px-2 py-0.5 text-black outline-none select-none data-[highlighted]:bg-[#000080] data-[highlighted]:text-white data-[state=open]:bg-[#000080] data-[state=open]:text-white',
        className,
      )}
      {...props}
    />
  );
}

const CONTENT = cn('z-50 min-w-48 bg-[#c0c0c0] p-[3px] text-xs text-black', RAISED);

export function MenubarContent({ className, ...props }: React.ComponentProps<typeof MenubarPrimitive.Content>) {
  return (
    <MenubarPrimitive.Portal container={portalContainer()}>
      <MenubarPrimitive.Content align="start" sideOffset={1} className={cn(CONTENT, className)} style={RETRO_FONT} {...props} />
    </MenubarPrimitive.Portal>
  );
}

export function MenubarSubContent({ className, ...props }: React.ComponentProps<typeof MenubarPrimitive.SubContent>) {
  return (
    <MenubarPrimitive.Portal container={portalContainer()}>
      <MenubarPrimitive.SubContent alignOffset={-3} className={cn(CONTENT, className)} style={RETRO_FONT} {...props} />
    </MenubarPrimitive.Portal>
  );
}

const ITEM =
  'relative flex cursor-default items-center py-[3px] pr-4 pl-6 outline-none select-none data-[disabled]:text-[#808080] data-[disabled]:[text-shadow:1px_1px_#fff] data-[highlighted]:bg-[#000080] data-[highlighted]:text-white data-[highlighted]:[text-shadow:none]';

function Shortcut({ children }: { children?: React.ReactNode }) {
  return children ? <span className="ml-auto pl-6">{children}</span> : null;
}

export function MenubarItem({
  shortcut,
  children,
  className,
  ...props
}: React.ComponentProps<typeof MenubarPrimitive.Item> & { shortcut?: string }) {
  return (
    <MenubarPrimitive.Item className={cn(ITEM, className)} {...props}>
      {children}
      <Shortcut>{shortcut}</Shortcut>
    </MenubarPrimitive.Item>
  );
}

export function MenubarCheckboxItem({
  shortcut,
  children,
  ...props
}: React.ComponentProps<typeof MenubarPrimitive.CheckboxItem> & { shortcut?: string }) {
  return (
    <MenubarPrimitive.CheckboxItem className={ITEM} {...props}>
      <MenubarPrimitive.ItemIndicator className="absolute left-2">✓</MenubarPrimitive.ItemIndicator>
      {children}
      <Shortcut>{shortcut}</Shortcut>
    </MenubarPrimitive.CheckboxItem>
  );
}

export function MenubarRadioItem({ children, ...props }: React.ComponentProps<typeof MenubarPrimitive.RadioItem>) {
  return (
    <MenubarPrimitive.RadioItem className={ITEM} {...props}>
      <MenubarPrimitive.ItemIndicator className="absolute left-2">●</MenubarPrimitive.ItemIndicator>
      {children}
    </MenubarPrimitive.RadioItem>
  );
}

export function MenubarSubTrigger({ children }: { children: React.ReactNode }) {
  return (
    <MenubarPrimitive.SubTrigger className={cn(ITEM, 'data-[state=open]:bg-[#000080] data-[state=open]:text-white')}>
      {children}
      <span className="ml-auto pl-6">▸</span>
    </MenubarPrimitive.SubTrigger>
  );
}

export function MenubarSeparator() {
  return <MenubarPrimitive.Separator className="mx-0.5 my-[3px] h-0 border-t border-b border-t-[#808080] border-b-white" />;
}
