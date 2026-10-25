import { cloneElement, useEffect, useId, useMemo, useRef, useState } from 'react';
import { DropdownMenu as Menu, Popover } from 'radix-ui';
import {
  ArrowLeft,
  Check,
  ChevronDown,
  ChevronRight,
  ChevronUp,
  Clock,
  File,
  FileText,
  FolderOpen,
  Info,
  Minus,
  Plus,
  Printer,
  Redo2,
  Save,
  Search,
  Undo2,
  X,
} from 'lucide-react';
import { portalContainer } from '@/lib/portalContainer';
import { cn } from '@/lib/utils';
import { ACCENTS, AppContext, FIELD, FOCUS, keepFocus, refocusFrame, useOfficeApp, type OfficeApp } from './accent';
import { FONT_CHOICES, fontStack } from './fonts';
import { PICKER_NAMES, PICKER_THEME_ORDER, pickerVariants, STANDARD_COLORS, tintColor, type Theme, type ThemeColorName } from './theme';

/**
 * The Office look the three apps share: an app-colored title bar with the
 * Quick Access Toolbar, ribbon tabs over a ribbon of labelled groups, the
 * File tab's full-window Backstage, and a status bar with view buttons and
 * the zoom slider. People who know Office find things where their hands
 * expect them, so this follows Microsoft 365's layout and wording closely.
 */

export function OfficeFrame({
  app,
  children,
  className,
  ...props
}: { app: OfficeApp } & React.ComponentProps<'div'>) {
  const a = ACCENTS[app];
  return (
    <AppContext.Provider value={app}>
      <div
        tabIndex={-1}
        {...props}
        className={cn('office-frame relative flex h-full w-full flex-col overflow-hidden outline-none bg-[#f3f3f3] text-[12px] text-[#242424] select-none', className)}
        style={
          {
            '--office-accent': a.accent,
            '--office-accent-dark': a.dark,
            '--office-accent-light': a.light,
            fontFamily: "'Inter Variable', 'Segoe UI', system-ui, sans-serif",
            colorScheme: 'light',
          } as React.CSSProperties
        }
      >
        {children}
      </div>
    </AppContext.Provider>
  );
}

// ---- Title bar -------------------------------------------------------------------

export function TitleBar({
  title,
  status,
  onSave,
  onUndo,
  onRedo,
  canUndo,
  canRedo,
  search,
}: {
  title: string;
  status?: string;
  onSave: () => void;
  onUndo: () => void;
  onRedo: () => void;
  canUndo: boolean;
  canRedo: boolean;
  search?: { placeholder?: string; onSearch: (text: string) => void };
}) {
  const [query, setQuery] = useState('');
  return (
    <div className="flex h-10 shrink-0 items-center gap-1 bg-[var(--office-accent)] px-2 text-white" onMouseDown={keepFocus}>
      <QatButton label="Save (Ctrl+S)" onClick={onSave}>
        <Save className="size-4" />
      </QatButton>
      <QatButton label="Undo (Ctrl+Z)" onClick={onUndo} disabled={!canUndo}>
        <Undo2 className="size-4" />
      </QatButton>
      <QatButton label="Redo (Ctrl+Y)" onClick={onRedo} disabled={!canRedo}>
        <Redo2 className="size-4" />
      </QatButton>
      <div className="flex min-w-0 flex-1 items-center justify-center gap-2 px-2">
        <span className="truncate text-[12.5px] font-normal">{title}</span>
        {status && <span className="hidden shrink-0 text-[12px] text-white/75 sm:inline">• {status}</span>}
      </div>
      {search && (
        <form
          className="hidden w-[min(320px,30%)] items-center gap-2 rounded-md bg-white/15 px-2.5 transition-colors focus-within:bg-white md:flex"
          onSubmit={(e) => {
            e.preventDefault();
            search.onSearch(query);
          }}
        >
          <Search className="size-3.5 shrink-0 opacity-80 [form:focus-within_&]:text-[#424242]" />
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => e.stopPropagation()}
            placeholder={search.placeholder ?? 'Search'}
            aria-label="Search"
            className="h-7 min-w-0 flex-1 bg-transparent text-[12.5px] text-white outline-none placeholder:text-white/80 focus:text-[#242424] focus:placeholder:text-[#707070]"
          />
        </form>
      )}
    </div>
  );
}

function QatButton({ label, onClick, disabled, children }: { label: string; onClick: () => void; disabled?: boolean; children: React.ReactNode }) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      onClick={onClick}
      disabled={disabled}
      className="grid size-8 place-items-center rounded-md hover:bg-white/15 active:bg-white/25 disabled:opacity-45 disabled:hover:bg-transparent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white"
    >
      {children}
    </button>
  );
}

// ---- Ribbon ----------------------------------------------------------------------

export interface RibbonTab {
  id: string;
  label: string;
  /** Contextual tabs (Table Design, Shape Format) show while something is selected. */
  contextual?: boolean;
}

export function RibbonTabs({
  tabs,
  active,
  onSelect,
  onFile,
  collapsed,
  onToggleCollapsed,
}: {
  tabs: RibbonTab[];
  active: string;
  onSelect: (id: string) => void;
  onFile: () => void;
  collapsed: boolean;
  onToggleCollapsed: () => void;
}) {
  return (
    <div role="tablist" aria-label="Ribbon tabs" className="flex h-9 shrink-0 items-end gap-0.5 overflow-x-auto px-2 [scrollbar-width:none]" onMouseDown={keepFocus}>
      <button
        type="button"
        onClick={onFile}
        className={cn('mb-1 h-7 shrink-0 rounded-md px-3 text-[13px] text-[#242424] hover:bg-black/5', FOCUS)}
      >
        File
      </button>
      {tabs.map((t) => {
        const selected = t.id === active && !collapsed;
        return (
          <button
            key={t.id}
            type="button"
            role="tab"
            aria-selected={selected}
            onClick={() => (collapsed ? (onSelect(t.id), onToggleCollapsed()) : onSelect(t.id))}
            onDoubleClick={onToggleCollapsed}
            className={cn(
              'relative mb-1 h-7 shrink-0 rounded-md px-3 text-[13px] whitespace-nowrap hover:bg-black/5',
              t.contextual ? 'font-semibold text-[var(--office-accent)]' : 'text-[#242424]',
              selected && 'font-semibold text-[var(--office-accent)]',
              FOCUS,
            )}
          >
            {/* Bold without shifting the tabs after it: the bold width is reserved by an invisible copy. */}
            <span data-text={t.label} className="inline-flex flex-col after:invisible after:h-0 after:overflow-hidden after:font-semibold after:content-[attr(data-text)]">
              {t.label}
            </span>
            {selected && <span className="absolute inset-x-3 -bottom-0.5 h-[3px] rounded-full bg-[var(--office-accent)]" />}
          </button>
        );
      })}
      <span className="flex-1" />
      <button
        type="button"
        onClick={onToggleCollapsed}
        title={collapsed ? 'Pin the ribbon (Ctrl+F1)' : 'Collapse the ribbon (Ctrl+F1)'}
        aria-label={collapsed ? 'Pin the ribbon' : 'Collapse the ribbon'}
        className={cn('mb-1 grid size-7 shrink-0 place-items-center rounded-md text-[#424242] hover:bg-black/5', FOCUS)}
      >
        {collapsed ? <ChevronDown className="size-4" /> : <ChevronUp className="size-4" />}
      </button>
    </div>
  );
}

export function Ribbon({ children, collapsed }: { children: React.ReactNode; collapsed: boolean }) {
  if (collapsed) return <div className="h-1 shrink-0" />;
  return (
    <div
      role="toolbar"
      className="mx-1.5 mb-1.5 flex h-[100px] shrink-0 items-stretch overflow-x-auto overflow-y-hidden rounded-lg border border-[#e0e0e0] bg-white px-1 shadow-[0_1px_2px_rgba(0,0,0,0.06)] [scrollbar-width:thin]"
      onMouseDown={keepFocus}
    >
      {children}
    </div>
  );
}

export function RibbonGroup({ label, children, className }: { label: string; children: React.ReactNode; className?: string }) {
  return (
    <div role="group" aria-label={label} className="relative flex shrink-0 flex-col py-1 after:absolute after:top-2 after:right-0 after:bottom-2 after:w-px after:bg-[#e1e1e1] last:after:hidden">
      <div className={cn('flex min-h-0 flex-1 items-start gap-0.5 px-1.5', className)}>{children}</div>
      <div className="h-4 shrink-0 px-2 text-center text-[11px] leading-4 whitespace-nowrap text-[#616161]">{label}</div>
    </div>
  );
}

/** Rows of small buttons stacked in a group (a group has room for three). */
export function Stack({ children, className }: { children: React.ReactNode; className?: string }) {
  return <div className={cn('flex flex-col justify-start gap-0.5', className)}>{children}</div>;
}

export function Row({ children, className }: { children: React.ReactNode; className?: string }) {
  return <div className={cn('flex items-center gap-0.5', className)}>{children}</div>;
}

export function RowSep() {
  return <span className="mx-0.5 h-5 w-px shrink-0 bg-[#e1e1e1]" />;
}

const BTN = 'rounded-[4px] text-[#242424] hover:bg-[#f0f0f0] active:bg-[#e0e0e0] disabled:text-[#bdbdbd] disabled:hover:bg-transparent';
const PRESSED = 'bg-[#e0e0e0] hover:bg-[#d6d6d6]';

interface ButtonProps {
  icon?: React.ReactNode;
  label: string;
  /** Shown beside small buttons; tooltips name the rest. */
  text?: string;
  /** The tooltip, if it should say more than the label (a shortcut, say). */
  tip?: string;
  onClick?: () => void;
  pressed?: boolean;
  disabled?: boolean;
  /** A dropdown: the whole button opens it, or with `split`, just its arrow. */
  menu?: React.ReactNode;
  split?: boolean;
  className?: string;
  menuClassName?: string;
}

export function BigButton({ icon, label, tip, onClick, pressed, disabled, menu, split, className, menuClassName }: ButtonProps) {
  const face = (
    <>
      <span className="grid h-8 place-items-center [&>svg]:size-7">{icon}</span>
      <span className="flex items-center gap-0.5 text-center text-[11.5px] leading-[14px] whitespace-nowrap">
        {label}
        {menu && !split && <ChevronDown className="size-3 shrink-0 text-[#616161]" />}
      </span>
    </>
  );
  const base = cn('flex min-w-11 flex-col items-center gap-1 px-1.5 pt-1.5 pb-1', FOCUS);
  if (menu && split) {
    return (
      <div className={cn('flex h-[76px] flex-col overflow-hidden rounded-[4px] hover:ring-1 hover:ring-[#e0e0e0]', className)}>
        <button type="button" title={tip ?? label} onClick={onClick} disabled={disabled} aria-pressed={pressed} className={cn(BTN, base, 'flex-1 rounded-b-none pb-0', pressed && PRESSED)}>
          <span className="grid h-8 place-items-center [&>svg]:size-7">{icon}</span>
        </button>
        <DropButton menu={menu} disabled={disabled} label={`${label} options`} menuClassName={menuClassName} className={cn(BTN, 'flex flex-col items-center rounded-t-none px-1.5 pb-1 text-[11.5px] leading-[14px]', FOCUS)}>
          <span className="whitespace-nowrap">{label}</span>
          <ChevronDown className="size-3 text-[#616161]" />
        </DropButton>
      </div>
    );
  }
  if (menu) {
    return (
      <DropButton menu={menu} disabled={disabled} label={tip ?? label} menuClassName={menuClassName} className={cn(BTN, base, 'h-[76px]', pressed && PRESSED, className)}>
        {face}
      </DropButton>
    );
  }
  return (
    <button type="button" title={tip ?? label} onClick={onClick} disabled={disabled} aria-pressed={pressed} className={cn(BTN, base, 'h-[76px]', pressed && PRESSED, className)}>
      {face}
    </button>
  );
}

export function SmallButton({ icon, label, text, tip, onClick, pressed, disabled, menu, split, className, menuClassName }: ButtonProps) {
  const base = cn('flex h-6 items-center gap-1 px-1 [&>svg]:size-4 [&>span>svg]:size-4', FOCUS);
  if (menu && split) {
    return (
      <div className={cn('flex h-6 items-stretch rounded-[4px] hover:ring-1 hover:ring-[#e0e0e0]', className)}>
        <button type="button" aria-label={label} title={tip ?? label} onClick={onClick} disabled={disabled} aria-pressed={pressed} className={cn(BTN, base, 'rounded-r-none', pressed && PRESSED)}>
          {icon}
          {text && <span className="text-[12px] whitespace-nowrap">{text}</span>}
        </button>
        <DropButton menu={menu} disabled={disabled} label={`${label} options`} menuClassName={menuClassName} className={cn(BTN, 'grid w-3.5 place-items-center rounded-l-none', FOCUS)}>
          <ChevronDown className="size-3 text-[#616161]" />
        </DropButton>
      </div>
    );
  }
  if (menu) {
    return (
      <DropButton menu={menu} disabled={disabled} label={tip ?? label} menuClassName={menuClassName} className={cn(BTN, base, pressed && PRESSED, className)}>
        {icon}
        {text && <span className="text-[12px] whitespace-nowrap">{text}</span>}
        <ChevronDown className="size-3 text-[#616161]" />
      </DropButton>
    );
  }
  return (
    <button type="button" aria-label={label} title={tip ?? label} onClick={onClick} disabled={disabled} aria-pressed={pressed} className={cn(BTN, base, pressed && PRESSED, className)}>
      {icon}
      {text && <span className="text-[12px] whitespace-nowrap">{text}</span>}
    </button>
  );
}

function DropButton({
  menu,
  disabled,
  label,
  className,
  menuClassName,
  children,
}: {
  menu: React.ReactNode;
  disabled?: boolean;
  label: string;
  className?: string;
  menuClassName?: string;
  children: React.ReactNode;
}) {
  const triggerRef = useRef<HTMLButtonElement>(null);
  // Closed by a press outside the app (another window, the desktop): focus
  // belongs there now, and taking it back would raise this window over it.
  const leftApp = useRef(false);
  return (
    <Menu.Root modal={false}>
      <Menu.Trigger asChild disabled={disabled}>
        <button ref={triggerRef} type="button" title={label} aria-label={label} className={className}>
          {children}
        </button>
      </Menu.Trigger>
      <MenuContent
        className={menuClassName}
        onPointerDownOutside={(e) => {
          leftApp.current = !triggerRef.current?.closest('.office-frame')?.contains(e.target as Node);
        }}
        onCloseAutoFocus={(e) => {
          e.preventDefault();
          if (!leftApp.current) refocusFrame(triggerRef.current);
          leftApp.current = false;
        }}
      >
        {menu}
      </MenuContent>
    </Menu.Root>
  );
}

// ---- Menus -----------------------------------------------------------------------


const MENU = 'z-[60] min-w-44 rounded-md border border-[#d1d1d1] bg-white p-1 text-[12.5px] text-[#242424] shadow-[0_8px_24px_rgba(0,0,0,0.16)] outline-none';

export function MenuContent({ className, children, ...props }: React.ComponentProps<typeof Menu.Content>) {
  const app = useOfficeApp();
  const a = ACCENTS[app];
  return (
    <Menu.Portal container={portalContainer()}>
      <Menu.Content
        align="start"
        sideOffset={2}
        collisionPadding={8}
        onCloseAutoFocus={(e) => e.preventDefault()}
        className={cn(MENU, 'max-h-[min(80vh,640px)] overflow-y-auto', className)}
        style={{ '--office-accent': a.accent, '--office-accent-light': a.light, fontFamily: "'Inter Variable', 'Segoe UI', sans-serif" } as React.CSSProperties}
        {...props}
      >
        {children}
      </Menu.Content>
    </Menu.Portal>
  );
}

const ITEM = cn(
  'relative flex min-h-8 cursor-default items-center gap-2.5 rounded-[4px] py-1 pr-3 pl-2 outline-none select-none',
  'data-[highlighted]:bg-[#f0f0f0] data-[disabled]:text-[#bdbdbd]',
);

export function MenuItem({
  icon,
  shortcut,
  checked,
  children,
  className,
  ...props
}: React.ComponentProps<typeof Menu.Item> & { icon?: React.ReactNode; shortcut?: string; checked?: boolean }) {
  return (
    <Menu.Item className={cn(ITEM, className)} {...props}>
      <span className="grid w-5 shrink-0 place-items-center text-[#424242] [&>svg]:size-4">{checked ? <Check className="size-4" /> : icon}</span>
      <span className="min-w-0 flex-1">{children}</span>
      {shortcut && <span className="pl-6 text-[11.5px] text-[#707070]">{shortcut}</span>}
    </Menu.Item>
  );
}

export function MenuSeparator() {
  return <Menu.Separator className="mx-1 my-1 h-px bg-[#e0e0e0]" />;
}

export function MenuLabel({ children }: { children: React.ReactNode }) {
  return <Menu.Label className="px-2 pt-2 pb-1 text-[11.5px] font-semibold text-[#424242]">{children}</Menu.Label>;
}

export function SubMenu({ label, icon, children }: { label: string; icon?: React.ReactNode; children: React.ReactNode }) {
  const app = useOfficeApp();
  return (
    <Menu.Sub>
      <Menu.SubTrigger className={cn(ITEM, 'data-[state=open]:bg-[#f0f0f0]')}>
        <span className="grid w-5 shrink-0 place-items-center text-[#424242] [&>svg]:size-4">{icon}</span>
        <span className="flex-1">{label}</span>
        <ChevronRight className="size-3.5 text-[#616161]" />
      </Menu.SubTrigger>
      <Menu.Portal container={portalContainer()}>
        <Menu.SubContent
          className={cn(MENU, 'max-h-[70vh] overflow-y-auto')}
          sideOffset={4}
          style={{ '--office-accent': ACCENTS[app].accent, fontFamily: "'Inter Variable', 'Segoe UI', sans-serif" } as React.CSSProperties}
        >
          {children}
        </Menu.SubContent>
      </Menu.Portal>
    </Menu.Sub>
  );
}

/** A menu item that is a whole tile: gallery entries, swatches, a table grid cell. */
export function MenuTile(props: React.ComponentProps<typeof Menu.Item>) {
  return <Menu.Item {...props} />;
}

// ---- Combo boxes (font name and size) ---------------------------------------------

export function ComboBox({
  value,
  onCommit,
  options,
  label,
  width,
  renderOption,
  header,
}: {
  value: string;
  onCommit: (value: string) => void;
  options: { value: string; label?: string; group?: string }[];
  label: string;
  width: number;
  renderOption?: (o: { value: string; label?: string }) => React.ReactNode;
  header?: React.ReactNode;
}) {
  const [text, setText] = useState(value);
  const [editing, setEditing] = useState(false);
  const [open, setOpen] = useState(false);
  const listRef = useRef<HTMLDivElement>(null);
  const shown = editing ? text : value;
  const app = useOfficeApp();

  useEffect(() => {
    if (!open) return;
    // Scroll the current choice into view.
    requestAnimationFrame(() => listRef.current?.querySelector('[data-current]')?.scrollIntoView({ block: 'center' }));
  }, [open]);

  const commit = (v: string) => {
    setEditing(false);
    setOpen(false);
    if (v.trim()) onCommit(v.trim());
  };

  return (
    <Popover.Root open={open} onOpenChange={setOpen}>
      <Popover.Anchor asChild>
        <div
          className="flex h-6 items-stretch rounded-[4px] border border-[#c8c8c8] bg-white hover:border-[#9e9e9e] focus-within:border-[var(--office-accent)]"
          style={{ width }}
        >
          <input
            value={shown}
            aria-label={label}
            title={label}
            onFocus={(e) => {
              setText(value);
              setEditing(true);
              requestAnimationFrame(() => e.target.select());
            }}
            onBlur={() => setEditing(false)}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => {
              e.stopPropagation();
              if (e.key === 'Enter') {
                e.preventDefault();
                commit(text);
              } else if (e.key === 'Escape') {
                setEditing(false);
                setOpen(false);
                (e.target as HTMLInputElement).blur();
              } else if (e.key === 'ArrowDown' && e.altKey) {
                setOpen(true);
              }
            }}
            className="min-w-0 flex-1 bg-transparent pl-1.5 text-[12px] text-[#242424] outline-none select-text"
          />
          <Popover.Trigger asChild>
            <button type="button" tabIndex={-1} aria-label={`${label} list`} onMouseDown={keepFocus} className="grid w-4 place-items-center border-l border-transparent text-[#616161] hover:bg-[#f0f0f0]">
              <ChevronDown className="size-3" />
            </button>
          </Popover.Trigger>
        </div>
      </Popover.Anchor>
      <Popover.Portal container={portalContainer()}>
        <Popover.Content
          align="start"
          sideOffset={2}
          onOpenAutoFocus={(e) => e.preventDefault()}
          onCloseAutoFocus={(e) => e.preventDefault()}
          className={cn(MENU, 'max-h-[min(60vh,480px)] overflow-y-auto p-1')}
          style={{ minWidth: width, '--office-accent': ACCENTS[app].accent, fontFamily: "'Inter Variable', 'Segoe UI', sans-serif" } as React.CSSProperties}
        >
          <div ref={listRef} role="listbox" aria-label={label}>
            {header}
            {options.map((o, i) => {
              const groupHead = o.group && o.group !== options[i - 1]?.group ? o.group : null;
              return (
                <div key={`${o.group ?? ''}:${o.value}`}>
                  {groupHead && <div className="px-2 pt-2 pb-1 text-[11.5px] font-semibold text-[#424242]">{groupHead}</div>}
                  <button
                    type="button"
                    role="option"
                    aria-selected={o.value === value}
                    data-current={o.value === value ? '' : undefined}
                    onMouseDown={keepFocus}
                    onClick={() => commit(o.value)}
                    className={cn('flex w-full items-center rounded-[4px] px-2 py-1 text-left hover:bg-[#f0f0f0]', o.value === value && 'bg-[#e8e8e8]')}
                  >
                    {renderOption ? renderOption(o) : (o.label ?? o.value)}
                  </button>
                </div>
              );
            })}
          </div>
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
}

/** The font box: theme fonts first, then every font, each shown in itself. */
export function FontBox({ value, onCommit, theme, width = 150 }: { value: string; onCommit: (v: string) => void; theme?: Theme; width?: number }) {
  const options = useMemo(() => {
    const list: { value: string; label?: string; group?: string }[] = [];
    if (theme) {
      list.push({ value: theme.majorFont, label: `${theme.majorFont}`, group: 'Theme Fonts' });
      list.push({ value: theme.minorFont, label: `${theme.minorFont}`, group: 'Theme Fonts' });
    }
    for (const f of FONT_CHOICES) list.push({ value: f, group: 'All Fonts' });
    return list;
  }, [theme]);
  return (
    <ComboBox
      value={value}
      onCommit={onCommit}
      options={options}
      label="Font"
      width={width}
      renderOption={(o) => (
        <span className="flex w-full items-baseline justify-between gap-4">
          <span className="text-[15px] whitespace-nowrap" style={{ fontFamily: fontStack(o.value) }}>
            {o.value}
          </span>
          {theme && (o.label === theme.majorFont || o.label === theme.minorFont) && o.value !== '' && (
            <span className="text-[11px] text-[#707070]">{o.value === theme.majorFont ? 'Headings' : 'Body'}</span>
          )}
        </span>
      )}
    />
  );
}

export function SizeBox({ value, onCommit, sizes }: { value: string; onCommit: (v: number) => void; sizes: number[] }) {
  return (
    <ComboBox
      value={value}
      label="Font Size"
      width={48}
      options={sizes.map((s) => ({ value: String(s) }))}
      onCommit={(v) => {
        const n = parseFloat(v);
        if (Number.isFinite(n) && n >= 1 && n <= 1638) onCommit(Math.round(n * 2) / 2);
      }}
    />
  );
}

// ---- Colors ----------------------------------------------------------------------

/** A color as picked: a hex, plus the theme slot it came from, if any. */
export interface PickedColor {
  hex: string;
  theme?: ThemeColorName;
  tint?: number;
}

/** Office's color picker: Theme Colors with their tints, Standard Colors, More Colors. */
export function ColorPalette({
  theme,
  onPick,
  automatic,
  none,
  onMore,
}: {
  theme: Theme;
  onPick: (c: PickedColor | null) => void;
  /** "Automatic" (font color) — picks null. */
  automatic?: string;
  /** "No Fill" / "No Color" — picks null. */
  none?: string;
  onMore: () => void;
}) {
  const swatch = (hex: string, title: string, pick: PickedColor) => (
    <MenuTile
      key={title + hex}
      title={title}
      aria-label={title}
      onSelect={() => onPick(pick)}
      className="size-[18px] cursor-pointer border border-[#e0e0e0] outline-none data-[highlighted]:z-10 data-[highlighted]:scale-110 data-[highlighted]:border-[#e86e15] data-[highlighted]:ring-1 data-[highlighted]:ring-[#fbd5a8]"
      style={{ background: `#${hex}` }}
    />
  );
  return (
    <div className="w-[234px] p-1">
      {(automatic || none) && (
        <MenuTile onSelect={() => onPick(null)} className="mb-1 flex h-7 cursor-pointer items-center gap-2 rounded-[4px] px-2 outline-none data-[highlighted]:bg-[#f0f0f0]">
          <span className={cn('size-4 border border-[#9e9e9e]', automatic ? 'bg-black' : 'bg-[linear-gradient(to_top_right,transparent_45%,#d13438_45%,#d13438_55%,transparent_55%)] bg-white')} />
          {automatic ?? none}
        </MenuTile>
      )}
      <div className="px-1 pb-1 text-[11.5px] font-semibold text-[#424242]">Theme Colors</div>
      <div className="grid grid-cols-10 gap-x-1 px-1">
        {PICKER_THEME_ORDER.map((name) => swatch(theme.colors[name], PICKER_NAMES[name], { hex: theme.colors[name], theme: name }))}
      </div>
      <div className="mt-1 grid grid-cols-10 gap-x-1 px-1">
        {[0, 1, 2, 3, 4].map((row) =>
          PICKER_THEME_ORDER.map((name) => {
            const [label, tint] = pickerVariants(theme.colors[name])[row];
            const hex = tintColor(theme.colors[name], tint);
            return swatch(hex, `${PICKER_NAMES[name]}, ${label}`, { hex, theme: name, tint });
          }),
        )}
      </div>
      <div className="px-1 pt-2 pb-1 text-[11.5px] font-semibold text-[#424242]">Standard Colors</div>
      <div className="grid grid-cols-10 gap-x-1 px-1">{STANDARD_COLORS.map(([hex, name]) => swatch(hex, name, { hex }))}</div>
      <MenuSeparator />
      <MenuTile onSelect={onMore} className="flex h-7 cursor-pointer items-center gap-2 rounded-[4px] px-2 outline-none data-[highlighted]:bg-[#f0f0f0]">
        <span className="size-4 rounded-full bg-[conic-gradient(red,yellow,lime,cyan,blue,magenta,red)]" />
        More Colors…
      </MenuTile>
    </div>
  );
}

/**
 * Font Color, Highlight, Shape Fill: the button applies the last color
 * picked (the bar under its icon), the arrow opens the palette.
 */
export function ColorButton({
  icon,
  label,
  color,
  onApply,
  theme,
  automatic,
  none,
  big,
}: {
  icon: React.ReactNode;
  label: string;
  /** The color the button applies now, or null for automatic / none. */
  color: string | null;
  onApply: (c: PickedColor | null) => void;
  theme: Theme;
  automatic?: string;
  none?: string;
  big?: boolean;
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  const face = (
    <span className="relative flex flex-col items-center">
      {icon}
      <span
        className={cn('mt-[1px] h-[4px] w-4 rounded-[1px]', !color && 'border border-[#9e9e9e]')}
        style={{ background: color ? `#${color}` : automatic ? '#000' : 'transparent' }}
      />
    </span>
  );
  const props = {
    icon: face,
    label,
    split: true,
    onClick: () => onApply(color ? { hex: color } : null),
    menu: <ColorPalette theme={theme} onPick={onApply} automatic={automatic} none={none} onMore={() => setTimeout(() => inputRef.current?.click(), 50)} />,
  };
  return (
    <>
      {big ? <BigButton {...props} /> : <SmallButton {...props} className="[&_button:first-child]:h-6 [&_button:first-child]:py-0" />}
      <input
        ref={inputRef}
        type="color"
        tabIndex={-1}
        aria-hidden
        className="pointer-events-none absolute size-0 opacity-0"
        defaultValue={`#${color ?? '000000'}`}
        onChange={(e) => onApply({ hex: e.target.value.slice(1).toUpperCase() })}
      />
    </>
  );
}

/** The "A" with a colored bar that Office uses for Font Color. */
export function FontColorGlyph() {
  return <span className="text-[14px] leading-[14px] font-semibold text-[#242424]">A</span>;
}

// ---- Status bar ------------------------------------------------------------------

export function StatusBar({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex h-6 shrink-0 items-center gap-1 bg-[#f3f3f3] px-2 text-[11.5px] text-[#424242]" onMouseDown={keepFocus}>
      {children}
    </div>
  );
}

export function StatusText({ children, className, onClick, title }: { children: React.ReactNode; className?: string; onClick?: () => void; title?: string }) {
  if (onClick) {
    return (
      <button type="button" onClick={onClick} title={title} className={cn('h-5 rounded-[3px] px-1.5 whitespace-nowrap hover:bg-black/5', FOCUS, className)}>
        {children}
      </button>
    );
  }
  return <span className={cn('px-1.5 whitespace-nowrap', className)} title={title}>{children}</span>;
}

export function ViewButton({ label, active, onClick, children }: { label: string; active?: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      type="button"
      title={label}
      aria-label={label}
      aria-pressed={active}
      onClick={onClick}
      className={cn('grid h-5 w-6 place-items-center rounded-[3px] text-[#424242] hover:bg-black/5 [&>svg]:size-3.5', active && 'bg-black/10', FOCUS)}
    >
      {children}
    </button>
  );
}

/**
 * Office's zoom slider: 10% at the left end, 100% in the middle, 500% at the
 * right, with − and + stepping by 10 and the percentage opening Zoom.
 */
export function ZoomSlider({ zoom, onZoom, onDialog, min = 10, max = 500 }: { zoom: number; onZoom: (z: number) => void; onDialog?: () => void; min?: number; max?: number }) {
  const toPos = (z: number) => (z <= 100 ? ((z - min) / (100 - min)) * 50 : 50 + ((z - 100) / (max - 100)) * 50);
  const fromPos = (p: number) => Math.round(p <= 50 ? min + (p / 50) * (100 - min) : 100 + ((p - 50) / 50) * (max - 100));
  const clamp = (z: number) => Math.max(min, Math.min(max, z));
  const step = (dir: 1 | -1) => onZoom(clamp(dir > 0 ? Math.floor(zoom / 10) * 10 + 10 : Math.ceil(zoom / 10) * 10 - 10));
  return (
    <div className="flex items-center gap-1">
      <button type="button" aria-label="Zoom Out" title="Zoom Out" onClick={() => step(-1)} className={cn('grid size-5 place-items-center rounded-[3px] hover:bg-black/5', FOCUS)}>
        <Minus className="size-3" />
      </button>
      <div className="relative hidden h-5 w-24 items-center sm:flex">
        <span className="absolute inset-x-0 h-px bg-[#8a8a8a]" />
        <span className="absolute left-1/2 h-2 w-px bg-[#8a8a8a]" />
        <input
          type="range"
          min={0}
          max={100}
          step={0.5}
          value={toPos(zoom)}
          aria-label="Zoom"
          onChange={(e) => {
            let z = fromPos(parseFloat(e.target.value));
            if (Math.abs(z - 100) < 4) z = 100;
            onZoom(clamp(z));
          }}
          onKeyDown={(e) => e.stopPropagation()}
          className="office-zoom relative w-full cursor-pointer appearance-none bg-transparent [&::-webkit-slider-thumb]:h-3 [&::-webkit-slider-thumb]:w-1.5 [&::-webkit-slider-thumb]:appearance-none [&::-webkit-slider-thumb]:rounded-[2px] [&::-webkit-slider-thumb]:bg-[#424242]"
        />
      </div>
      <button type="button" aria-label="Zoom In" title="Zoom In" onClick={() => step(1)} className={cn('grid size-5 place-items-center rounded-[3px] hover:bg-black/5', FOCUS)}>
        <Plus className="size-3" />
      </button>
      <button type="button" title="Zoom level" onClick={onDialog} className={cn('h-5 w-11 rounded-[3px] text-right tabular-nums hover:bg-black/5', FOCUS)}>
        {Math.round(zoom)}%
      </button>
    </div>
  );
}

// ---- Dialogs ---------------------------------------------------------------------

export function OfficeButton({ primary, className, ...props }: React.ComponentProps<'button'> & { primary?: boolean }) {
  return (
    <button
      type="button"
      className={cn(
        'h-8 min-w-20 rounded-[4px] px-3 text-[13px] font-semibold transition-colors motion-reduce:transition-none disabled:opacity-40',
        primary
          ? 'bg-[var(--office-accent)] text-white hover:bg-[var(--office-accent-dark)]'
          : 'border border-[#d1d1d1] bg-white text-[#242424] hover:bg-[#f5f5f5] active:bg-[#e0e0e0]',
        FOCUS,
        className,
      )}
      {...props}
    />
  );
}

export function OfficeDialog({
  title,
  children,
  onOk,
  onCancel,
  okLabel = 'OK',
  cancelLabel = 'Cancel',
  okDisabled,
  width = 400,
  footer,
}: {
  title: string;
  children: React.ReactNode;
  onOk?: () => void;
  onCancel: () => void;
  okLabel?: string;
  cancelLabel?: string;
  okDisabled?: boolean;
  width?: number;
  /** Replaces the OK / Cancel buttons. */
  footer?: React.ReactNode;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const okRef = useRef(onOk);
  useEffect(() => {
    okRef.current = onOk;
  });
  useEffect(() => {
    const el = ref.current;
    if (el && !el.contains(document.activeElement)) (el.querySelector<HTMLElement>('[autofocus],[data-autofocus],input,select,button.primary') ?? el).focus();
  }, []);
  return (
    <div className="absolute inset-0 z-50 grid place-items-center bg-black/25 p-4" onMouseDown={(e) => e.target === e.currentTarget && e.preventDefault()}>
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
            onCancel();
          } else if (e.key === 'Enter' && onOk && !okDisabled && !(e.target instanceof HTMLTextAreaElement) && !(e.target instanceof HTMLButtonElement)) {
            e.preventDefault();
            // Fields commit what's typed on blur; OK then sees it.
            (document.activeElement as HTMLElement | null)?.blur();
            requestAnimationFrame(() => okRef.current?.());
          }
        }}
        className="flex max-h-full max-w-full flex-col overflow-hidden rounded-lg border border-[#d1d1d1] bg-white text-[13px] text-[#242424] shadow-[0_16px_48px_rgba(0,0,0,0.22)] outline-none select-text"
        style={{ width }}
      >
        <div className="flex shrink-0 items-center justify-between pt-4 pr-3 pl-5">
          <h2 className="text-[15px] font-semibold">{title}</h2>
          <button type="button" aria-label="Close" onClick={onCancel} className={cn('grid size-7 place-items-center rounded-[4px] text-[#424242] hover:bg-[#f0f0f0]', FOCUS)}>
            <X className="size-4" />
          </button>
        </div>
        <div className="min-h-0 overflow-y-auto px-5 py-3">{children}</div>
        <div className="flex shrink-0 justify-end gap-2 px-5 pt-2 pb-4">
          {footer ?? (
            <>
              {onOk && (
                <OfficeButton primary className="primary" onClick={onOk} disabled={okDisabled}>
                  {okLabel}
                </OfficeButton>
              )}
              <OfficeButton onClick={onCancel}>{cancelLabel}</OfficeButton>
            </>
          )}
        </div>
      </div>
    </div>
  );
}


export function Field({ label, children, className }: { label: string; children: React.ReactElement<{ id?: string }>; className?: string }) {
  const id = useId();
  return (
    <label htmlFor={id} className={cn('flex items-center justify-between gap-3 py-1', className)}>
      <span className="text-[13px] text-[#424242]">{label}</span>
      {cloneElement(children, { id })}
    </label>
  );
}

/** A number with Office's spinner arrows and unit ("12 pt", "1.5"). */
export function Spinner({
  value,
  onChange,
  min = 0,
  max = 1000,
  step = 1,
  unit = '',
  decimals = 0,
  width = 88,
  label,
  id,
}: {
  value: number;
  onChange: (v: number) => void;
  min?: number;
  max?: number;
  step?: number;
  unit?: string;
  decimals?: number;
  width?: number;
  label?: string;
  id?: string;
}) {
  const fmt = (v: number) => `${Number(v.toFixed(decimals))}${unit === '"' ? '"' : unit ? ` ${unit}` : ''}`;
  const [text, setText] = useState<string | null>(null);
  const clamp = (v: number) => Math.max(min, Math.min(max, v));
  const commit = (raw: string) => {
    const v = parseFloat(raw);
    if (Number.isFinite(v)) onChange(clamp(v));
    setText(null);
  };
  const bump = (dir: 1 | -1) => onChange(clamp(Number((Math.round(value / step) * step + dir * step).toFixed(4))));
  return (
    <span className="relative inline-flex items-stretch" style={{ width }}>
      <input
        id={id}
        aria-label={label}
        value={text ?? fmt(value)}
        onFocus={(e) => requestAnimationFrame(() => e.target.select())}
        onChange={(e) => setText(e.target.value)}
        onBlur={(e) => commit(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') commit((e.target as HTMLInputElement).value);
          else if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
            e.stopPropagation();
            e.preventDefault();
            bump(e.key === 'ArrowUp' ? 1 : -1);
          } else if (e.key !== 'Escape') e.stopPropagation();
        }}
        className={cn(FIELD, 'w-full pr-5')}
      />
      <span className="absolute inset-y-px right-px flex w-4 flex-col">
        <button type="button" tabIndex={-1} aria-label="Up" onMouseDown={keepFocus} onClick={() => bump(1)} className="grid flex-1 place-items-center rounded-tr-[3px] text-[#616161] hover:bg-[#f0f0f0]">
          <ChevronUp className="size-2.5" />
        </button>
        <button type="button" tabIndex={-1} aria-label="Down" onMouseDown={keepFocus} onClick={() => bump(-1)} className="grid flex-1 place-items-center rounded-br-[3px] text-[#616161] hover:bg-[#f0f0f0]">
          <ChevronDown className="size-2.5" />
        </button>
      </span>
    </span>
  );
}

/** A compact spinner with a label for the ribbon (Layout > Indent, Spacing). */
export function RibbonSpinner(props: React.ComponentProps<typeof Spinner> & { caption: string; icon?: React.ReactNode }) {
  const { caption, icon, ...rest } = props;
  return (
    <span className="flex h-6 items-center gap-1.5 text-[12px] text-[#424242] [&_input]:h-6">
      {icon && <span className="[&>svg]:size-4">{icon}</span>}
      <span className="w-12 whitespace-nowrap">{caption}</span>
      <Spinner {...rest} label={caption} width={rest.width ?? 72} />
    </span>
  );
}

export function MessageBar({ children, onDismiss, tone = 'info' }: { children: React.ReactNode; onDismiss: () => void; tone?: 'info' | 'warning' }) {
  return (
    <div
      role="status"
      className={cn(
        'mx-1.5 mb-1.5 flex shrink-0 items-center gap-2 rounded-md border px-3 py-1.5 text-[12px]',
        tone === 'warning' ? 'border-[#f2d18d] bg-[#fff4ce] text-[#5c4400]' : 'border-[#c7dbf3] bg-[#ebf3fc] text-[#1d3a5f]',
      )}
    >
      <Info className="size-4 shrink-0" />
      <span className="min-w-0 flex-1">{children}</span>
      <button type="button" aria-label="Dismiss" onClick={onDismiss} className={cn('grid size-6 place-items-center rounded-[4px] hover:bg-black/5', FOCUS)}>
        <X className="size-3.5" />
      </button>
    </div>
  );
}

// ---- Backstage (the File tab) -------------------------------------------------------

export type BackstagePage = 'home' | 'new' | 'open' | 'info' | 'saveAs' | 'export';

export interface Template {
  id: string;
  name: string;
  /** A small picture of it, drawn in HTML. */
  preview: React.ReactNode;
  create: () => void;
}

export interface RecentFile {
  path: string;
  time: number;
}

export function Backstage({
  page,
  onPage,
  onClose,
  onSave,
  onCloseDocument,
  templates,
  recent,
  onOpenRecent,
  onBrowse,
  onSaveAs,
  info,
  exports,
  path,
  onPrint,
}: {
  page: BackstagePage;
  onPage: (p: BackstagePage) => void;
  onClose: () => void;
  onSave: () => void;
  onCloseDocument: () => void;
  templates: Template[];
  recent: RecentFile[];
  onOpenRecent: (path: string) => void;
  onBrowse: () => void;
  onSaveAs: () => void;
  info: React.ReactNode;
  exports: { label: string; description: string; icon: React.ReactNode; onClick: () => void }[];
  path: string | null;
  /** Print opens Din's print dialog straight away. */
  onPrint?: () => void;
}) {
  const app = useOfficeApp();
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => ref.current?.focus(), []);
  const hour = new Date().getHours();
  const greeting = hour < 12 ? 'Good morning' : hour < 18 ? 'Good afternoon' : 'Good evening';
  const nav: ({ id: BackstagePage | 'save' | 'close' | 'print'; label: string; icon: React.ReactNode } | null)[] = [
    { id: 'home', label: 'Home', icon: <HomeIcon /> },
    { id: 'new', label: 'New', icon: <File className="size-4" /> },
    { id: 'open', label: 'Open', icon: <FolderOpen className="size-4" /> },
    null,
    { id: 'info', label: 'Info', icon: <Info className="size-4" /> },
    { id: 'save', label: 'Save', icon: <Save className="size-4" /> },
    { id: 'saveAs', label: 'Save As', icon: <Save className="size-4" /> },
    ...(onPrint ? [{ id: 'print' as const, label: 'Print', icon: <Printer className="size-4" /> }] : []),
    { id: 'export', label: 'Export', icon: <FileText className="size-4" /> },
    null,
    { id: 'close', label: 'Close', icon: <X className="size-4" /> },
  ];
  return (
    <div
      ref={ref}
      tabIndex={-1}
      className="absolute inset-0 z-40 flex bg-white outline-none motion-safe:animate-in motion-safe:fade-in-0 motion-safe:slide-in-from-left-4"
      onKeyDown={(e) => {
        if (e.key === 'Escape') {
          e.stopPropagation();
          onClose();
        }
      }}
    >
      <nav className="flex w-[176px] shrink-0 flex-col bg-[var(--office-accent)] py-2 text-white" aria-label="File">
        <button type="button" onClick={onClose} aria-label="Back" title="Back" className="mx-2 mb-3 grid size-9 place-items-center rounded-full hover:bg-white/15 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white">
          <ArrowLeft className="size-5" />
        </button>
        {nav.map((item, i) =>
          item ? (
            <button
              key={item.id}
              type="button"
              onClick={() => {
                if (item.id === 'save') onSave();
                else if (item.id === 'close') onCloseDocument();
                else if (item.id === 'print') onPrint?.();
                else onPage(item.id);
              }}
              className={cn(
                'flex h-10 items-center gap-3 px-5 text-left text-[13.5px] hover:bg-white/15 focus-visible:bg-white/15 focus-visible:outline-none',
                item.id === page && 'bg-[var(--office-accent-dark)] hover:bg-[var(--office-accent-dark)]',
              )}
            >
              {item.icon}
              {item.label}
            </button>
          ) : (
            <span key={`sep${i}`} className="mx-5 my-2 h-px bg-white/25" />
          ),
        )}
      </nav>
      <div className="min-w-0 flex-1 overflow-y-auto px-10 py-8 select-text">
        {page === 'home' && (
          <>
            <h1 className="mb-6 text-[28px] font-light">{greeting}</h1>
            <TemplateRow templates={templates} />
            <RecentList recent={recent} onOpen={onOpenRecent} />
          </>
        )}
        {page === 'new' && (
          <>
            <h1 className="mb-6 text-[28px] font-light">New</h1>
            <TemplateRow templates={templates} />
          </>
        )}
        {page === 'open' && (
          <>
            <h1 className="mb-6 text-[28px] font-light">Open</h1>
            <div className="mb-6 flex gap-2">
              <BackstageTile icon={<FolderOpen className="size-8 text-[#c19c00]" />} label="Browse" onClick={onBrowse} />
            </div>
            <RecentList recent={recent} onOpen={onOpenRecent} />
          </>
        )}
        {page === 'info' && (
          <>
            <h1 className="mb-6 text-[28px] font-light">Info</h1>
            {info}
          </>
        )}
        {page === 'saveAs' && (
          <>
            <h1 className="mb-6 text-[28px] font-light">Save As</h1>
            <p className="mb-4 max-w-lg text-[13px] text-[#616161]">
              {path ? `This file is in ${path.slice(0, path.lastIndexOf('/')) || '/'}.` : 'This file hasn’t been saved yet.'} Choose a folder and a name.
            </p>
            <BackstageTile icon={<FolderOpen className="size-8 text-[#c19c00]" />} label="Browse" onClick={onSaveAs} />
          </>
        )}
        {page === 'export' && (
          <>
            <h1 className="mb-6 text-[28px] font-light">Export</h1>
            <div className="max-w-xl space-y-1">
              {exports.map((x) => (
                <button key={x.label} type="button" onClick={x.onClick} className={cn('flex w-full items-start gap-4 rounded-md p-3 text-left hover:bg-[#f0f0f0]', FOCUS)}>
                  <span className="mt-0.5 text-[var(--office-accent)] [&>svg]:size-8">{x.icon}</span>
                  <span>
                    <span className="block text-[14px] font-semibold">{x.label}</span>
                    <span className="block text-[12.5px] text-[#616161]">{x.description}</span>
                  </span>
                </button>
              ))}
            </div>
          </>
        )}
        <span className="sr-only">{ACCENTS[app].name}</span>
      </div>
    </div>
  );
}

function HomeIcon() {
  return (
    <svg viewBox="0 0 24 24" className="size-4" fill="none" stroke="currentColor" strokeWidth="2" strokeLinejoin="round">
      <path d="M3 10.5 12 3l9 7.5V20a1 1 0 0 1-1 1h-5v-6H9v6H4a1 1 0 0 1-1-1z" />
    </svg>
  );
}

function BackstageTile({ icon, label, onClick }: { icon: React.ReactNode; label: string; onClick: () => void }) {
  return (
    <button type="button" onClick={onClick} className={cn('flex w-28 flex-col items-center gap-2 rounded-md border border-[#e0e0e0] p-4 hover:border-[#c8c8c8] hover:bg-[#f5f5f5]', FOCUS)}>
      {icon}
      <span className="text-[13px]">{label}</span>
    </button>
  );
}

function TemplateRow({ templates }: { templates: Template[] }) {
  return (
    <div className="mb-8 flex flex-wrap gap-4">
      {templates.map((t) => (
        <button key={t.id} type="button" onClick={t.create} className={cn('group flex w-[150px] flex-col gap-2 rounded-md text-left', FOCUS)}>
          <span className="block overflow-hidden rounded-[3px] border border-[#d1d1d1] bg-white shadow-sm transition-shadow group-hover:border-[var(--office-accent)] group-hover:shadow-md motion-reduce:transition-none">
            {t.preview}
          </span>
          <span className="truncate text-[12.5px]">{t.name}</span>
        </button>
      ))}
    </div>
  );
}

function RecentList({ recent, onOpen }: { recent: RecentFile[]; onOpen: (path: string) => void }) {
  return (
    <section>
      <h2 className="mb-2 flex items-center gap-2 border-b border-[#e0e0e0] pb-2 text-[14px] font-semibold">
        <Clock className="size-4" /> Recent
      </h2>
      {recent.length === 0 ? (
        <p className="py-6 text-[13px] text-[#616161]">Files you open will show up here.</p>
      ) : (
        <table className="w-full text-[13px]">
          <thead>
            <tr className="text-left text-[12px] text-[#616161]">
              <th className="py-1.5 font-normal">Name</th>
              <th className="hidden py-1.5 font-normal md:table-cell">Folder</th>
              <th className="py-1.5 text-right font-normal">Opened</th>
            </tr>
          </thead>
          <tbody>
            {recent.map((r) => {
              const slash = r.path.lastIndexOf('/');
              return (
                <tr key={r.path} className="cursor-pointer hover:bg-[#f0f0f0]" onClick={() => onOpen(r.path)}>
                  <td className="rounded-l-md py-2 pl-1">
                    <button type="button" className={cn('flex items-center gap-2 text-left', FOCUS)} onClick={() => onOpen(r.path)}>
                      <FileText className="size-4 shrink-0 text-[var(--office-accent)]" />
                      {r.path.slice(slash + 1)}
                    </button>
                  </td>
                  <td className="hidden max-w-[320px] truncate py-2 text-[#616161] md:table-cell">{r.path.slice(0, slash) || '/'}</td>
                  <td className="rounded-r-md py-2 pr-2 text-right whitespace-nowrap text-[#616161]">{relativeTime(r.time)}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}
    </section>
  );
}

function relativeTime(t: number): string {
  const d = Date.now() - t;
  if (d < 60_000) return 'Just now';
  if (d < 3_600_000) return `${Math.floor(d / 60_000)}m ago`;
  if (d < 86_400_000) return `${Math.floor(d / 3_600_000)}h ago`;
  return new Date(t).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
}
