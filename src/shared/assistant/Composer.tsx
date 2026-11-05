import { useEffect, useId, useImperativeHandle, useMemo, useRef, useState, type ReactNode, type Ref } from 'react';
import { ArrowUp, Mic, Paperclip, Square } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { parseSlashCommand, type PromptAttachment } from '@/lib/assistant';
import { draftStorageKey, loadDraftFiles, saveDraftFiles } from '@/lib/assistantTabs';
import { cn } from '@/lib/utils';
import { DRAG_MIME } from '@/sdk';
import { AttachmentItem } from '@/shared/assistant/Attachments';
import { useAssistantHost } from '@/shared/assistant/host';
import { ToastViewport } from '@/shared/Toaster';

/** Pasted pictures past this size are left out; the request would be too big. */
const MAX_PASTE_BYTES = 8 * 1024 * 1024;

/** How soon a second Escape has to follow the first to stop the agent. */
const STOP_ESCAPE_MS = 1500;

export interface ComposerHandle {
  /** Replace what's written with `text` and `files` (an undone message, back to edit). */
  fill: (text: string, files?: PromptAttachment[]) => void;
}

/** A file:// URL for a path, each segment escaped. */
function fileUri(path: string): string {
  return `file://${path.split('/').map(encodeURIComponent).join('/')}`;
}

/** Names of pictures, which are attached rather than written in as paths. */
const IMAGE_NAME = /\.(png|jpe?g|gif|webp|avif|bmp|svg)$/i;

/** The paths a `text/uri-list` names, when every URL in it is a local `file:` URL; else null. */
function localPaths(list: string): string[] | null {
  const lines = list.split(/\r?\n/).map((l) => l.trim()).filter((l) => l && !l.startsWith('#'));
  const paths: string[] = [];
  for (const line of lines) {
    try {
      const url = new URL(line);
      if (url.protocol !== 'file:' || (url.host !== '' && url.host !== 'localhost')) return null;
      paths.push(decodeURIComponent(url.pathname));
    } catch {
      return null;
    }
  }
  return paths.length > 0 ? paths : null;
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

/**
 * The composer's files, kept under `key` like its text. They load a moment
 * after it shows, ahead of any attached meanwhile.
 */
function useDraftFiles(key: string | undefined) {
  const [files, setFiles] = useState<PromptAttachment[]>([]);
  const [loaded, setLoaded] = useState(!key);
  useEffect(() => {
    if (!key) return;
    let live = true;
    void loadDraftFiles(key).then((kept) => {
      if (!live) return;
      setFiles((current) => [...kept.filter((f) => !current.some((c) => c.uri === f.uri)), ...current]);
      setLoaded(true);
    });
    return () => {
      live = false;
    };
  }, [key]);
  useEffect(() => {
    if (key && loaded) saveDraftFiles(key, files);
  }, [key, loaded, files]);
  return [files, setFiles] as const;
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
 * new line. Files come from Din's file picker, or are pasted or dropped in
 * (pictures, and files copied or dragged from Files: pictures among them
 * are attached and other files written in as their paths), and go along
 * with the message. While the agent works, a message sent
 * steers it, and Stop (or Escape twice) interrupts it. The mic button dictates into it, the
 * same as Super+H does anywhere. Shift+Tab switches agents, given
 * `onCycleAgent`.
 *
 * A message starting with one of `commands` (`/compact`) goes to
 * `onCommand` instead. Typing `/` lists them, narrowing as the name goes
 * on: the arrows move through it, Tab or Enter fills one in (Enter runs an
 * instant one), Escape puts it away.
 *
 * With `draftKey`, unsent text and files are kept until they're sent.
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
  ref: handleRef,
}: {
  ref?: Ref<ComposerHandle>;
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
  /** Keeps unsent text and files across restarts, one draft per key. */
  draftKey?: string;
}) {
  const [text, setText] = useDraft(draftKey);
  const [files, setFiles] = useDraftFiles(draftKey);
  const ownRef = useRef<HTMLTextAreaElement>(null);
  const ref = textareaRef ?? ownRef;
  const host = useAssistantHost();
  const dictation = host.useDictation(ref);
  const dictating = dictation.active;

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

  // The first Escape while the agent works arms the second, which stops it.
  const [stopArmed, setStopArmed] = useState(false);
  const canStop = running && !!onStop;
  useEffect(() => {
    if (!stopArmed) return;
    const timer = setTimeout(() => setStopArmed(false), STOP_ESCAPE_MS);
    return () => clearTimeout(timer);
  }, [stopArmed]);
  if (stopArmed && !canStop) setStopArmed(false);

  const escapeToStop = () => {
    if (!canStop) return false;
    if (stopArmed) {
      setStopArmed(false);
      onStop();
    } else {
      setStopArmed(true);
    }
    return true;
  };

  useImperativeHandle(handleRef, () => ({
    fill: (value, attached = []) => {
      setText(value);
      setFiles(attached);
      const textarea = ref.current;
      if (!textarea) return;
      textarea.focus();
      requestAnimationFrame(() => textarea.setSelectionRange(textarea.value.length, textarea.value.length));
    },
  }));

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
    const paths = await host.pickFiles({ title: 'Attach files', confirmLabel: 'Attach' }).catch(() => []);
    if (paths.length === 0) return;
    setFiles((current) => [
      ...current,
      ...paths
        .filter((path) => !current.some((f) => f.uri === fileUri(path)))
        .map((path) => ({ uri: fileUri(path), name: path.split('/').pop() || path })),
    ]);
    ref.current?.focus();
  };

  /** Pictures' bytes (copied from a page or Preview, dropped from a web page), attached. */
  const attachImages = async (images: File[]) => {
    const added = await Promise.all(
      images.map(async (file, index) => ({
        uri: await readAsDataUrl(file),
        name: file.name && file.name !== 'image.png' ? file.name : `Pasted picture ${files.length + index + 1}.png`,
      })),
    );
    setFiles((current) => [...current, ...added]);
  };

  /** Text typed in at the cursor, as if from the keyboard (so Undo takes it back). */
  const insertText = (value: string) => {
    const textarea = ref.current;
    if (!textarea || !value) return;
    textarea.focus();
    document.execCommand('insertText', false, value);
  };

  /**
   * Files on this computer, pasted or dropped: pictures attached, as the
   * paperclip attaches them, and anything else written in as its path.
   */
  const takePaths = (paths: string[]) => {
    const name = (path: string) => path.split('/').pop() || path;
    const images = paths.filter((path) => IMAGE_NAME.test(name(path)));
    const others = paths.filter((path) => !images.includes(path));
    if (images.length > 0) {
      setFiles((current) => [
        ...current,
        ...images.filter((path) => !current.some((f) => f.uri === fileUri(path))).map((path) => ({ uri: fileUri(path), name: name(path) })),
      ]);
      ref.current?.focus();
    }
    if (others.length > 0) insertText(others.join('\n'));
  };

  const imagesIn = (data: DataTransfer) =>
    [...data.files].filter((f) => f.type.startsWith('image/') && f.size <= MAX_PASTE_BYTES);

  const onPaste = (event: React.ClipboardEvent<HTMLTextAreaElement>) => {
    const data = event.clipboardData;
    const images = imagesIn(data);
    const text = data.getData('text/plain');
    // Files copied in Files: Din's clipboard keeps them until something else
    // is copied, which the system clipboard shows. A picture or text there
    // that isn't their paths was copied since, and is what's pasted.
    const copied = host.transferredPaths(data, 'paste');
    if (copied) {
      event.preventDefault();
      void copied.then((paths) => {
        if (images.length > 0) void attachImages(images);
        else if (paths.length > 0 && (!text || text === paths.join('\n'))) takePaths(paths);
        else insertText(text);
      });
      return;
    }
    if (images.length === 0) return;
    event.preventDefault();
    void attachImages(images);
  };

  const takesDrop = (data: DataTransfer) => data.types.includes('Files') || data.types.includes('text/uri-list') || data.types.includes(DRAG_MIME);

  const onDrop = (event: React.DragEvent) => {
    if (disabled) return;
    const data = event.dataTransfer;
    // Files from Files (or a native file manager) by their file: URLs; from
    // another app, by the handles Din grants for the drop.
    const listed = localPaths(data.getData('text/uri-list'));
    const dropped = listed ? Promise.resolve(listed) : host.transferredPaths(data, 'drop');
    if (dropped) {
      event.preventDefault();
      void dropped.then(takePaths);
      return;
    }
    const images = imagesIn(data);
    if (images.length === 0) return;
    event.preventDefault();
    void attachImages(images);
  };

  return (
    <div
      className={cn(
        'relative flex flex-col gap-2 rounded-2xl border border-border/60 bg-card p-2 shadow-sm transition-shadow focus-within:shadow-md',
        className,
      )}
      // The whole box takes files, not just the text in it.
      onDragOver={(event) => {
        if (disabled || !takesDrop(event.dataTransfer)) return;
        event.preventDefault();
        event.dataTransfer.dropEffect = 'copy';
      }}
      onDrop={onDrop}
    >
      {/* In an app, its toasts sit just above where the user writes. */}
      <ToastViewport className="absolute inset-x-0 bottom-full mb-2" />
      <div aria-live="polite" className="pointer-events-none absolute right-3 bottom-full z-30 mb-2">
        {stopArmed && (
          <span className="rounded-full border border-border bg-popover px-3 py-1 text-xs text-popover-foreground shadow-sm motion-safe:animate-in motion-safe:fade-in">
            Press Esc again to stop
          </span>
        )}
      </div>
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
        <ul className="flex flex-wrap items-end gap-1.5 px-1 pt-1" aria-label="Attachments">
          {files.map((file) => (
            <AttachmentItem
              key={file.uri}
              file={file}
              compact
              onRemove={() => setFiles((current) => current.filter((f) => f.uri !== file.uri))}
            />
          ))}
        </ul>
      )}
      <textarea
        ref={ref}
        value={text}
        onChange={(event) => setText(event.target.value)}
        onPaste={onPaste}
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
          if (event.key === 'Escape' && !event.shiftKey && !event.ctrlKey && !event.altKey && !event.metaKey && escapeToStop()) {
            event.preventDefault();
            event.stopPropagation();
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
        {dictation.available && (
          <Button
            type="button"
            variant="ghost"
            size="icon"
            // Keeps focus in the message, where the text goes.
            onMouseDown={(event) => event.preventDefault()}
            onClick={dictation.toggle}
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
          <span role="status" className="shrink-0 px-1 text-xs text-muted-foreground">
            {stopArmed && 'Esc again to stop'}
          </span>
        )}
        {running && onStop && (
          <Button
            type="button"
            variant="secondary"
            size="icon"
            onClick={onStop}
            aria-label="Stop"
            title="Stop (Esc Esc)"
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
