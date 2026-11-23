import { useEffect, useRef, useState } from 'react';
import { Bot, ChevronRight, KeyRound, SquareTerminal } from 'lucide-react';
import { EmbeddedEvent, UnreadableEvent } from '@/components/EmbeddedEvent';
import { Button } from '@/components/ui/button';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { getKindLabel } from '@/lib/kindLabels';
import { formatEventJson, parseDraftEvent } from '@/lib/draftEvent';
import { closeNotification, notify } from '@/lib/notificationCenter';
import {
  getProgramSignerBridge,
  type ProgramSignerDecision,
  type ProgramSignerRequest,
} from '@/lib/programSigner';
import type { PsbtSummary } from '@/shared/bitcoin';
import { formatBtc } from '@/shared/bitcoinAmounts';
import { Message, Person, Transaction } from './SignerPrompt';

/** The question as one sentence, plus a line under it when there's more to say. */
function headline(request: ProgramSignerRequest, psbt: PsbtSummary | null): { title: string; detail?: string } {
  const who = `“${request.program}”`;
  switch (request.method) {
    case 'sign_event':
      return { title: `${who} wants to sign as you`, detail: request.kind !== null ? getKindLabel(request.kind) : undefined };
    case 'nip04_encrypt':
    case 'nip44_encrypt':
      return { title: `${who} wants to encrypt a message as you` };
    case 'nip04_decrypt':
    case 'nip44_decrypt':
      return { title: `${who} wants to read a message sent to you` };
    case 'sign_psbt': {
      const spent = psbt?.spent;
      return {
        title: spent !== undefined && spent > 0 ? `${who} wants to send ${formatBtc(spent)} BTC` : `${who} wants to sign a Bitcoin transaction`,
        detail: 'Once it’s sent, it can’t be taken back.',
      };
    }
    case 'set_active':
      return {
        title: `${who} wants to switch your account`,
        detail: 'Din and every program would then sign as the account below.',
      };
    case 'import_account':
      return { title: `${who} wants to add an account`, detail: 'It gave a key to keep with your others.' };
    case 'generate_account':
      return { title: `${who} wants to create an account` };
    case 'set_password':
      return {
        title: `${who} wants to set the password on your keys`,
        detail: 'You’d need it to unlock them. Allow this only if you started it.',
      };
    default:
      return { title: `${who} wants to use your account` };
  }
}

/** A line for its notification. */
function summary(request: ProgramSignerRequest): string {
  const from = request.via ? ` · from ${request.via}` : '';
  if (request.method === 'sign_event') return `${request.kind !== null ? getKindLabel(request.kind) : 'An event'}${from}`;
  return `${request.command}${from}`.slice(0, 200);
}

function Artwork({ request }: { request: ProgramSignerRequest }) {
  const Icon = request.via === 'Assistant' ? Bot : request.method.endsWith('_account') || request.method === 'set_password' ? KeyRound : SquareTerminal;
  return (
    <span className="grid size-14 place-items-center rounded-2xl bg-secondary text-muted-foreground">
      <Icon className="size-7" aria-hidden />
    </span>
  );
}

/** What a sign_psbt request would do with the account's bitcoin. */
function usePsbt(request: ProgramSignerRequest): PsbtSummary | null {
  const [summary, setSummary] = useState<PsbtSummary | null>(null);
  useEffect(() => {
    const psbt = request.params[0];
    if (request.method !== 'sign_psbt' || typeof psbt !== 'string' || psbt.length > 400_000 || !request.account) return;
    let live = true;
    void import('@/shared/bitcoin')
      .then(({ summarizePsbt }) => summarizePsbt(psbt, request.account!))
      .then((s) => live && setSummary(s))
      .catch(() => {});
    return () => {
      live = false;
    };
  }, [request]);
  return summary;
}

/** One program's request, as a Din-level dialog. */
function ProgramSignerPrompt({
  request,
  onAnswer,
  onDismiss,
}: {
  request: ProgramSignerRequest;
  onAnswer: (decision: ProgramSignerDecision) => void;
  onDismiss: () => void;
}) {
  const psbt = usePsbt(request);
  const { title, detail } = headline(request, psbt);
  const event = request.method === 'sign_event' ? request.params[0] : undefined;
  const draft = event !== undefined ? parseDraftEvent(event) : null;
  const eventJson = event !== undefined ? formatEventJson(event) : null;
  const isEncrypt = request.method === 'nip04_encrypt' || request.method === 'nip44_encrypt';
  const isDecrypt = request.method === 'nip04_decrypt' || request.method === 'nip44_decrypt';
  const where = [request.via && `From ${request.via}`, request.path].filter(Boolean).join(' · ');

  return (
    <Dialog open onOpenChange={(open) => !open && onDismiss()}>
      <DialogContent
        showCloseButton={false}
        className="flex max-h-[85vh] flex-col gap-0 p-0 sm:max-w-sm"
        // Nothing focused to answer with: a program that asks while the user
        // is typing mustn't have their Enter press Allow.
        onOpenAutoFocus={(e) => {
          e.preventDefault();
          (e.currentTarget as HTMLElement).focus();
        }}
      >
        <DialogHeader className="items-center gap-0 px-6 pt-6 text-center sm:text-center">
          <span aria-hidden>
            <Artwork request={request} />
          </span>
          <DialogTitle className="mt-4 text-base leading-snug text-balance">{title}</DialogTitle>
          <DialogDescription className="mt-1 text-balance">{detail ?? where}</DialogDescription>
        </DialogHeader>

        <div className="min-h-0 flex-1 space-y-3 overflow-y-auto px-6 pt-4">
          {request.method === 'sign_event' &&
            (draft && request.account ? <EmbeddedEvent event={draft} pubkey={request.account} /> : <UnreadableEvent kind={request.kind} />)}

          {isEncrypt && (
            <>
              <Person label="To" pubkey={request.params[0]} />
              <Message>{String(request.params[1] ?? '')}</Message>
            </>
          )}

          {isDecrypt && <Person label="From" pubkey={request.params[0]} />}

          {psbt && <Transaction summary={psbt} />}

          {request.method === 'set_active' && <Person label="To" pubkey={request.params[0]} />}

          {request.method !== 'set_active' && request.account && !request.method.endsWith('_account') && (
            <Person label="As" pubkey={request.account} />
          )}

          <Collapsible>
            <CollapsibleTrigger className="group inline-flex items-center gap-1 rounded text-xs text-muted-foreground outline-none transition-colors hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring">
              <ChevronRight className="size-3 transition-transform group-data-[state=open]:rotate-90" aria-hidden />
              Details
            </CollapsibleTrigger>
            <CollapsibleContent className="space-y-2 pt-2">
              {detail && <p className="text-xs break-all text-muted-foreground">{where}</p>}
              <pre className="max-h-32 overflow-auto whitespace-pre-wrap break-all rounded-xl bg-muted/50 p-3 font-mono text-xs">
                {request.command}
              </pre>
              {eventJson && (
                <pre className="max-h-48 overflow-auto whitespace-pre-wrap break-all rounded-xl bg-muted/50 p-3 font-mono text-xs">
                  {eventJson}
                </pre>
              )}
            </CollapsibleContent>
          </Collapsible>
        </div>

        <DialogFooter className="flex-col gap-2 p-6 pt-6 sm:flex-col">
          <Button onClick={() => onAnswer('once')}>{request.method === 'sign_psbt' ? 'Sign' : 'Allow'}</Button>
          {request.canConversation ? (
            <Button variant="secondary" onClick={() => onAnswer('conversation')}>
              Allow for this conversation
            </Button>
          ) : (
            request.canProcess && (
              <Button variant="secondary" onClick={() => onAnswer('process')}>
                Allow until it quits
              </Button>
            )
          )}
          {request.canAlways && (
            <Button variant="secondary" onClick={() => onAnswer('always')}>
              {request.method === 'sign_event' && request.kind !== null
                ? `Always allow ${getKindLabel(request.kind).toLowerCase()}`
                : 'Always allow'}
            </Button>
          )}
          <Button variant="ghost" onClick={() => onAnswer('deny')}>
            Don’t allow
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/**
 * Asks the user about programs that want to sign as them through nostrd
 * (electron/nostrd-approval.mts): ngit in the Terminal, a script the
 * Assistant runs. As with sudo's approvals (AdminPromptHost), each is a
 * notification first, so nothing takes the keyboard while the user types
 * elsewhere; it can be denied right there, and clicking it opens the prompt,
 * which shows what would be signed. Closing the prompt denies it, as
 * sudo's does.
 *
 * Renders nothing outside the Electron shell.
 */
export function ProgramSignerHost() {
  const [requests, setRequests] = useState<ProgramSignerRequest[]>([]);
  const [openId, setOpenId] = useState<number | null>(null);
  const notifications = useRef(new Map<number, string>());

  useEffect(() => {
    const bridge = getProgramSignerBridge();
    if (!bridge) return;
    const shown = notifications.current;
    const add = (request: ProgramSignerRequest) => {
      if (shown.has(request.requestId)) return;
      setRequests((q) => [...q, request]);
      shown.set(
        request.requestId,
        notify({
          source: { name: 'Din', icon: KeyRound },
          title: headline(request, null).title,
          body: summary(request),
          urgency: 'critical',
          actions: [{ id: 'deny', label: 'Don’t allow' }],
          replaceKey: `program-signer:${request.requestId}`,
          onScreenOnly: true,
          onActivate: (action) => {
            if (action === 'deny') void bridge.answer(request.requestId, 'deny').catch(() => {});
            else setOpenId(request.requestId);
          },
        }),
      );
    };
    const offRequest = bridge.onRequest(add);
    const offCancel = bridge.onCancel((requestId) => {
      setRequests((q) => q.filter((r) => r.requestId !== requestId));
      setOpenId((open) => (open === requestId ? null : open));
      const id = shown.get(requestId);
      if (id) closeNotification(id, 'closed');
      shown.delete(requestId);
    });
    // Asked before this desktop was there (it reloaded).
    void bridge.pending().then((list) => list.forEach(add)).catch(() => {});
    return () => {
      offRequest();
      offCancel();
    };
  }, []);

  const current = requests.find((r) => r.requestId === openId) ?? null;
  if (!current) return null;
  return (
    <ProgramSignerPrompt
      key={current.requestId}
      request={current}
      onAnswer={(decision) => {
        // Main settles it, and the cancel that follows takes it off the queue.
        void getProgramSignerBridge()?.answer(current.requestId, decision).catch(() => {});
        setOpenId(null);
      }}
      onDismiss={() => {
        void getProgramSignerBridge()?.answer(current.requestId, 'deny').catch(() => {});
        setOpenId(null);
      }}
    />
  );
}
