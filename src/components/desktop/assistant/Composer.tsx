import { useRef, useState, type ReactNode } from 'react';
import { ArrowUp, FileText, ImageIcon, Mic, Paperclip, Square, X } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { useFilePicker } from '@/contexts/FilePickerContext';
import { useIsDictatingInto } from '@/hooks/useDictation';
import type { PromptAttachment } from '@/lib/assistant';
import { elementTarget, finishDictation, hasDictationBridge, startDictation } from '@/lib/dictation';
import { cn } from '@/lib/utils';

/** Pasted pictures past this size are left out; the request would be too big. */
const MAX_PASTE_BYTES = 8 * 1024 * 1024;

/** A file:// URL for a path, each segment escaped. */
function fileUri(path: string): string {
  return `file://${path.split('/').map(encodeURIComponent).join('/')}`;
}

function readAsDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(file);
  });
}

/**
 * Where the user writes to the agent. Enter sends and Shift+Enter starts a
 * new line. Files come from Din's file picker or are pasted in (pictures),
 * and go along with the message. While the agent works, a message sent
 * steers it, and Stop interrupts it. The mic button dictates into it, the
 * same as Super+H does anywhere.
 */
export function Composer({
  onSubmit,
  onStop,
  running = false,
  busy = false,
  disabled = false,
  placeholder = 'Ask anything…',
  autoFocus = false,
  toolbar,
  className,
  textareaRef,
}: {
  /** Resolves once sent; the text stays put if it rejects. */
  onSubmit: (text: string, files: PromptAttachment[]) => Promise<unknown> | void;
  onStop?: () => void;
  running?: boolean;
  /** Sending right now. */
  busy?: boolean;
  disabled?: boolean;
  placeholder?: string;
  autoFocus?: boolean;
  /** Controls beside the send button: the model and agent pickers. */
  toolbar?: ReactNode;
  className?: string;
  textareaRef?: React.RefObject<HTMLTextAreaElement | null>;
}) {
  const [text, setText] = useState('');
  const [files, setFiles] = useState<PromptAttachment[]>([]);
  const ownRef = useRef<HTMLTextAreaElement>(null);
  const ref = textareaRef ?? ownRef;
  const { pickFiles } = useFilePicker();
  const dictating = useIsDictatingInto(ref);

  const canSend = !disabled && !busy && text.trim().length > 0;

  const submit = async () => {
    if (!canSend) return;
    const sent = { text: text.trim(), files };
    setText('');
    setFiles([]);
    try {
      await onSubmit(sent.text, sent.files);
    } catch {
      // Give it back to try again.
      setText(sent.text);
      setFiles(sent.files);
    }
  };

  const attach = async () => {
    const result = await pickFiles({ title: 'Attach files', confirmLabel: 'Attach', multiple: true }).catch(() => null);
    if (!result) return;
    setFiles((current) => [
      ...current,
      ...result.paths
        .filter((path) => !current.some((f) => f.uri === fileUri(path)))
        .map((path) => ({ uri: fileUri(path), name: path.split('/').pop() || path })),
    ]);
    ref.current?.focus();
  };

  const dictate = () => {
    const textarea = ref.current;
    if (!textarea) return;
    if (dictating) {
      void finishDictation();
      return;
    }
    textarea.focus();
    void startDictation(elementTarget(textarea));
  };

  const onPaste = async (event: React.ClipboardEvent<HTMLTextAreaElement>) => {
    const images = [...event.clipboardData.files].filter((f) => f.type.startsWith('image/') && f.size <= MAX_PASTE_BYTES);
    if (images.length === 0) return;
    event.preventDefault();
    const added = await Promise.all(
      images.map(async (file, index) => ({
        uri: await readAsDataUrl(file),
        name: file.name && file.name !== 'image.png' ? file.name : `Pasted picture ${files.length + index + 1}.png`,
      })),
    );
    setFiles((current) => [...current, ...added]);
  };

  return (
    <div
      className={cn(
        'flex flex-col gap-2 rounded-2xl border border-border bg-card p-2 shadow-sm transition-shadow focus-within:border-ring/60 focus-within:shadow-md',
        className,
      )}
    >
      {files.length > 0 && (
        <ul className="flex flex-wrap gap-1.5 px-1 pt-1" aria-label="Attachments">
          {files.map((file) => {
            const Icon = file.uri.startsWith('data:image/') ? ImageIcon : FileText;
            return (
              <li
                key={file.uri}
                className="flex max-w-56 items-center gap-1.5 rounded-lg border border-border bg-muted/50 py-1 pl-2 pr-1 text-xs"
              >
                <Icon className="size-3.5 shrink-0 text-muted-foreground" aria-hidden />
                <span className="truncate" title={file.name}>
                  {file.name}
                </span>
                <button
                  type="button"
                  onClick={() => setFiles((current) => current.filter((f) => f.uri !== file.uri))}
                  aria-label={`Remove ${file.name}`}
                  className="grid size-5 shrink-0 place-items-center rounded text-muted-foreground hover:bg-foreground/10 hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                >
                  <X className="size-3" aria-hidden />
                </button>
              </li>
            );
          })}
        </ul>
      )}
      <textarea
        ref={ref}
        value={text}
        onChange={(event) => setText(event.target.value)}
        onPaste={(event) => void onPaste(event)}
        onKeyDown={(event) => {
          if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) {
            event.preventDefault();
            void submit();
          }
        }}
        placeholder={placeholder}
        disabled={disabled}
        autoFocus={autoFocus}
        rows={1}
        aria-label="Message"
        className="field-sizing-content max-h-60 min-h-11 w-full resize-none bg-transparent px-2 py-1.5 text-base leading-relaxed outline-none placeholder:text-muted-foreground disabled:cursor-not-allowed disabled:opacity-50"
      />
      <div className="flex items-center gap-1">
        <Button
          type="button"
          variant="ghost"
          size="icon"
          onClick={() => void attach()}
          disabled={disabled}
          aria-label="Attach files"
          title="Attach files"
          className="size-8 text-muted-foreground hover:text-foreground"
        >
          <Paperclip className="size-4" aria-hidden />
        </Button>
        <div className="flex min-w-0 flex-1 items-center gap-1">{toolbar}</div>
        {hasDictationBridge() && (
          <Button
            type="button"
            variant="ghost"
            size="icon"
            // Keeps focus in the message, where the text goes.
            onMouseDown={(event) => event.preventDefault()}
            onClick={dictate}
            disabled={disabled}
            aria-label={dictating ? 'Stop dictating' : 'Dictate'}
            aria-pressed={dictating}
            title={dictating ? 'Stop dictating' : 'Dictate (Super+H)'}
            className={cn(
              'size-8 rounded-full text-muted-foreground hover:text-foreground',
              dictating && 'bg-primary/15 text-primary hover:bg-primary/20 hover:text-primary',
            )}
          >
            <Mic className={cn('size-4', dictating && 'motion-safe:animate-pulse')} aria-hidden />
          </Button>
        )}
        {running && onStop && (
          <Button
            type="button"
            variant="secondary"
            size="icon"
            onClick={onStop}
            aria-label="Stop"
            title="Stop"
            className="size-8 rounded-full"
          >
            <Square className="size-3.5 fill-current" aria-hidden />
          </Button>
        )}
        <Button
          type="button"
          size="icon"
          onClick={() => void submit()}
          disabled={!canSend}
          aria-label={running ? 'Send (steers the agent)' : 'Send'}
          title={running ? 'Send — the agent reads it as it works' : 'Send'}
          className="size-8 rounded-full"
        >
          <ArrowUp className="size-4" aria-hidden />
        </Button>
      </div>
    </div>
  );
}
