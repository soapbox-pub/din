/**
 * Typed access to programs asking to sign as the user (`window.dinos.programSigner`,
 * see electron/preload.cjs + electron/nostrd-approval.mts). On DinOS nostrd
 * makes the user's programs (ngit, nak, the Assistant's scripts) ask Din
 * before it signs, encrypts or decrypts for them; `ProgramSignerHost` asks
 * the user, and Settings → Connected apps lists the programs allowed always.
 * Absent in a plain browser.
 */

export interface ProgramSignerRequest {
  requestId: number;
  /** The program, by name: "ngit", "nak", "sync.py". */
  program: string;
  /** Where it runs from. */
  path: string;
  /** What it was started from: "Assistant", "Terminal", or another program. */
  via: string | null;
  /** Its command line. */
  command: string;
  /** The name the program gave itself, if any. */
  client: string | null;
  /** nostrd's method: sign_event, nip44_decrypt, sign_psbt, set_active… */
  method: string;
  params: unknown[];
  /** The account it would use (hex). */
  account: string | null;
  /** sign_event's kind. */
  kind: number | null;
  canAlways: boolean;
  canProcess: boolean;
  canConversation: boolean;
}

export type ProgramSignerDecision = 'once' | 'process' | 'conversation' | 'always' | 'deny';

/** A program allowed always. */
export interface ProgramGrant {
  name: string;
  path: string;
  /** nostrd methods allowed, other than sign_event. */
  methods: string[];
  /** sign_event, by kind. */
  kinds: number[];
  createdAt: number;
  lastUsed: number;
}

export interface ProgramGrants {
  /** Whether nostrd keeps them: Din is its approver. */
  available: boolean;
  /** By key: `system:<name>`, `path:<file>` or `script:<interpreter>:<file>`. */
  programs: Record<string, ProgramGrant>;
}

export interface ProgramSignerBridge {
  pending(): Promise<ProgramSignerRequest[]>;
  onRequest(callback: (request: ProgramSignerRequest) => void): () => void;
  onCancel(callback: (requestId: number) => void): () => void;
  answer(requestId: number, decision: ProgramSignerDecision): Promise<void>;
  grants(): Promise<ProgramGrants>;
  /** Forget a program, or one thing it may do (`kind` for sign_event). */
  revoke(key: string, method?: string | null, kind?: number | null): Promise<boolean>;
  onGrantsChanged(callback: () => void): () => void;
}

declare global {
  interface Dinos {
    /** Present only inside the Electron shell. */
    programSigner?: ProgramSignerBridge;
  }
}

/** The bridge, or undefined outside the Electron shell. */
export function getProgramSignerBridge(): ProgramSignerBridge | undefined {
  if (typeof window === 'undefined') return undefined;
  return window.dinos?.programSigner;
}

/** nostrd's method as the site signer names it (src/lib/signerPermissions.ts), for its labels. */
export function signerMethodOf(method: string): 'signEvent' | 'nip04.encrypt' | 'nip04.decrypt' | 'nip44.encrypt' | 'nip44.decrypt' | 'signPsbt' | null {
  switch (method) {
    case 'sign_event':
      return 'signEvent';
    case 'nip04_encrypt':
      return 'nip04.encrypt';
    case 'nip04_decrypt':
      return 'nip04.decrypt';
    case 'nip44_encrypt':
      return 'nip44.encrypt';
    case 'nip44_decrypt':
      return 'nip44.decrypt';
    case 'sign_psbt':
      return 'signPsbt';
    default:
      return null;
  }
}

/** The rules a grant holds, each as a method and, for signing, a kind. */
export function programRules(grant: ProgramGrant): { method: string; kind?: number }[] {
  return [
    ...[...grant.kinds].sort((a, b) => a - b).map((kind) => ({ method: 'sign_event', kind })),
    ...grant.methods.map((method) => ({ method })),
  ];
}
