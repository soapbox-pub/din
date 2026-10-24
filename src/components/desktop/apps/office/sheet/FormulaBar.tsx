import { useState } from 'react';
import { Popover } from 'radix-ui';
import { Check, ChevronDown, ChevronUp, X } from 'lucide-react';
import { portalContainer } from '@/lib/portalContainer';
import { cn } from '@/lib/utils';
import { FOCUS } from '../accent';
import { EditText } from './EditText';

/**
 * The Name Box and the formula bar: where the selection is (or how big it
 * is while dragging), Cancel / Enter / Insert Function, and the active cell's
 * contents, editable in place.
 */
export function FormulaBar({
  name,
  names,
  onGo,
  text,
  selStart,
  selEnd,
  editing,
  editingHere,
  acIndex,
  onChange,
  onCaret,
  onCancel,
  onEnter,
  onFx,
  onPick,
  inputRef,
  expanded,
  onToggleExpanded,
}: {
  name: string;
  names: string[];
  onGo: (ref: string) => void;
  text: string;
  selStart: number;
  selEnd: number;
  editing: boolean;
  editingHere: boolean;
  acIndex: number;
  onChange: (text: string, s: number, e: number) => void;
  onCaret: (s: number, e: number) => void;
  onCancel: () => void;
  onEnter: () => void;
  onFx: () => void;
  onPick: (name: string) => void;
  inputRef: React.RefObject<HTMLTextAreaElement | null>;
  expanded: boolean;
  onToggleExpanded: () => void;
}) {
  const [box, setBox] = useState<string | null>(null);
  const [open, setOpen] = useState(false);
  const btn = 'grid h-6 w-6 place-items-center rounded-[3px] text-[#424242] hover:bg-[#f0f0f0] disabled:text-[#c8c8c8] disabled:hover:bg-transparent';
  return (
    <div className="mx-1.5 mb-1.5 flex shrink-0 items-stretch gap-1 text-[12.5px]" style={{ height: expanded ? 68 : 26 }}>
      <Popover.Root open={open} onOpenChange={setOpen}>
        <Popover.Anchor asChild>
          <div className="flex h-[26px] w-[112px] shrink-0 items-stretch rounded-[4px] border border-[#d1d1d1] bg-white focus-within:border-[var(--office-accent)]">
            <input
              aria-label="Name Box"
              title="Name Box"
              value={box ?? name}
              onFocus={(e) => {
                setBox(name);
                requestAnimationFrame(() => e.target.select());
              }}
              onBlur={() => setBox(null)}
              onChange={(e) => setBox(e.target.value)}
              onKeyDown={(e) => {
                e.stopPropagation();
                if (e.key === 'Enter' && box) {
                  e.preventDefault();
                  onGo(box);
                  setBox(null);
                } else if (e.key === 'Escape') {
                  setBox(null);
                  (e.target as HTMLInputElement).blur();
                  onGo('');
                }
              }}
              className="min-w-0 flex-1 bg-transparent px-1.5 text-[12.5px] outline-none select-text"
            />
            <Popover.Trigger asChild>
              <button type="button" tabIndex={-1} aria-label="Defined names" disabled={!names.length} className="grid w-4 place-items-center text-[#616161] hover:bg-[#f0f0f0] disabled:opacity-40" onMouseDown={(e) => e.preventDefault()}>
                <ChevronDown className="size-3" />
              </button>
            </Popover.Trigger>
          </div>
        </Popover.Anchor>
        <Popover.Portal container={portalContainer()}>
          <Popover.Content align="start" sideOffset={2} onOpenAutoFocus={(e) => e.preventDefault()} className="z-[60] min-w-[112px] rounded-md border border-[#d1d1d1] bg-white p-1 text-[12.5px] shadow-[0_8px_24px_rgba(0,0,0,0.16)]">
            {names.map((n) => (
              <button
                key={n}
                type="button"
                onClick={() => {
                  setOpen(false);
                  onGo(n);
                }}
                className="block w-full rounded-[3px] px-2 py-1 text-left hover:bg-[#f0f0f0]"
              >
                {n}
              </button>
            ))}
          </Popover.Content>
        </Popover.Portal>
      </Popover.Root>
      <div className="flex h-[26px] shrink-0 items-center gap-0.5 px-0.5" onMouseDown={(e) => e.preventDefault()}>
        <span className="mx-0.5 h-4 w-[3px] bg-[radial-gradient(circle,#9e9e9e_1px,transparent_1.2px)] bg-[length:3px_4px]" aria-hidden />
        <button type="button" aria-label="Cancel" title="Cancel" disabled={!editing} onClick={onCancel} className={cn(btn, FOCUS)}>
          <X className="size-4" />
        </button>
        <button type="button" aria-label="Enter" title="Enter" disabled={!editing} onClick={onEnter} className={cn(btn, FOCUS)}>
          <Check className="size-4" />
        </button>
        <button type="button" aria-label="Insert Function" title="Insert Function" onClick={onFx} className={cn(btn, 'w-7 font-serif text-[14px] italic', FOCUS)}>
          fx
        </button>
      </div>
      <div className="relative flex min-w-0 flex-1 items-stretch rounded-[4px] border border-[#d1d1d1] bg-white focus-within:border-[var(--office-accent)]">
        <EditText
          inputRef={inputRef}
          label="Formula Bar"
          value={text}
          selStart={selStart}
          selEnd={selEnd}
          onChange={onChange}
          onCaret={onCaret}
          className="min-w-0 flex-1 text-[13px] leading-[18px] text-[#242424] [font-family:'Inter_Variable','Segoe_UI',sans-serif]"
          pad="3px 6px"
          wrap
          active={editingHere}
          colored={editing}
          acIndex={acIndex}
          onPick={onPick}
        />
        <button
          type="button"
          aria-label={expanded ? 'Collapse Formula Bar' : 'Expand Formula Bar'}
          title={expanded ? 'Collapse Formula Bar (Ctrl+Shift+U)' : 'Expand Formula Bar (Ctrl+Shift+U)'}
          onMouseDown={(e) => e.preventDefault()}
          onClick={onToggleExpanded}
          className={cn('grid w-5 shrink-0 place-items-start pt-1 text-[#616161] hover:bg-[#f0f0f0]', FOCUS)}
        >
          {expanded ? <ChevronUp className="size-3.5" /> : <ChevronDown className="size-3.5" />}
        </button>
      </div>
    </div>
  );
}
