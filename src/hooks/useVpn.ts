import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { getVpnBridge } from '@/lib/vpn';
import type { VpnConnection } from '@/lib/vpn';

/**
 * TanStack Query hooks over the OS VPN bridge (window.dinos.vpn).
 *
 * The profile list polls on a short interval so the network selector tracks
 * tunnels brought up or down elsewhere (e.g. nmcli in the Terminal). Mutations
 * invalidate everything VPN so the toggles converge after connect/disconnect.
 */

function requireBridge() {
  const vpn = getVpnBridge();
  if (!vpn) throw new Error('VPN bridge unavailable');
  return vpn;
}

/** Saved VPN/WireGuard profiles with their active state (polls every few seconds). */
export function useVpnConnections() {
  const vpn = getVpnBridge();
  return useQuery<VpnConnection[]>({
    queryKey: ['vpn', 'list'],
    queryFn: () => requireBridge().list(),
    enabled: vpn !== undefined,
    // Refreshed on NetworkManager change events (SystemEventsHost); the
    // poll is only a fallback.
    refetchInterval: 30_000,
    retry: false,
  });
}

/** VPN write operations; each invalidates all cached VPN state. */
export function useVpnMutations() {
  const queryClient = useQueryClient();
  const invalidate = () => queryClient.invalidateQueries({ queryKey: ['vpn'] });

  const connect = useMutation({
    mutationFn: (name: string) => requireBridge().connect(name),
    onSettled: invalidate,
  });

  const disconnect = useMutation({
    mutationFn: (name: string) => requireBridge().disconnect(name),
    onSettled: invalidate,
  });

  return { connect, disconnect };
}
