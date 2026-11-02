import { useCallback, useEffect, useMemo, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { ChevronLeft, MessageCircle, RefreshCw, Search, Smartphone, SquarePen, X } from 'lucide-react';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { Button } from '@/components/ui/button';
import type { PhoneConversation, PhoneDevice, PhoneMessage } from '@/lib/phone';
import { cn } from '@/lib/utils';
import type { LaunchContext } from '@/sdk/din';
import { useDin, useDocumentVisible, useMediaQuery, useMenuBar, useWindowFocused, WindowControls, WindowDragRegion } from '@/sdk/react';
import { toast } from '@/shared/toast';
import { cleanPhoneError, formatAddress, phoneDigits } from '@/shared/phone';
import { useContacts, useConversations, useMessages, usePhone, usePhoneState, usePhoneSync } from './messages/api';
import { Avatar } from './messages/Avatar';
import { Composer } from './messages/Composer';
import { ConversationList } from './messages/ConversationList';
import { conversationKey, displayName } from './messages/format';
import { Recipients, type Recipient } from './messages/Recipients';
import { Thread } from './messages/Thread';

type Selection =
  | { kind: 'thread'; phoneId: string; threadId: string; addresses: string[] }
  | { kind: 'new' }
  | null;

function fromLaunch(launch: Pick<LaunchContext, 'params' | 'shortcut'>): Selection {
  const { phoneId, threadId } = launch.params;
  if (typeof phoneId === 'string' && typeof threadId === 'string') return { kind: 'thread', phoneId, threadId, addresses: [] };
  if (launch.shortcut === 'new' || recipientsOf(launch).length) return { kind: 'new' };
  return null;
}

/** A launch's `{ to: [{ name, address }] }` (Contacts' Send Message): who a new message is for. */
function recipientsOf(launch: Pick<LaunchContext, 'params'>): Recipient[] {
  const { to } = launch.params;
  if (!Array.isArray(to)) return [];
  return to.flatMap((r: unknown) => {
    const { name, address } = (r ?? {}) as { name?: unknown; address?: unknown };
    return typeof address === 'string' && address.trim() ? [{ name: typeof name === 'string' && name ? name : formatAddress(address), address: address.trim() }] : [];
  });
}

function sameAddresses(a: string[], b: string[]): boolean {
  const key = (list: string[]) => list.map((x) => phoneDigits(x) || x).sort().join(',');
  return key(a) === key(b);
}

/**
 * Messages: the texts on the user's phones (Settings → Phone adds them), in
 * conversations, answered from here. A launch with `{ phoneId, threadId }`
 * (a notification's click) opens that conversation; the New Message
 * shortcut starts one, and `{ to: [{ name, address }] }` one to them.
 */
export function Messages() {
  const din = useDin();
  const phone = usePhone();
  const qc = useQueryClient();
  usePhoneSync();
  const state = usePhoneState();
  const conversations = useConversations();
  const focused = useWindowFocused();
  const visible = useDocumentVisible();
  const narrow = !useMediaQuery('(min-width: 680px)');

  const [selection, setSelection] = useState<Selection>(() => fromLaunch(din.app.launch));
  const [search, setSearch] = useState('');
  const [deleting, setDeleting] = useState<PhoneConversation | null>(null);
  const [newFrom, setNewFrom] = useState<string | null>(null);
  const [recipients, setRecipients] = useState<Recipient[]>(() => recipientsOf(din.app.launch));

  const phones = useMemo(() => state.data?.phones ?? [], [state.data]);
  const phoneById = useMemo(() => new Map(phones.map((p) => [p.id, p])), [phones]);
  const list = useMemo(() => conversations.data ?? [], [conversations.data]);

  useEffect(
    () =>
      din.app.onLaunch((launch) => {
        const next = fromLaunch(launch);
        if (next) setSelection(next);
        const to = recipientsOf(launch);
        if (to.length || next?.kind === 'new') setRecipients(to);
      }),
    [din],
  );

  // The conversation on screen: the one picked; one started here, under the
  // phone's own id once the phone has it; or, in a wide window, the newest.
  const current = useMemo(() => {
    if (selection?.kind === 'thread') {
      const exact = list.find((c) => c.phoneId === selection.phoneId && c.threadId === selection.threadId);
      if (exact || selection.addresses.length === 0) return exact ?? null;
      return list.find((c) => c.phoneId === selection.phoneId && sameAddresses(c.addresses, selection.addresses)) ?? null;
    }
    return selection === null && !narrow ? list[0] ?? null : null;
  }, [selection, list, narrow]);

  // What's on screen is read.
  useEffect(() => {
    if (phone && current && current.unread > 0 && focused && visible) void phone.markRead(current.phoneId, current.threadId);
  }, [phone, current, focused, visible]);

  const select = (c: PhoneConversation) => setSelection({ kind: 'thread', phoneId: c.phoneId, threadId: c.threadId, addresses: c.addresses });
  const startNew = () => {
    setRecipients([]);
    setSelection({ kind: 'new' });
  };

  const refresh = useCallback(() => {
    for (const p of phones) void phone?.refresh(p.id).catch(() => {});
    void qc.invalidateQueries({ queryKey: ['phone'] });
  }, [phone, phones, qc]);

  const markRead = (c: PhoneConversation) => void phone?.markRead(c.phoneId, c.threadId);
  const copyNumbers = (c: PhoneConversation) => void navigator.clipboard.writeText(c.addresses.join(', '));
  const remove = (c: PhoneConversation) => {
    void phone?.deleteConversation(c.phoneId, c.threadId).then(() => {
      if (current && conversationKey(current) === conversationKey(c)) setSelection(null);
    });
  };

  const send = async (phoneId: string, addresses: string[], text: string): Promise<string> => {
    try {
      return await phone!.send(phoneId, addresses, text);
    } catch (error) {
      toast('Couldn’t send the text', { body: cleanPhoneError(error), destructive: true });
      throw error;
    }
  };

  const retry = (m: PhoneMessage) => void send(m.phoneId, m.addresses, m.body).catch(() => {});

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return list;
    const digits = q.replace(/\D/g, '');
    return list.filter(
      (c) =>
        c.name.toLowerCase().includes(q) ||
        c.last.body.toLowerCase().includes(q) ||
        (digits.length >= 3 && c.addresses.some((a) => a.replace(/\D/g, '').includes(digits))),
    );
  }, [list, search]);

  useMenuBar(
    [
      {
        label: 'File',
        items: [{ id: 'new', label: 'New Message', accelerator: 'Ctrl+N', enabled: phones.length > 0 }],
      },
      {
        label: 'Conversation',
        items: [
          { id: 'read', label: 'Mark as Read', enabled: !!current && current.unread > 0 },
          { id: 'copy', label: 'Copy Number', enabled: !!current },
          { type: 'separator' },
          { id: 'delete', label: 'Delete Conversation…', enabled: !!current, destructive: true },
        ],
      },
      {
        label: 'View',
        items: [
          { id: 'refresh', label: 'Check for New Messages', accelerator: 'Ctrl+R', enabled: phones.length > 0 },
          { id: 'search', label: 'Search', accelerator: 'Ctrl+F', notInFields: true },
          { type: 'separator' },
          { id: 'settings', label: 'Phone Settings…' },
        ],
      },
    ],
    (id) => {
      switch (id) {
        case 'new': return startNew();
        case 'read': return current && markRead(current);
        case 'copy': return current && copyNumbers(current);
        case 'delete': return current && setDeleting(current);
        case 'refresh': return refresh();
        case 'search': return document.getElementById('messages-search')?.focus();
        case 'settings': return void din.app.open('settings', { section: 'phone' });
      }
    },
  );

  if (!phone) {
    return (
      <Shell>
        <Empty icon={MessageCircle} title="Messages">Messages needs the Din desktop app to reach your phone.</Empty>
      </Shell>
    );
  }

  if (state.isSuccess && phones.length === 0) {
    return (
      <Shell>
        <Empty icon={Smartphone} title="Text from your computer">
          Connect your iPhone or Android phone to read and answer its texts here.
          <Button className="mt-6" onClick={() => void din.app.open('settings', { section: 'phone', add: true, nonce: Date.now() })}>
            Set Up a Phone
          </Button>
        </Empty>
      </Shell>
    );
  }

  const showList = !narrow || !selection;
  const showPane = !narrow || !!selection;
  const currentPhone = current ? phoneById.get(current.phoneId) : selection?.kind === 'thread' ? phoneById.get(selection.phoneId) : undefined;

  return (
    <div className="relative flex h-full text-foreground">
      {showList && (
        <aside
          aria-label="Conversations"
          className={cn('flex min-w-0 shrink-0 flex-col border-r border-border/60 bg-background/60', narrow ? 'flex-1' : 'w-80')}
        >
          <WindowDragRegion className="flex h-13 shrink-0 items-center gap-1 pr-2 pl-4">
            <h1 className="min-w-0 flex-1 truncate font-[family-name:var(--font-title)] text-[17px] font-bold">Messages</h1>
            <ToolButton label="Check for new messages" onClick={refresh}>
              <RefreshCw className="size-4" strokeWidth={1.75} />
            </ToolButton>
            <ToolButton label="New message" onClick={startNew}>
              <SquarePen className="size-4" strokeWidth={1.75} />
            </ToolButton>
            {narrow && <WindowControls />}
          </WindowDragRegion>
          <div className="px-3 pb-2">
            <div className="relative">
              <Search className="pointer-events-none absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2 text-muted-foreground" />
              <input
                id="messages-search"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                onKeyDown={(e) => e.key === 'Escape' && setSearch('')}
                placeholder="Search"
                aria-label="Search conversations"
                className="h-8 w-full rounded-lg bg-foreground/[0.06] pr-7 pl-8 text-sm outline-none placeholder:text-muted-foreground focus-visible:ring-2 focus-visible:ring-ring/60"
              />
              {search && (
                <button type="button" aria-label="Clear search" onClick={() => setSearch('')} className="absolute top-1/2 right-2 grid size-4 -translate-y-1/2 place-items-center rounded-full bg-muted-foreground/40 text-background">
                  <X className="size-3" />
                </button>
              )}
            </div>
          </div>
          <PhoneStrip phones={phones} onSettings={() => void din.app.open('settings', { section: 'phone' })} />
          <div className="min-h-0 flex-1 overflow-y-auto">
            {!conversations.isPending && filtered.length === 0 ? (
              <p className="px-6 py-10 text-center text-sm text-muted-foreground">
                {search ? 'No conversations match.' : 'No messages yet. New texts show up here as they arrive.'}
              </p>
            ) : (
              <ConversationList
                conversations={filtered}
                loading={conversations.isPending}
                selected={current ? conversationKey(current) : null}
                phoneNames={phones.length > 1 ? new Map(phones.map((p) => [p.id, p.name])) : null}
                onSelect={select}
                onMarkRead={markRead}
                onCopyNumbers={copyNumbers}
                onDelete={setDeleting}
              />
            )}
          </div>
        </aside>
      )}

      {showPane && (
        <main className="flex min-w-0 flex-1 flex-col bg-background">
          {selection?.kind === 'new' ? (
            <NewMessage
              phones={phones}
              from={newFrom ?? phones.find((p) => p.status === 'connected')?.id ?? phones[0]?.id ?? null}
              onFrom={setNewFrom}
              recipients={recipients}
              onRecipients={setRecipients}
              narrow={narrow}
              onBack={() => setSelection(null)}
              onSend={async (phoneId, text) => {
                const addresses = recipients.map((r) => r.address);
                const threadId = await send(phoneId, addresses, text);
                setSelection({ kind: 'thread', phoneId, threadId, addresses });
              }}
            />
          ) : current ? (
            <ConversationPane
              key={conversationKey(current)}
              conversation={current}
              phone={currentPhone}
              narrow={narrow}
              onBack={() => setSelection(null)}
              onSend={(text) => send(current.phoneId, current.addresses, text).then(() => {})}
              onRetry={retry}
            />
          ) : (
            <>
              <WindowDragRegion className="flex h-13 shrink-0 items-center justify-end px-3">
                <WindowControls />
              </WindowDragRegion>
              <div className="grid flex-1 place-items-center p-8 text-sm text-muted-foreground">
                {conversations.isPending ? '' : 'Pick a conversation, or start a new one.'}
              </div>
            </>
          )}
        </main>
      )}

      <AlertDialog open={deleting !== null} onOpenChange={(o) => !o && setDeleting(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete the conversation with {deleting ? displayName(deleting.name) : ''}?</AlertDialogTitle>
            <AlertDialogDescription>
              It’s deleted from this computer. It stays on the phone, and new texts from them start it again.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              className="bg-destructive text-white hover:bg-destructive/90 focus-visible:ring-destructive/20"
              onClick={() => deleting && remove(deleting)}
            >
              Delete
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}

function ConversationPane({
  conversation,
  phone,
  narrow,
  onBack,
  onSend,
  onRetry,
}: {
  conversation: PhoneConversation;
  phone: PhoneDevice | undefined;
  narrow: boolean;
  onBack: () => void;
  onSend: (text: string) => Promise<void>;
  onRetry: (m: PhoneMessage) => void;
}) {
  const messages = useMessages(conversation.phoneId, conversation.threadId);
  const contacts = useContacts(conversation.phoneId);
  const group = conversation.addresses.length > 1;
  const name = displayName(conversation.name);
  const nameOf = useCallback(
    (address: string) => {
      const digits = phoneDigits(address);
      return contacts.data?.find((c) => c.numbers.some((n) => phoneDigits(n) === digits))?.name ?? formatAddress(address);
    },
    [contacts.data],
  );

  return (
    <>
      <WindowDragRegion className="flex h-13 shrink-0 items-center gap-2.5 border-b border-border/60 pr-3 pl-2">
        {narrow ? (
          <ToolButton label="Back to conversations" onClick={onBack}>
            <ChevronLeft className="size-5" />
          </ToolButton>
        ) : (
          <span className="w-1" />
        )}
        <Avatar name={conversation.name} group={group} className="size-8 text-xs" />
        <div className="min-w-0 flex-1 leading-tight">
          <h2 className="truncate text-[15px] font-semibold">{name}</h2>
          <p className="truncate text-[11px] text-muted-foreground">
            {name === conversation.addresses.map(formatAddress).join(', ') ? phone?.name : conversation.addresses.map(formatAddress).join(', ')}
          </p>
        </div>
        <WindowControls />
      </WindowDragRegion>
      <Thread
        messages={messages.data ?? []}
        loading={messages.isPending}
        group={group}
        nameOf={nameOf}
        onRetry={onRetry}
      />
      <Composer
        draftKey={`${conversation.phoneId}\u0000${conversation.threadId}`}
        disabled={sendBlocked(phone)}
        placeholder="Text Message"
        onSend={onSend}
        autoFocus
      />
    </>
  );
}

function NewMessage({
  phones,
  from,
  onFrom,
  recipients,
  onRecipients,
  narrow,
  onBack,
  onSend,
}: {
  phones: PhoneDevice[];
  from: string | null;
  onFrom: (id: string) => void;
  recipients: Recipient[];
  onRecipients: (r: Recipient[]) => void;
  narrow: boolean;
  onBack: () => void;
  onSend: (phoneId: string, text: string) => Promise<void>;
}) {
  const contacts = useContacts(from);
  const phone = phones.find((p) => p.id === from);
  return (
    <>
      <WindowDragRegion className="flex h-13 shrink-0 items-center gap-2 border-b border-border/60 pr-3 pl-2">
        {narrow ? (
          <ToolButton label="Back to conversations" onClick={onBack}>
            <ChevronLeft className="size-5" />
          </ToolButton>
        ) : (
          <span className="w-2" />
        )}
        <h2 className="min-w-0 flex-1 truncate text-[15px] font-semibold">New Message</h2>
        {phones.length > 1 && (
          <label className="flex items-center gap-1.5 text-xs text-muted-foreground">
            From
            <select
              value={from ?? ''}
              onChange={(e) => onFrom(e.target.value)}
              className="rounded-md border border-border bg-background px-1.5 py-1 text-xs text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            >
              {phones.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
            </select>
          </label>
        )}
        <WindowControls />
      </WindowDragRegion>
      <Recipients recipients={recipients} contacts={contacts.data ?? []} onChange={onRecipients} />
      <div className="flex-1 p-6 text-center text-xs text-muted-foreground">
        {recipients.length > 1 && 'The phone sends this to each of them separately.'}
      </div>
      <Composer
        draftKey="new"
        disabled={recipients.length === 0 ? 'Add who it’s to.' : sendBlocked(phone)}
        placeholder="Text Message"
        onSend={(text) => (from ? onSend(from, text) : Promise.reject(new Error('No phone')))}
      />
    </>
  );
}

/** Why a text can't be sent from this phone now, or null. */
function sendBlocked(phone: PhoneDevice | undefined): string | null {
  if (!phone) return 'This phone has been removed.';
  if (phone.status === 'connected') return null;
  if (phone.status === 'connecting') return `Connecting to ${phone.name}…`;
  return `${phone.name} isn’t connected. Bring it near this computer.`;
}

/** The phones, when one needs attention: not connected, or a problem. */
function PhoneStrip({ phones, onSettings }: { phones: PhoneDevice[]; onSettings: () => void }) {
  const away = phones.filter((p) => p.status !== 'connected');
  if (away.length === 0) return null;
  return (
    <div className="mx-3 mb-2 flex flex-col gap-1">
      {away.map((p) => (
        <button
          key={p.id}
          type="button"
          onClick={onSettings}
          className="flex items-start gap-2 rounded-lg bg-foreground/[0.05] px-2.5 py-2 text-left text-xs text-muted-foreground hover:bg-foreground/[0.08] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          <Smartphone className={cn('mt-0.5 size-3.5 shrink-0', p.error && 'text-destructive')} aria-hidden />
          <span className="min-w-0">
            <span className="font-medium text-foreground">{p.name}</span>{' '}
            {p.status === 'connecting' ? 'is connecting…' : p.error ?? 'isn’t connected.'}
          </span>
        </button>
      ))}
    </div>
  );
}

function Shell({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex h-full flex-col bg-background text-foreground">
      <WindowDragRegion className="flex h-13 shrink-0 items-center justify-end px-3">
        <WindowControls />
      </WindowDragRegion>
      {children}
    </div>
  );
}

function Empty({ icon: Icon, title, children }: { icon: typeof Smartphone; title: string; children: React.ReactNode }) {
  return (
    <div className="grid flex-1 place-items-center p-8">
      <div className="flex max-w-sm flex-col items-center text-center">
        <div className="mb-5 grid size-20 place-items-center rounded-3xl bg-gradient-to-b from-emerald-400 to-green-600 text-white shadow-lg">
          <Icon className="size-10" aria-hidden />
        </div>
        <h1 className="font-[family-name:var(--font-title)] text-2xl font-semibold">{title}</h1>
        <div className="mt-2 flex flex-col items-center text-sm text-muted-foreground">{children}</div>
      </div>
    </div>
  );
}

function ToolButton({ label, onClick, children }: { label: string; onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      onClick={onClick}
      className="grid size-8 place-items-center rounded-md text-foreground/80 hover:bg-foreground/[0.08] hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
    >
      {children}
    </button>
  );
}
