import { useEffect, useRef, useState } from 'react';
import { DropdownMenu as Menu } from 'radix-ui';
import { ChevronLeft, ChevronRight, Plus } from 'lucide-react';
import { cn } from '@/lib/utils';
import { FOCUS } from '@/shared/office/accent';
import { ColorPalette, MenuContent, MenuItem, MenuSeparator, SubMenu, type PickedColor } from '@/shared/office/chrome';
import type { Theme } from '@/shared/office/theme';
import type { Sheet } from './model';

/**
 * Excel's sheet tabs: the active one white with a green underline, the
 * rest flat; double-click to rename, drag to reorder, right-click for
 * Insert, Delete, Rename, Move or Copy, Tab Color, Hide and Unhide.
 */
export function SheetTabs({
  sheets,
  active,
  theme,
  onSelect,
  onAdd,
  onRename,
  onDelete,
  onMove,
  onMoveDialog,
  onTabColor,
  onHide,
  onUnhide,
  renaming,
  setRenaming,
  validate,
}: {
  sheets: Sheet[];
  active: number;
  theme: Theme;
  onSelect: (i: number) => void;
  onAdd: () => void;
  onRename: (i: number, name: string) => void;
  onDelete: (i: number) => void;
  onMove: (from: number, to: number) => void;
  onMoveDialog: () => void;
  onTabColor: (c: PickedColor | null) => void;
  onHide: () => void;
  onUnhide: () => void;
  renaming: number | null;
  setRenaming: (i: number | null) => void;
  validate: (name: string, i: number) => string | null;
}) {
  const strip = useRef<HTMLDivElement>(null);
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null);
  const [drag, setDrag] = useState<{ from: number; to: number } | null>(null);
  const [draft, setDraft] = useState('');
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    strip.current?.querySelector('[data-active]')?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  }, [active]);

  const visible = sheets.map((s, i) => ({ s, i })).filter(({ s }) => !s.hidden);
  const hiddenCount = sheets.length - visible.length;

  const finishRename = (commit: boolean) => {
    if (renaming === null) return;
    if (commit && draft.trim() !== sheets[renaming].name) {
      const err = validate(draft, renaming);
      if (err) {
        setError(err);
        return;
      }
      onRename(renaming, draft.trim());
    }
    setError(null);
    setRenaming(null);
  };

  return (
    <div className="flex min-w-0 flex-1 items-stretch" onMouseDown={(e) => e.target instanceof HTMLInputElement || e.preventDefault()}>
      <div className="flex shrink-0 items-center px-0.5">
        <button type="button" aria-label="Scroll tabs left" title="Previous sheet" onClick={() => strip.current?.scrollBy({ left: -120 })} className={cn('grid size-6 place-items-center rounded-[3px] text-[#616161] hover:bg-black/5', FOCUS)}>
          <ChevronLeft className="size-3.5" />
        </button>
        <button type="button" aria-label="Scroll tabs right" title="Next sheet" onClick={() => strip.current?.scrollBy({ left: 120 })} className={cn('grid size-6 place-items-center rounded-[3px] text-[#616161] hover:bg-black/5', FOCUS)}>
          <ChevronRight className="size-3.5" />
        </button>
      </div>
      <div ref={strip} role="tablist" aria-label="Sheets" className="flex min-w-0 items-stretch overflow-hidden">
        {visible.map(({ s, i }) => {
          const isActive = i === active;
          return (
            <div key={s.id} className="relative flex shrink-0 items-stretch">
              {drag && drag.to === i && drag.from !== i && <span className="absolute top-1 bottom-1 -left-px z-10 w-[2px] bg-[#242424]" />}
              <button
                type="button"
                role="tab"
                aria-selected={isActive}
                data-active={isActive ? '' : undefined}
                onMouseDown={(e) => {
                  if (e.button !== 0 || renaming === i) return;
                  onSelect(i);
                  const startX = e.clientX;
                  let moved = false;
                  let target = i;
                  const mm = (ev: MouseEvent) => {
                    if (!moved && Math.abs(ev.clientX - startX) < 6) return;
                    moved = true;
                    const els = [...(strip.current?.querySelectorAll<HTMLElement>('[role=tab]') ?? [])];
                    let to = visible.length;
                    for (let k = 0; k < els.length; k++) {
                      const r = els[k].getBoundingClientRect();
                      if (ev.clientX < r.left + r.width / 2) {
                        to = k;
                        break;
                      }
                    }
                    target = visible[to]?.i ?? sheets.length;
                    setDrag({ from: i, to: target });
                  };
                  const mu = () => {
                    window.removeEventListener('mousemove', mm);
                    window.removeEventListener('mouseup', mu);
                    setDrag(null);
                    if (moved && target !== i && target !== i + 1) onMove(i, target > i ? target - 1 : target);
                  };
                  window.addEventListener('mousemove', mm);
                  window.addEventListener('mouseup', mu);
                }}
                onDoubleClick={() => {
                  setDraft(s.name);
                  setError(null);
                  setRenaming(i);
                }}
                onContextMenu={(e) => {
                  e.preventDefault();
                  onSelect(i);
                  setMenu({ x: e.clientX, y: e.clientY });
                }}
                className={cn(
                  'relative flex h-full min-w-[64px] items-center justify-center px-3 text-[12.5px] whitespace-nowrap',
                  isActive ? 'bg-white font-semibold text-[#107c41] shadow-[0_0_0_1px_#d6d6d6]' : 'text-[#424242] hover:bg-[#e8e8e8]',
                  FOCUS,
                )}
                style={!isActive && s.tabColor ? { background: `linear-gradient(to top, #${s.tabColor} 0 4px, transparent 4px)` } : undefined}
              >
                {renaming === i ? (
                  <input
                    autoFocus
                    value={draft}
                    aria-label="Sheet name"
                    onChange={(e) => {
                      setDraft(e.target.value);
                      setError(null);
                    }}
                    onFocus={(e) => e.target.select()}
                    onBlur={() => finishRename(true)}
                    onKeyDown={(e) => {
                      e.stopPropagation();
                      if (e.key === 'Enter') finishRename(true);
                      else if (e.key === 'Escape') finishRename(false);
                    }}
                    onMouseDown={(e) => e.stopPropagation()}
                    className="w-[max(64px,calc(var(--len)*1ch))] bg-white text-center font-semibold text-[#242424] outline outline-1 outline-[#107c41] select-text"
                    style={{ '--len': draft.length + 2 } as React.CSSProperties}
                  />
                ) : (
                  s.name
                )}
                {isActive && <span className="absolute inset-x-2 bottom-0 h-[3px] rounded-full" style={{ background: s.tabColor ? `#${s.tabColor}` : '#107c41' }} />}
              </button>
              {!isActive && i + 1 !== active && <span className="my-2 w-px bg-[#d0d0d0]" />}
            </div>
          );
        })}
        {drag && drag.to >= sheets.length && <span className="my-1 w-[2px] bg-[#242424]" />}
      </div>
      <button type="button" aria-label="New sheet" title="New sheet (Shift+F11)" onClick={onAdd} className={cn('mx-1 grid size-7 shrink-0 place-items-center self-center rounded-full text-[#424242] hover:bg-black/5', FOCUS)}>
        <Plus className="size-4" />
      </button>
      {error && (
        <div role="alert" className="absolute bottom-9 left-24 z-30 max-w-80 rounded-md border border-[#f2c1c1] bg-[#fdf3f4] px-3 py-2 text-[12px] text-[#a4262c] shadow-md">
          {error}
        </div>
      )}
      <Menu.Root open={!!menu} onOpenChange={(o) => !o && setMenu(null)} modal={false}>
        <Menu.Trigger asChild>
          <span className="fixed size-0" style={{ left: menu?.x ?? 0, top: menu?.y ?? 0 }} />
        </Menu.Trigger>
        <MenuContent side="top">
          <MenuItem onSelect={onAdd}>Insert</MenuItem>
          <MenuItem onSelect={() => onDelete(active)} disabled={visible.length < 2}>
            Delete
          </MenuItem>
          <MenuItem
            onSelect={() => {
              setDraft(sheets[active].name);
              setRenaming(active);
            }}
          >
            Rename
          </MenuItem>
          <MenuItem onSelect={onMoveDialog}>Move or Copy…</MenuItem>
          <SubMenu label="Tab Color">
            <ColorPalette theme={theme} onPick={onTabColor} none="No Color" onMore={() => undefined} />
          </SubMenu>
          <MenuSeparator />
          <MenuItem onSelect={onHide} disabled={visible.length < 2}>
            Hide
          </MenuItem>
          <MenuItem onSelect={onUnhide} disabled={!hiddenCount}>
            Unhide…
          </MenuItem>
        </MenuContent>
      </Menu.Root>
    </div>
  );
}
