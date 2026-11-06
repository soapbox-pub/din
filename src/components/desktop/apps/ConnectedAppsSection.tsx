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
import { useSiteIdentity } from '@/hooks/useSiteIdentity';
import { grantRules, type GuardedMethod, type Decision, type SiteGrant } from '@/lib/signerPermissions';
import { ruleLabel } from '@/lib/signerLabels';
import { AppIcon } from '@/components/desktop/AppIcon';
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
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Skeleton } from '@/components/ui/skeleton';
import { QRCodeCanvas } from '@/components/ui/qrcode';
import { settingsCard, settingsGroup, settingsRowButton, settingsTokenClass } from '@/shared/settingsChromeStyles';
import { SettingsSection, SettingsSubHeading } from '@/shared/settingsSection';
import { SegmentedControl } from '@/shared/appChrome';
import { useWindowActions } from '@/contexts/WindowManagerContext';
import { useWindowTitle } from '@/contexts/WindowTitleContext';
import type { AppComponentProps } from '@/lib/apps';
import { CONNECT_APP_APP_ID, connectAppParams } from '@/lib/settingsWindows';

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
                    ? 'bg-success/15 text-success'
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
                className="grid size-6 shrink-0 place-items-center rounded text-muted-foreground hover:bg-foreground/10 hover:text-foreground outline-none focus-visible:ring-2 focus-visible:ring-ring/60"
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
    <Collapsible open={open} onOpenChange={setOpen}>
      <ContextMenu>
        <ContextMenuTrigger asChild>
          <CollapsibleTrigger asChild>
            <button
              type="button"
              className={cn(settingsRowButton, 'py-3')}
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
      <CollapsibleContent className="space-y-3 px-4 pt-1 pb-3 pl-16">{children}</CollapsibleContent>
    </Collapsible>
  );
}

function Tile({ children }: { children: React.ReactNode }) {
  return <span className={cn(settingsTokenClass(), 'size-9')}>{children}</span>;
}

/** A site or installed app, under the name and icon it has on the desktop. */
function SiteRow({
  origin,
  grant,
  onDisconnect,
  onRevoke,
}: {
  origin: string;
  grant: SiteGrant;
  onDisconnect: (origin: string) => void;
  onRevoke: (origin: string, method: GuardedMethod, kind?: number) => void;
}) {
  const identity = useSiteIdentity(origin);
  const rules = grantRules(grant);
  const blocked = grant.status === 'blocked';
  return (
    <Row
      icon={
        blocked ? (
          <Tile><Ban className="size-4.5" strokeWidth={1.75} /></Tile>
        ) : identity.icon ? (
          <AppIcon icon={identity.icon} className="size-9 rounded-lg" />
        ) : (
          <Tile><Globe className="size-4.5" strokeWidth={1.75} /></Tile>
        )
      }
      title={identity.name}
      subtitle={`${blocked ? 'Blocked' : summary(rules)} · ${ago(grant.lastUsed)}`}
      menu={
        <ContextMenuItem variant={blocked ? 'default' : 'destructive'} onSelect={() => onDisconnect(origin)}>
          {blocked ? <Ban aria-hidden /> : <Unplug aria-hidden />}
          {blocked ? 'Unblock' : 'Disconnect'}
        </ContextMenuItem>
      }
    >
      <p className="break-all text-xs text-muted-foreground">{origin}</p>
      {!blocked && <RuleList rules={rules} onRevoke={(r) => onRevoke(origin, r.method, r.kind)} />}
      <Button variant="outline" size="sm" onClick={() => onDisconnect(origin)}>
        {blocked ? 'Unblock' : 'Disconnect'}
      </Button>
    </Row>
  );
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
        <Copy className="size-4.5" strokeWidth={1.75} aria-hidden />
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

/**
 * Settings → Connected apps → Connect an app, in a window of its own
 * (src/lib/settingsWindows.ts): make a bunker:// link for an app to connect
 * with, or take the nostrconnect:// link an app gave (its `link` launch
 * param, when a page opened one) and show the app it's for, connecting it
 * only when the user says so. Its `at` launch param starts it over.
 */
export function ConnectAppWindow({ windowId, params }: AppComponentProps) {
  useWindowTitle('Connect an App');
  const link = typeof params?.link === 'string' ? params.link : '';
  return <ConnectApp key={`${String(params?.at)}:${link}`} windowId={windowId} initialLink={link} />;
}

function ConnectApp({ windowId, initialLink }: { windowId: string; initialLink: string }) {
  const { close } = useWindowActions();
  const { user } = useCurrentUser();
  const { config } = useAppContext();
  const connections = useBunkerConnections();
  const [mode, setMode] = useState<'show' | 'paste'>(initialLink ? 'paste' : 'show');
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

  if (!bridge || !user) {
    return (
      <div className="h-full bg-background p-4">
        <div className="px-8 py-12 text-center">
          <p className="mx-auto max-w-sm text-sm text-muted-foreground">
            {bridge ? 'Log in to connect apps to your Nostr account.' : 'Connecting apps needs the Din desktop shell.'}
          </p>
        </div>
      </div>
    );
  }
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
      close(windowId);
    } catch (e) {
      setError(bunkerErrorMessage(e));
    } finally {
      setAccepting(false);
    }
  };

  const perms = parsed ? grantRules(parsed.grants) : [];

  return (
    <div className="flex h-full flex-col gap-4 overflow-y-auto bg-background p-4 [&>*]:shrink-0">
      <p className="px-1 text-sm text-muted-foreground">
        Apps on your phone or other computers can use your Nostr account through Din (NIP-46). Din asks you before they
        sign or decrypt anything.
      </p>
      <SegmentedControl
        label="How to connect"
        size="md"
        value={mode}
        options={[
          { value: 'show', label: 'Give the app a link' },
          { value: 'paste', label: 'Paste the app’s link' },
        ]}
        onValueChange={setMode}
        className="self-center"
      />
      {mode === 'show' ? (
        <div className="space-y-3">
          {connection?.uri ? (
            <BunkerLinkView connection={connection} />
          ) : connection ? (
            <p className="text-sm text-muted-foreground">Connected. You can close this.</p>
          ) : (
            <>
              <p className="px-1 text-sm text-muted-foreground">
                Make a bunker:// link to scan or paste into the app’s “log in with a remote signer” option.
              </p>
              <Button onClick={createLink} disabled={creating}>
                {creating && <Loader2 className="size-4 motion-safe:animate-spin" aria-hidden />}
                Make a link
              </Button>
            </>
          )}
        </div>
      ) : (
        <>
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
            <div className={cn(settingsCard, 'space-y-2 px-4 py-3 text-sm')}>
              <div className="flex items-center gap-3">
                <Avatar className="size-9 rounded-lg">
                  {parsed.image && <AvatarImage src={parsed.image} alt="" />}
                  <AvatarFallback className="rounded-lg">
                    <Smartphone className="size-4.5" strokeWidth={1.75} aria-hidden />
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
          {shownError && <p className="px-1 text-sm text-destructive">{shownError}</p>}
          <div className="mt-auto flex justify-end gap-2">
            <Button variant="outline" onClick={() => close(windowId)}>
              Cancel
            </Button>
            <Button onClick={accept} disabled={!parsed || accepting}>
              {accepting && <Loader2 className="size-4 motion-safe:animate-spin" aria-hidden />}
              Connect
            </Button>
          </div>
        </>
      )}
    </div>
  );
}

/**
 * Settings → Connected apps: every site, installed app, and remote (NIP-46)
 * app that may use the signed-in account, with what each may do without
 * asking. Things can only be taken away here; granting happens in the prompt,
 * where the user can see what is being asked.
 */
export function ConnectedAppsSection() {
  const { user } = useCurrentUser();
  const { grants, disconnect, revoke } = useSignerGrants();
  const connections = useBunkerConnections();
  const bridge = getBunkerBridge();
  const copyLink = useCopyLink();
  const { open } = useWindowActions();

  const sites = Object.entries(grants).sort(([, a], [, b]) => b.lastUsed - a.lastUsed);
  const remote = (connections ?? [])
    .filter((c) => c.account === user?.pubkey)
    .sort((a, b) => (b.lastUsed ?? b.createdAt) - (a.lastUsed ?? a.createdAt));

  return (
    <SettingsSection
      title="Connected apps"
      actions={
        bridge && user && (
          <Button
            size="sm"
            onClick={() => open(CONNECT_APP_APP_ID, connectAppParams())}
          >
            <Plus className="size-4.5" strokeWidth={1.75} aria-hidden />
            Connect an app
          </Button>
        )
      }
    >
      {!user ? (
        <div className="px-8 py-12 text-center">
          <p className="mx-auto max-w-sm text-sm text-muted-foreground">Log in to connect sites and apps to your Nostr account.</p>
        </div>
      ) : (
        <>
          <p className="text-sm text-muted-foreground">
            Sites in the Web Browser, installed apps, and apps connected with a link can use your Nostr account through Din. Din asks before they sign, encrypt, or decrypt anything, unless you told it to remember.
          </p>

          <div className="space-y-2">
            <SettingsSubHeading>Sites and installed apps</SettingsSubHeading>
            {sites.length === 0 ? (
              <div className="px-8 py-8 text-center">
                <p className="mx-auto max-w-sm text-sm text-muted-foreground">No site has connected to your account yet.</p>
              </div>
            ) : (
              <div className={settingsGroup}>
                {sites.map(([origin, grant]) => (
                  <SiteRow key={origin} origin={origin} grant={grant} onDisconnect={disconnect} onRevoke={revoke} />
                ))}
              </div>
            )}
          </div>

          {bridge && (
            <div className="space-y-2">
              <SettingsSubHeading>Apps connected with a link</SettingsSubHeading>
              {connections === null ? (
                <Skeleton className="h-14 rounded-xl" />
              ) : remote.length === 0 ? (
                <div className="px-8 py-8 text-center">
                  <p className="mx-auto max-w-sm text-sm text-muted-foreground">
                    No apps yet. Use “Connect an app” to sign in to an app on another device with this account.
                  </p>
                </div>
              ) : (
                <div className={settingsGroup}>
                  {remote.map((c) => {
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
                                <Smartphone className="size-4.5" strokeWidth={1.75} />
                              </AvatarFallback>
                            </Avatar>
                          ) : (
                            <Tile>{waiting ? <Link2 className="size-4.5" strokeWidth={1.75} /> : <Smartphone className="size-4.5" strokeWidth={1.75} />}</Tile>
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
                  })}
                </div>
              )}
            </div>
          )}
        </>
      )}

    </SettingsSection>
  );
}
