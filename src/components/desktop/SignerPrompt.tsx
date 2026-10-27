import { useState, type ReactNode } from 'react';
import type { NostrSigner } from '@nostrify/nostrify';
import { AppWindow, ChevronRight, Globe, Loader2, Smartphone } from 'lucide-react';
import { nip19 } from 'nostr-tools';
import { EmbeddedEvent, UnreadableEvent } from '@/components/EmbeddedEvent';
import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar';
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
import { useAuthor } from '@/hooks/useAuthor';
import { useCurrentUser } from '@/hooks/useCurrentUser';
import { getKindLabel } from '@/lib/kindLabels';
import { formatEventJson, parseDraftEvent } from '@/lib/draftEvent';
import type { NostrBridgeRequest } from '@/lib/nostrBridge';
import type { SignerQuestion } from '@/lib/signerLabels';
import type { Decision } from '@/lib/signerPermissions';
import { middleEllipsis } from '@/lib/utils';

/** One question for the user, queued by NostrBridgeHost. */
export interface SignerPromptItem {
  id: number;
  request: NostrBridgeRequest;
  question: SignerQuestion;
  /** The event kind, for signEvent. */
  kind?: number;
  /** What to call the asker (never its own claim for a web page). */
  name: string;
  /** The account that would sign. */
  account: string;
  signer: NostrSigner;
  /** What the grants say now; anything but 'ask' settles the question unshown. */
  recheck: () => Decision | 'ask';
  resolve: (answer: PromptAnswer) => void;
}

export interface PromptAnswer {
  /** `dismiss`: closed without answering. `block`: refuse the site everything. */
  choice: 'allow' | 'deny' | 'block' | 'dismiss';
  remember: boolean;
  /** A decrypted message the user already looked at, handed on as the result. */
  preview?: string;
}

function shortNpub(pubkey: string): string {
  try {
    return middleEllipsis(nip19.npubEncode(pubkey), 20);
  } catch {
    return middleEllipsis(pubkey, 20);
  }
}

/** The asker's tile. A web page or installed app is named by its origin, which it can't choose. */
function Artwork({ request }: { request: NostrBridgeRequest }) {
  const tile = (icon: ReactNode) => (
    <span className="grid size-14 place-items-center rounded-2xl bg-secondary text-muted-foreground">{icon}</span>
  );
  switch (request.source) {
    case 'tab':
      return tile(<Globe className="size-7" aria-hidden />);
    case 'app':
      return tile(<AppWindow className="size-7" aria-hidden />);
    case 'bunker': {
      const image = request.client?.image;
      if (!image) return tile(<Smartphone className="size-7" aria-hidden />);
      return (
        <Avatar className="size-14 rounded-2xl">
          <AvatarImage src={image} alt="" />
          <AvatarFallback className="rounded-2xl">
            <Smartphone className="size-7" aria-hidden />
          </AvatarFallback>
        </Avatar>
      );
    }
  }
}

/** The question as one sentence, plus a quiet line under it only when there is something to add. */
function headline(item: SignerPromptItem, isConnect: boolean): { title: string; detail?: string } {
  const who = `“${item.name}”`;
  if (isConnect) {
    return item.question === 'connect'
      ? { title: `Connect ${who}?`, detail: 'It can ask to sign as you from wherever it runs, until you disconnect it.' }
      : { title: `Connect ${who}?`, detail: 'It will see your public key. It still has to ask before signing anything.' };
  }
  switch (item.question) {
    case 'signEvent':
      return { title: `${who} wants to sign as you`, detail: item.kind !== undefined ? getKindLabel(item.kind) : undefined };
    case 'nip04.encrypt':
    case 'nip44.encrypt':
      return { title: `${who} wants to encrypt a message as you` };
    default:
      return { title: `${who} wants to read a message sent to you` };
  }
}

function Person({ label, pubkey }: { label: string; pubkey: unknown }) {
  const author = useAuthor(typeof pubkey === 'string' ? pubkey : undefined);
  if (typeof pubkey !== 'string') return null;
  const metadata = author.data?.metadata;
  const name = metadata?.display_name?.trim() || metadata?.name?.trim() || shortNpub(pubkey);
  return (
    <div className="flex items-center gap-2 text-sm text-muted-foreground">
      <span>{label}</span>
      <Avatar className="size-5">
        <AvatarImage src={metadata?.picture} alt="" />
        <AvatarFallback className="text-[10px]">{name.slice(0, 1).toUpperCase()}</AvatarFallback>
      </Avatar>
      <span className="min-w-0 truncate font-medium text-foreground">{name}</span>
    </div>
  );
}

function Message({ children }: { children: ReactNode }) {
  return (
    <p className="max-h-48 overflow-auto whitespace-pre-wrap break-words rounded-xl bg-muted/50 px-3 py-2.5 text-sm">
      {children}
    </p>
  );
}

/** What a decrypt would reveal, shown only when the user asks to see it. */
function DecryptPreview({
  item,
  params,
  onDecrypted,
}: {
  item: SignerPromptItem;
  params: Record<string, unknown>;
  onDecrypted: (plaintext: string) => void;
}) {
  const [state, setState] = useState<{ status: 'idle' | 'busy' } | { status: 'done'; text: string } | { status: 'error'; message: string }>({ status: 'idle' });
  const nip = item.question.startsWith('nip04') ? 'nip04' : 'nip44';

  const reveal = async () => {
    setState({ status: 'busy' });
    try {
      const impl = item.signer[nip];
      if (!impl) throw new Error(`This account can't use ${nip.toUpperCase()}`);
      const text = await impl.decrypt(String(params.pubkey), String(params.ciphertext));
      setState({ status: 'done', text });
      onDecrypted(text);
    } catch (error) {
      setState({ status: 'error', message: error instanceof Error ? error.message : String(error) });
    }
  };

  if (state.status === 'done') return <Message>{state.text}</Message>;
  return (
    <div className="space-y-2">
      <button
        type="button"
        onClick={reveal}
        disabled={state.status === 'busy'}
        className="inline-flex items-center gap-1.5 rounded text-sm font-medium text-primary outline-none hover:underline focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50"
      >
        {state.status === 'busy' && <Loader2 className="size-3.5 animate-spin" aria-hidden />}
        Show message first
      </button>
      {state.status === 'error' && <p className="text-sm text-destructive">{state.message}</p>}
    </div>
  );
}

/** The question the host is asking right now, as a Din-level dialog. */
export function SignerPrompt({ item, onAnswer }: { item: SignerPromptItem; onAnswer: (answer: PromptAnswer) => void }) {
  const { users } = useCurrentUser();
  const [preview, setPreview] = useState<string | undefined>();

  const params = (item.request.params ?? {}) as Record<string, unknown>;
  const isConnect = item.question === 'connect' || item.question === 'getPublicKey' || item.question === 'getRelays';
  const draft = item.question === 'signEvent' ? parseDraftEvent(params.event) : null;
  const eventJson = item.question === 'signEvent' ? formatEventJson(params.event) : null;
  const { title, detail } = headline(item, isConnect);

  const answer = (choice: PromptAnswer['choice'], remember = false) =>
    onAnswer({ choice, remember, preview: choice === 'allow' ? preview : undefined });

  const isEncrypt = item.question === 'nip04.encrypt' || item.question === 'nip44.encrypt';
  const isDecrypt = item.question === 'nip04.decrypt' || item.question === 'nip44.decrypt';
  // A signed event names its author in its own card; otherwise the account is
  // worth a line only when there is more than one it could be.
  const showAccount = item.question !== 'signEvent' && users.length > 1;
  const hasBody = item.question === 'signEvent' || isEncrypt || isDecrypt || showAccount;

  return (
    <Dialog open onOpenChange={(open) => !open && answer('dismiss')}>
      <DialogContent
        showCloseButton={false}
        className="flex max-h-[85vh] flex-col gap-0 p-0 sm:max-w-sm"
        onOpenAutoFocus={(event) => {
          if (isConnect) return;
          event.preventDefault();
          (event.currentTarget as HTMLElement).focus();
        }}
      >
        <DialogHeader className="items-center gap-0 px-6 pt-6 text-center sm:text-center">
          <span aria-hidden>
            <Artwork request={item.request} />
          </span>
          <DialogTitle className="mt-4 text-base leading-snug text-balance">{title}</DialogTitle>
          <DialogDescription className={detail ? 'mt-1 text-balance' : 'sr-only'}>
            {detail ?? (item.request.source === 'bunker' ? 'Connected with Nostr Connect' : item.request.origin)}
          </DialogDescription>
        </DialogHeader>

        {hasBody && (
          <div className="min-h-0 flex-1 space-y-3 overflow-y-auto px-6 pt-4">
            {item.question === 'signEvent' &&
              (draft ? <EmbeddedEvent event={draft} pubkey={item.account} /> : <UnreadableEvent kind={item.kind ?? null} />)}

            {eventJson && (
              <Collapsible>
                <CollapsibleTrigger className="group inline-flex items-center gap-1 rounded text-xs text-muted-foreground outline-none transition-colors hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring">
                  <ChevronRight className="size-3 transition-transform group-data-[state=open]:rotate-90" aria-hidden />
                  Details
                </CollapsibleTrigger>
                <CollapsibleContent>
                  <pre className="mt-2 max-h-48 overflow-auto whitespace-pre-wrap break-all rounded-xl bg-muted/50 p-3 font-mono text-xs">
                    {eventJson}
                  </pre>
                </CollapsibleContent>
              </Collapsible>
            )}

            {isEncrypt && (
              <>
                <Person label="To" pubkey={params.pubkey} />
                <Message>{String(params.plaintext ?? '')}</Message>
              </>
            )}

            {isDecrypt && (
              <>
                <Person label="From" pubkey={params.pubkey} />
                <DecryptPreview item={item} params={params} onDecrypted={setPreview} />
              </>
            )}

            {showAccount && <Person label="As" pubkey={item.account} />}
          </div>
        )}

        <DialogFooter className="flex-col gap-2 p-6 pt-6 sm:flex-col">
          {isConnect ? (
            <>
              <Button onClick={() => answer('allow')} autoFocus>
                Connect
              </Button>
              <Button variant="secondary" onClick={() => answer('deny')}>
                Not now
              </Button>
              {item.request.source === 'tab' && (
                <Button variant="ghost" className="text-destructive hover:text-destructive" onClick={() => answer('block')}>
                  Block this site
                </Button>
              )}
            </>
          ) : (
            <>
              <Button onClick={() => answer('allow')}>Allow</Button>
              <Button variant="secondary" onClick={() => answer('allow', true)}>
                Always allow
              </Button>
              <Button variant="ghost" onClick={() => answer('deny')}>
                Don’t allow
              </Button>
            </>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
