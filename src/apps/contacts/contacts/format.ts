import { displayName, type Contact, type PostalAddress } from '@/shared/vcard';

const LABELS: Record<string, string> = {
  mobile: 'Mobile', home: 'Home', work: 'Work', main: 'Main', fax: 'Fax', pager: 'Pager', other: 'Other', homepage: 'Homepage',
};

/** A field's label as the card shows it: Din's own in title case, the user's as they wrote it. */
export function labelText(label: string): string {
  return LABELS[label] ?? (label || 'Other');
}

/** `1985-04-12` as "April 12, 1985", `--04-12` as "April 12". */
export function describeBirthday(birthday: string): string {
  const m = /^(\d{4}|--)-?(\d{2})-(\d{2})$/.exec(birthday);
  if (!m) return birthday;
  const year = m[1] === '--' ? 2000 : Number(m[1]);
  const date = new Date(year, Number(m[2]) - 1, Number(m[3]));
  return date.toLocaleDateString(undefined, m[1] === '--' ? { month: 'long', day: 'numeric' } : { year: 'numeric', month: 'long', day: 'numeric' });
}

export function addressLines(a: PostalAddress): string {
  return [a.street, [a.city, a.region, a.postcode].filter(Boolean).join(' '), a.country].filter(Boolean).join('\n');
}

/** A contact as text, for the clipboard. */
export function cardText(c: Contact): string {
  const lines = [displayName(c) || 'No Name'];
  const role = [c.title, c.organization].filter(Boolean).join(', ');
  if (role && role !== lines[0]) lines.push(role);
  for (const p of c.phones) lines.push(`${labelText(p.label)}: ${p.value}`);
  for (const e of c.emails) lines.push(`${labelText(e.label)}: ${e.value}`);
  for (const a of c.addresses) lines.push(`${labelText(a.label)}: ${addressLines(a).replace(/\n/g, ', ')}`);
  for (const u of c.urls) lines.push(`${labelText(u.label)}: ${u.value}`);
  if (c.birthday) lines.push(`Birthday: ${describeBirthday(c.birthday)}`);
  return lines.join('\n');
}

/** A file name for a contact's vCard. */
export function vcardFileName(contacts: readonly Contact[], fallback: string): string {
  const name = contacts.length === 1 ? displayName(contacts[0]) : fallback;
  return `${(name || 'Contact').replace(/[/\\:*?"<>|]+/g, ' ').trim() || 'Contact'}.vcf`;
}
