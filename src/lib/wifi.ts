/**
 * Typed access to the OS WiFi bridge exposed by the Electron preload
 * (`window.wifi`, see electron/preload.cjs + electron/main.cjs).
 *
 * Backed by nmcli/NetworkManager in the main process; the shell's OS user is
 * in the `networkmanager` group so no polkit prompts appear. On systems
 * without NetworkManager `status()` resolves with `available: false`.
 *
 * In a plain browser (`make dev-browser`) the bridge is absent; callers must
 * feature-detect via `getWifiBridge()` and render a fallback.
 */

export interface WifiDeviceStatus {
  /** Interface name, e.g. "wlan1". */
  iface: string;
  /** NetworkManager device state, e.g. "connected", "disconnected". */
  state: string;
  /** Name of the active connection profile, or null when not connected. */
  connection: string | null;
}

export interface WifiStatus {
  /** False when NetworkManager/nmcli is not present on the system. */
  available: boolean;
  /** Whether the WiFi radio (rfkill soft switch) is on. */
  radioEnabled: boolean;
  /** The first WiFi adapter, or null when none exists. */
  device: WifiDeviceStatus | null;
}

export interface WifiNetwork {
  ssid: string;
  /** True for the network the adapter is currently connected to. */
  inUse: boolean;
  /** Signal strength, 0-100. */
  signal: number;
  /** Security flags as nmcli reports them, e.g. "WPA2"; "" for open. */
  security: string;
  freqMhz: number;
}

export interface WifiBridge {
  /** Adapter/radio state. `available: false` when NetworkManager is absent. */
  status(): Promise<WifiStatus>;
  /** Visible networks, one entry per SSID. `rescan` forces a fresh scan. */
  networks(rescan?: boolean): Promise<WifiNetwork[]>;
  /** Names of saved (remembered) WiFi connection profiles. */
  saved(): Promise<string[]>;
  /** Join a network, creating or updating its saved profile. */
  connect(ssid: string, password?: string): Promise<void>;
  /** Disconnect the WiFi adapter from its current network. */
  disconnect(): Promise<void>;
  /** Delete a saved network profile. */
  forget(ssid: string): Promise<void>;
  /** Turn the WiFi radio on or off. */
  setRadio(enabled: boolean): Promise<void>;
}

declare global {
  interface Window {
    /** Present only inside the Electron shell. */
    wifi?: WifiBridge;
  }
}

/** The wifi bridge, or undefined when running outside the Electron shell. */
export function getWifiBridge(): WifiBridge | undefined {
  if (typeof window === 'undefined') return undefined;
  return window.wifi;
}

/**
 * Strip Electron's IPC error prefix ("Error invoking remote method
 * 'wifi:connect': Error: ...") so users see just the underlying message.
 */
export function cleanWifiError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.replace(/^Error invoking remote method '[^']*':\s*(?:Error:\s*)?/, '');
}

/** Whether a network requires a password to join. */
export function isSecured(network: WifiNetwork): boolean {
  return network.security !== '' && network.security !== '--';
}
