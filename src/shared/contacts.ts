import type { FsBridge } from '@/lib/fs';
import type { PhoneContact } from '@/lib/phone';
import {
  blankContact,
  mergeContacts,
  parseVCards,
  sameContent,
  samePerson,
  serializeVCard,
  serializeVCards,
  type Contact,
} from './vcard';

/**
 * The address book: one vCard per contact in ~/.local/share/din/contacts/
 * (Contacts' own folder, its manifest's `din.folders`), the layout
 * vdirsyncer and khard call a vdir, so other tools can sync and read it.
 * The groups are the cards' CATEGORIES, plus `groups.json` for the order
 * of the list and the ones nobody's in yet. Contacts reaches the folder
 * through its scoped `din.system.fs`, the desktop's `din contacts`
 * through its own; both call these.
 */

export const CONTACTS_FOLDER = '.local/share/din/contacts';
const GROUPS_FILE = 'groups.json';

export type ContactsFs = Pick<FsBridge, 'homedir' | 'readdir' | 'readFile' | 'writeFile' | 'mkdir' | 'rm'>;

/** A contact, and the file it's in. */
export interface StoredContact extends Contact {
  path: string;
  /** Other cards are in the same file. */
  shared?: boolean;
}

export interface AddressBook {
  folder: string;
  contacts: StoredContact[];
  /** Every group, in the user's order: groups.json's, then any only cards name. */
  groups: string[];
}

export async function contactsFolder(fs: ContactsFs): Promise<string> {
  const home = (await fs.homedir()).replace(/\/+$/, '');
  return `${home}/${CONTACTS_FOLDER}`;
}

/** Where a contact's own card goes: its UID, made safe for a file name. */
function fileFor(folder: string, uid: string): string {
  const safe = uid.replace(/^urn:uuid:/i, '').replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^[.-]+/, '').slice(0, 120);
  return `${folder}/${safe || crypto.randomUUID()}.vcf`;
}

const decoder = new TextDecoder();

async function readText(fs: ContactsFs, path: string): Promise<string> {
  return decoder.decode((await fs.readFile(path, 32 * 1024 * 1024)).data);
}

function isMissing(error: unknown): boolean {
  return /ENOENT|no such file/i.test(error instanceof Error ? error.message : String(error));
}

async function readGroups(fs: ContactsFs, folder: string): Promise<string[]> {
  try {
    const value: unknown = JSON.parse(await readText(fs, `${folder}/${GROUPS_FILE}`));
    const list = value && typeof value === 'object' ? (value as { groups?: unknown }).groups : null;
    return Array.isArray(list) ? list.filter((g): g is string => typeof g === 'string' && !!g.trim()) : [];
  } catch {
    return [];
  }
}

async function writeGroups(fs: ContactsFs, folder: string, groups: string[]): Promise<void> {
  await fs.mkdir(folder);
  await fs.writeFile(`${folder}/${GROUPS_FILE}`, `${JSON.stringify({ groups: [...new Set(groups)] }, null, 2)}\n`);
}

/** Everything in the folder (none if it isn't there yet). */
export async function loadAddressBook(fs: ContactsFs): Promise<AddressBook> {
  const folder = await contactsFolder(fs);
  let names: string[] = [];
  try {
    names = (await fs.readdir(folder)).entries.filter((e) => e.kind === 'file' && /\.(vcf|vcard)$/i.test(e.name)).map((e) => e.name);
  } catch (error) {
    if (!isMissing(error)) throw error;
  }
  const files = await Promise.all(
    names.map(async (name) => {
      const path = `${folder}/${name}`;
      try {
        const cards = parseVCards(await readText(fs, path));
        return cards.map((c): StoredContact => ({ ...c, path, shared: cards.length > 1 || undefined }));
      } catch {
        return [];
      }
    }),
  );
  // Two files with the same card (a copy dropped in): the newer wins.
  const byUid = new Map<string, StoredContact>();
  for (const c of files.flat()) {
    const had = byUid.get(c.uid);
    if (!had || c.updated > had.updated) byUid.set(c.uid, c);
  }
  const contacts = [...byUid.values()];
  const listed = await readGroups(fs, folder);
  const named = contacts.flatMap((c) => c.groups);
  return { folder, contacts, groups: [...new Set([...listed, ...named])] };
}

/** A file of several cards loses one, or goes when it was the last. */
async function removeFromFile(fs: ContactsFs, path: string, uid: string): Promise<void> {
  let rest: Contact[];
  try {
    rest = parseVCards(await readText(fs, path)).filter((c) => c.uid !== uid);
  } catch (error) {
    if (isMissing(error)) return;
    throw error;
  }
  if (rest.length) await fs.writeFile(path, serializeVCards(rest));
  else await fs.rm(path);
}

/** Write a contact to its own file, stamped now; resolves with it as stored. */
export async function saveContact(fs: ContactsFs, contact: Contact, was?: StoredContact): Promise<StoredContact> {
  const folder = await contactsFolder(fs);
  await fs.mkdir(folder);
  const { path: _path, shared: _shared, ...card } = contact as Partial<StoredContact> & Contact;
  // A card keeps its file, unless it shared one with others (a file dropped into the folder).
  const keep = was && !was.shared && was.uid === contact.uid && was.path.startsWith(`${folder}/`);
  const stored: StoredContact = { ...card, updated: Date.now(), path: keep ? was.path : fileFor(folder, contact.uid) };
  await fs.writeFile(stored.path, serializeVCard(stored));
  if (was && was.path !== stored.path) await removeFromFile(fs, was.path, was.uid);
  return stored;
}

export async function deleteContacts(fs: ContactsFs, contacts: readonly StoredContact[]): Promise<void> {
  for (const c of contacts) await removeFromFile(fs, c.path, c.uid);
}

export interface ImportResult {
  added: number;
  /** Cards for someone already here: what they add was put in. */
  merged: number;
  /** Cards that add nothing to what's here. */
  unchanged: number;
  /** The contacts as stored now, in the cards' order. */
  contacts: StoredContact[];
}

/** Bring cards into the address book: someone already here (by UID, or by name and an email or number) gets what's new, anyone else is added. */
export async function importContacts(fs: ContactsFs, cards: readonly Contact[], book?: AddressBook): Promise<ImportResult> {
  const current = book ?? (await loadAddressBook(fs));
  const known = [...current.contacts];
  const result: ImportResult = { added: 0, merged: 0, unchanged: 0, contacts: [] };
  for (const card of cards) {
    const match = known.find((c) => c.uid === card.uid) ?? known.find((c) => samePerson(c, card));
    if (!match) {
      const uid = known.some((c) => c.uid === card.uid) ? crypto.randomUUID() : card.uid;
      const stored = await saveContact(fs, { ...card, uid });
      known.push(stored);
      result.added++;
      result.contacts.push(stored);
      continue;
    }
    const merged = mergeContacts(match, card);
    if (sameContent(merged, match)) {
      result.unchanged++;
      result.contacts.push(match);
      continue;
    }
    const stored = await saveContact(fs, merged, match);
    known[known.indexOf(match)] = stored;
    result.merged++;
    result.contacts.push(stored);
  }
  return result;
}

/** A group in the list, before anyone's in it. */
export async function addGroup(fs: ContactsFs, name: string): Promise<void> {
  const folder = await contactsFolder(fs);
  const book = await loadAddressBook(fs);
  if (!book.groups.includes(name)) await writeGroups(fs, folder, [...book.groups, name]);
}

/** Rename a group (`to` null deletes it), on every card in it; the contacts themselves stay. */
export async function changeGroup(fs: ContactsFs, from: string, to: string | null): Promise<void> {
  const book = await loadAddressBook(fs);
  for (const c of book.contacts) {
    if (!c.groups.includes(from)) continue;
    const groups = c.groups.flatMap((g) => (g === from ? (to && !c.groups.includes(to) ? [to] : []) : [g]));
    await saveContact(fs, { ...c, groups }, c);
  }
  const list = book.groups.flatMap((g) => (g === from ? (to ? [to] : []) : [g]));
  await writeGroups(fs, book.folder, list);
}

/** Put contacts in a group, or take them out. */
export async function setInGroup(fs: ContactsFs, contacts: readonly StoredContact[], group: string, inGroup: boolean): Promise<void> {
  for (const c of contacts) {
    if (c.groups.includes(group) === inGroup) continue;
    await saveContact(fs, { ...c, groups: inGroup ? [...c.groups, group] : c.groups.filter((g) => g !== group) }, c);
  }
}

/** A name written out, as a card's parts: the last word the family name, the rest given; anything that isn't words (a company, a number) as written. */
export function nameParts(name: string): Pick<Contact, 'given' | 'family' | 'formatted'> {
  const words = name.trim().split(/\s+/).filter(Boolean);
  if (words.length && words.every((w) => /\p{L}/u.test(w))) {
    const family = words.length > 1 ? words.pop()! : '';
    return { given: words.join(' '), family, formatted: '' };
  }
  return { given: '', family: '', formatted: name.trim() };
}

/** A contact from the phone's own list, as a card: its name and numbers. */
export function contactFromPhone(p: PhoneContact): Contact {
  return { ...blankContact(), ...nameParts(p.name), phones: p.numbers.map((value) => ({ label: 'mobile', value })) };
}
