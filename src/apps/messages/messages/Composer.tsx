import { useRef, useState } from 'react';
import { ArrowUp, Loader2 } from 'lucide-react';
import { cn } from '@/lib/utils';
import { ToastViewport } from '@/shared/Toaster';

/**
 * Where a text is written: Enter sends, Shift+Enter starts a new line. Kept
 * per conversation while the window is open, so switching away and back
 * doesn't lose a half-written text. The window's toasts sit just above it.
 */
export function Composer({
  draftKey,
  disabled,
  placeholder,
  onSend,
  autoFocus,
  prefill,
}: {
  draftKey: string;
  disabled: string | null;
  placeholder: string;
  onSend: (text: string) => Promise<void>;
  autoFocus?: boolean;
  /** Text to start the draft with (something shared here), put in again each time its `key` changes. */
  prefill?: { key: string; text: string } | null;
}) {
  const [drafts, setDrafts] = useState<Record<string, string>>(() => (prefill ? { [draftKey]: prefill.text } : {}));
  const [filled, setFilled] = useState(prefill?.key ?? null);
  if (prefill && prefill.key !== filled) {
    setFilled(prefill.key);
    setDrafts((d) => ({ ...d, [draftKey]: prefill.text }));
  }
  const [sending, setSending] = useState(false);
  const ref = useRef<HTMLTextAreaElement>(null);
  const text = drafts[draftKey] ?? '';
  const setText = (value: string) => setDrafts((d) => ({ ...d, [draftKey]: value }));

  const send = () => {
    const body = text.trim();
    if (!body || sending || disabled) return;
    setSending(true);
    onSend(body).then(
      () => {
        setText('');
        setSending(false);
        ref.current?.focus();
      },
      () => setSending(false),
    );
  };

  return (
    <div className="relative shrink-0 border-t border-border/60 px-4 pt-2.5 pb-3">
      <ToastViewport className="absolute inset-x-0 bottom-full mb-2 px-4" />
      {disabled && <p className="pb-2 text-xs text-muted-foreground">{disabled}</p>}
      <form
        className="flex items-end gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          send();
        }}
      >
        <textarea
          key={draftKey}
          ref={ref}
          rows={1}
          autoFocus={autoFocus}
          value={text}
          disabled={!!disabled}
          placeholder={placeholder}
          aria-label={placeholder}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
              e.preventDefault();
              send();
            }
          }}
          className={cn(
            'max-h-40 min-h-10 flex-1 resize-none rounded-[20px] bg-foreground/[0.06] px-4 py-2 text-[15px] leading-6 text-foreground',
            'placeholder:text-muted-foreground focus-visible:border-ring focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/40',
            'disabled:opacity-60 [field-sizing:content]',
          )}
        />
        <button
          type="submit"
          aria-label="Send"
          disabled={!text.trim() || sending || !!disabled}
          className="mb-0.5 grid size-9 shrink-0 place-items-center rounded-full bg-pigment text-primary-foreground clay-pigment transition-[opacity,transform] hover:scale-105 active:scale-95 disabled:pointer-events-none disabled:opacity-30 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring motion-reduce:transition-none"
        >
          {sending ? <Loader2 className="size-4 animate-spin" aria-hidden /> : <ArrowUp className="size-5" strokeWidth={2.5} aria-hidden />}
        </button>
      </form>
    </div>
  );
}
