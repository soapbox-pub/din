import { useCallback, useEffect, useMemo, useRef, useState, type ClipboardEvent, type KeyboardEvent } from 'react';
import { EditorContent, useEditor, useEditorState } from '@tiptap/react';
import StarterKit from '@tiptap/starter-kit';
import { Bold, ChevronDown, Italic, List, ListOrdered, Loader2, Paperclip, Quote, Send, Strikethrough, Underline, X } from 'lucide-react';
import { useDin, useCloseGuard, useMenuBar, useWindowTitle, WindowControls, WindowDragRegion } from '@/sdk/react';
import { DialogButton, Overlay } from '@/shared/dialogs';
import { cn } from '@/lib/utils';
import type { MailAccount, MailAddress, MailAttachment, OutgoingMessage } from '@/lib/mail';
import { useAccounts, useMail } from './api';
import { rememberAddresses, suggestAddresses } from './contacts';
import { EMAIL, fileSize, formatAddress, parseAddresses, textToHtml, type ComposeSeed } from './format';
import { messageTarget, type SavedWindow } from './restore';

/** An attachment in the message, or one still loading from the message being forwarded. */
type Attached = { id: string; file: MailAttachment | null; name: string; size: number };

function RecipientField({ label, value, onChange, autoFocus, trailing }: { label: string; value: MailAddress[]; onChange: (v: MailAddress[]) => void; autoFocus?: boolean; trailing?: React.ReactNode }) {
  const [draft, setDraft] = useState('');
  const [open, setOpen] = useState(false);
  const [index, setIndex] = useState(0);
  const input = useRef<HTMLInputElement>(null);
  const taken = useMemo(() => new Set(value.map((a) => a.address.toLowerCase())), [value]);
  const suggestions = useMemo(() => (open ? suggestAddresses(draft, taken) : []), [open, draft, taken]);

  const commit = (text = draft) => {
    const added = parseAddresses(text).filter((a) => !taken.has(a.address.toLowerCase()));
    if (added.length) onChange([...value, ...added]);
    setDraft('');
    setIndex(0);
  };

  const pick = (a: MailAddress) => {
    if (!taken.has(a.address.toLowerCase())) onChange([...value, a]);
    setDraft('');
    setIndex(0);
    input.current?.focus();
  };

  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (suggestions.length && (e.key === 'ArrowDown' || e.key === 'ArrowUp')) {
      e.preventDefault();
      setIndex((i) => (i + (e.key === 'ArrowDown' ? 1 : suggestions.length - 1)) % suggestions.length);
    } else if ((e.key === 'Enter' || e.key === 'Tab') && suggestions.length && draft) {
      e.preventDefault();
      pick(suggestions[index] ?? suggestions[0]);
    } else if ((e.key === 'Enter' || e.key === ',' || e.key === ';') && draft.trim()) {
      e.preventDefault();
      commit();
    } else if (e.key === 'Backspace' && !draft && value.length) {
      onChange(value.slice(0, -1));
    } else if (e.key === 'Escape' && open) {
      setOpen(false);
    }
  };

  const onPaste = (e: ClipboardEvent<HTMLInputElement>) => {
    const text = e.clipboardData.getData('text');
    if (/[,;\n]/.test(text) || EMAIL.test(text.trim())) {
      e.preventDefault();
      commit(draft + text.replace(/\n/g, ','));
    }
  };

  const id = `field-${label.toLowerCase()}`;
  return (
    <div className="relative flex min-h-10 items-center gap-2 border-b border-border/60 px-4">
      <label htmlFor={id} className="shrink-0 text-[13px] text-muted-foreground">{label}:</label>
      <div className="flex min-w-0 flex-1 flex-wrap items-center gap-1 py-1.5" onMouseDown={(e) => { if (e.target === e.currentTarget) { e.preventDefault(); input.current?.focus(); } }}>
        {value.map((a, i) => {
          const valid = EMAIL.test(a.address);
          return (
            <span
              key={`${a.address}-${i}`}
              title={formatAddress(a)}
              className={cn('flex max-w-60 items-center gap-0.5 rounded-full py-0.5 pr-1 pl-2.5 text-[13px]', valid ? 'bg-primary/12 text-primary' : 'bg-destructive/12 text-destructive')}
            >
              <span className="truncate">{a.name || a.address}</span>
              <button type="button" aria-label={`Remove ${a.name || a.address}`} onClick={() => onChange(value.filter((_, j) => j !== i))} className="grid size-4 place-items-center rounded-full opacity-60 hover:opacity-100">
                <X className="size-3" />
              </button>
            </span>
          );
        })}
        <input
          ref={input}
          id={id}
          autoFocus={autoFocus}
          value={draft}
          onChange={(e) => {
            setDraft(e.target.value);
            setOpen(true);
            setIndex(0);
          }}
          onKeyDown={onKeyDown}
          onPaste={onPaste}
          onFocus={() => setOpen(true)}
          onBlur={() => {
            setOpen(false);
            if (draft.trim()) commit();
          }}
          className="h-6 min-w-24 flex-1 bg-transparent text-[13px] outline-none"
          autoComplete="off"
          spellCheck={false}
          role="combobox"
          aria-expanded={suggestions.length > 0}
          aria-controls={`${id}-list`}
        />
      </div>
      {trailing}
      {suggestions.length > 0 && (
        <ul id={`${id}-list`} role="listbox" className="absolute top-full left-14 z-20 mt-1 w-80 overflow-hidden rounded-lg border border-border/70 bg-popover py-1 shadow-lg">
          {suggestions.map((s, i) => (
            <li
              key={s.address}
              role="option"
              aria-selected={i === index}
              onMouseDown={(e) => {
                e.preventDefault();
                pick(s);
              }}
              className={cn('cursor-default px-3 py-1.5 text-[13px]', i === index && 'bg-primary text-primary-foreground')}
            >
              <span className="font-medium">{s.name || s.address}</span>
              {s.name && <span className={cn('ml-2', i === index ? 'text-primary-foreground/80' : 'text-muted-foreground')}>{s.address}</span>}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/** The editor's HTML as plain text, with quotes as "> " lines, for the text part of the message. */
function htmlToPlain(html: string): string {
  const doc = new DOMParser().parseFromString(html, 'text/html');
  const out: string[] = [];
  const walk = (node: Node, quote: string): string => {
    if (node.nodeType === Node.TEXT_NODE) return node.textContent ?? '';
    if (!(node instanceof Element)) return '';
    const tag = node.tagName;
    if (tag === 'BR') return '\n';
    if (tag === 'BLOCKQUOTE') {
      for (const c of node.childNodes) block(c, `${quote}> `);
      return '';
    }
    let s = '';
    for (const c of node.childNodes) s += walk(c, quote);
    if (tag === 'A') {
      const href = node.getAttribute('href');
      if (href && href !== s && !href.startsWith('mailto:')) s += ` <${href}>`;
    }
    return s;
  };
  const block = (node: Node, quote: string) => {
    if (node instanceof Element && node.tagName === 'BLOCKQUOTE') {
      walk(node, quote);
      return;
    }
    if (node instanceof Element && (node.tagName === 'UL' || node.tagName === 'OL')) {
      [...node.children].forEach((li, i) => out.push(`${quote}${node.tagName === 'OL' ? `${i + 1}.` : '•'} ${walk(li, quote).trim()}`));
      return;
    }
    const text = walk(node, quote);
    for (const line of text.split('\n')) out.push(`${quote}${line}`.trimEnd());
  };
  for (const c of doc.body.childNodes) block(c, '');
  return out.join('\n').replace(/\n{3,}/g, '\n\n').trim() + '\n';
}

function wrapHtml(body: string): string {
  return `<!DOCTYPE html><html><head><meta charset="utf-8"><style>p { margin: 0; }</style></head><body style="font-family: -apple-system, 'Helvetica Neue', Helvetica, Arial, sans-serif; font-size: 14px; line-height: 1.5;">${body.replace(/<p><\/p>/g, '<p><br></p>').replace(/<blockquote>/g, '<blockquote type="cite" style="margin: 0 0 0 4px; padding-left: 12px; border-left: 2px solid #0a84ff;">')}</body></html>`;
}

function withSignature(seed: ComposeSeed, account: MailAccount | undefined): string {
  const sig = account?.signature.trim();
  const rest = seed.html.replace(/^(<p><\/p>)+/, '');
  if (seed.draftUid) return seed.html;
  const block = sig ? `<p>${textToHtml(sig)}</p>` : '';
  return `<p></p>${block ? `<p></p>${block}` : ''}${rest ? `<p></p>${rest}` : ''}`;
}

function FormatButton({ label, active, onClick, children }: { label: string; active?: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      aria-pressed={active}
      onMouseDown={(e) => e.preventDefault()}
      onClick={onClick}
      className={cn('grid size-7 place-items-center rounded-md text-muted-foreground hover:bg-foreground/5 hover:text-foreground', active && 'bg-foreground/10 text-foreground')}
    >
      {children}
    </button>
  );
}

/**
 * `restored` when Din reopened the window: the seed is the message as it
 * was left (its body signed already), and `dirty` whether it was unsaved.
 */
export function Compose({ seed, restored = null }: { seed: ComposeSeed; restored?: { dirty: boolean } | null }) {
  const din = useDin();
  const mail = useMail();
  const accounts = useAccounts();
  const list = useMemo(() => accounts.data ?? [], [accounts.data]);
  const [accountId, setAccountId] = useState<string | null>(seed.accountId);
  const account = list.find((a) => a.id === accountId) ?? list[0];
  const [to, setTo] = useState(seed.to);
  const [cc, setCc] = useState(seed.cc);
  const [bcc, setBcc] = useState(seed.bcc);
  const [showCc, setShowCc] = useState(seed.cc.length > 0 || seed.bcc.length > 0);
  const [subject, setSubject] = useState(seed.subject);
  const [attached, setAttached] = useState<Attached[]>(() => (seed.forwardFrom?.indexes ?? []).map((i) => ({ id: `fwd-${i}`, file: null, name: 'Attachment', size: 0 })));
  const [draftUid, setDraftUid] = useState(seed.draftUid);
  const [dirty, setDirty] = useState(restored?.dirty ?? false);
  const [revision, setRevision] = useState(0);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [asking, setAsking] = useState<'close' | 'subject' | null>(null);
  const [status, setStatus] = useState<string | null>(null);

  useWindowTitle(subject.trim() || 'New Message');

  useEffect(() => {
    if (din.window.state.bounds.width > 900) din.window.setBounds({ width: 760, height: 680 });
  }, [din]);

  // A message to open, sent here (a restored window can't be told from a
  // viewer): it opens in a viewer of its own.
  useEffect(
    () =>
      din.app.onLaunch(({ params }) => {
        if (messageTarget(params)) void din.app.open('mail', params);
      }),
    [din],
  );

  const editor = useEditor({
    extensions: [StarterKit.configure({ link: { openOnClick: false, autolink: true }, heading: false, codeBlock: false })],
    content: '',
    editorProps: { attributes: { class: 'mail-compose min-h-full px-5 py-4 text-[14px] leading-relaxed outline-none', 'aria-label': 'Message' } },
    onUpdate: () => {
      setDirty(true);
      setRevision((r) => r + 1);
    },
  });

  // The body starts once accounts are known, so the signature is the sender's.
  const started = useRef(false);
  useEffect(() => {
    if (!editor || started.current || accounts.isPending) return;
    started.current = true;
    editor.commands.setContent(restored ? seed.html : withSignature(seed, account), { emitUpdate: false });
    if (seed.to.length) editor.commands.focus('start');
  }, [editor, accounts.isPending, seed, account, restored]);

  // Kept for Din to reopen the window with, as it changes. Files attached
  // from this computer aren't (they can be bigger than what's kept); a
  // forwarded message's are fetched again.
  useEffect(() => {
    if (!editor || !started.current) return;
    const t = setTimeout(() => {
      const forwarded = attached.filter((a) => a.id.startsWith('fwd-')).map((a) => Number(a.id.slice(4)));
      const state: SavedWindow = {
        kind: 'compose',
        dirty,
        seed: {
          ...seed,
          accountId,
          to,
          cc,
          bcc,
          subject,
          html: editor.getHTML(),
          draftUid,
          forwardFrom: seed.forwardFrom && forwarded.length ? { ...seed.forwardFrom, indexes: forwarded } : null,
        },
      };
      din.app.saveState(state);
    }, 500);
    return () => clearTimeout(t);
  }, [din, editor, seed, accountId, to, cc, bcc, subject, attached, draftUid, dirty, revision]);

  const format = useEditorState({
    editor,
    selector: ({ editor: e }) => ({
      bold: !!e?.isActive('bold'),
      italic: !!e?.isActive('italic'),
      underline: !!e?.isActive('underline'),
      strike: !!e?.isActive('strike'),
      bullet: !!e?.isActive('bulletList'),
      ordered: !!e?.isActive('orderedList'),
      quote: !!e?.isActive('blockquote'),
    }),
  });

  // Attachments of a forwarded message come along.
  useEffect(() => {
    const from = seed.forwardFrom;
    if (!mail || !from) return;
    for (const index of from.indexes) {
      void mail
        .attachment(from.accountId, from.path, from.uid, index)
        .then((file) => setAttached((list) => list.map((a) => (a.id === `fwd-${index}` ? { id: a.id, file, name: file.filename, size: file.content.byteLength } : a))))
        .catch(() => setAttached((list) => list.filter((a) => a.id !== `fwd-${index}`)));
    }
  }, [mail, seed.forwardFrom]);

  const attach = useCallback(async () => {
    const handles = await din.files.open({ title: 'Attach Files', multiple: true, writable: false, confirmLabel: 'Attach' });
    for (const h of handles) {
      const file = await h.getFile();
      const content = new Uint8Array(await file.arrayBuffer());
      setAttached((list) => [...list, { id: crypto.randomUUID(), name: h.name, size: content.byteLength, file: { filename: h.name, contentType: file.type || 'application/octet-stream', content } }]);
      setDirty(true);
    }
  }, [din]);

  const message = useCallback((): OutgoingMessage => {
    const html = editor?.getHTML() ?? '';
    return {
      to,
      cc,
      bcc,
      subject: subject.trim(),
      text: htmlToPlain(html),
      html: wrapHtml(html),
      attachments: attached.flatMap((a) => (a.file ? [a.file] : [])),
      inReplyTo: seed.inReplyTo,
      references: seed.references,
      answering: seed.answering,
      draftUid,
    };
  }, [editor, to, cc, bcc, subject, attached, seed, draftUid]);

  // Set once the window is going for good (sent, or the user said not to save).
  const closing = useRef(false);
  const close = useCallback(() => {
    closing.current = true;
    din.window.close();
  }, [din]);

  const saveDraft = useCallback(async (): Promise<boolean> => {
    if (!mail || !account) return false;
    setStatus('Saving…');
    try {
      const uid = await mail.saveDraft(account.id, message());
      setDraftUid(uid);
      setDirty(false);
      setStatus('Draft saved');
      return true;
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setStatus(null);
      return false;
    }
  }, [mail, account, message]);

  const send = useCallback(
    async (force = false) => {
      if (!mail || !account || sending) return;
      const everyone = [...to, ...cc, ...bcc];
      if (!everyone.length) {
        setError('Add someone to send this message to.');
        return;
      }
      const bad = everyone.find((a) => !EMAIL.test(a.address));
      if (bad) {
        setError(`“${bad.address}” isn’t an email address.`);
        return;
      }
      if (attached.some((a) => !a.file)) {
        setError('Attachments are still loading.');
        return;
      }
      if (!subject.trim() && !force) {
        setAsking('subject');
        return;
      }
      setError(null);
      setSending(true);
      try {
        await mail.send(account.id, message());
        rememberAddresses(everyone, 5);
        close();
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
        setSending(false);
      }
    },
    [mail, account, sending, to, cc, bcc, attached, subject, message, close],
  );

  useCloseGuard(dirty ? () => {
    if (closing.current) return false;
    setAsking('close');
    return true;
  } : null);

  useMenuBar(
    [
      {
        label: 'File',
        items: [
          { id: 'send', label: 'Send', accelerator: 'Ctrl+Enter' },
          { id: 'save', label: 'Save as Draft', accelerator: 'Ctrl+S' },
          { type: 'separator' },
          { id: 'attach', label: 'Attach Files…', accelerator: 'Ctrl+Shift+A' },
        ],
      },
      {
        label: 'View',
        items: [{ id: 'cc', label: 'Cc and Bcc Fields', type: 'checkbox', checked: showCc }],
      },
    ],
    (id) => {
      if (id === 'send') void send();
      else if (id === 'save') void saveDraft();
      else if (id === 'attach') void attach();
      else if (id === 'cc') setShowCc((v) => !v);
    },
  );

  if (!accounts.isPending && !list.length) {
    return (
      <div className="flex h-full flex-col bg-background">
        <WindowDragRegion className="flex h-12 shrink-0 items-center justify-end px-3">
          <WindowControls />
        </WindowDragRegion>
        <div className="grid flex-1 place-items-center p-8 text-center text-muted-foreground">Add a mail account in Mail to send messages.</div>
      </div>
    );
  }

  return (
    <div className="relative flex h-full flex-col bg-background text-foreground">
      <WindowDragRegion className="flex h-12 shrink-0 items-center gap-2 border-b border-border/60 pr-3 pl-3">
        <button
          type="button"
          onClick={() => void send()}
          disabled={sending || !account}
          aria-label="Send"
          title="Send (Ctrl+Enter)"
          className="grid size-8 place-items-center rounded-md text-primary outline-none hover:bg-primary/10 focus-visible:ring-2 focus-visible:ring-ring/60 disabled:opacity-50"
        >
          {sending ? <Loader2 className="size-4.5 animate-spin motion-reduce:animate-none" /> : <Send className="size-4.5" />}
        </button>
        <div className="min-w-0 flex-1 truncate text-center text-[13px] font-semibold">{subject.trim() || 'New Message'}</div>
        {status && !dirty && <span className="text-xs text-muted-foreground">{status}</span>}
        <button type="button" onClick={() => void attach()} aria-label="Attach files" title="Attach Files" className="grid size-8 place-items-center rounded-md text-muted-foreground hover:bg-foreground/5 hover:text-foreground">
          <Paperclip className="size-4" />
        </button>
        <WindowControls />
      </WindowDragRegion>

      <RecipientField
        label="To"
        value={to}
        onChange={(v) => {
          setTo(v);
          setDirty(true);
        }}
        autoFocus={!seed.to.length}
        trailing={
          !showCc && (
            <button type="button" onClick={() => setShowCc(true)} className="shrink-0 text-xs text-muted-foreground hover:text-foreground">
              Cc/Bcc
            </button>
          )
        }
      />
      {showCc && (
        <>
          <RecipientField label="Cc" value={cc} onChange={(v) => { setCc(v); setDirty(true); }} />
          <RecipientField label="Bcc" value={bcc} onChange={(v) => { setBcc(v); setDirty(true); }} />
        </>
      )}
      <div className="flex h-10 items-center gap-2 border-b border-border/60 px-4">
        <label htmlFor="field-subject" className="shrink-0 text-[13px] text-muted-foreground">Subject:</label>
        <input
          id="field-subject"
          value={subject}
          onChange={(e) => {
            setSubject(e.target.value);
            setDirty(true);
          }}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault();
              editor?.commands.focus('start');
            }
          }}
          className="h-full min-w-0 flex-1 bg-transparent text-[13px] font-medium outline-none"
        />
      </div>
      {list.length > 1 && (
        <div className="flex h-10 items-center gap-2 border-b border-border/60 px-4">
          <label htmlFor="field-from" className="shrink-0 text-[13px] text-muted-foreground">From:</label>
          <div className="relative">
            <select
              id="field-from"
              value={account?.id}
              onChange={(e) => setAccountId(e.target.value)}
              className="h-7 appearance-none rounded-md bg-transparent pr-6 pl-1 text-[13px] outline-none hover:bg-foreground/5 focus-visible:ring-2 focus-visible:ring-ring/60"
            >
              {list.map((a) => (
                <option key={a.id} value={a.id}>
                  {a.fullName ? `${a.fullName} – ${a.email}` : a.email}
                </option>
              ))}
            </select>
            <ChevronDown className="pointer-events-none absolute top-1/2 right-1 size-3.5 -translate-y-1/2 text-muted-foreground" />
          </div>
        </div>
      )}

      <div className="flex h-9 shrink-0 items-center gap-0.5 border-b border-border/60 px-3" role="toolbar" aria-label="Formatting">
        <FormatButton label="Bold" active={format?.bold} onClick={() => editor?.chain().focus().toggleBold().run()}><Bold className="size-4" /></FormatButton>
        <FormatButton label="Italic" active={format?.italic} onClick={() => editor?.chain().focus().toggleItalic().run()}><Italic className="size-4" /></FormatButton>
        <FormatButton label="Underline" active={format?.underline} onClick={() => editor?.chain().focus().toggleUnderline().run()}><Underline className="size-4" /></FormatButton>
        <FormatButton label="Strikethrough" active={format?.strike} onClick={() => editor?.chain().focus().toggleStrike().run()}><Strikethrough className="size-4" /></FormatButton>
        <span className="mx-1 h-4 w-px bg-border" />
        <FormatButton label="Bulleted list" active={format?.bullet} onClick={() => editor?.chain().focus().toggleBulletList().run()}><List className="size-4" /></FormatButton>
        <FormatButton label="Numbered list" active={format?.ordered} onClick={() => editor?.chain().focus().toggleOrderedList().run()}><ListOrdered className="size-4" /></FormatButton>
        <FormatButton label="Quote" active={format?.quote} onClick={() => editor?.chain().focus().toggleBlockquote().run()}><Quote className="size-4" /></FormatButton>
      </div>

      {error && (
        <div role="alert" className="flex items-start gap-2 border-b border-destructive/30 bg-destructive/10 px-4 py-2 text-[13px] text-destructive">
          <span className="flex-1">{error}</span>
          <button type="button" aria-label="Dismiss" onClick={() => setError(null)}><X className="size-4" /></button>
        </div>
      )}

      <div className="min-h-0 flex-1 cursor-text overflow-y-auto" onMouseDown={(e) => { if (e.target === e.currentTarget) { e.preventDefault(); editor?.commands.focus('end'); } }}>
        <EditorContent editor={editor} className="h-full" />
      </div>

      {attached.length > 0 && (
        <div className="flex max-h-32 shrink-0 flex-wrap gap-2 overflow-y-auto border-t border-border/60 px-4 py-3">
          {attached.map((a) => (
            <span key={a.id} className="flex max-w-64 items-center gap-2 rounded-lg border border-border/70 bg-card py-1.5 pr-1.5 pl-3 text-[13px]">
              {a.file ? <Paperclip className="size-3.5 shrink-0 text-muted-foreground" /> : <Loader2 className="size-3.5 shrink-0 animate-spin text-muted-foreground motion-reduce:animate-none" />}
              <span className="min-w-0 truncate">{a.name}</span>
              {a.size > 0 && <span className="shrink-0 text-xs text-muted-foreground">{fileSize(a.size)}</span>}
              <button type="button" aria-label={`Remove ${a.name}`} onClick={() => setAttached((list) => list.filter((x) => x.id !== a.id))} className="grid size-5 place-items-center rounded-md text-muted-foreground hover:bg-foreground/5">
                <X className="size-3.5" />
              </button>
            </span>
          ))}
        </div>
      )}

      {asking === 'subject' && (
        <Overlay label="No subject" onClose={() => setAsking(null)}>
          <div className="p-5">
            <h2 className="text-[15px] font-semibold">This message has no subject.</h2>
            <p className="mt-1 text-[13px] text-muted-foreground">Do you want to send it anyway?</p>
          </div>
          <div className="flex justify-end gap-2 border-t border-border/60 px-5 py-3">
            <DialogButton onClick={() => setAsking(null)}>Don’t Send</DialogButton>
            <DialogButton variant="primary" autoFocus onClick={() => { setAsking(null); void send(true); }}>Send Anyway</DialogButton>
          </div>
        </Overlay>
      )}
      {asking === 'close' && (
        <Overlay label="Save draft" onClose={() => setAsking(null)}>
          <div className="p-5">
            <h2 className="text-[15px] font-semibold">Do you want to save this message as a draft?</h2>
            <p className="mt-1 text-[13px] text-muted-foreground">Drafts are kept in the account’s Drafts mailbox{account ? ` (${account.name})` : ''}.</p>
          </div>
          <div className="flex gap-2 border-t border-border/60 px-5 py-3">
            <DialogButton className="mr-auto" onClick={close}>Don’t Save</DialogButton>
            <DialogButton onClick={() => setAsking(null)}>Cancel</DialogButton>
            <DialogButton variant="primary" autoFocus onClick={() => void saveDraft().then((ok) => { setAsking(null); if (ok) close(); })}>Save</DialogButton>
          </div>
        </Overlay>
      )}
    </div>
  );
}
