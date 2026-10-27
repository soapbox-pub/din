import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Ban, ChevronDown, Copy, Globe, Link2, Loader2, Plus, Smartphone, Unplug, X } from 'lucide-react';
import { cn } from '@/lib/utils';
import { useAppContext } from '@/hooks/useAppContext';
import { useCurrentUser } from '@/hooks/useCurrentUser';
import { useSignerGrants } from '@/hooks/useSignerGrants';
import { useBunkerConnections } from '@/hooks/useBunkerConnections';
import { useToast } from '@/hooks/useToast';
import {
  bunkerErrorMessage,
  getBunkerBridge,
  type BunkerConnection,
  type NostrConnectLink,
} from '@/lib/bunkerBridge';
import { grantRules, type GuardedMethod, type Decision } from '@/lib/signerPermissions';
import { originLabel, ruleLabel } from '@/lib/signerLabels';
import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar';
import { Button } from '@/components/ui/button';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible';
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuTrigger,
} from '@/components/ui/context-menu';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { QRCodeCanvas } from '@/components/ui/qrcode';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';

const relativeTime = new Intl.RelativeTimeFormat(undefined, { numeric: 'auto' });

/** "3 days ago", "just now". */
function ago(ms: number): string {
  const seconds = Math.round((ms - Date.now()) / 1000);
  const steps: [Intl.RelativeTimeFormatUnit, number][] = [
    ['year', 31_536_000],
    ['month', 2_592_000],
    ['week', 604_800],
    ['day', 86_400],
    ['hour', 3600],
    ['minute', 60],
  ];
  for (const [unit, size] of steps) {
    if (Math.abs(seconds) >= size) return relativeTime.format(Math.round(seconds / size), unit);
  }
  return 'just now';
}

interface Rule {
  method: GuardedMethod;
  kind?: number;
  decision: Decision;
}

function summary(rules: Rule[]): string {
  if (rules.length === 0) return 'Asks before signing anything';
  const allowed = rules.filter((r) => r.decision === 'allow').length;
  const denied = rules.length - allowed;
  return [allowed && `${allowed} allowed without asking`, denied && `${denied} always refused`].filter(Boolean).join(' · ');
}

function RuleList({ rules, onRevoke }: { rules: Rule[]; onRevoke: (rule: Rule) => void }) {
  if (rules.length === 0) return null;
  return (
    <ul className="space-y-1">
      {rules.map((rule) => (
        <ContextMenu key={`${rule.method}:${rule.kind ?? ''}`}>
          <ContextMenuTrigger asChild>
            <li className="flex items-center gap-2 rounded-md px-2 py-1 text-sm hover:bg-foreground/5">
              <span
                className={cn(
                  'shrink-0 rounded px-1.5 py-0.5 text-xs font-medium',
                  rule.decision === 'allow'
                    ? 'bg-emerald-500/15 text-emerald-700 dark:text-emerald-300'
                    : 'bg-destructive/15 text-destructive',
                )}
              >
                {rule.decision === 'allow' ? 'Allow' : 'Deny'}
              </span>
              <span className="min-w-0 flex-1 truncate">{ruleLabel(rule.method, rule.kind)}</span>
              <button
                type="button"
                aria-label={`Forget: ${ruleLabel(rule.method, rule.kind)}`}
                onClick={() => onRevoke(rule)}
                className="grid size-6 shrink-0 place-items-center rounded text-muted-foreground hover:bg-foreground/10 hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              >
                <X className="size-3.5" aria-hidden />
              </button>
            </li>
          </ContextMenuTrigger>
          <ContextMenuContent>
            <ContextMenuItem onSelect={() => onRevoke(rule)}>
              <X aria-hidden />
              Forget
            </ContextMenuItem>
          </ContextMenuContent>
        </ContextMenu>
      ))}
    </ul>
  );
}

function Row({
  icon,
  title,
  subtitle,
  menu,
  children,
}: {
  icon: React.ReactNode;
  title: string;
  subtitle: string;
  /** The row's right-click menu items. */
  menu: React.ReactNode;
  children: React.ReactNode;
}) {
  const [open, setOpen] = useState(false);
  return (
    <Collapsible open={open} onOpenChange={setOpen} className="rounded-md border bg-muted/20">
      <ContextMenu>
        <ContextMenuTrigger asChild>
          <CollapsibleTrigger asChild>
            <button
              type="button"
              className="flex w-full items-center gap-3 rounded-md p-3 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            >
              <span aria-hidden className="shrink-0">{icon}</span>
              <span className="min-w-0 flex-1">
                <span className="block truncate text-sm font-medium text-foreground">{title}</span>
                <span className="block truncate text-xs text-muted-foreground">{subtitle}</span>
              </span>
              <ChevronDown className={cn('size-4 shrink-0 text-muted-foreground transition-transform', open && 'rotate-180')} aria-hidden />
            </button>
          </CollapsibleTrigger>
        </ContextMenuTrigger>
        <ContextMenuContent>
          <ContextMenuItem onSelect={() => setOpen(!open)}>
            <ChevronDown className={cn(open && 'rotate-180')} aria-hidden />
            {open ? 'Hide details' : 'Show details'}
          </ContextMenuItem>
          <ContextMenuSeparator />
          {menu}
        </ContextMenuContent>
      </ContextMenu>
      <CollapsibleContent className="space-y-3 border-t border-border/60 p-3">{children}</CollapsibleContent>
    </Collapsible>
  );
}

function Tile({ children }: { children: React.ReactNode }) {
  return <span className="grid size-9 place-items-center rounded-lg bg-secondary text-muted-foreground">{children}</span>;
}

function useCopyLink() {
  const { toast } = useToast();
  return (uri: string) =>
    navigator.clipboard.writeText(uri).then(
      () => toast({ title: 'Link copied' }),
      () => toast({ title: "Couldn't copy the link", variant: 'destructive' }),
    );
}

function CopyLink({ uri }: { uri: string }) {
  const copy = useCopyLink();
  return (
    <div className="flex items-center gap-2">
      <code className="min-w-0 flex-1 truncate rounded bg-muted px-2 py-1 font-mono text-xs">{uri}</code>
      <Button variant="outline" size="sm" onClick={() => copy(uri)}>
        <Copy className="size-4" aria-hidden />
        Copy
      </Button>
    </div>
  );
}

/** A link for an app to connect with: a QR code for a phone, and the text. */
function BunkerLinkView({ connection }: { connection: BunkerConnection }) {
  if (!connection.uri) return null;
  return (
    <div className="space-y-3">
      <div className="mx-auto w-fit rounded-xl bg-white p-3">
        <QRCodeCanvas value={connection.uri} size={200} />
      </div>
      <CopyLink uri={connection.uri} />
      <p className="text-xs text-muted-foreground">
        The link works for one app. Anyone who has it can ask to use your account, so only give it to the app you're connecting.
      </p>
    </div>
  );
}

function ConnectAppDialog({
  open,
  onOpenChange,
  initialLink,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  initialLink: string;
}) {
  const { user } = useCurrentUser();
  const { config } = useAppContext();
  const connections = useBunkerConnections();
  const [tab, setTab] = useState(initialLink ? 'paste' : 'show');
  const [created, setCreated] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [link, setLink] = useState(initialLink);
  const [error, setError] = useState<string | null>(null);
  const [accepting, setAccepting] = useState(false);
  const bridge = getBunkerBridge();

  const trimmed = link.trim();
  const parse = useQuery({
    queryKey: ['nostrconnect-link', trimmed],
    queryFn: () => bridge!.parse(trimmed),
    enabled: Boolean(bridge && trimmed),
    retry: false,
  });
  const parsed: NostrConnectLink | null = trimmed ? (parse.data ?? null) : null;
  const shownError = error ?? (trimmed && parse.error ? bunkerErrorMessage(parse.error) : null);

  if (!bridge || !user) return null;
  const connection = connections?.find((c) => c.id === created) ?? null;

  const createLink = async () => {
    const relays = config.relayMetadata.relays;
    const write = relays.filter((r) => r.write).map((r) => r.url);
    setCreating(true);
    try {
      const c = await bridge.create({ account: user.pubkey, relays: write.length ? write : relays.map((r) => r.url) });
      setCreated(c.id);
    } catch (e) {
      setError(bunkerErrorMessage(e));
    } finally {
      setCreating(false);
    }
  };

  const accept = async () => {
    setAccepting(true);
    try {
      await bridge.accept({ account: user.pubkey, uri: link.trim() });
      onOpenChange(false);
    } catch (e) {
      setError(bunkerErrorMessage(e));
    } finally {
      setAccepting(false);
    }
  };

  const perms = parsed ? grantRules(parsed.grants) : [];

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Connect an app</DialogTitle>
          <DialogDescription>
            Apps on your phone or other computers can use your Nostr account through Din (NIP-46). Din asks you before they sign or decrypt anything.
          </DialogDescription>
        </DialogHeader>
        <Tabs value={tab} onValueChange={setTab}>
          <TabsList className="grid w-full grid-cols-2">
            <TabsTrigger value="show">Give the app a link</TabsTrigger>
            <TabsTrigger value="paste">Paste the app's link</TabsTrigger>
          </TabsList>
          <TabsContent value="show" className="space-y-3 pt-2">
            {connection?.uri ? (
              <BunkerLinkView connection={connection} />
            ) : connection ? (
              <p className="text-sm text-muted-foreground">Connected. You can close this.</p>
            ) : (
              <>
                <p className="text-sm text-muted-foreground">
                  Make a bunker:// link to scan or paste into the app's “log in with a remote signer” option.
                </p>
                <Button onClick={createLink} disabled={creating}>
                  {creating && <Loader2 className="size-4 animate-spin" aria-hidden />}
                  Make a link
                </Button>
              </>
            )}
          </TabsContent>
          <TabsContent value="paste" className="space-y-3 pt-2">
            <div className="space-y-1.5">
              <Label htmlFor="nostrconnect-link">nostrconnect:// link</Label>
              <Input
                id="nostrconnect-link"
                value={link}
                onChange={(e) => {
                  setLink(e.target.value);
                  setError(null);
                }}
                placeholder="nostrconnect://…"
                autoComplete="off"
                spellCheck={false}
                aria-invalid={Boolean(shownError)}
              />
            </div>
            {parsed && (
              <div className="space-y-2 rounded-md border bg-muted/20 p-3 text-sm">
                <div className="flex items-center gap-3">
                  <Avatar className="size-9 rounded-lg">
                    {parsed.image && <AvatarImage src={parsed.image} alt="" />}
                    <AvatarFallback className="rounded-lg">
                      <Smartphone className="size-4" aria-hidden />
                    </AvatarFallback>
                  </Avatar>
                  <div className="min-w-0">
                    <p className="truncate font-medium">{parsed.name || 'An app'}</p>
                    <p className="truncate text-xs text-muted-foreground">{parsed.url ?? 'It gave no website'}</p>
                  </div>
                </div>
                <p className="text-xs text-muted-foreground">
                  {perms.length > 0
                    ? `Connecting allows it, without asking: ${perms.map((p) => ruleLabel(p.method, p.kind)).join(', ')}.`
                    : 'It will ask before signing or decrypting anything.'}
                </p>
              </div>
            )}
            {shownError && <p className="text-sm text-destructive">{shownError}</p>}
          </TabsContent>
        </Tabs>
        {tab === 'paste' && (
          <DialogFooter>
            <Button variant="outline" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button onClick={accept} disabled={!parsed || accepting}>
              {accepting && <Loader2 className="size-4 animate-spin" aria-hidden />}
              Connect
            </Button>
          </DialogFooter>
        )}
      </DialogContent>
    </Dialog>
  );
}

/**
 * Settings → Connected apps: every site, installed app, and remote (NIP-46)
 * app that may use the signed-in account, with what each may do without
 * asking. Things can only be taken away here; granting happens in the prompt,
 * where the user can see what is being asked.
 */
export function ConnectedAppsSection({ nostrconnect, nonce }: { nostrconnect?: string; nonce?: unknown }) {
  const { user } = useCurrentUser();
  const { grants, disconnect, revoke } = useSignerGrants();
  const connections = useBunkerConnections();
  const bridge = getBunkerBridge();
  const copyLink = useCopyLink();
  const [connecting, setConnecting] = useState(Boolean(nostrconnect));
  const [dialogKey, setDialogKey] = useState(0);
  const [initialLink, setInitialLink] = useState(nostrconnect ?? '');

  // A nostrconnect:// link opened from a page: show it, connect nothing yet.
  const linkRequest = nostrconnect ? `${String(nonce)}:${nostrconnect}` : null;
  const [seenRequest, setSeenRequest] = useState(linkRequest);
  if (linkRequest !== seenRequest) {
    setSeenRequest(linkRequest);
    if (nostrconnect) {
      setInitialLink(nostrconnect);
      setDialogKey((k) => k + 1);
      setConnecting(true);
    }
  }

  const sites = Object.entries(grants).sort(([, a], [, b]) => b.lastUsed - a.lastUsed);
  const remote = (connections ?? [])
    .filter((c) => c.account === user?.pubkey)
    .sort((a, b) => (b.lastUsed ?? b.createdAt) - (a.lastUsed ?? a.createdAt));

  return (
    <section className="mx-auto flex max-w-2xl flex-col gap-4 p-4">
      <header className="flex items-center justify-between gap-2">
        <h2 className="text-lg font-semibold text-foreground">Connected apps</h2>
        {bridge && user && (
          <Button
            size="sm"
            onClick={() => {
              setInitialLink('');
              setDialogKey((k) => k + 1);
              setConnecting(true);
            }}
          >
            <Plus className="size-4" aria-hidden />
            Connect an app
          </Button>
        )}
      </header>

      {!user ? (
        <div className="rounded-xl border border-dashed border-border px-8 py-12 text-center">
          <p className="mx-auto max-w-sm text-sm text-muted-foreground">Log in to connect sites and apps to your Nostr account.</p>
        </div>
      ) : (
        <>
          <p className="text-sm text-muted-foreground">
            Sites in the Web Browser, installed apps, and apps connected with a link can use your Nostr account through Din. Din asks before they sign, encrypt, or decrypt anything, unless you told it to remember.
          </p>

          <div className="space-y-2">
            <h3 className="text-sm font-medium text-foreground">Sites and installed apps</h3>
            {sites.length === 0 ? (
              <div className="rounded-xl border border-dashed border-border px-8 py-8 text-center">
                <p className="mx-auto max-w-sm text-sm text-muted-foreground">No site has connected to your account yet.</p>
              </div>
            ) : (
              sites.map(([origin, grant]) => {
                const rules = grantRules(grant);
                const blocked = grant.status === 'blocked';
                return (
                  <Row
                    key={origin}
                    icon={<Tile>{blocked ? <Ban className="size-4" /> : <Globe className="size-4" />}</Tile>}
                    title={originLabel(origin)}
                    subtitle={`${blocked ? 'Blocked' : summary(rules)} · ${ago(grant.lastUsed)}`}
                    menu={
                      <ContextMenuItem
                        variant={blocked ? 'default' : 'destructive'}
                        onSelect={() => disconnect(origin)}
                      >
                        {blocked ? <Ban aria-hidden /> : <Unplug aria-hidden />}
                        {blocked ? 'Unblock' : 'Disconnect'}
                      </ContextMenuItem>
                    }
                  >
                    <p className="break-all text-xs text-muted-foreground">{origin}</p>
                    {!blocked && <RuleList rules={rules} onRevoke={(r) => revoke(origin, r.method, r.kind)} />}
                    <Button variant="outline" size="sm" onClick={() => disconnect(origin)}>
                      {blocked ? 'Unblock' : 'Disconnect'}
                    </Button>
                  </Row>
                );
              })
            )}
          </div>

          {bridge && (
            <div className="space-y-2 border-t border-border/60 pt-4">
              <h3 className="text-sm font-medium text-foreground">Apps connected with a link</h3>
              {connections === null ? (
                <div className="h-14 animate-pulse rounded-md bg-muted/40" />
              ) : remote.length === 0 ? (
                <div className="rounded-xl border border-dashed border-border px-8 py-8 text-center">
                  <p className="mx-auto max-w-sm text-sm text-muted-foreground">
                    No apps yet. Use “Connect an app” to sign in to an app on another device with this account.
                  </p>
                </div>
              ) : (
                remote.map((c) => {
                  const rules = grantRules(c.grants);
                  const waiting = !c.client;
                  return (
                    <Row
                      key={c.id}
                      icon={
                        c.image ? (
                          <Avatar className="size-9 rounded-lg">
                            <AvatarImage src={c.image} alt="" />
                            <AvatarFallback className="rounded-lg">
                              <Smartphone className="size-4" />
                            </AvatarFallback>
                          </Avatar>
                        ) : (
                          <Tile>{waiting ? <Link2 className="size-4" /> : <Smartphone className="size-4" />}</Tile>
                        )
                      }
                      title={waiting ? 'Waiting for an app to connect' : c.name || 'An app'}
                      subtitle={
                        waiting
                          ? `Link made ${ago(c.createdAt)}`
                          : `${summary(rules)} · ${ago(c.lastUsed ?? c.createdAt)}`
                      }
                      menu={
                        <>
                          {waiting && c.uri && (
                            <ContextMenuItem onSelect={() => c.uri && copyLink(c.uri)}>
                              <Copy aria-hidden />
                              Copy link
                            </ContextMenuItem>
                          )}
                          <ContextMenuItem variant="destructive" onSelect={() => bridge.remove(c.id)}>
                            {waiting ? <X aria-hidden /> : <Unplug aria-hidden />}
                            {waiting ? 'Delete link' : 'Disconnect'}
                          </ContextMenuItem>
                        </>
                      }
                    >
                      {c.url && <p className="break-all text-xs text-muted-foreground">{c.url}</p>}
                      <p className="break-all text-xs text-muted-foreground">Relays: {c.relays.join(', ')}</p>
                      {waiting && <BunkerLinkView connection={c} />}
                      <RuleList rules={rules} onRevoke={(r) => bridge.revoke({ id: c.id, method: r.method, kind: r.kind })} />
                      <Button variant="outline" size="sm" onClick={() => bridge.remove(c.id)}>
                        {waiting ? 'Delete link' : 'Disconnect'}
                      </Button>
                    </Row>
                  );
                })
              )}
            </div>
          )}
        </>
      )}

      {connecting && (
        <ConnectAppDialog key={dialogKey} open={connecting} onOpenChange={setConnecting} initialLink={initialLink} />
      )}
    </section>
  );
}
