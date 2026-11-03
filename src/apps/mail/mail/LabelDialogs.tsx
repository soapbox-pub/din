import { useState } from 'react';
import { Check, Loader2 } from 'lucide-react';
import { DialogButton, Overlay } from '@/shared/dialogs';
import { Input } from '@/components/ui/input';
import { cn } from '@/lib/utils';
import { LABEL_COLORS, type LabelColor, type LabelKind, type MailLabel } from '@/lib/mail';
import { COLOR_NAMES, LABEL_STYLES, labelColor } from './labels';

/** A row of swatches to pick a label's color from. */
export function ColorPicker({ value, onChange }: { value: LabelColor; onChange: (c: LabelColor) => void }) {
  return (
    <div role="radiogroup" aria-label="Color" className="flex flex-wrap gap-2">
      {LABEL_COLORS.map((c) => (
        <button
          key={c}
          type="button"
          role="radio"
          aria-checked={value === c}
          aria-label={COLOR_NAMES[c]}
          title={COLOR_NAMES[c]}
          onClick={() => onChange(c)}
          className={cn(
            'grid size-7 place-items-center rounded-full text-white outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-popover',
            LABEL_STYLES[c].dot,
            value === c && 'ring-2 ring-foreground/70 ring-offset-2 ring-offset-popover',
          )}
        >
          {value === c && <Check className="size-4" strokeWidth={3} />}
        </button>
      ))}
    </div>
  );
}

/** A new label's name and color, or a label's new ones. */
export function LabelEditor({
  label,
  kind,
  onSave,
  onClose,
}: {
  /** The label to change; a new one without. */
  label?: MailLabel;
  kind: LabelKind;
  /** Rejects with what went wrong, shown in the dialog. */
  onSave: (name: string, color: LabelColor) => Promise<void>;
  onClose: () => void;
}) {
  const [name, setName] = useState(label?.name ?? '');
  const [color, setColor] = useState<LabelColor>(() => (label ? labelColor(label) : LABEL_COLORS[1 + Math.floor(Math.random() * (LABEL_COLORS.length - 1))]));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const title = label ? 'Edit Label' : 'New Label';
  const unchanged = !!label && name.trim() === label.name && color === labelColor(label);

  const save = async () => {
    if (!name.trim() || busy) return;
    if (unchanged) return onClose();
    setBusy(true);
    setError(null);
    try {
      await onSave(name.trim(), color);
      onClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setBusy(false);
    }
  };

  return (
    <Overlay label={title} onClose={onClose}>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          void save();
        }}
      >
        <div className="space-y-4 px-5 pt-5 pb-4">
          <h2 className="text-[15px] font-semibold">{title}</h2>
          <label className="block space-y-1.5">
            <span className="text-[13px] font-medium">Name</span>
            <Input autoFocus value={name} maxLength={100} onChange={(e) => setName(e.target.value)} aria-invalid={!!error || undefined} />
          </label>
          {kind === 'gmail' && <p className="text-xs text-muted-foreground">Gmail shows it on its web page and app too. Put a / in the name to make it a label inside another one.</p>}
          <div className="space-y-1.5">
            <span className="text-[13px] font-medium">Color</span>
            <ColorPicker value={color} onChange={setColor} />
            <p className="text-xs text-muted-foreground">Colors are kept on this computer.</p>
          </div>
          {error && <p role="alert" className="text-[13px] text-destructive">{error}</p>}
        </div>
        <div className="flex justify-end gap-2 border-t border-border/60 px-5 py-3">
          <DialogButton onClick={onClose}>Cancel</DialogButton>
          <DialogButton type="submit" variant="primary" disabled={!name.trim() || busy} className="flex items-center gap-1.5">
            {busy && <Loader2 className="size-3.5 animate-spin motion-reduce:animate-none" />}
            {label ? 'Save' : 'Create'}
          </DialogButton>
        </div>
      </form>
    </Overlay>
  );
}

/** Asks before a label comes off every message. */
export function DeleteLabelDialog({ label, kind, onDelete, onClose }: { label: MailLabel; kind: LabelKind; onDelete: () => void; onClose: () => void }) {
  return (
    <Overlay label="Delete Label" onClose={onClose}>
      <div className="space-y-2 px-5 pt-5 pb-4">
        <h2 className="text-[15px] font-semibold">Delete the label “{label.name}”?</h2>
        <p className="text-[13px] text-muted-foreground">
          {kind === 'gmail'
            ? 'Gmail takes it off every message that has it, on all your devices. The messages themselves stay, in All Mail and wherever else they are.'
            : 'It comes off every message that has it, in every mailbox on the server. The messages themselves stay where they are.'}
        </p>
      </div>
      <div className="flex justify-end gap-2 border-t border-border/60 px-5 py-3">
        <DialogButton onClick={onClose}>Cancel</DialogButton>
        <DialogButton
          variant="destructive"
          autoFocus
          onClick={() => {
            onDelete();
            onClose();
          }}
        >
          Delete Label
        </DialogButton>
      </div>
    </Overlay>
  );
}
