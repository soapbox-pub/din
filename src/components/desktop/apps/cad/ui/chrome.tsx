import { useEffect, useRef } from 'react';
import { DropdownMenu as Menu } from 'radix-ui';
import { Check, ChevronDown, ChevronRight } from 'lucide-react';
import { portalContainer } from '@/lib/portalContainer';
import { cn } from '@/lib/utils';
import { FOCUS, keepFocus } from './style';

/**
 * CAD's widgets in AutoCAD's dark theme: the slate ribbon, its big and
 * small buttons and split buttons, dropdowns, and dark dialogs.
 */

export function BigButton({ icon, label, onClick, menu, active, title }: { icon: React.ReactNode; label: string; onClick?: () => void; menu?: React.ReactNode; active?: boolean; title?: string }) {
  const body = (
    <>
      <span className="grid size-8 place-items-center [&>svg]:size-7">{icon}</span>
      <span className="flex items-center gap-0.5 text-[11.5px] leading-tight whitespace-nowrap text-[#dfe4ec]">
        {label}
        {menu && <ChevronDown className="size-3 text-[#a9b2bf]" />}
      </span>
    </>
  );
  const cls = cn('flex h-[66px] min-w-[46px] flex-col items-center justify-start gap-1 rounded-[2px] px-1.5 pt-1.5 hover:bg-[#4b5563] active:bg-[#566173]', active && 'bg-[#1f6fa3] hover:bg-[#2582bd]', FOCUS);
  if (menu)
    return (
      <SplitMenu trigger={<button type="button" title={title ?? label} className={cls}>{body}</button>} onClick={onClick}>
        {menu}
      </SplitMenu>
    );
  return (
    <button type="button" title={title ?? label} onClick={onClick} className={cls} onMouseDown={keepFocus}>
      {body}
    </button>
  );
}

export function SmallButton({ icon, label, onClick, menu, active, iconOnly, title, disabled }: { icon: React.ReactNode; label: string; onClick?: () => void; menu?: React.ReactNode; active?: boolean; iconOnly?: boolean; title?: string; disabled?: boolean }) {
  const body = (
    <>
      <span className="grid size-4 shrink-0 place-items-center [&>svg]:size-4">{icon}</span>
      {!iconOnly && <span className="text-[11.5px] whitespace-nowrap text-[#dfe4ec]">{label}</span>}
      {menu && <ChevronDown className="size-3 shrink-0 text-[#a9b2bf]" />}
    </>
  );
  const cls = cn('flex h-[21px] items-center gap-1.5 rounded-[2px] px-1 hover:bg-[#4b5563] active:bg-[#566173] disabled:opacity-40 disabled:hover:bg-transparent', active && 'bg-[#1f6fa3] hover:bg-[#2582bd]', FOCUS);
  if (menu)
    return (
      <SplitMenu trigger={<button type="button" title={title ?? label} aria-label={label} className={cls} disabled={disabled}>{body}</button>} onClick={onClick}>
        {menu}
      </SplitMenu>
    );
  return (
    <button type="button" title={title ?? label} aria-label={label} onClick={onClick} className={cls} onMouseDown={keepFocus} disabled={disabled}>
      {body}
    </button>
  );
}

/** A button whose menu opens on its arrow, or on the whole button if it has no action of its own. */
function SplitMenu({ trigger, onClick, children }: { trigger: React.ReactElement; onClick?: () => void; children: React.ReactNode }) {
  void onClick;
  return (
    <Menu.Root modal={false}>
      <Menu.Trigger asChild onMouseDown={keepFocus}>
        {trigger}
      </Menu.Trigger>
      <MenuContent>{children}</MenuContent>
    </Menu.Root>
  );
}

export function MenuContent({ className, children, ...props }: React.ComponentProps<typeof Menu.Content>) {
  return (
    <Menu.Portal container={portalContainer()}>
      <Menu.Content
        align="start"
        sideOffset={2}
        collisionPadding={8}
        onCloseAutoFocus={(e) => e.preventDefault()}
        className={cn(
          'z-[60] max-h-[min(80vh,640px)] min-w-48 overflow-y-auto rounded-[3px] border border-[#15191e] bg-[#2f3640] p-1 text-[12px] text-[#e3e8ef] shadow-[0_6px_18px_rgba(0,0,0,0.45)] outline-none',
          className,
        )}
        style={{ fontFamily: "'Inter Variable', 'Segoe UI', sans-serif" }}
        {...props}
      >
        {children}
      </Menu.Content>
    </Menu.Portal>
  );
}

export function MenuItem({ icon, children, shortcut, checked, className, ...props }: React.ComponentProps<typeof Menu.Item> & { icon?: React.ReactNode; shortcut?: string; checked?: boolean }) {
  return (
    <Menu.Item
      className={cn(
        'relative flex h-7 cursor-default items-center gap-2 rounded-[2px] pr-3 pl-2 outline-none select-none data-[disabled]:text-[#737c89] data-[highlighted]:bg-[#0b6aa8] data-[highlighted]:text-white',
        className,
      )}
      {...props}
    >
      <span className="grid size-4 shrink-0 place-items-center [&>svg]:size-4">{checked ? <Check className="size-3.5" /> : icon}</span>
      <span className="flex-1 whitespace-nowrap">{children}</span>
      {shortcut && <span className="pl-6 text-[11px] text-[#9aa4b1]">{shortcut}</span>}
    </Menu.Item>
  );
}

export const MenuSeparator = () => <Menu.Separator className="mx-1 my-1 h-px bg-[#454e5b]" />;
export const MenuLabel = ({ children }: { children: React.ReactNode }) => <Menu.Label className="px-2 pt-1.5 pb-1 text-[11px] font-semibold tracking-wide text-[#9aa4b1] uppercase">{children}</Menu.Label>;

export function SubMenu({ label, icon, children }: { label: string; icon?: React.ReactNode; children: React.ReactNode }) {
  return (
    <Menu.Sub>
      <Menu.SubTrigger className="relative flex h-7 cursor-default items-center gap-2 rounded-[2px] pr-2 pl-2 outline-none select-none data-[highlighted]:bg-[#0b6aa8] data-[state=open]:bg-[#3b4452]">
        <span className="grid size-4 shrink-0 place-items-center [&>svg]:size-4">{icon}</span>
        <span className="flex-1">{label}</span>
        <ChevronRight className="size-3.5" />
      </Menu.SubTrigger>
      <Menu.Portal container={portalContainer()}>
        <Menu.SubContent sideOffset={2} className="z-[61] min-w-44 rounded-[3px] border border-[#15191e] bg-[#2f3640] p-1 text-[12px] text-[#e3e8ef] shadow-[0_6px_18px_rgba(0,0,0,0.45)]" style={{ fontFamily: "'Inter Variable', 'Segoe UI', sans-serif" }}>
          {children}
        </Menu.SubContent>
      </Menu.Portal>
    </Menu.Sub>
  );
}

/** A ribbon dropdown: shows the current choice, opens a menu of all of them. */
export function Dropdown({ value, label, width = 'w-44', children, title }: { value: React.ReactNode; label: string; width?: string; children: React.ReactNode; title?: string }) {
  return (
    <Menu.Root modal={false}>
      <Menu.Trigger asChild onMouseDown={keepFocus}>
        <button type="button" aria-label={label} title={title ?? label} className={cn('flex h-[22px] items-center gap-1.5 rounded-[2px] border border-[#4f5865] bg-[#2b313a] pr-1 pl-1.5 text-left text-[11.5px] text-[#e3e8ef] hover:border-[#6f7b8b]', width, FOCUS)}>
          <span className="flex min-w-0 flex-1 items-center gap-1.5 truncate">{value}</span>
          <ChevronDown className="size-3 shrink-0 text-[#a9b2bf]" />
        </button>
      </Menu.Trigger>
      <MenuContent className="min-w-56">{children}</MenuContent>
    </Menu.Root>
  );
}

export function Panel({ title, children, onExpand }: { title: string; children: React.ReactNode; onExpand?: () => void }) {
  return (
    <div className="flex shrink-0 flex-col border-r border-[#262c34]">
      <div className="flex flex-1 items-start gap-0.5 px-1 pt-1">{children}</div>
      <button
        type="button"
        onClick={onExpand}
        onMouseDown={keepFocus}
        tabIndex={onExpand ? 0 : -1}
        className={cn('flex h-[18px] items-center justify-center gap-1 bg-[#2f3640] text-[11px] text-[#b6bec9]', onExpand && 'hover:bg-[#3b4452] hover:text-white')}
      >
        {title}
        {onExpand && <ChevronDown className="size-3" />}
      </button>
    </div>
  );
}

/** A column of small buttons in a panel. */
export const Col = ({ children }: { children: React.ReactNode }) => <div className="flex flex-col gap-px">{children}</div>;

export function Button({ primary, className, ...props }: React.ComponentProps<'button'> & { primary?: boolean }) {
  return (
    <button
      type="button"
      className={cn(
        'h-7 min-w-20 rounded-[2px] px-4 text-[12px] disabled:opacity-40',
        primary ? 'bg-[#0696d7] text-white hover:bg-[#13a7ea] active:bg-[#0583bd]' : 'border border-[#5a6473] bg-[#38404c] text-[#e3e8ef] hover:bg-[#434c5a]',
        FOCUS,
        className,
      )}
      {...props}
    />
  );
}

/** A dark dialog inside the window, AutoCAD style: title bar, body, buttons on the right. */
export function Dialog({
  title,
  onCancel,
  onOk,
  okLabel = 'OK',
  cancelLabel = 'Cancel',
  children,
  footer,
  width = 420,
  className,
}: {
  title: string;
  onCancel: () => void;
  onOk?: () => void;
  okLabel?: string;
  cancelLabel?: string;
  children: React.ReactNode;
  footer?: React.ReactNode;
  width?: number;
  className?: string;
}) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = ref.current;
    if (el && !el.contains(document.activeElement)) (el.querySelector<HTMLElement>('[autofocus],[data-autofocus]') ?? el).focus();
  }, []);
  return (
    <div className="absolute inset-0 z-50 grid place-items-center bg-black/30 p-4" onPointerDown={(e) => e.target === e.currentTarget && e.preventDefault()}>
      <div
        ref={ref}
        role="dialog"
        aria-modal
        aria-label={title}
        tabIndex={-1}
        style={{ width }}
        onKeyDown={(e) => {
          e.stopPropagation();
          if (e.key === 'Escape') {
            e.preventDefault();
            onCancel();
          } else if (e.key === 'Enter' && onOk && !(e.target instanceof HTMLTextAreaElement) && !(e.target instanceof HTMLButtonElement)) {
            e.preventDefault();
            onOk();
          }
        }}
        className={cn('flex max-h-full max-w-full flex-col overflow-hidden rounded-[4px] border border-[#15191e] bg-[#333a45] text-[12.5px] text-[#e3e8ef] shadow-[0_12px_40px_rgba(0,0,0,0.55)] outline-none', className)}
      >
        <div className="flex h-8 shrink-0 items-center justify-between bg-[#272d36] pr-1 pl-3 text-[12.5px]">
          <span>{title}</span>
          <button type="button" aria-label="Close" onClick={onCancel} className={cn('grid size-6 place-items-center rounded-[2px] text-[#c4ccd7] hover:bg-[#c42b1c] hover:text-white', FOCUS)}>
            <svg viewBox="0 0 24 24" className="size-3.5" stroke="currentColor" strokeWidth={2} fill="none">
              <path d="M6 6l12 12M18 6 6 18" />
            </svg>
          </button>
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto p-4">{children}</div>
        <div className="flex shrink-0 items-center gap-2 border-t border-[#262c34] bg-[#2f3640] px-4 py-2.5">
          <div className="min-w-0 flex-1">{footer}</div>
          {onOk && (
            <Button primary onClick={onOk}>
              {okLabel}
            </Button>
          )}
          <Button onClick={onCancel}>{cancelLabel}</Button>
        </div>
      </div>
    </div>
  );
}

export function Field({ label, children, className }: { label: string; children: React.ReactNode; className?: string }) {
  return (
    <label className={cn('flex items-center justify-between gap-3 py-1', className)}>
      <span className="text-[12px] text-[#c4ccd7]">{label}</span>
      {children}
    </label>
  );
}

export function Check2({ checked, onChange, children }: { checked: boolean; onChange: (v: boolean) => void; children: React.ReactNode }) {
  return (
    <label className="flex cursor-pointer items-center gap-2 py-0.5 text-[12px] text-[#dfe4ec] select-none">
      <input type="checkbox" checked={checked} onChange={(e) => onChange(e.target.checked)} onKeyDown={(e) => e.stopPropagation()} className={cn('size-3.5 cursor-pointer accent-[#0696d7]', FOCUS)} />
      {children}
    </label>
  );
}

