// Mail's rules and blocked senders (electron/mail.mts runs them): what
// they are, how a message is matched against them, the Sieve script
// (RFC 5228) that says the same to a mail server, and the ManageSieve
// client (RFC 5804) that puts it there.
//
// The rules Din keeps are its own structured ones, not Sieve, so Mail can
// show and edit them; the script is made from them, and carries them too
// (in a comment, with a hash of the rest), so another computer's Din can
// read them back and a script edited by something else is told from one
// Din wrote. Sieve has no way to say "only while Din runs", so whatever a
// server can't run (it lacks an extension), Din runs itself on new mail.
//
// ManageSieve is a line protocol on port 4190, signed in to with the same
// user and password as IMAP, over STARTTLS (never in the clear, except to a
// bridge on this computer).

import net from 'node:net';
import tls from 'node:tls';
import { createHash, randomUUID } from 'node:crypto';
import type { BlockedSender, MailAddress, MailRule, RuleAction, RuleCondition, RuleField, RuleMatch } from '../src/lib/mail.ts';

export const SIEVE_PORT = 4190;
/** The script Din keeps on the server. */
export const SCRIPT_NAME = 'din';
export const RULES_MAX = 500;
export const BLOCKED_MAX = 5000;
const CONDITIONS_MAX = 20;
const ACTIONS_MAX = 10;
const VALUE_MAX = 500;

const FIELDS: readonly RuleField[] = ['from', 'to', 'subject', 'list-id', 'header'];
const MATCHES: Record<RuleField, readonly RuleMatch[]> = {
  from: ['contains', 'is', 'domain'],
  to: ['contains', 'is', 'domain'],
  subject: ['contains', 'is'],
  'list-id': ['contains'],
  header: ['contains', 'is'],
};
const HEADER_NAME = /^[A-Za-z0-9-]{1,64}$/;
/** An address, or a domain for `domain` and `@domain` blocks: no spaces, quotes or brackets. */
const ADDRESS = /^[^\s@<>"\\]+@[^\s@<>"\\]+\.[^\s@<>"\\]+$/;
const DOMAIN = /^[a-z0-9-]+(\.[a-z0-9-]+)+$/i;

// ---------------------------------------------------------------------------
// What a rule is
// ---------------------------------------------------------------------------

function plainText(v: unknown, max: number, what: string): string {
  if (typeof v !== 'string') throw new Error(`${what} is missing.`);
  const s = v.trim();
  // Control characters (newlines most of all) would end a Sieve string's line or a header's.
  if ([...s].some((ch) => ch.charCodeAt(0) < 0x20 || ch.charCodeAt(0) === 0x7f)) throw new Error(`${what} can’t have line breaks in it.`);
  if (s.length > max) throw new Error(`${what} is too long.`);
  return s;
}

function conditionOf(v: unknown): RuleCondition {
  const c = (v ?? {}) as Partial<RuleCondition>;
  if (!FIELDS.includes(c.field as RuleField)) throw new Error('A condition looks at something Mail doesn’t know.');
  const field = c.field as RuleField;
  if (!MATCHES[field].includes(c.match as RuleMatch)) throw new Error('A condition matches in a way that doesn’t fit what it looks at.');
  const match = c.match as RuleMatch;
  let value = plainText(c.value, VALUE_MAX, 'A condition’s words');
  if (!value) throw new Error('A condition has nothing to match.');
  if (match === 'is' && (field === 'from' || field === 'to')) {
    value = value.toLowerCase();
    if (!ADDRESS.test(value)) throw new Error(`${value} isn’t an email address.`);
  }
  if (match === 'domain') {
    value = value.toLowerCase().replace(/^.*@/, '');
    if (!DOMAIN.test(value)) throw new Error(`${value} isn’t a domain.`);
  }
  const out: RuleCondition = { field, match, value };
  if (field === 'header') {
    const header = plainText(c.header, 64, 'The header’s name');
    if (!HEADER_NAME.test(header)) throw new Error('That isn’t a header’s name.');
    out.header = header.toLowerCase();
  }
  return out;
}

function actionOf(v: unknown): RuleAction {
  const a = (v ?? {}) as { type?: unknown; to?: unknown; label?: unknown };
  switch (a.type) {
    case 'move': {
      const special = (a.to as { special?: unknown } | null)?.special;
      if (special === 'junk' || special === 'trash' || special === 'archive') return { type: 'move', to: { special } };
      const to = plainText(a.to, 1000, 'The mailbox');
      if (!to) throw new Error('Say which mailbox to move it to.');
      return { type: 'move', to };
    }
    case 'label': {
      const label = plainText(a.label, 1000, 'The label');
      if (!label) throw new Error('Say which label to put on it.');
      return { type: 'label', label };
    }
    case 'read':
    case 'flag':
      return { type: a.type };
    case 'forward': {
      const to = plainText(a.to, 320, 'The address to forward to').toLowerCase();
      if (!ADDRESS.test(to)) throw new Error(`${to || 'That'} isn’t an email address to forward to.`);
      return { type: 'forward', to };
    }
    default:
      throw new Error('A rule does something Mail doesn’t know.');
  }
}

/** A rule as the app or `din mail` gave it, checked; a new one gets an id. */
export function ruleOf(v: unknown): MailRule {
  const r = (v ?? {}) as Partial<MailRule>;
  if (!Array.isArray(r.conditions) || !r.conditions.length) throw new Error('A rule needs something to look for.');
  if (r.conditions.length > CONDITIONS_MAX) throw new Error('That rule has too many conditions.');
  if (!Array.isArray(r.actions) || !r.actions.length) throw new Error('A rule needs something to do.');
  if (r.actions.length > ACTIONS_MAX) throw new Error('That rule does too many things.');
  const actions = r.actions.map(actionOf);
  if (actions.filter((a) => a.type === 'move').length > 1) throw new Error('A rule can move mail to one place.');
  const id = typeof r.id === 'string' && /^[\w-]{1,64}$/.test(r.id) ? r.id : randomUUID();
  return {
    id,
    name: plainText(r.name ?? '', 200, 'The rule’s name'),
    enabled: r.enabled !== false,
    match: r.match === 'any' ? 'any' : 'all',
    conditions: r.conditions.map(conditionOf),
    actions,
    stop: r.stop === true,
  };
}

/** A sender to block, as typed: an address, or a domain (`@example.com`, or just `example.com`). */
export function senderOf(v: unknown): string {
  const s = typeof v === 'string' ? v.trim().toLowerCase().replace(/^<|>$/g, '') : '';
  if (ADDRESS.test(s)) return s;
  const domain = s.replace(/^@/, '');
  if (DOMAIN.test(domain)) return `@${domain}`;
  throw new Error(`${s || 'That'} isn’t an email address or a domain.`);
}

export function rulesFrom(v: unknown): MailRule[] | undefined {
  if (!Array.isArray(v)) return undefined;
  const out: MailRule[] = [];
  for (const r of v.slice(0, RULES_MAX)) {
    try {
      out.push(ruleOf(r));
    } catch {
      // A rule this Din can't read (a newer one's): left out rather than half-run.
    }
  }
  return out;
}

export function blockedFrom(v: unknown): BlockedSender[] | undefined {
  if (!Array.isArray(v)) return undefined;
  const out: BlockedSender[] = [];
  const seen = new Set<string>();
  for (const b of v.slice(0, BLOCKED_MAX)) {
    const x = b as Partial<BlockedSender>;
    try {
      const sender = senderOf(x.sender);
      if (seen.has(sender)) continue;
      seen.add(sender);
      out.push({ sender, to: x.to === 'trash' ? 'trash' : 'junk', added: typeof x.added === 'number' ? x.added : 0 });
    } catch {
      // Unreadable: left out.
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Matching a message, as the server's Sieve would
// ---------------------------------------------------------------------------

/** What a rule is matched against: the envelope's addresses and subject, and the headers the rules name (lowercase). */
export interface RuleMessage {
  from: MailAddress[];
  to: MailAddress[];
  subject: string;
  headers: Map<string, string[]>;
}

/** The headers to fetch for these rules, beyond the envelope. */
export function neededHeaders(rules: MailRule[]): string[] {
  const out = new Set<string>();
  for (const r of rules) {
    for (const c of r.conditions) {
      if (c.field === 'list-id') out.add('list-id');
      else if (c.field === 'header' && c.header) out.add(c.header);
    }
  }
  return [...out];
}

function domainMatches(address: string, domain: string): boolean {
  const d = address.toLowerCase().split('@').pop() ?? '';
  return d === domain || d.endsWith(`.${domain}`);
}

function addressMatches(list: MailAddress[], match: RuleMatch, value: string): boolean {
  const v = value.toLowerCase();
  return list.some((a) => {
    if (match === 'is') return a.address.toLowerCase() === v;
    if (match === 'domain') return domainMatches(a.address, v);
    return `${a.name} <${a.address}>`.toLowerCase().includes(v);
  });
}

function textMatches(values: string[], match: RuleMatch, value: string): boolean {
  const v = value.toLowerCase();
  return values.some((x) => (match === 'is' ? x.trim().toLowerCase() === v : x.toLowerCase().includes(v)));
}

export function conditionMatches(c: RuleCondition, m: RuleMessage): boolean {
  switch (c.field) {
    case 'from':
      return addressMatches(m.from, c.match, c.value);
    case 'to':
      return addressMatches(m.to, c.match, c.value);
    case 'subject':
      return textMatches([m.subject], c.match, c.value);
    case 'list-id':
      return textMatches(m.headers.get('list-id') ?? [], c.match, c.value);
    case 'header':
      return textMatches(m.headers.get(c.header ?? '') ?? [], c.match, c.value);
  }
}

export function ruleMatches(r: MailRule, m: RuleMessage): boolean {
  return r.match === 'any' ? r.conditions.some((c) => conditionMatches(c, m)) : r.conditions.every((c) => conditionMatches(c, m));
}

export function blockMatches(b: BlockedSender, m: RuleMessage): boolean {
  return b.sender.startsWith('@') ? m.from.some((a) => domainMatches(a.address, b.sender.slice(1))) : m.from.some((a) => a.address.toLowerCase() === b.sender);
}

// ---------------------------------------------------------------------------
// The Sieve script
// ---------------------------------------------------------------------------

/** What's kept in the script's comment for Din to read back. */
export interface CarriedRules {
  /** When the rules last changed, ms: the newer of the server's and this computer's wins. */
  updated: number;
  blocked: BlockedSender[];
  rules: MailRule[];
}

/** Where moves go on this server: its junk, trash and archive mailboxes' paths. */
export interface SievePlaces {
  junk: string;
  trash: string;
  archive: string;
}

const CARRIED = '# din-rules ';
const HASHED = '# din-sha256 ';

function str(s: string): string {
  return `"${s.replace(/[\\"]/g, (c) => `\\${c}`)}"`;
}

function strList(list: string[]): string {
  return list.length === 1 ? str(list[0]) : `[${list.map(str).join(', ')}]`;
}

function sha256(s: string): string {
  return createHash('sha256').update(s, 'utf8').digest('hex');
}

/** A condition as a Sieve test. */
function test(c: RuleCondition): string {
  const headers = c.field === 'from' ? ['from'] : c.field === 'to' ? ['to', 'cc'] : c.field === 'subject' ? ['subject'] : c.field === 'list-id' ? ['list-id'] : [c.header ?? ''];
  if ((c.field === 'from' || c.field === 'to') && c.match === 'is') return `address :all :is ${strList(headers)} ${str(c.value)}`;
  if ((c.field === 'from' || c.field === 'to') && c.match === 'domain') return `address :domain :matches ${strList(headers)} ${strList([c.value, `*.${c.value}`])}`;
  // :is and :contains take * and ? as they are (only :matches reads them as wildcards).
  return `header ${c.match === 'is' ? ':is' : ':contains'} ${strList(headers)} ${str(c.value)}`;
}

function placeOf(to: string | { special: 'junk' | 'trash' | 'archive' }, places: SievePlaces): string {
  return typeof to === 'string' ? to : places[to.special];
}

/**
 * The script for these rules, on a server with these extensions: the
 * blocked senders first, then each enabled rule in order. What the server
 * can't do is left out of it (Din does it on new mail itself). `include`,
 * the user's own script to run after Din's, where the server can.
 */
export function sieveScript(carried: CarriedRules, places: SievePlaces, extensions: ReadonlySet<string>, include: string | null = null): string {
  const has = (x: string) => extensions.has(x);
  const needs = new Set<string>();
  const body: string[] = [];

  if (has('fileinto') && carried.blocked.length) {
    needs.add('fileinto');
    body.push('# Blocked senders');
    for (const to of ['junk', 'trash'] as const) {
      const list = carried.blocked.filter((b) => b.to === to);
      const addresses = list.filter((b) => !b.sender.startsWith('@')).map((b) => b.sender);
      const domains = list.filter((b) => b.sender.startsWith('@')).map((b) => b.sender.slice(1));
      const tests = [
        ...(addresses.length ? [`address :all :is "from" ${strList(addresses)}`] : []),
        ...(domains.length ? [`address :domain :matches "from" ${strList(domains.flatMap((d) => [d, `*.${d}`]))}`] : []),
      ];
      if (!tests.length) continue;
      body.push(`if ${tests.length > 1 ? `anyof (${tests.join(', ')})` : tests[0]} {`, `  fileinto ${str(places[to])};`, '  stop;', '}');
    }
  }

  for (const r of carried.rules) {
    if (!r.enabled) continue;
    const lines: string[] = [];
    let moves = false;
    let forwards = false;
    // Flags first: imap4flags' flags go with the fileinto (or the keep) after them.
    const flags: string[] = [];
    for (const a of r.actions) {
      if (a.type === 'read') flags.push('\\Seen');
      else if (a.type === 'flag') flags.push('\\Flagged');
      else if (a.type === 'label') flags.push(a.label);
    }
    if (flags.length && has('imap4flags')) {
      needs.add('imap4flags');
      lines.push(`  addflag ${strList(flags)};`);
    }
    for (const a of r.actions) {
      if (a.type === 'forward') {
        forwards = true;
        if (has('copy')) {
          needs.add('copy');
          lines.push(`  redirect :copy ${str(a.to)};`);
        } else {
          lines.push(`  redirect ${str(a.to)};`);
        }
      }
    }
    const move = r.actions.find((a) => a.type === 'move');
    if (move && move.type === 'move' && has('fileinto')) {
      needs.add('fileinto');
      lines.push(`  fileinto ${str(placeOf(move.to, places))};`);
      moves = true;
    }
    // A redirect without :copy cancels keeping it: keep it all the same, unless it was filed.
    if (forwards && !has('copy') && !moves) lines.push('  keep;');
    if (r.stop) lines.push('  stop;');
    if (!lines.length) continue;
    const tests = r.conditions.map(test);
    const cond = tests.length === 1 ? tests[0] : `${r.match === 'any' ? 'anyof' : 'allof'} (${tests.join(', ')})`;
    body.push(`# ${(r.name || 'Rule').replace(/[\r\n]/g, ' ')}`, `if ${cond} {`, ...lines, '}');
  }

  if (include && has('include')) {
    needs.add('include');
    body.push('# Your own rules, from before', `include :personal ${str(include)};`);
  }

  const require = needs.size ? [`require ${strList([...needs].sort())};`] : [];
  const rest = [...require, ...body].join('\r\n') + '\r\n';
  const json = Buffer.from(JSON.stringify(carried), 'utf8').toString('base64');
  return [
    '# Mail’s rules, from Din. Change them in Din’s Mail (Settings → Rules) or with `din mail rules`:',
    '# Din puts this script back as its rules say, and leaves it alone once it’s changed anywhere else.',
    `${CARRIED}${json}`,
    `${HASHED}${sha256(rest)}`,
    rest,
  ].join('\r\n');
}

/** What a script Din wrote carries, or `edited` when it's been changed since (or isn't Din's). */
export function readScript(script: string): CarriedRules | 'edited' {
  const lines = script.split(/\r?\n/);
  const carried = lines.findIndex((l) => l.startsWith(CARRIED));
  const hashed = lines.findIndex((l) => l.startsWith(HASHED));
  if (carried < 0 || hashed !== carried + 1) return 'edited';
  const rest = lines.slice(hashed + 1).join('\r\n');
  if (sha256(rest) !== lines[hashed].slice(HASHED.length).trim()) return 'edited';
  try {
    const data = JSON.parse(Buffer.from(lines[carried].slice(CARRIED.length).trim(), 'base64').toString('utf8')) as Partial<CarriedRules>;
    return {
      updated: typeof data.updated === 'number' ? data.updated : 0,
      blocked: blockedFrom(data.blocked) ?? [],
      rules: rulesFrom(data.rules) ?? [],
    };
  } catch {
    return 'edited';
  }
}

// ---------------------------------------------------------------------------
// ManageSieve (RFC 5804)
// ---------------------------------------------------------------------------

/** A word of a server's line: an atom (OK, ACTIVE…), or a string (quoted or a literal). */
interface Token {
  value: string;
  atom: boolean;
}

interface Response {
  /** The lines before the status, each as its words. */
  lines: Token[][];
  status: 'OK' | 'NO' | 'BYE';
  /** The status's text, or the code in brackets when there's none. */
  text: string;
}

const TIMEOUT_MS = 15_000;

export class SieveError extends Error {
  /** It never answered as ManageSieve: nothing's there. */
  readonly unreachable: boolean;
  constructor(message: string, unreachable = false) {
    super(message);
    this.unreachable = unreachable;
  }
}

export interface SieveSession {
  /** The server's capabilities, uppercased names: SIEVE (its extensions), SASL, STARTTLS, IMPLEMENTATION… */
  capabilities: Map<string, string>;
  extensions: Set<string>;
  list(): Promise<{ name: string; active: boolean }[]>;
  get(name: string): Promise<string>;
  put(name: string, script: string): Promise<void>;
  setActive(name: string): Promise<void>;
}

class Connection {
  private socket: net.Socket;
  private buffer = Buffer.alloc(0);
  private waiting: (() => void) | null = null;
  private failed: Error | null = null;

  constructor(socket: net.Socket) {
    this.socket = socket;
    this.attach(socket);
  }

  private attach(socket: net.Socket): void {
    socket.setTimeout(TIMEOUT_MS);
    socket.on('data', (chunk: Buffer) => {
      this.buffer = Buffer.concat([this.buffer, chunk]);
      this.wake();
    });
    socket.on('timeout', () => socket.destroy(new SieveError('The server’s rules didn’t answer in time.', true)));
    socket.on('error', (error: Error) => {
      this.failed ??= error;
      this.wake();
    });
    socket.on('close', () => {
      this.failed ??= new SieveError('The server closed the connection.');
      this.wake();
    });
  }

  private wake(): void {
    const w = this.waiting;
    this.waiting = null;
    w?.();
  }

  private async more(): Promise<void> {
    if (this.failed) throw this.failed;
    await new Promise<void>((resolve) => (this.waiting = resolve));
    if (this.failed && !this.buffer.length) throw this.failed;
  }

  async line(): Promise<string> {
    for (;;) {
      const at = this.buffer.indexOf('\r\n');
      if (at >= 0) {
        const line = this.buffer.subarray(0, at).toString('utf8');
        this.buffer = this.buffer.subarray(at + 2);
        return line;
      }
      if (this.buffer.length > 1024 * 1024) throw new SieveError('The server sent too long a line.');
      await this.more();
    }
  }

  async bytes(n: number): Promise<string> {
    while (this.buffer.length < n) await this.more();
    const out = this.buffer.subarray(0, n).toString('utf8');
    this.buffer = this.buffer.subarray(n);
    return out;
  }

  write(s: string): void {
    this.socket.write(s, 'utf8');
  }

  /** Go on over TLS: after STARTTLS's OK. */
  async startTls(host: string): Promise<void> {
    const plain = this.socket;
    plain.removeAllListeners('data');
    plain.removeAllListeners('timeout');
    plain.removeAllListeners('close');
    plain.removeAllListeners('error');
    this.buffer = Buffer.alloc(0);
    const secure = tls.connect({ socket: plain, servername: net.isIP(host) ? undefined : host });
    await new Promise<void>((resolve, reject) => {
      secure.once('secureConnect', resolve);
      secure.once('error', reject);
    });
    this.socket = secure;
    this.failed = null;
    this.attach(secure);
  }

  close(): void {
    this.socket.destroy();
  }

  /** One logical line's words, literals ({n} or {n+} and the n bytes after) taken in. */
  async tokens(): Promise<Token[]> {
    const out: Token[] = [];
    let line = await this.line();
    for (;;) {
      let i = 0;
      let literal: number | null = null;
      while (i < line.length) {
        const c = line[i];
        if (c === ' ') {
          i++;
        } else if (c === '"') {
          let s = '';
          i++;
          while (i < line.length && line[i] !== '"') {
            if (line[i] === '\\' && i + 1 < line.length) i++;
            s += line[i++];
          }
          i++;
          out.push({ value: s, atom: false });
        } else if (c === '{' && /^\{\d+\+?\}$/.test(line.slice(i))) {
          literal = Number(line.slice(i + 1).replace(/\+?\}$/, ''));
          break;
        } else if (c === '(') {
          // A response code, (QUOTA) or (WARNINGS): kept as an atom with its brackets.
          const end = line.indexOf(')', i);
          const stop = end < 0 ? line.length : end + 1;
          out.push({ value: line.slice(i, stop), atom: true });
          i = stop;
        } else {
          let j = i;
          while (j < line.length && line[j] !== ' ') j++;
          out.push({ value: line.slice(i, j), atom: true });
          i = j;
        }
      }
      if (literal === null) return out;
      if (literal > 4 * 1024 * 1024) throw new SieveError('The server sent too big a script.');
      out.push({ value: await this.bytes(literal), atom: false });
      line = await this.line();
    }
  }

  async response(): Promise<Response> {
    const lines: Token[][] = [];
    for (;;) {
      const t = await this.tokens();
      const head = t[0];
      if (head?.atom && /^(OK|NO|BYE)$/i.test(head.value)) {
        const words = t.slice(1);
        const text = words.find((w) => !w.atom)?.value ?? words.map((w) => w.value).join(' ');
        return { lines, status: head.value.toUpperCase() as Response['status'], text };
      }
      lines.push(t);
    }
  }

  async command(line: string): Promise<Response> {
    this.write(`${line}\r\n`);
    const r = await this.response();
    if (r.status !== 'OK') throw new SieveError(r.text || `The server said ${r.status}.`);
    return r;
  }
}

function quoted(s: string): string {
  if (/[\r\n]/.test(s)) throw new SieveError('A script’s name can’t have line breaks.');
  return `"${s.replace(/[\\"]/g, (c) => `\\${c}`)}"`;
}

function capabilities(r: Response): Map<string, string> {
  const out = new Map<string, string>();
  for (const line of r.lines) if (line[0]) out.set(line[0].value.toUpperCase(), line[1]?.value ?? '');
  return out;
}

function isLocal(host: string): boolean {
  return host === 'localhost' || host === '127.0.0.1' || host === '::1';
}

/**
 * Sign in to a ManageSieve server and run `fn` there. Over STARTTLS only
 * (a bridge on this computer may go without); with SASL PLAIN.
 */
export async function withSieve<T>(server: { host: string; port: number; user: string }, password: string, fn: (s: SieveSession) => Promise<T>): Promise<T> {
  const socket = await new Promise<net.Socket>((resolve, reject) => {
    const s = net.connect({ host: server.host, port: server.port });
    const fail = (error: Error) => {
      s.destroy();
      reject(new SieveError(`The server has no rules service (${(error as { code?: string }).code ?? error.message}).`, true));
    };
    s.setTimeout(8000, () => fail(new Error('no answer')));
    s.once('error', fail);
    s.once('connect', () => {
      s.setTimeout(0);
      s.removeListener('error', fail);
      resolve(s);
    });
  });
  const c = new Connection(socket);
  try {
    let caps: Map<string, string>;
    try {
      caps = capabilities(await c.response());
    } catch (error) {
      throw error instanceof SieveError ? new SieveError(error.message, true) : new SieveError('The server didn’t answer as a rules service.', true);
    }
    if (!caps.has('SIEVE')) throw new SieveError('The server didn’t answer as a rules service.', true);
    if (caps.has('STARTTLS')) {
      await c.command('STARTTLS');
      await c.startTls(server.host);
      caps = capabilities(await c.response());
    } else if (!isLocal(server.host)) {
      throw new SieveError('The server’s rules service doesn’t offer TLS, so the password can’t be sent to it safely.');
    }
    const sasl = (caps.get('SASL') ?? '').toUpperCase().split(/\s+/);
    if (!sasl.includes('PLAIN')) throw new SieveError('The server’s rules service doesn’t take a password the way Mail signs in.');
    const auth = Buffer.from(`\0${server.user}\0${password}`, 'utf8').toString('base64');
    try {
      await c.command(`AUTHENTICATE "PLAIN" "${auth}"`);
    } catch (error) {
      throw new SieveError(`The server’s rules service didn’t take the password: ${error instanceof Error ? error.message : String(error)}`);
    }
    const extensions = new Set((caps.get('SIEVE') ?? '').toLowerCase().split(/\s+/).filter(Boolean));
    const session: SieveSession = {
      capabilities: caps,
      extensions,
      async list() {
        const r = await c.command('LISTSCRIPTS');
        return r.lines.filter((l) => l[0] && !l[0].atom).map((l) => ({ name: l[0].value, active: l[1]?.atom === true && l[1].value.toUpperCase() === 'ACTIVE' }));
      },
      async get(name) {
        const r = await c.command(`GETSCRIPT ${quoted(name)}`);
        return r.lines[0]?.[0]?.value ?? '';
      },
      async put(name, script) {
        const bytes = Buffer.byteLength(script, 'utf8');
        await c.command(`PUTSCRIPT ${quoted(name)} {${bytes}+}\r\n${script}`);
      },
      async setActive(name) {
        await c.command(`SETACTIVE ${quoted(name)}`);
      },
    };
    const out = await fn(session);
    c.write('LOGOUT\r\n');
    return out;
  } finally {
    c.close();
  }
}
