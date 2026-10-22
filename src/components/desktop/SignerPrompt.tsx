import { useState, type ReactNode } from 'react';
import type { NostrSigner } from '@nostrify/nostrify';
import { AppWindow, Check, Globe, Loader2, Smartphone, X } from 'lucide-react';
import { nip19 } from 'nostr-tools';
import { EmbeddedEvent, UnreadableEvent } from '@/components/EmbeddedEvent';
import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Label } from '@/components/ui/label';
import { useAuthor } from '@/hooks/useAuthor';
import { formatEventJson, parseDraftEvent } from '@/lib/draftEvent';
import type { NostrBridgeRequest } from '@/lib/nostrBridge';
import {
  questionDescription,
  questionIcon,
  questionTitle,
  ruleLabel,
  type SignerQuestion,
} from '@/lib/signerLabels';
import type { Decision, SignerMethod } from '@/lib/signerPermissions';
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

/** Who is asking: the line under their name is one they can't choose. */
function asker(item: SignerPromptItem): { artwork: ReactNode; subtitle: string } {
  const tile = (icon: ReactNode) => (
    <span className="grid size-10 place-items-center rounded-xl bg-secondary text-muted-foreground">{icon}</span>
  );
  const { request } = item;
  switch (request.source) {
    case 'tab':
      return {
        artwork: tile(<Globe className="size-5" aria-hidden />),
        subtitle: request.origin.startsWith('nsite://') ? 'nsite in the Web Browser' : `Web page · ${request.origin}`,
      };
    case 'app':
      return { artwork: tile(<AppWindow className="size-5" aria-hidden />), subtitle: `Installed app · ${request.origin}` };
    case 'bunker': {
      const image = request.client?.image;
      return {
        artwork: image ? (
          <Avatar className="size-10 rounded-xl">
            <AvatarImage src={image} alt="" />
            <AvatarFallback className="rounded-xl">
              <Smartphone className="size-5" aria-hidden />
            </AvatarFallback>
          </Avatar>
        ) : (
          tile(<Smartphone className="size-5" aria-hidden />)
        ),
        subtitle: 'Connected app (NIP-46)',
      };
    }
  }
}

function AccountLine({ pubkey, label }: { pubkey: string; label: string }) {
  const author = useAuthor(pubkey);
  const metadata = author.data?.metadata;
  const name = metadata?.display_name?.trim() || metadata?.name?.trim() || shortNpub(pubkey);
  return (
    <div className="flex items-center gap-2 text-sm text-muted-foreground">
      <span>{label}</span>
      <Avatar className="size-6">
        <AvatarImage src={metadata?.picture} alt="" />
        <AvatarFallback className="text-xs">{name.slice(0, 1).toUpperCase()}</AvatarFallback>
      </Avatar>
      <span className="min-w-0 truncate font-medium text-foreground">{name}</span>
    </div>
  );
}

function Peer({ label, pubkey }: { label: string; pubkey: unknown }) {
  if (typeof pubkey !== 'string') return null;
  return <AccountLine pubkey={pubkey} label={label} />;
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

  if (state.status === 'done') {
    return (
      <pre className="max-h-48 overflow-auto whitespace-pre-wrap break-words rounded-lg border bg-muted/30 p-3 text-sm">
        {state.text}
      </pre>
    );
  }
  return (
    <div className="space-y-2">
      <Button variant="outline" size="sm" onClick={reveal} disabled={state.status === 'busy'}>
        {state.status === 'busy' && <Loader2 className="size-4 animate-spin" aria-hidden />}
        Show me the message first
      </Button>
      {state.status === 'error' && <p className="text-sm text-destructive">{state.message}</p>}
    </div>
  );
}

/** The question the host is asking right now, as a Din-level dialog. */
export function SignerPrompt({ item, onAnswer }: { item: SignerPromptItem; onAnswer: (answer: PromptAnswer) => void }) {
  const [remember, setRemember] = useState(false);
  const [showJson, setShowJson] = useState(false);
  const [preview, setPreview] = useState<string | undefined>();

  const params = (item.request.params ?? {}) as Record<string, unknown>;
  const { artwork, subtitle } = asker(item);
  const isConnect = item.question === 'connect' || item.question === 'getPublicKey' || item.question === 'getRelays';
  const draft = item.question === 'signEvent' ? parseDraftEvent(params.event) : null;
  const eventJson = item.question === 'signEvent' ? formatEventJson(params.event) : null;

  const answer = (choice: PromptAnswer['choice']) =>
    onAnswer({ choice, remember: !isConnect && remember, preview: choice === 'allow' ? preview : undefined });

  const scope = item.request.source === 'bunker' ? 'this app' : 'this site';

  return (
    <Dialog open onOpenChange={(open) => !open && answer('dismiss')}>
      <DialogContent className="flex max-h-[85vh] flex-col gap-4 sm:max-w-md">
        <DialogHeader className="flex-row items-center gap-3 space-y-0 text-left">
          <span aria-hidden className="shrink-0">{artwork}</span>
          <div className="min-w-0">
            <DialogTitle className="truncate">{item.name}</DialogTitle>
            <DialogDescription className="truncate">{subtitle}</DialogDescription>
          </div>
        </DialogHeader>

        <div className="-mx-6 min-h-0 flex-1 space-y-3 overflow-y-auto px-6">
          <div className="flex items-start gap-3 rounded-lg bg-muted/50 p-3">
            <div className="mt-0.5 shrink-0">{questionIcon(isConnect ? 'getPublicKey' : item.question)}</div>
            <div className="min-w-0">
              <p className="text-sm font-medium">
                {isConnect ? `Connect ${item.name} to your account?` : questionTitle(item.question, item.kind)}
              </p>
              <p className="mt-0.5 text-sm text-muted-foreground">
                {questionDescription(isConnect ? 'getPublicKey' : item.question)}
              </p>
            </div>
          </div>

          {item.question === 'signEvent' &&
            (draft ? <EmbeddedEvent event={draft} pubkey={item.account} /> : <UnreadableEvent kind={item.kind ?? null} />)}

          {(item.question === 'nip04.encrypt' || item.question === 'nip44.encrypt') && (
            <>
              <Peer label="To" pubkey={params.pubkey} />
              <pre className="max-h-48 overflow-auto whitespace-pre-wrap break-words rounded-lg border bg-muted/30 p-3 text-sm">
                {String(params.plaintext ?? '')}
              </pre>
            </>
          )}

          {(item.question === 'nip04.decrypt' || item.question === 'nip44.decrypt') && (
            <>
              <Peer label="From" pubkey={params.pubkey} />
              <DecryptPreview item={item} params={params} onDecrypted={setPreview} />
            </>
          )}

          {eventJson && (
            <Collapsible open={showJson} onOpenChange={setShowJson}>
              <CollapsibleTrigger asChild>
                <button
                  type="button"
                  className="rounded text-sm text-muted-foreground outline-none transition-colors hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
                >
                  {showJson ? 'Hide details' : 'Show details'}
                </button>
              </CollapsibleTrigger>
              <CollapsibleContent>
                <pre className="mt-2 max-h-48 overflow-auto whitespace-pre-wrap break-all rounded-lg border bg-muted/30 p-3 font-mono text-xs">
                  {eventJson}
                </pre>
              </CollapsibleContent>
            </Collapsible>
          )}

          <AccountLine pubkey={item.account} label={isConnect ? 'As' : 'Signing as'} />
        </div>

        {!isConnect && (
          <div className="flex items-center gap-2">
            <Checkbox
              id={`signer-remember-${item.id}`}
              checked={remember}
              onCheckedChange={(checked) => setRemember(checked === true)}
            />
            <Label htmlFor={`signer-remember-${item.id}`} className="cursor-pointer text-sm font-normal text-muted-foreground">
              Remember for “{ruleLabel(item.question as SignerMethod, item.kind)}” on {scope}
            </Label>
          </div>
        )}

        <DialogFooter className="gap-2 sm:justify-between">
          {isConnect && item.request.source === 'tab' ? (
            <>
              <Button variant="ghost" className="text-destructive hover:text-destructive" onClick={() => answer('block')}>
                Block site
              </Button>
              <div className="flex gap-2">
                <Button variant="outline" className="flex-1" onClick={() => answer('deny')}>
                  Not now
                </Button>
                <Button className="flex-1" onClick={() => answer('allow')} autoFocus>
                  Connect
                </Button>
              </div>
            </>
          ) : (
            <div className="flex w-full gap-2">
              <Button variant="outline" className="flex-1" onClick={() => answer('deny')}>
                <X className="size-4" aria-hidden />
                Deny
              </Button>
              <Button className="flex-1" onClick={() => answer('allow')}>
                <Check className="size-4" aria-hidden />
                Allow
              </Button>
            </div>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
