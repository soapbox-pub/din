/**
 * Typed access to the OS VPN bridge exposed by the Electron preload
 * (`window.dinos.vpn`, see electron/preload.cjs + electron/main.mts).
 *
 * Backed by nmcli/NetworkManager in the main process, scoped to VPN and
 * WireGuard connection profiles. The network selector can toggle profiles that
 * already exist; creating/editing them (import, credentials, per-provider
 * config) is done out of band via `nmcli connection import` or the Terminal.
 *
 * In a plain browser (`make dev-browser`) the bridge is absent, and on a
 * machine without NetworkManager `list()` resolves to `[]`. Either way the
 * network selector simply renders no VPN section.
 */

export interface VpnConnection {
  /** The NetworkManager connection profile name. */
  name: string;
  /** "vpn" (OpenVPN, IKEv2, ...) or "wireguard". */
  type: string;
  /** Whether the tunnel is currently up. */
  active: boolean;
}

export interface VpnBridge {
  /** Saved VPN/WireGuard profiles with their active state. `[]` when NetworkManager is absent. */
  list(): Promise<VpnConnection[]>;
  /** Bring a saved VPN profile up. */
  connect(name: string): Promise<void>;
  /** Bring a saved VPN profile down. */
  disconnect(name: string): Promise<void>;
}

declare global {
  interface Dinos {
    /** Present only inside the Electron shell. */
    vpn?: VpnBridge;
  }
}

/** The vpn bridge, or undefined when running outside the Electron shell. */
export function getVpnBridge(): VpnBridge | undefined {
  if (typeof window === 'undefined') return undefined;
  return window.dinos?.vpn;
}

/**
 * Strip Electron's IPC error prefix ("Error invoking remote method
 * 'vpn:connect': Error: ...") so users see just the underlying message.
 */
export function cleanVpnError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.replace(/^Error invoking remote method '[^']*':\s*(?:Error:\s*)?/, '');
}

/** Whether a profile is a WireGuard tunnel (vs a generic VPN plugin). */
export function isWireGuard(connection: VpnConnection): boolean {
  return connection.type === 'wireguard';
}
