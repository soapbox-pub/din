import { getFsBridge } from '@/lib/fs';
import {
  addGroup,
  changeGroup,
  deleteContacts,
  importContacts,
  loadAddressBook,
  nameParts,
  saveContact,
  setInGroup,
  type ContactsFs,
  type StoredContact,
} from '@/shared/contacts';
import {
  blankContact,
  compareContacts,
  contactMatches,
  displayName,
  parseVCards,
  serializeVCards,
  type Contact,
} from '@/shared/vcard';
import { CommandError, type Area, type Param } from './types';
import { call, command, need, pick } from './util';

/**
 * `din contacts`: the address book Contacts keeps, one vCard each in
 * ~/.local/share/din/contacts (src/shared/contacts.ts, which Contacts calls
 * too): list and show people, add and change them, delete (asks on screen
 * first), groups, importing and exporting .vcf files, and opening Contacts
 * on someone.
 */

const CONTACT: Param = { name: 'contact', type: 'string', positional: true, help: 'Who: a name, an email, a number, or a UID' };
const FIELDS: Param[] = [
  { name: 'email', type: 'string', optional: true, help: 'Email addresses, separated by commas' },
  { name: 'phone', type: 'string', optional: true, help: 'Phone numbers, separated by commas' },
  { name: 'company', type: 'string', optional: true, help: 'Where they work' },
  { name: 'title', type: 'string', optional: true, help: 'Their job title' },
  { name: 'birthday', type: 'string', optional: true, help: 'YYYY-MM-DD, or MM-DD without the year' },
  { name: 'note', type: 'string', optional: true, help: 'Notes' },
];

function fsOf(): ContactsFs {
  return need(getFsBridge(), 'The address book');
}

async function book(fs: ContactsFs) {
  return call(loadAddressBook(fs));
}

function find(contacts: readonly StoredContact[], query: string): StoredContact {
  return pick(contacts, query, (c) => [c.uid, displayName(c), c.nickname, ...c.emails.map((e) => e.value), ...c.phones.map((p) => p.value)], 'contact');
}

function list(value: string | undefined): string[] {
  return (value ?? '').split(',').map((s) => s.trim()).filter(Boolean);
}

function birthday(value: string): string {
  const s = value.trim();
  if (!s) return '';
  const full = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
  const noYear = /^(?:--)?(\d{2})-(\d{2})$/.exec(s);
  const [month, day] = full ? [full[2], full[3]] : noYear ? [noYear[1], noYear[2]] : ['', ''];
  if (!month || +month < 1 || +month > 12 || +day < 1 || +day > 31) throw new CommandError(`Not a birthday (YYYY-MM-DD or MM-DD): ${value}`, 'usage');
  return full ? s : `--${month}-${day}`;
}

/** What `add` and `edit` were given, over a card. */
function withFields(c: Contact, args: { optString(name: string): string | undefined }, labels: { email: string; phone: string }): Contact {
  const out = { ...c };
  const email = args.optString('email');
  const phone = args.optString('phone');
  if (email !== undefined) out.emails = list(email).map((value, i) => ({ label: c.emails[i]?.label ?? labels.email, value }));
  if (phone !== undefined) out.phones = list(phone).map((value, i) => ({ label: c.phones[i]?.label ?? labels.phone, value }));
  if (args.optString('company') !== undefined) out.organization = args.optString('company')!.trim();
  if (args.optString('title') !== undefined) out.title = args.optString('title')!.trim();
  if (args.optString('birthday') !== undefined) out.birthday = birthday(args.optString('birthday')!);
  if (args.optString('note') !== undefined) out.note = args.optString('note')!.trim();
  return out;
}

function summary(c: StoredContact) {
  return {
    name: displayName(c),
    uid: c.uid,
    company: c.organization || undefined,
    title: c.title || undefined,
    phones: c.phones,
    emails: c.emails,
    addresses: c.addresses.length ? c.addresses : undefined,
    urls: c.urls.length ? c.urls : undefined,
    birthday: c.birthday || undefined,
    groups: c.groups.length ? c.groups : undefined,
    note: c.note || undefined,
    file: c.path,
  };
}

function line(c: StoredContact): string {
  return [displayName(c) || '(no name)', c.phones[0]?.value, c.emails[0]?.value].filter(Boolean).join('  ');
}

function details(c: StoredContact): string {
  const s = summary(c);
  const rows = [
    s.name || '(no name)',
    [c.title, c.organization].filter(Boolean).join(', '),
    ...c.phones.map((p) => `${p.label}: ${p.value}`),
    ...c.emails.map((e) => `${e.label}: ${e.value}`),
    ...c.addresses.map((a) => `${a.label}: ${[a.street.replace(/\n/g, ', '), a.city, a.region, a.postcode, a.country].filter(Boolean).join(', ')}`),
    ...c.urls.map((u) => `${u.label}: ${u.value}`),
    c.birthday && `birthday: ${c.birthday}`,
    c.groups.length ? `groups: ${c.groups.join(', ')}` : '',
    c.note && `note: ${c.note}`,
  ];
  return rows.filter(Boolean).join('\n');
}

/** A path as the fs bridge takes it: `~` is home. */
async function absolute(fs: ContactsFs, path: string): Promise<string> {
  if (path !== '~' && !path.startsWith('~/')) return path;
  return `${(await call(fs.homedir())).replace(/\/+$/, '')}${path.slice(1)}`;
}

export const contactsArea: Area = {
  name: 'contacts',
  summary: 'Your address book, as Contacts keeps it: list, show, add, edit, delete; groups; import and export vCards; open Contacts',
  commands: [
    command('contacts', 'list', 'Everyone in your address book (or a group), with their first number and email', [
      { name: 'search', type: 'string', positional: true, optional: true, rest: true, help: 'Only those a search finds: by name, company, email, number, address or note' },
      { name: 'group', type: 'string', optional: true, help: 'Only those in this group' },
    ], async (args) => {
      const { contacts, groups } = await book(fsOf());
      const groupArg = args.optString('group');
      const group = groupArg ? pick(groups, groupArg, (g) => [g], 'group') : null;
      const query = args.list('search').join(' ');
      const found = contacts.filter((c) => (!group || c.groups.includes(group)) && contactMatches(c, query)).sort((a, b) => compareContacts(a, b, 'family'));
      return { data: found.map(summary), text: found.length ? found.map(line).join('\n') : query || group ? 'No one matches' : 'The address book is empty' };
    }),
    command('contacts', 'show', 'Everything on someone’s card', [CONTACT], async (args) => {
      const c = find((await book(fsOf())).contacts, args.string('contact'));
      return { data: summary(c), text: details(c) };
    }),
    command('contacts', 'add', 'Add someone to your address book', [
      { name: 'name', type: 'string', positional: true, rest: true, help: 'Their name (the last word is taken as the family name), or a company’s' },
      ...FIELDS,
      { name: 'group', type: 'string', optional: true, help: 'Groups to put them in, separated by commas (made if new)' },
    ], async (args) => {
      const name = args.list('name').join(' ').trim();
      if (!name) throw new CommandError('Missing name', 'usage');
      const fs = fsOf();
      const draft = withFields({ ...blankContact(), ...nameParts(name), groups: list(args.optString('group')) }, args, { email: 'home', phone: 'mobile' });
      const stored = await call(saveContact(fs, draft));
      return { data: summary(stored), text: `Added ${displayName(stored)}` };
    }),
    command('contacts', 'edit', 'Change what someone’s card says: the fields given replace what it has', [
      CONTACT,
      { name: 'name', type: 'string', optional: true, help: 'Their name, written out' },
      ...FIELDS,
      { name: 'add-email', type: 'string', optional: true, help: 'An email address to add to theirs' },
      { name: 'add-phone', type: 'string', optional: true, help: 'A number to add to theirs' },
    ], async (args) => {
      const fs = fsOf();
      const was = find((await book(fs)).contacts, args.string('contact'));
      let next = withFields(was, args, { email: 'home', phone: 'mobile' });
      const name = args.optString('name');
      if (name !== undefined) {
        if (!name.trim()) throw new CommandError('A name can’t be empty', 'usage');
        next = { ...next, ...nameParts(name), prefix: '', middle: '', suffix: '' };
      }
      const addEmail = args.optString('add-email')?.trim();
      const addPhone = args.optString('add-phone')?.trim();
      if (addEmail) next.emails = [...next.emails, { label: 'other', value: addEmail }];
      if (addPhone) next.phones = [...next.phones, { label: 'mobile', value: addPhone }];
      const stored = await call(saveContact(fs, next, was));
      return { data: summary(stored), text: details(stored) };
    }),
    command('contacts', 'delete', 'Delete someone from your address book (asks on screen first)', [CONTACT], async (args, ctx) => {
      const fs = fsOf();
      const c = find((await book(fs)).contacts, args.string('contact'));
      const ok = await ctx.confirm({
        title: `Delete ${displayName(c) || 'this contact'}?`,
        description: 'Their card is removed from this computer’s address book. This can’t be undone.',
        action: 'Delete',
        destructive: true,
      });
      if (!ok) throw new CommandError('You didn’t allow it');
      await call(deleteContacts(fs, [c]));
      return { text: `Deleted ${displayName(c)}` };
    }),
    command('contacts', 'groups', 'The groups, and how many people are in each', [], async () => {
      const { contacts, groups } = await book(fsOf());
      const counted = groups.map((name) => ({ name, count: contacts.filter((c) => c.groups.includes(name)).length }));
      return { data: counted, text: counted.length ? counted.map((g) => `${g.name}  ${g.count}`).join('\n') : 'No groups' };
    }),
    command('contacts', 'group', 'Put someone in a group (made if new), or take them out', [
      CONTACT,
      { name: 'group', type: 'string', positional: true, help: 'The group' },
      { name: 'remove', type: 'boolean', optional: true, help: 'Take them out of it instead' },
    ], async (args) => {
      const fs = fsOf();
      const { contacts, groups } = await book(fs);
      const c = find(contacts, args.string('contact'));
      const remove = args.optBool('remove') ?? false;
      const asked = args.string('group').trim();
      const group = groups.find((g) => g.toLowerCase() === asked.toLowerCase()) ?? (remove ? pick(c.groups, asked, (g) => [g], 'group of theirs') : asked);
      if (!remove) await call(addGroup(fs, group));
      await call(setInGroup(fs, [c], group, !remove));
      return { text: remove ? `${displayName(c)} is out of ${group}` : `${displayName(c)} is in ${group}` };
    }),
    command('contacts', 'rename-group', 'Rename a group', [
      { name: 'group', type: 'string', positional: true, help: 'The group' },
      { name: 'to', type: 'string', positional: true, help: 'Its new name' },
    ], async (args) => {
      const fs = fsOf();
      const { groups } = await book(fs);
      const from = pick(groups, args.string('group'), (g) => [g], 'group');
      const to = args.string('to').trim();
      if (!to) throw new CommandError('A name can’t be empty', 'usage');
      if (to !== from && groups.includes(to)) throw new CommandError(`There’s a group called ${to} already`);
      await call(changeGroup(fs, from, to));
      return { text: `${from} is ${to} now` };
    }),
    command('contacts', 'delete-group', 'Delete a group; the people in it stay in your contacts', [
      { name: 'group', type: 'string', positional: true, help: 'The group' },
    ], async (args) => {
      const fs = fsOf();
      const group = pick((await book(fs)).groups, args.string('group'), (g) => [g], 'group');
      await call(changeGroup(fs, group, null));
      return { text: `Deleted the group ${group}` };
    }),
    command('contacts', 'import', 'Bring in the vCards in a .vcf file: new people are added, anyone already here gets what the file adds', [
      { name: 'file', type: 'path', positional: true, help: 'The .vcf file' },
    ], async (args) => {
      const fs = fsOf();
      const path = await absolute(fs, args.string('file'));
      const read = await call(fs.readFile(path, 32 * 1024 * 1024));
      if (read.truncated) throw new CommandError('That file is too big');
      const cards = parseVCards(new TextDecoder().decode(read.data));
      if (!cards.length) throw new CommandError(`No vCards in ${path}`);
      const result = await call(importContacts(fs, cards));
      return {
        data: { added: result.added, merged: result.merged, unchanged: result.unchanged },
        text: [`${result.added} added`, result.merged && `${result.merged} updated`, result.unchanged && `${result.unchanged} already here`].filter(Boolean).join(', '),
      };
    }),
    command('contacts', 'export', 'Write your contacts (or a group, or one person) to a .vcf file', [
      { name: 'file', type: 'path', positional: true, help: 'Where to write it' },
      { name: 'group', type: 'string', optional: true, help: 'Only this group' },
      { name: 'contact', type: 'string', optional: true, help: 'Only this person' },
    ], async (args) => {
      const fs = fsOf();
      const { contacts, groups } = await book(fs);
      const groupArg = args.optString('group');
      const contactArg = args.optString('contact');
      const group = groupArg ? pick(groups, groupArg, (g) => [g], 'group') : null;
      const chosen = contactArg ? [find(contacts, contactArg)] : contacts.filter((c) => !group || c.groups.includes(group));
      if (!chosen.length) throw new CommandError('No one to export');
      const path = await absolute(fs, args.string('file'));
      await call(fs.writeFile(path, serializeVCards(chosen.sort((a, b) => compareContacts(a, b, 'family')))));
      return { data: { path, count: chosen.length }, text: `${chosen.length === 1 ? '1 contact' : `${chosen.length} contacts`} written to ${path}` };
    }),
    command('contacts', 'open', 'Open Contacts, on someone if given', [{ ...CONTACT, optional: true }], async (args, ctx) => {
      const query = args.optString('contact');
      const c = query ? find((await book(fsOf())).contacts, query) : null;
      ctx.actions.open('contacts', c ? { contact: c.uid } : {});
    }),
  ],
};
