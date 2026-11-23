import { useEffect, useState, type KeyboardEvent } from 'react';
import { Bot, ChevronRight, KeyRound, SquareTerminal } from 'lucide-react';
import { EmbeddedEvent, UnreadableEvent } from '@/components/EmbeddedEvent';
import { Button } from '@/components/ui/button';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible';
import { WindowControls, WindowDragRegion } from '@/components/desktop/WindowHeader';
import { useWindowActions } from '@/contexts/WindowManagerContext';
import { useOwnWindowHeader } from '@/contexts/WindowFrameContext';
import { useWindowTitle } from '@/contexts/WindowTitleContext';
import type { AppComponentProps } from '@/lib/apps';
import { formatEventJson, parseDraftEvent } from '@/lib/draftEvent';
import { getKindLabel } from '@/lib/kindLabels';
import { getProgramSignerBridge, type ProgramSignerDecision, type ProgramSignerRequest } from '@/lib/programSigner';
import { getProgramSignerRequest } from '@/lib/programSignerWindows';
import { ContentPane } from '@/shared/appChrome';
import type { PsbtSummary } from '@/shared/bitcoin';
import { headline } from '../programSignerText';
import { Message, Person, Transaction } from '../SignerPrompt';

function Artwork({ request }: { request: ProgramSignerRequest }) {
  const Icon = request.via === 'Assistant' ? Bot : request.method.endsWith('_account') || request.method === 'set_password' ? KeyRound : SquareTerminal;
  return (
    <span aria-hidden className="grid size-14 place-items-center rounded-2xl bg-secondary text-muted-foreground">
      <Icon className="size-7" />
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

/** How many windows show each request (one, but for a remount). */
const mounted = new Map<number, number>();

function answer(requestId: number, decision: ProgramSignerDecision): void {
  void getProgramSignerBridge()?.answer(requestId, decision).catch(() => {});
}

/**
 * A program asking to sign as the user (PROGRAM_SIGNER_APP_ID), one window
 * per request, opened from its notification by ProgramSignerHost: a window,
 * not a dialog, so it can be moved aside while the user looks at what asked,
 * and clicking elsewhere doesn't answer it. Answering closes it; closing it
 * or Escape is Don't allow, as closing sudo's prompt is. The host closes it
 * when the request is settled some other way (the notification's buttons, the
 * program quitting, nostrd giving up).
 */
export function ProgramSignerWindow({ windowId, params }: AppComponentProps) {
  const { close } = useWindowActions();
  const requestId = typeof params?.request === 'number' ? params.request : null;
  // Read once: answering forgets it, while the window plays its close.
  const [request] = useState(() => (requestId !== null ? getProgramSignerRequest(requestId) : undefined));
  useOwnWindowHeader();
  useWindowTitle(request ? `“${request.program}”` : 'Signing request');

  // However the window goes (its close button, the Dock's Quit), the program
  // hears no. Deferred, so a remount doesn't count as closing; main ignores a
  // request that's already settled.
  useEffect(() => {
    if (requestId === null) return;
    mounted.set(requestId, (mounted.get(requestId) ?? 0) + 1);
    return () => {
      mounted.set(requestId, (mounted.get(requestId) ?? 1) - 1);
      window.setTimeout(() => {
        if ((mounted.get(requestId) ?? 0) > 0) return;
        mounted.delete(requestId);
        answer(requestId, 'deny');
      }, 0);
    };
  }, [requestId]);

  return (
    <div className="flex h-full w-full flex-col text-foreground">
      <WindowDragRegion className="flex h-12 shrink-0 items-center gap-2 pr-3 pl-4">
        <h1 className="min-w-0 flex-1 truncate font-[family-name:var(--font-title)] text-sm font-medium text-foreground/90">
          {request ? `Signing request from “${request.program}”` : 'Signing request'}
        </h1>
        <WindowControls />
      </WindowDragRegion>
      <ContentPane className="ml-2">
        {request ? (
          <Prompt
            request={request}
            onAnswer={(decision) => {
              answer(request.requestId, decision);
              close(windowId);
            }}
          />
        ) : (
          <p className="p-6 text-sm text-muted-foreground">Nothing to answer: whatever asked has stopped waiting.</p>
        )}
      </ContentPane>
    </div>
  );
}

function Prompt({ request, onAnswer }: { request: ProgramSignerRequest; onAnswer: (decision: ProgramSignerDecision) => void }) {
  const psbt = usePsbt(request);
  const { title, detail } = headline(request, psbt);
  const event = request.method === 'sign_event' ? request.params[0] : undefined;
  const draft = event !== undefined ? parseDraftEvent(event) : null;
  const eventJson = event !== undefined ? formatEventJson(event) : null;
  const isEncrypt = request.method === 'nip04_encrypt' || request.method === 'nip44_encrypt';
  const isDecrypt = request.method === 'nip04_decrypt' || request.method === 'nip44_decrypt';
  const where = [request.via && `From ${request.via}`, request.path].filter(Boolean).join(' · ');
  const kindLabel = request.method === 'sign_event' && request.kind !== null ? getKindLabel(request.kind).toLowerCase() : null;

  const onKeyDown = (e: KeyboardEvent) => {
    if (e.key !== 'Escape') return;
    e.preventDefault();
    onAnswer('deny');
  };

  return (
    // Nothing is focused to answer with: Enter mustn't press Allow.
    <div className="flex min-h-0 flex-1 flex-col outline-none" tabIndex={-1} onKeyDown={onKeyDown}>
      <div className="flex min-h-0 flex-1 flex-col overflow-y-auto px-6 pt-6 [&>*]:shrink-0">
        <header className="flex flex-col items-center text-center">
          <Artwork request={request} />
          <h2 className="mt-4 text-base leading-snug font-semibold text-balance">{title}</h2>
          <p className="mt-1 text-sm text-balance text-muted-foreground">{detail ?? where}</p>
        </header>

        <div className="space-y-3 pt-4">
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
            <CollapsibleTrigger className="group inline-flex items-center gap-1 rounded text-xs text-muted-foreground outline-none transition-colors hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/60">
              <ChevronRight className="size-3 transition-transform group-data-[state=open]:rotate-90" aria-hidden />
              Details
            </CollapsibleTrigger>
            <CollapsibleContent className="space-y-2 pt-2">
              {detail && <p className="text-xs break-all text-muted-foreground">{where}</p>}
              <pre className="max-h-32 overflow-auto rounded-xl bg-muted/50 p-3 font-mono text-xs break-all whitespace-pre-wrap">
                {request.command}
              </pre>
              {eventJson && (
                <pre className="max-h-48 overflow-auto rounded-xl bg-muted/50 p-3 font-mono text-xs break-all whitespace-pre-wrap">
                  {eventJson}
                </pre>
              )}
            </CollapsibleContent>
          </Collapsible>
        </div>
      </div>

      <footer className="flex shrink-0 flex-col gap-2 p-6">
        <Button className="rounded-full" onClick={() => onAnswer('once')}>
          {request.method === 'sign_psbt' ? 'Sign' : 'Allow'}
        </Button>
        {request.canConversation ? (
          <Button variant="secondary" className="rounded-full" onClick={() => onAnswer('conversation')}>
            Allow for this conversation
          </Button>
        ) : (
          request.canProcess && (
            <Button variant="secondary" className="rounded-full" onClick={() => onAnswer('process')}>
              Allow until it quits
            </Button>
          )
        )}
        {request.canAlwaysProgram && (
          <Button
            variant="secondary"
            className="rounded-full"
            title={`“${request.program}” won’t ask again to sign, encrypt or decrypt anything as you`}
            onClick={() => onAnswer('program')}
          >
            Always allow “{request.program}”
          </Button>
        )}
        {request.canAlways && (
          <Button variant="secondary" className="rounded-full" onClick={() => onAnswer('always')}>
            {kindLabel ? `Always allow ${kindLabel} only` : 'Always allow'}
          </Button>
        )}
        <Button variant="ghost" className="rounded-full" onClick={() => onAnswer('deny')}>
          Don’t allow
        </Button>
      </footer>
    </div>
  );
}
