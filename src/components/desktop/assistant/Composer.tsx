import { useEffect, useId, useMemo, useRef, useState, type ReactNode } from 'react';
import { ArrowUp, FileText, ImageIcon, Mic, Paperclip, Square, X } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { useFilePicker } from '@/contexts/FilePickerContext';
import { useIsDictatingInto } from '@/hooks/useDictation';
import { parseSlashCommand, type PromptAttachment } from '@/lib/assistant';
import { draftStorageKey } from '@/lib/assistantTabs';
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

export interface SlashCommand {
  name: string;
  description?: string;
  /** What goes after it, shown in the menu (`title`). */
  args?: string;
  /** Takes nothing after it, so picking it in the menu runs it. */
  instant?: boolean;
}

/**
 * The composer's text, kept in localStorage under `key` (when given) so it
 * outlasts the window, Din and a restart. An empty message leaves no entry.
 */
function useDraft(key: string | undefined) {
  const storageKey = key && draftStorageKey(key);
  const [text, setText] = useState(() => (storageKey && localStorage.getItem(storageKey)) || '');
  const save = (value: string) => {
    setText(value);
    if (!storageKey) return;
    try {
      if (value) localStorage.setItem(storageKey, value);
      else localStorage.removeItem(storageKey);
    } catch {
      // Full or unavailable: it still works, just without keeping the draft.
    }
  };
  return [text, save] as const;
}

/** The commands a partly typed `/name` could be, those it starts first. */
function matchCommands(commands: SlashCommand[], typed: string): SlashCommand[] {
  const query = typed.toLowerCase();
  const starts = commands.filter((c) => c.name.toLowerCase().startsWith(query));
  const contains = commands.filter((c) => !starts.includes(c) && c.name.toLowerCase().includes(query));
  return [...starts, ...contains];
}

/**
 * Where the user writes to the agent. Enter sends and Shift+Enter starts a
 * new line. Files come from Din's file picker or are pasted in (pictures),
 * and go along with the message. While the agent works, a message sent
 * steers it, and Stop interrupts it. The mic button dictates into it, the
 * same as Super+H does anywhere. Shift+Tab switches agents, given
 * `onCycleAgent`.
 *
 * A message starting with one of `commands` (`/compact`) goes to
 * `onCommand` instead. Typing `/` lists them, narrowing as the name goes
 * on: the arrows move through it, Tab or Enter fills one in (Enter runs an
 * instant one), Escape puts it away.
 *
 * With `draftKey`, unsent text is kept until it's sent.
 */
export function Composer({
  onSubmit,
  commands = [],
  onCommand,
  onStop,
  running = false,
  busy = false,
  disabled = false,
  placeholder = 'Ask anything…',
  autoFocus = false,
  toolbar,
  onCycleAgent,
  className,
  textareaRef,
  draftKey,
}: {
  /** Resolves once sent; the text stays put if it rejects. */
  onSubmit: (text: string, files: PromptAttachment[]) => Promise<unknown> | void;
  commands?: SlashCommand[];
  /** Like `onSubmit`, for a command: its name and what followed it. */
  onCommand?: (name: string, args: string, files: PromptAttachment[]) => Promise<unknown> | void;
  onStop?: () => void;
  running?: boolean;
  /** Sending right now. */
  busy?: boolean;
  disabled?: boolean;
  placeholder?: string;
  autoFocus?: boolean;
  /** Controls beside the send button: the model and agent pickers. */
  toolbar?: ReactNode;
  /** Shift+Tab: on to the next agent. Without it, Shift+Tab moves focus as usual. */
  onCycleAgent?: () => void;
  className?: string;
  textareaRef?: React.RefObject<HTMLTextAreaElement | null>;
  /** Keeps unsent text across restarts, one draft per key. */
  draftKey?: string;
}) {
  const [text, setText] = useDraft(draftKey);
  const [files, setFiles] = useState<PromptAttachment[]>([]);
  const ownRef = useRef<HTMLTextAreaElement>(null);
  const ref = textareaRef ?? ownRef;
  const { pickFiles } = useFilePicker();
  const dictating = useIsDictatingInto(ref);

  const menuID = useId();
  // The text Escape put the menu away for; typing on brings it back.
  const [dismissed, setDismissed] = useState<string | null>(null);
  const [highlight, setHighlight] = useState({ typed: '', index: 0 });
  const typed = /^\/(\S*)$/.exec(text)?.[1];
  const matches = useMemo(
    () => (typed === undefined || !onCommand ? [] : matchCommands(commands, typed)),
    [commands, onCommand, typed],
  );
  const menuOpen = matches.length > 0 && dismissed !== text && !disabled;
  const active = menuOpen ? Math.min(highlight.typed === typed ? highlight.index : 0, matches.length - 1) : -1;
  const optionID = (index: number) => `${menuID}-${index}`;

  // Not the autoFocus attribute: that leaves the caret before a restored draft.
  useEffect(() => {
    const textarea = ref.current;
    if (!autoFocus || !textarea) return;
    textarea.focus();
    textarea.setSelectionRange(textarea.value.length, textarea.value.length);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- only when it first shows
  }, []);

  useEffect(() => {
    if (active >= 0) document.getElementById(`${menuID}-${active}`)?.scrollIntoView({ block: 'nearest' });
  }, [active, menuID]);

  const canSend = !disabled && !busy && text.trim().length > 0;

  const send = async (message: string) => {
    if (disabled || busy || !message) return;
    const sent = { text: message, files };
    const command = parseSlashCommand(message);
    const known = command && onCommand && commands.some((c) => c.name === command.name) ? command : null;
    setText('');
    setFiles([]);
    try {
      if (known) await onCommand!(known.name, known.args, sent.files);
      else await onSubmit(sent.text, sent.files);
    } catch {
      // Give it back to try again.
      setText(sent.text);
      setFiles(sent.files);
    }
  };

  const submit = () => send(text.trim());

  const pick = (command: SlashCommand, run: boolean) => {
    if (run && command.instant) {
      void send(`/${command.name}`);
    } else {
      setText(`/${command.name} `);
      ref.current?.focus();
    }
  };

  /** The menu's keys; true when one was used. */
  const menuKey = (event: React.KeyboardEvent<HTMLTextAreaElement>): boolean => {
    if (!menuOpen) return false;
    const move = (by: number) => setHighlight({ typed: typed ?? '', index: (active + by + matches.length) % matches.length });
    switch (event.key) {
      case 'ArrowDown':
        move(1);
        return true;
      case 'ArrowUp':
        move(-1);
        return true;
      case 'Tab':
        if (event.shiftKey) return false;
        pick(matches[active], false);
        return true;
      case 'Enter':
        if (event.shiftKey || event.nativeEvent.isComposing) return false;
        // Typed out in full already: Enter sends it as it is.
        if (text === `/${matches[active].name}` && !matches[active].instant) return false;
        pick(matches[active], true);
        return true;
      case 'Escape':
        event.stopPropagation();
        setDismissed(text);
        return true;
      default:
        return false;
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
        'relative flex flex-col gap-2 rounded-2xl border border-border bg-card p-2 shadow-sm transition-shadow focus-within:border-ring/60 focus-within:shadow-md',
        className,
      )}
    >
      {menuOpen && (
        <ul
          id={menuID}
          role="listbox"
          aria-label="Commands"
          className="absolute inset-x-0 bottom-full z-30 mb-2 max-h-64 overflow-y-auto rounded-xl border border-border bg-popover p-1 text-popover-foreground shadow-lg"
        >
          {matches.map((command, index) => (
            <li
              key={command.name}
              id={optionID(index)}
              role="option"
              aria-selected={index === active}
              // Keeps focus in the message.
              onMouseDown={(event) => event.preventDefault()}
              onMouseMove={() => index !== active && setHighlight({ typed: typed ?? '', index })}
              onClick={() => pick(command, true)}
              className={cn(
                'flex cursor-pointer items-baseline gap-3 rounded-lg px-3 py-2 text-sm',
                index === active && 'bg-accent text-accent-foreground',
              )}
            >
              <span className="shrink-0 font-mono font-medium">
                /{command.name}
                {command.args && <span className="font-normal text-muted-foreground"> {command.args}</span>}
              </span>
              {command.description && <span className="truncate text-muted-foreground">{command.description}</span>}
            </li>
          ))}
        </ul>
      )}
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
          if (menuKey(event)) {
            event.preventDefault();
            return;
          }
          if (onCycleAgent && event.key === 'Tab' && event.shiftKey && !event.ctrlKey && !event.altKey && !event.metaKey) {
            event.preventDefault();
            onCycleAgent();
            return;
          }
          if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) {
            event.preventDefault();
            void submit();
          }
        }}
        placeholder={placeholder}
        disabled={disabled}
        rows={1}
        aria-label="Message"
        role={onCommand ? 'combobox' : undefined}
        aria-autocomplete={onCommand ? 'list' : undefined}
        aria-expanded={onCommand ? menuOpen : undefined}
        aria-controls={menuOpen ? menuID : undefined}
        aria-activedescendant={active >= 0 ? optionID(active) : undefined}
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
