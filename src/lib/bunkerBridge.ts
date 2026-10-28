/**
 * Typed access to Din's NIP-46 remote signer (`window.dinos.bunkerHost`, see
 * electron/bunker.mts). Apps connect to the user's account with a bunker://
 * link Din makes, or a nostrconnect:// link they make; their requests then
 * arrive through the same bridge as window.nostr's (see nostrBridge.ts).
 *
 * Absent outside the Electron shell; feature-detect via `getBunkerBridge()`.
 */

export interface BunkerGrants {
  methods: Record<string, 'allow' | 'deny'>;
  kinds: Record<string, 'allow' | 'deny'>;
}

export interface BunkerConnection {
  /** The connection's own public key. */
  id: string;
  /** The account it signs for. */
  account: string;
  relays: string[];
  /** The client's pubkey; null until an app has used the bunker:// link. */
  client: string | null;
  name?: string;
  url?: string;
  image?: string;
  /** Unix ms. */
  createdAt: number;
  lastUsed: number | null;
  grants: BunkerGrants;
  /** The bunker:// link, while nobody has used it. */
  uri: string | null;
}

/** What a nostrconnect:// link says about the app behind it. */
export interface NostrConnectLink {
  client: string;
  relays: string[];
  perms: string | null;
  name?: string;
  url?: string;
  image?: string;
  /** What accepting it grants straight away. */
  grants: BunkerGrants;
}

export interface BunkerBridge {
  list(): Promise<BunkerConnection[]>;
  create(options: { account: string; relays: string[] }): Promise<BunkerConnection>;
  parse(uri: string): Promise<NostrConnectLink>;
  accept(options: { account: string; uri: string }): Promise<BunkerConnection>;
  remove(id: string): Promise<void>;
  revoke(options: { id: string; method: string; kind?: number }): Promise<void>;
  onChange(callback: (connections: BunkerConnection[]) => void): () => void;
  onLink(callback: (uri: string) => void): () => void;
}

declare global {
  interface Dinos {
    bunkerHost?: BunkerBridge;
  }
}

export function getBunkerBridge(): BunkerBridge | undefined {
  if (typeof window === 'undefined') return undefined;
  return window.dinos?.bunkerHost;
}

/** Electron prefixes errors from main ("Error invoking remote method …: Error: …"); keep the message. */
export function bunkerErrorMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.replace(/^Error invoking remote method '[^']+': (Error: )?/, '');
}
