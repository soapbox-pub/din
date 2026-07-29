import { useState } from 'react';
import { Check, Loader2, Shield, ShieldCheck } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import { cleanVpnError, getVpnBridge, isWireGuard } from '@/lib/vpn';
import type { VpnConnection } from '@/lib/vpn';
import { useVpnConnections, useVpnMutations } from '@/hooks/useVpn';

/** Human label for a profile's transport. */
function typeLabel(conn: VpnConnection): string {
  return isWireGuard(conn) ? 'WireGuard' : 'VPN';
}

/**
 * VPN section for the network selector: toggles saved VPN/WireGuard profiles
 * up and down. Renders nothing outside the Electron shell or when no VPN
 * profiles exist, so the network menu stays clean on machines without a VPN.
 *
 * `compact` picks the taskbar-popover layout; the default is the roomier
 * Settings layout.
 */
export function VpnControls({ compact = false }: { compact?: boolean }) {
  const bridge = getVpnBridge();
  const connections = useVpnConnections();
  const { connect, disconnect } = useVpnMutations();

  // Last failed operation, keyed to the profile it concerned.
  const [opError, setOpError] = useState<{ name: string; message: string } | null>(null);

  const list = connections.data ?? [];
  // Only surface VPN once we know there's at least one profile to toggle.
  if (!bridge || list.length === 0) return null;

  const toggle = (conn: VpnConnection) => {
    setOpError(null);
    const mutation = conn.active ? disconnect : connect;
    mutation.mutate(conn.name, {
      onError: (error) => setOpError({ name: conn.name, message: cleanVpnError(error) }),
    });
  };

  const isPending = (conn: VpnConnection) =>
    (connect.isPending && connect.variables === conn.name) ||
    (disconnect.isPending && disconnect.variables === conn.name);

  if (compact) {
    return (
      <div className="border-t border-border/60">
        <p className="px-3 pt-2 pb-1 text-xs font-medium text-muted-foreground">VPN</p>
        <ul aria-label="VPN connections" className="flex flex-col gap-0.5 p-1.5 pt-0.5">
          {list.map((conn) => {
            const pending = isPending(conn);
            return (
              <li key={conn.name}>
                <button
                  type="button"
                  onClick={() => toggle(conn)}
                  disabled={pending}
                  aria-label={
                    conn.active ? `Disconnect ${conn.name}` : `Connect ${conn.name}`
                  }
                  aria-pressed={conn.active}
                  className={cn(
                    'flex w-full items-center gap-2.5 rounded-md px-2 py-1.5 text-left transition-colors',
                    'hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
                    'disabled:opacity-70',
                    conn.active && 'bg-accent/60',
                  )}
                >
                  {conn.active ? (
                    <ShieldCheck className="size-4.5 shrink-0 text-primary" aria-hidden />
                  ) : (
                    <Shield className="size-4.5 shrink-0 text-muted-foreground" aria-hidden />
                  )}
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-sm text-foreground">{conn.name}</span>
                    <span
                      className={cn(
                        'block text-xs',
                        conn.active ? 'text-primary' : 'text-muted-foreground',
                      )}
                    >
                      {conn.active ? 'Connected' : typeLabel(conn)}
                    </span>
                  </span>
                  {pending ? (
                    <Loader2
                      className="size-3.5 shrink-0 animate-spin text-muted-foreground"
                      aria-hidden
                    />
                  ) : (
                    conn.active && <Check className="size-3.5 shrink-0 text-primary" aria-hidden />
                  )}
                </button>
                {opError?.name === conn.name && (
                  <p role="alert" className="px-2 py-1 text-xs text-destructive">
                    {opError.message}
                  </p>
                )}
              </li>
            );
          })}
        </ul>
      </div>
    );
  }

  return (
    <div className="mt-6">
      <h3 className="mb-2 flex items-center gap-2 text-sm font-medium text-foreground">
        <Shield className="size-4 shrink-0 text-muted-foreground" aria-hidden />
        VPN
      </h3>
      <ul className="flex flex-col gap-1" aria-label="VPN connections">
        {list.map((conn) => {
          const pending = isPending(conn);
          return (
            <li key={conn.name} className="rounded-lg border border-border/60 bg-background/40">
              <div className="flex items-center gap-3 px-3 py-2">
                {conn.active ? (
                  <ShieldCheck className="size-5 shrink-0 text-primary" aria-hidden />
                ) : (
                  <Shield className="size-5 shrink-0 text-muted-foreground" aria-hidden />
                )}
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm text-foreground">{conn.name}</p>
                  <p className="text-xs text-muted-foreground">{typeLabel(conn)}</p>
                </div>

                {conn.active && (
                  <span className="flex items-center gap-1 text-xs font-medium text-primary">
                    <Check className="size-3.5" aria-hidden />
                    Connected
                  </span>
                )}
                <Button
                  variant="outline"
                  size="sm"
                  disabled={pending}
                  onClick={() => toggle(conn)}
                >
                  {pending ? (
                    <>
                      <Loader2 className="size-3.5 animate-spin" aria-hidden />
                      {conn.active ? 'Disconnecting…' : 'Connecting…'}
                    </>
                  ) : conn.active ? (
                    'Disconnect'
                  ) : (
                    'Connect'
                  )}
                </Button>
              </div>
              {opError?.name === conn.name && (
                <p
                  role="alert"
                  className="border-t border-border/60 px-3 py-1.5 text-xs text-destructive"
                >
                  {opError.message}
                </p>
              )}
            </li>
          );
        })}
      </ul>
    </div>
  );
}
