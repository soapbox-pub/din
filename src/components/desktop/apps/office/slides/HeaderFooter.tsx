import { useState } from 'react';
import { FIELD } from '../accent';
import { OfficeButton, OfficeDialog } from '../chrome';

export interface HeaderFooterChoice {
  date: boolean;
  /** Fixed text, or null for a date that updates. */
  fixedDate: string | null;
  number: boolean;
  footer: boolean;
  footerText: string;
  skipTitle: boolean;
}

/** Insert > Header & Footer: what goes in the slides' footer placeholders. */
export function HeaderFooterDialog({ initial, onApply, onCancel }: { initial: HeaderFooterChoice; onApply: (c: HeaderFooterChoice, all: boolean) => void; onCancel: () => void }) {
  const [c, setC] = useState(initial);
  const [update, setUpdate] = useState(initial.fixedDate === null);
  const set = (p: Partial<HeaderFooterChoice>) => setC((x) => ({ ...x, ...p }));
  const result = (): HeaderFooterChoice => ({ ...c, fixedDate: update ? null : (c.fixedDate ?? new Date().toLocaleDateString('en-US')) });
  return (
    <OfficeDialog
      title="Header and Footer"
      onCancel={onCancel}
      width={440}
      footer={
        <>
          <OfficeButton onClick={() => onApply(result(), false)}>Apply</OfficeButton>
          <OfficeButton primary onClick={() => onApply(result(), true)}>Apply to All</OfficeButton>
          <OfficeButton onClick={onCancel}>Cancel</OfficeButton>
        </>
      }
    >
      <div className="space-y-2 text-[13px]">
        <p className="text-[12px] font-semibold text-[#424242]">Include on slide</p>
        <label className="flex items-center gap-2">
          <input type="checkbox" checked={c.date} onChange={(e) => set({ date: e.target.checked })} className="accent-[#c43e1c]" /> Date and time
        </label>
        <div className={c.date ? 'space-y-1.5 pl-6' : 'pointer-events-none space-y-1.5 pl-6 opacity-50'}>
          <label className="flex items-center gap-2">
            <input type="radio" name="hf-date" checked={update} onChange={() => setUpdate(true)} className="accent-[#c43e1c]" /> Update automatically
          </label>
          <label className="flex items-center gap-2">
            <input type="radio" name="hf-date" checked={!update} onChange={() => setUpdate(false)} className="accent-[#c43e1c]" /> Fixed
            <input value={c.fixedDate ?? new Date().toLocaleDateString('en-US')} onChange={(e) => set({ fixedDate: e.target.value })} onFocus={() => setUpdate(false)} className={`${FIELD} w-48`} aria-label="Fixed date" />
          </label>
        </div>
        <label className="flex items-center gap-2">
          <input type="checkbox" checked={c.number} onChange={(e) => set({ number: e.target.checked })} className="accent-[#c43e1c]" /> Slide number
        </label>
        <label className="flex items-center gap-2">
          <input type="checkbox" checked={c.footer} onChange={(e) => set({ footer: e.target.checked })} className="accent-[#c43e1c]" /> Footer
        </label>
        <div className={c.footer ? 'pl-6' : 'pointer-events-none pl-6 opacity-50'}>
          <input value={c.footerText} onChange={(e) => set({ footerText: e.target.value })} className={`${FIELD} w-full`} aria-label="Footer text" />
        </div>
        <label className="flex items-center gap-2 pt-2">
          <input type="checkbox" checked={c.skipTitle} onChange={(e) => set({ skipTitle: e.target.checked })} className="accent-[#c43e1c]" /> Don’t show on title slide
        </label>
      </div>
    </OfficeDialog>
  );
}
