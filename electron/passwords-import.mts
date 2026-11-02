// Reading other password managers' exports for Passwords' Import
// (passwords.mts puts what's read here into the vault; KeePass files it
// reads itself, with kdbxweb).
//
// CSV exports are read by their header row, whatever the app: Google
// Passwords and the Chromium browsers (name,url,username,password,note),
// Firefox, Safari and Apple Passwords, Bitwarden, 1Password, LastPass,
// KeePassXC, Proton Pass, Dashlane, NordPass and the like all name their
// columns something `COLUMNS` knows. Bitwarden's unencrypted JSON is read
// too, with its folders, cards and identities.
//
// Runs as TypeScript directly via Node's native type stripping - erasable
// syntax only, like the rest of electron/.

export interface ImportedField {
  name: string;
  value: string;
  protected: boolean;
}

/** One item read from an export, before it's in the vault. */
export interface ImportedItem {
  kind: 'login' | 'note';
  title: string;
  username: string;
  password: string;
  url: string;
  notes: string;
  otp: string;
  /** The folder it was in, as a path of names; empty for the top. */
  folder: string[];
  favorite: boolean;
  tags: string[];
  fields: ImportedField[];
  created: Date | null;
  modified: Date | null;
}

export interface ParsedExport {
  /** The app it came from, as far as can be told ("Google Passwords"), or "CSV". */
  source: string;
  items: ImportedItem[];
}

type Column = 'title' | 'url' | 'username' | 'email' | 'password' | 'notes' | 'otp' | 'folder' | 'favorite' | 'type' | 'tags' | 'created' | 'modified' | 'fields' | 'ignore';

/** Header names, lowercased with spaces and underscores dropped, to what they hold. */
const COLUMNS: Record<string, Column> = {
  name: 'title', title: 'title', loginname: 'title', itemname: 'title',
  url: 'url', loginuri: 'url', uri: 'url', website: 'url', websiteurl: 'url', loginurl: 'url', weburl: 'url', hostname: 'url',
  username: 'username', loginusername: 'username', login: 'username', user: 'username', userid: 'username',
  email: 'email', emailaddress: 'email',
  password: 'password', loginpassword: 'password', pass: 'password',
  note: 'notes', notes: 'notes', extra: 'notes', comment: 'notes', comments: 'notes',
  otpauth: 'otp', totp: 'otp', logintotp: 'otp', otp: 'otp', otpsecret: 'otp', otpurl: 'otp', onetimepassword: 'otp', twofactorsecret: 'otp',
  folder: 'folder', group: 'folder', grouping: 'folder', vault: 'folder', foldername: 'folder',
  favorite: 'favorite', favourite: 'favorite', fav: 'favorite', isfavorite: 'favorite',
  type: 'type', itemtype: 'type',
  tags: 'tags', tag: 'tags',
  created: 'created', createtime: 'created', timecreated: 'created', creationtime: 'created', createdat: 'created', datecreated: 'created',
  modified: 'modified', lastmodified: 'modified', modifytime: 'modified', timepasswordchanged: 'modified', modifiedat: 'modified', updatedat: 'modified', lastmodifiedat: 'modified',
  fields: 'fields',
  // Bookkeeping that means nothing in a vault.
  guid: 'ignore', httprealm: 'ignore', formactionorigin: 'ignore', timelastused: 'ignore', reprompt: 'ignore', icon: 'ignore',
  archived: 'ignore', id: 'ignore', uuid: 'ignore', lastused: 'ignore', passwordstrength: 'ignore', category: 'ignore',
};

/** Fields Passwords hides like a password, when an export's extra columns are kept. */
const SECRET_NAMES = /pass|secret|pin|cvv|cvc|code|number|ssn|key|token|answer/i;

const MAX_TEXT = 64 * 1024;

function clip(value: string): string {
  return value.length > MAX_TEXT ? value.slice(0, MAX_TEXT) : value;
}

/** RFC 4180, with the separator the header row uses (`,`, `;` or a tab). */
export function parseCsv(text: string): string[][] {
  const body = text.replace(/^\uFEFF/, '');
  const firstLine = body.slice(0, body.search(/\r?\n|$/));
  const unquoted = firstLine.replace(/"[^"]*"/g, '');
  const counts = [',', ';', '\t'].map((s) => [s, unquoted.split(s).length] as const);
  const separator = counts.reduce((a, b) => (b[1] > a[1] ? b : a))[0];
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let quoted = false;
  for (let i = 0; i < body.length; i++) {
    const c = body[i];
    if (quoted) {
      if (c === '"') {
        if (body[i + 1] === '"') {
          field += '"';
          i++;
        } else {
          quoted = false;
        }
      } else {
        field += c;
      }
    } else if (c === '"' && field === '') {
      quoted = true;
    } else if (c === separator) {
      row.push(field);
      field = '';
    } else if (c === '\n' || c === '\r') {
      if (c === '\r' && body[i + 1] === '\n') i++;
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
    } else {
      field += c;
    }
  }
  if (field !== '' || row.length > 0) {
    row.push(field);
    rows.push(row);
  }
  return rows.filter((r) => r.some((v) => v.trim() !== ''));
}

function headerKey(name: string): string {
  return name.trim().toLowerCase().replace(/[\s_\-.]/g, '');
}

function truthy(value: string): boolean {
  return /^(1|true|yes|y|x|\*)$/i.test(value.trim());
}

/** A time from an export: seconds or milliseconds since 1970, or a date string. */
function parseTime(value: string): Date | null {
  const v = value.trim();
  if (!v) return null;
  if (/^\d+(\.\d+)?$/.test(v)) {
    const n = Number(v);
    if (n > 1e14) return new Date(n / 1000); // microseconds
    if (n > 1e11) return new Date(n);
    if (n > 1e8) return new Date(n * 1000);
    return null;
  }
  const t = Date.parse(v);
  return Number.isNaN(t) ? null : new Date(t);
}

function sourceOf(keys: Set<string>): string {
  const has = (...names: string[]) => names.every((n) => keys.has(n));
  if (has('loginuri', 'loginpassword')) return 'Bitwarden';
  if (has('guid', 'httprealm')) return 'Firefox';
  if (has('otpauth', 'title') && !keys.has('archived')) return 'Apple Passwords';
  if (has('archived', 'otpauth')) return '1Password';
  if (has('grouping', 'extra')) return 'LastPass';
  if (has('group', 'lastmodified')) return 'KeePassXC';
  if (has('vault', 'createtime')) return 'Proton Pass';
  if (has('username2')) return 'Dashlane';
  if (has('cardholdername')) return 'NordPass';
  if (keys.size === 5 && has('name', 'url', 'username', 'password', 'note')) return 'Google Passwords';
  return 'CSV';
}

function blank(): ImportedItem {
  return {
    kind: 'login', title: '', username: '', password: '', url: '', notes: '', otp: '',
    folder: [], favorite: false, tags: [], fields: [], created: null, modified: null,
  };
}

/** Bitwarden's CSV `fields` column: "name: value" lines. */
function parseFieldLines(value: string): ImportedField[] {
  const fields: ImportedField[] = [];
  for (const line of value.split(/\r?\n/)) {
    const at = line.indexOf(': ');
    if (at <= 0) continue;
    const name = line.slice(0, at).trim();
    fields.push({ name, value: clip(line.slice(at + 2)), protected: SECRET_NAMES.test(name) });
  }
  return fields;
}

function folderPath(value: string): string[] {
  return value.split(/[/\\]/).map((s) => s.trim()).filter(Boolean);
}

export function parseCsvExport(text: string): ParsedExport {
  const rows = parseCsv(text);
  if (rows.length === 0) throw new Error('That file is empty');
  const header = rows[0].map(headerKey);
  const columns = header.map((key) => COLUMNS[key] ?? null);
  if (!columns.includes('password') && !(columns.includes('url') && columns.includes('username'))) {
    throw new Error('That doesn\'t look like a passwords export: it has no password column');
  }
  const keys = new Set(header);
  const source = sourceOf(keys);
  const items: ImportedItem[] = [];
  for (const row of rows.slice(1)) {
    const item = blank();
    let email = '';
    let type = '';
    header.forEach((key, i) => {
      const value = row[i] ?? '';
      if (!value.trim()) return;
      switch (columns[i]) {
        case 'title': item.title = clip(value.trim()); break;
        case 'url': item.url = item.url ? item.url : clip(value.trim()); break;
        case 'username': item.username = clip(value.trim()); break;
        case 'email': email = clip(value.trim()); break;
        case 'password': item.password = clip(value); break;
        case 'notes': item.notes = item.notes ? `${item.notes}\n\n${clip(value)}` : clip(value); break;
        case 'otp': item.otp = clip(value.trim()); break;
        case 'folder': item.folder = folderPath(value); break;
        case 'favorite': item.favorite = truthy(value); break;
        case 'type': type = value.trim().toLowerCase(); break;
        case 'tags': item.tags = value.split(/[,;]/).map((t) => t.trim()).filter(Boolean); break;
        case 'created': item.created = parseTime(value); break;
        case 'modified': item.modified = parseTime(value); break;
        case 'fields': item.fields.push(...parseFieldLines(value)); break;
        case 'ignore': break;
        default: {
          // A column of the app's own (Dashlane's username2, NordPass's card number…): kept as a field.
          const name = (rows[0][i] ?? key).trim();
          item.fields.push({ name, value: clip(value), protected: SECRET_NAMES.test(name) });
        }
      }
    });
    if (email) {
      if (!item.username) item.username = email;
      else if (email !== item.username) item.fields.push({ name: 'Email', value: email, protected: false });
    }
    // LastPass's secure notes are rows with the URL http://sn.
    if (item.url === 'http://sn') {
      item.url = '';
      type = 'note';
    }
    if (type === 'note' || type === 'securenote' || type === 'secure note') item.kind = 'note';
    if (item.kind === 'login' && !item.password && !item.username && !item.url && item.notes) item.kind = 'note';
    if (!item.password && !item.username && !item.notes && !item.otp && item.fields.length === 0) continue;
    items.push(item);
  }
  if (source === 'KeePassXC') stripCommonRoot(items);
  return { source, items };
}

/** KeePassXC writes every group path from the root ("Passwords/Email"): the root goes. */
function stripCommonRoot(items: ImportedItem[]): void {
  const first = items[0]?.folder[0];
  if (!first || !items.every((i) => i.folder[0] === first)) return;
  for (const item of items) item.folder = item.folder.slice(1);
}

// ---------------------------------------------------------------------------
// Bitwarden JSON
// ---------------------------------------------------------------------------

function str(value: unknown): string {
  return typeof value === 'string' ? clip(value) : typeof value === 'number' ? String(value) : '';
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

/** A card's or identity's details, as fields. */
function detailFields(details: Record<string, unknown>): ImportedField[] {
  const fields: ImportedField[] = [];
  for (const [key, value] of Object.entries(details)) {
    const text = str(value).trim();
    if (!text) continue;
    const name = key.replace(/([a-z])([A-Z])/g, '$1 $2').replace(/^./, (c) => c.toUpperCase());
    fields.push({ name, value: text, protected: SECRET_NAMES.test(key) });
  }
  return fields;
}

export function parseJsonExport(text: string): ParsedExport {
  let data: Record<string, unknown>;
  try {
    data = record(JSON.parse(text.replace(/^\uFEFF/, '')));
  } catch {
    throw new Error('That file isn\'t a passwords export Passwords can read');
  }
  if (data.encrypted === true) {
    throw new Error('That Bitwarden export is encrypted. Export it again as “.json” rather than “.json (Encrypted)”.');
  }
  if (!Array.isArray(data.items)) throw new Error('That file isn\'t a passwords export Passwords can read');
  const folders = new Map<string, string>();
  for (const f of Array.isArray(data.folders) ? data.folders : []) {
    const folder = record(f);
    if (typeof folder.id === 'string') folders.set(folder.id, str(folder.name));
  }
  const items: ImportedItem[] = [];
  for (const raw of data.items) {
    const entry = record(raw);
    const item = blank();
    item.title = str(entry.name).trim();
    item.notes = str(entry.notes);
    item.favorite = entry.favorite === true;
    const folder = typeof entry.folderId === 'string' ? folders.get(entry.folderId) : undefined;
    if (folder) item.folder = folderPath(folder);
    item.created = typeof entry.creationDate === 'string' ? parseTime(entry.creationDate) : null;
    item.modified = typeof entry.revisionDate === 'string' ? parseTime(entry.revisionDate) : null;
    const login = record(entry.login);
    if (entry.type === 1) {
      item.username = str(login.username).trim();
      item.password = str(login.password);
      item.otp = str(login.totp).trim();
      const uris = (Array.isArray(login.uris) ? login.uris : []).map((u) => str(record(u).uri).trim()).filter(Boolean);
      item.url = uris[0] ?? '';
      uris.slice(1).forEach((uri, i) => item.fields.push({ name: i === 0 ? 'KP2A_URL' : `KP2A_URL_${i}`, value: uri, protected: false }));
    } else {
      item.kind = 'note';
      if (entry.type === 3) item.fields.push(...detailFields(record(entry.card)));
      if (entry.type === 4) item.fields.push(...detailFields(record(entry.identity)));
    }
    for (const f of Array.isArray(entry.fields) ? entry.fields : []) {
      const field = record(f);
      const name = str(field.name).trim();
      // 3 is a field linked to another, which has no value of its own.
      if (!name || field.type === 3) continue;
      item.fields.push({ name, value: str(field.value), protected: field.type === 1 });
    }
    if (!item.password && !item.username && !item.notes && !item.otp && item.fields.length === 0 && !item.title) continue;
    items.push(item);
  }
  return { source: 'Bitwarden', items };
}
