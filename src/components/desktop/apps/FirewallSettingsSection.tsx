import { useState, type ComponentType, type FormEvent, type ReactNode } from 'react';
import { EllipsisVertical, Loader2, Plus, Shield, ShieldOff } from 'lucide-react';
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
  FIREWALL_PROTOCOLS,
  getFirewallBridge,
  parsePorts,
  PROTOCOL_LABELS,
  type FirewallProtocol,
  type FirewallRule,
} from '@/lib/firewall';
import { cn } from '@/lib/utils';

/**
 * Settings → Firewall: the ports other devices may connect to, besides
 * those Din's own features use, and letting more in for an app Din doesn't
 * know about (a game server, a file-sharing program). On DinOS only; the
 * rules are os/din-firewall.sh's.
 */
export function FirewallSettingsSection() {
  const bridge = getFirewallBridge();
  const status = useFirewallStatus();
  const { toast } = useToast();

  const remove = (rule: FirewallRule) => {
    bridge?.remove(rule).catch((error: unknown) =>
      toast({ title: `Couldn’t shut ${describeRule(rule)}`, description: cleanFirewallError(error), variant: 'destructive' }),
    );
  };

  return (
    <section className="mx-auto flex max-w-2xl flex-col gap-4 p-4">
      <header>
        <h2 className="font-[family-name:var(--font-title)] text-lg font-semibold text-foreground">Firewall</h2>
      </header>

      {!bridge ? (
        <Fallback>Firewall settings need the Din desktop shell; they aren’t available in a plain browser.</Fallback>
      ) : !status ? (
        <div className="flex flex-col gap-2">
          <Skeleton className="h-16 w-full rounded-lg" />
          <Skeleton className="h-12 w-full rounded-lg" />
        </div>
      ) : !status.canChange ? (
        <Fallback>
          Din doesn’t manage this computer’s firewall. Use your system’s own firewall settings to let other devices
          connect.
        </Fallback>
      ) : (
        <>
          <div className="flex items-start gap-3 rounded-lg border border-border/60 bg-background/40 px-3 py-3">
            <span
              className={cn(
                'grid size-9 shrink-0 place-items-center rounded-full',
                status.active === false
                  ? 'bg-amber-500/15 text-amber-600 dark:text-amber-400'
                  : 'bg-emerald-600/15 text-emerald-700 dark:text-emerald-400',
              )}
            >
              {status.active === false ? <ShieldOff className="size-4.5" aria-hidden /> : <Shield className="size-4.5" aria-hidden />}
            </span>
            <div className="min-w-0 flex-1 space-y-1">
              <p className="text-sm font-medium text-foreground">
                {status.active === false ? 'The firewall isn’t running' : 'The firewall is on'}
              </p>
              <p className="text-xs text-muted-foreground">
                Other devices can connect to this computer only on the ports below, and on the ones Din’s own
                features use: Quick Share, AirPlay and LocalSend. What you start yourself, like a game server or a
                file-sharing app, may need its port let in here.
              </p>
            </div>
          </div>

          <div>
            <h3 className="mb-2 text-sm font-medium text-foreground">Allowed ports</h3>
            {status.rules.length === 0 ? (
              <div className="rounded-lg border border-dashed border-border px-6 py-8 text-center">
                <p className="mx-auto max-w-sm text-sm text-muted-foreground">No other ports are let in.</p>
              </div>
            ) : (
              <ul className="flex flex-col gap-2" aria-label="Allowed ports">
                {status.rules.map((rule) => (
                  <RuleRow key={`${rule.protocol} ${rule.from}-${rule.to}`} rule={rule} onRemove={() => remove(rule)} />
                ))}
              </ul>
            )}
          </div>

          <AllowPortForm />
        </>
      )}
    </section>
  );
}

function Fallback({ children }: { children: ReactNode }) {
  return (
    <div className="rounded-xl border border-dashed border-border px-8 py-12 text-center">
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
    <li className="rounded-lg border border-border/60 bg-background/40">
      <ContextMenu>
        <ContextMenuTrigger asChild>
          <div className="flex items-center gap-3 px-3 py-2">
            <div className="min-w-0 flex-1">
              <p className="truncate text-sm text-foreground">{label}</p>
              {rule.name && <p className="truncate text-xs text-muted-foreground tabular-nums">{ports}</p>}
            </div>
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button variant="ghost" size="icon" aria-label={`${label} options`}>
                  <EllipsisVertical className="size-4" />
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
    <form onSubmit={submit} className="rounded-lg border border-border/60 bg-background/40 p-3" aria-label="Allow a port">
      <h3 className="mb-3 text-sm font-medium text-foreground">Allow a port</h3>
      <div className="grid gap-3 sm:grid-cols-[minmax(0,1fr)_8rem_9rem]">
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
          {pending ? <Loader2 className="size-4 motion-safe:animate-spin" aria-hidden /> : <Plus className="size-4" aria-hidden />}
          Allow
        </Button>
      </div>
    </form>
  );
}
