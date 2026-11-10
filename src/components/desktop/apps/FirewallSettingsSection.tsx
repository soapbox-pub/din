import { useState, type ComponentType, type FormEvent, type ReactNode } from 'react';
import { Loader2, MoreHorizontal, Plus, Shield, ShieldOff } from 'lucide-react';
import { Button } from '@/components/ui/button';
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuTrigger,
} from '@/components/ui/context-menu';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Skeleton } from '@/components/ui/skeleton';
import { useFirewallStatus } from '@/hooks/useFirewall';
import { useToast } from '@/hooks/useToast';
import {
  cleanFirewallError,
  describeRule,
  featurePortsAllowed,
  FIREWALL_PROTOCOLS,
  getFirewallBridge,
  parsePorts,
  PROTOCOL_LABELS,
  type FirewallProtocol,
  type FirewallRule,
} from '@/lib/firewall';
import { cn } from '@/lib/utils';
import { settingsCard, settingsGroup } from '@/shared/settingsChromeStyles';
import { SettingsSection, SettingsSubHeading } from '@/shared/settingsSection';

/**
 * Settings → Firewall: the ports other devices may connect to, besides
 * those Din's own features use, and letting more in for an app Din doesn't
 * know about (a game server, a file-sharing program). On DinOS the rules are
 * os/din-firewall.sh's; where firewalld runs they're firewalld's, and Din's
 * own features' ports are let in with the rest (electron/firewall.mts).
 */
export function FirewallSettingsSection() {
  const bridge = getFirewallBridge();
  const status = useFirewallStatus();
  const { toast } = useToast();

  const [allowingFeatures, setAllowingFeatures] = useState(false);
  const allowFeatures = () => {
    if (!bridge) return;
    setAllowingFeatures(true);
    bridge
      .allowFeatures()
      .catch((error: unknown) =>
        toast({ title: 'Couldn’t allow Din’s features', description: cleanFirewallError(error), variant: 'destructive' }),
      )
      .finally(() => setAllowingFeatures(false));
  };

  const remove = (rule: FirewallRule) => {
    bridge?.remove(rule).catch((error: unknown) =>
      toast({ title: `Couldn’t shut ${describeRule(rule)}`, description: cleanFirewallError(error), variant: 'destructive' }),
    );
  };

  return (
    <SettingsSection title="Firewall">

      {!bridge ? (
        <Fallback>Firewall settings need the Din desktop shell; they aren’t available in a plain browser.</Fallback>
      ) : !status ? (
        <div className="flex flex-col gap-2">
          <Skeleton className="h-16 w-full rounded-xl" />
          <Skeleton className="h-12 w-full rounded-xl" />
        </div>
      ) : !status.canChange ? (
        <Fallback>
          Din doesn’t manage this computer’s firewall. Use your system’s own firewall settings to let other devices
          connect.
        </Fallback>
      ) : (
        <>
          <div className={cn(settingsCard, 'flex items-start gap-3 px-4 py-3')}>
            <span
              className={cn(
                'grid size-9 shrink-0 place-items-center rounded-full',
                status.active === false
                  ? 'bg-destructive/15 text-destructive'
                  : 'bg-pigment text-primary-foreground clay-pigment',
              )}
            >
              {status.active === false ? <ShieldOff className="size-4.5" aria-hidden /> : <Shield className="size-4.5" aria-hidden />}
            </span>
            <div className="min-w-0 flex-1 space-y-1">
              <p className="text-sm font-medium text-foreground">
                {status.active === false ? 'The firewall isn’t running' : 'The firewall is on'}
              </p>
              {status.manager === 'firewalld' ? (
                <p className="text-xs text-muted-foreground">
                  Other devices can only connect on the ports below, plus any your system already allows. Changes
                  ask for your password.
                </p>
              ) : (
                <p className="text-xs text-muted-foreground">
                  Other devices can connect to this computer only on the ports below, and on the ones Din’s own
                  features use: Quick Share, AirPlay and LocalSend. What you start yourself, like a game server or a
                  file-sharing app, may need its port let in here.
                </p>
              )}
              {status.manager === 'firewalld' && !featurePortsAllowed(status.rules) && (
                <>
                  <p className="text-xs text-muted-foreground">Quick Share, AirPlay and LocalSend need their ports allowed.</p>
                  <Button variant="outline" size="sm" className="mt-2" onClick={allowFeatures} disabled={allowingFeatures}>
                    {allowingFeatures ? (
                      <Loader2 className="size-4.5 motion-safe:animate-spin" aria-hidden />
                    ) : (
                      <Shield className="size-4.5" strokeWidth={1.75} aria-hidden />
                    )}
                    Allow Din’s Features
                  </Button>
                </>
              )}
            </div>
          </div>

          <div>
            <SettingsSubHeading>Allowed ports</SettingsSubHeading>
            {status.rules.length === 0 ? (
              <div className="mt-2 px-6 py-8 text-center">
                <p className="mx-auto max-w-sm text-sm text-muted-foreground">No other ports are let in.</p>
              </div>
            ) : (
              <ul className={cn(settingsGroup, 'mt-2')} aria-label="Allowed ports">
                {status.rules.map((rule) => (
                  <RuleRow key={`${rule.protocol} ${rule.from}-${rule.to}`} rule={rule} onRemove={() => remove(rule)} />
                ))}
              </ul>
            )}
          </div>

          <AllowPortForm />
        </>
      )}
    </SettingsSection>
  );
}

function Fallback({ children }: { children: ReactNode }) {
  return (
    <div className="px-8 py-12 text-center">
      <Shield className="mx-auto mb-4 size-8 text-muted-foreground/80" aria-hidden />
      <p className="mx-auto max-w-sm text-sm text-muted-foreground">{children}</p>
    </div>
  );
}

/** The pieces a rule's ⋯ menu and its right-click menu are both built from. */
interface MenuParts {
  Item: ComponentType<{ variant?: 'default' | 'destructive'; onSelect?: () => void; children?: ReactNode }>;
}

const DROPDOWN_PARTS: MenuParts = { Item: DropdownMenuItem };
const CONTEXT_PARTS: MenuParts = { Item: ContextMenuItem };

function RuleMenuItems({ parts: { Item }, onRemove }: { parts: MenuParts; onRemove: () => void }) {
  return (
    <Item variant="destructive" onSelect={onRemove}>
      Stop letting in
    </Item>
  );
}

function RuleRow({ rule, onRemove }: { rule: FirewallRule; onRemove: () => void }) {
  const ports = describeRule(rule);
  const label = rule.name || ports;
  return (
    <li>
      <ContextMenu>
        <ContextMenuTrigger asChild>
          <div className="flex items-center gap-3 py-2 pr-2 pl-4">
            <div className="min-w-0 flex-1">
              <p className="truncate text-sm text-foreground">{label}</p>
              {rule.name && <p className="truncate text-xs text-muted-foreground tabular-nums">{ports}</p>}
            </div>
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button variant="ghost" size="icon" aria-label={`${label} options`}>
                  <MoreHorizontal className="size-4.5" strokeWidth={1.75} />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end">
                <RuleMenuItems parts={DROPDOWN_PARTS} onRemove={onRemove} />
              </DropdownMenuContent>
            </DropdownMenu>
          </div>
        </ContextMenuTrigger>
        <ContextMenuContent>
          <RuleMenuItems parts={CONTEXT_PARTS} onRemove={onRemove} />
        </ContextMenuContent>
      </ContextMenu>
    </li>
  );
}

/** Letting a port in: what it's for, the port or range, and its protocol. */
function AllowPortForm() {
  const bridge = getFirewallBridge();
  const { toast } = useToast();
  const [name, setName] = useState('');
  const [ports, setPorts] = useState('');
  const [protocol, setProtocol] = useState<FirewallProtocol>('tcp');
  const [portsError, setPortsError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (!bridge || pending) return;
    const range = parsePorts(ports);
    if ('error' in range) {
      setPortsError(range.error);
      return;
    }
    setPending(true);
    const rule = { protocol, ...range, name: name.trim() };
    bridge
      .allow(rule)
      .then(() => {
        setName('');
        setPorts('');
        toast({ title: `${describeRule(rule)} is let in`, description: rule.name || undefined });
      })
      .catch((error: unknown) =>
        toast({ title: 'Couldn’t let the port in', description: cleanFirewallError(error), variant: 'destructive' }),
      )
      .finally(() => setPending(false));
  };

  return (
    <form onSubmit={submit} className={cn(settingsCard, 'px-4 py-3')} aria-label="Allow a port">
      <h3 className="mb-3 text-sm font-medium text-foreground">Allow a port</h3>
      <div className="grid gap-3 @xl:grid-cols-[minmax(0,1fr)_8rem_9rem]">
        <div className="space-y-1.5">
          <Label htmlFor="firewall-name">What it’s for</Label>
          <Input
            id="firewall-name"
            value={name}
            maxLength={64}
            placeholder="Minecraft server"
            onChange={(e) => setName(e.target.value)}
          />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="firewall-ports">Port</Label>
          <Input
            id="firewall-ports"
            value={ports}
            inputMode="numeric"
            placeholder="25565"
            aria-invalid={portsError ? true : undefined}
            aria-describedby={portsError ? 'firewall-ports-error' : undefined}
            onChange={(e) => {
              setPorts(e.target.value);
              setPortsError(null);
            }}
          />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="firewall-protocol">Protocol</Label>
          <Select value={protocol} onValueChange={(value) => setProtocol(value as FirewallProtocol)}>
            <SelectTrigger id="firewall-protocol" className="w-full">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {FIREWALL_PROTOCOLS.map((p) => (
                <SelectItem key={p} value={p}>
                  {PROTOCOL_LABELS[p]}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      </div>
      {portsError && (
        <p id="firewall-ports-error" role="alert" className="mt-2 text-xs text-destructive">
          {portsError}
        </p>
      )}
      <div className="mt-3 flex items-center justify-between gap-3">
        <p className="text-xs text-muted-foreground">
          A range is two ports with a dash, like 27000-27015. The app’s instructions say which it needs.
        </p>
        <Button type="submit" size="sm" disabled={pending || !ports.trim()}>
          {pending ? <Loader2 className="size-4 motion-safe:animate-spin" aria-hidden /> : <Plus className="size-4.5" strokeWidth={1.75} aria-hidden />}
          Allow
        </Button>
      </div>
    </form>
  );
}
