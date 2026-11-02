/**
 * Typed access to Passwords, Din's password manager (electron/passwords.mts):
 * `window.dinos.passwords` on the desktop, `din.system.passwords` in the
 * Passwords app. The vault is a KeePass file that only Electron main holds
 * open; these calls get items out of it one at a time.
 *
 * The browser's autofill (`suggestions`, `offers`, `choose`, …) is the
 * desktop's alone: main refuses those calls from apps.
 */

export interface PasswordsState {
  exists: boolean;
  locked: boolean;
  /** Where the vault is. */
  file: string;
  /** Whether it opens at login, from the login keyring. */
  autoUnlock: boolean;
  /** Sites (origins) the browser never offers to save a password for. */
  never: string[];
}

export interface PasswordSummary {
  id: string;
  title: string;
  username: string;
  url: string;
  groupId: string;
  kind: 'login' | 'note';
  favorite: boolean;
  /** Whether it has a verification code (TOTP). */
  otp: boolean;
  trashed: boolean;
  created: number;
  modified: number;
}

export interface PasswordField {
  name: string;
  value: string;
  protected: boolean;
}

export interface PasswordItem extends PasswordSummary {
  password: string;
  notes: string;
  /** An otpauth:// URI or a bare base32 secret. */
  otpUri: string;
  fields: PasswordField[];
  tags: string[];
}

export interface PasswordItemInput {
  /** Absent for a new item. */
  id?: string;
  groupId?: string;
  title: string;
  username: string;
  password: string;
  url: string;
  notes: string;
  otpUri: string;
  fields: PasswordField[];
  favorite: boolean;
}

export interface PasswordGroup {
  id: string;
  name: string;
  /** Null for a top-level folder. */
  parentId: string | null;
  depth: number;
  /** The recycle bin: Recently Deleted. */
  trash: boolean;
}

export interface PasswordList {
  /** The vault's top folder, which new items go in. */
  rootId: string;
  items: PasswordSummary[];
  groups: PasswordGroup[];
}

export interface GenerateOptions {
  /** `apple`: three hyphenated groups of six letters, one a capital and one a digit. */
  style?: 'apple' | 'random';
  length?: number;
  numbers?: boolean;
  symbols?: boolean;
}

/** What `copy` puts on the clipboard. Passwords and codes are cleared from it after 90 seconds. */
export type CopyField = 'username' | 'password' | 'otp' | 'url' | 'notes' | { field: string };

export interface PasswordsImportOptions {
  /** The file's name, which a KeePass file's folder is named after. */
  name: string;
  /** A KeePass file's password. */
  password?: string;
  /** A KeePass file's key file. */
  keyFile?: ArrayBuffer;
}

export interface PasswordsImportResult {
  /** Where it came from: "KeePass", "Google Passwords", "Bitwarden", "CSV"… */
  source: string;
  added: number;
  /** Items the vault already had. */
  skipped: number;
  /** The folder a KeePass file's items went in; null when they went in at the top. */
  folderId: string | null;
}

/** Whether a file is a KeePass database (KDBX), by its first bytes. */
export function isKdbx(head: Uint8Array): boolean {
  return [0x03, 0xd9, 0xa2, 0x9a].every((b, i) => head[i] === b);
}

export interface PasswordsBridge {
  /** Tries the login keyring first, while the vault is locked and wasn't locked by hand. */
  state(): Promise<PasswordsState>;
  create(password: string): Promise<void>;
  unlock(password: string): Promise<void>;
  lock(): Promise<void>;
  setAutoUnlock(on: boolean): Promise<void>;
  forgetNever(origin: string): Promise<void>;
  changePassword(old: string, next: string): Promise<void>;
  list(): Promise<PasswordList>;
  get(id: string): Promise<PasswordItem>;
  /** Resolves with the item's id. */
  save(item: PasswordItemInput): Promise<string>;
  setFavorite(id: string, favorite: boolean): Promise<void>;
  move(id: string, groupId: string): Promise<void>;
  /** To Recently Deleted, or for good from there. */
  trash(id: string): Promise<void>;
  restore(id: string): Promise<void>;
  deleteForever(id: string): Promise<void>;
  emptyTrash(): Promise<void>;
  createGroup(name: string, parentId?: string): Promise<string>;
  renameGroup(id: string, name: string): Promise<void>;
  deleteGroup(id: string): Promise<void>;
  /**
   * Add what's in a file to the vault: a KeePass file (KDBX 3 or 4, with its
   * password or key file), into a folder named after it; or another app's
   * export: a CSV from Google Passwords, Chrome, Firefox, Safari, Apple
   * Passwords, Bitwarden, 1Password, LastPass, KeePassXC, Proton Pass and the
   * like, read by its header row, or Bitwarden's unencrypted JSON. Items the
   * vault already has are skipped.
   */
  import(data: ArrayBuffer, options: PasswordsImportOptions): Promise<PasswordsImportResult>;
  generate(options?: GenerateOptions): Promise<string>;
  copy(id: string, field: CopyField): Promise<void>;
  onChanged(callback: (state: PasswordsState) => void): () => void;
}

/** A login field's place in its frame, as fractions of the frame's viewport. */
export interface FieldRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** Logins for the field the cursor just went into, for the desktop to show below it. */
export interface PasswordSuggestion {
  requestId: number;
  wcId: number;
  /** In a frame of its own, `rect` is that frame's; the list goes at the top of the page instead. */
  mainFrame: boolean;
  rect: FieldRect;
  kind: 'username' | 'password' | 'new-password';
  site: string;
  items: { id: string; title: string; username: string }[];
  /** The vault is locked: offer to unlock it. */
  locked: boolean;
  /** A strong password to offer, for a new-password field. */
  generated: string | null;
}

/** A submitted login the vault doesn't have, or has with another password. */
export interface PasswordOffer {
  offerId: number;
  wcId: number;
  site: string;
  username: string;
  update: boolean;
}

export type SuggestionChoice = { type: 'login'; id: string } | { type: 'generated' } | { type: 'dismiss' };

/** The desktop's extras: the browser's toolbar and autofill. */
export interface PasswordsDesktopBridge extends PasswordsBridge {
  /** The logins saved for a page's site. */
  siteLogins(url: string): Promise<PasswordSummary[]>;
  /** Fill a login into a page's login form (its frames on the login's site). Resolves how many frames got it. */
  fillPage(wcId: number, id: string): Promise<number>;
  choose(requestId: number, choice: SuggestionChoice): Promise<void>;
  highlight(requestId: number, highlighted: boolean): Promise<void>;
  answerOffer(offerId: number, answer: 'save' | 'never' | 'dismiss', username?: string): Promise<void>;
  onSuggest(callback: (suggestion: PasswordSuggestion) => void): () => void;
  onHide(callback: (requestId: number) => void): () => void;
  onKey(callback: (event: { requestId: number; key: 'ArrowDown' | 'ArrowUp' | 'Enter' | 'Escape' }) => void): () => void;
  onOffer(callback: (offer: PasswordOffer) => void): () => void;
  onOfferGone(callback: (offerId: number) => void): () => void;
}

declare global {
  interface Dinos {
    /** Present only inside the Electron shell. */
    passwords?: PasswordsDesktopBridge;
  }
}

/** Passwords, or undefined outside Electron (or in an app without the permission). */
export function getPasswordsBridge(): PasswordsBridge | undefined {
  if (typeof window === 'undefined') return undefined;
  // The app has it through window.din; the desktop, through window.dinos.
  return window.din?.system.passwords ?? window.dinos?.passwords;
}

/** The desktop's Passwords, with the browser's autofill. */
export function getPasswordsDesktopBridge(): PasswordsDesktopBridge | undefined {
  if (typeof window === 'undefined') return undefined;
  return window.dinos?.passwords;
}

/** Strip Electron's IPC error prefix so users see just the underlying message. */
export function cleanPasswordsError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.replace(/^Error invoking remote method '[^']*':\s*(?:Error:\s*)?/, '');
}
