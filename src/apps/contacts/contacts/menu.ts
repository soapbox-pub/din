import { Copy, Download, FolderPlus, Mail, MessageCircle, Pencil, Tag, Trash2, UserPlus, UserRound } from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import type { StoredContact } from '@/shared/contacts';
import type { Contact } from '@/shared/vcard';

export type ContactAction =
  | 'edit'
  | 'message'
  | 'email'
  | 'copy'
  | 'export'
  | 'delete'
  /** A phone's contact: into the address book. */
  | 'add'
  /** A phone's contact already in the address book: show that one. */
  | 'show'
  | 'new-group'
  | `group:${string}`;

export type MenuEntry =
  | { kind: 'item'; action: ContactAction; label: string; icon?: LucideIcon; checked?: boolean; destructive?: boolean }
  | { kind: 'submenu'; label: string; icon: LucideIcon; entries: MenuEntry[] }
  | { kind: 'separator' };

const item = (action: ContactAction, label: string, icon?: LucideIcon, more: { checked?: boolean; destructive?: boolean } = {}): MenuEntry => ({ kind: 'item', action, label, icon, ...more });
const separator: MenuEntry = { kind: 'separator' };

function joined(groups: MenuEntry[][]): MenuEntry[] {
  return groups.filter((g) => g.length).flatMap((g, i) => (i ? [separator, ...g] : g));
}

function groupMenu(targets: readonly Contact[], groups: readonly string[]): MenuEntry {
  return {
    kind: 'submenu',
    label: 'Groups',
    icon: Tag,
    entries: [
      ...groups.map((g) => item(`group:${g}`, g, undefined, { checked: targets.every((c) => c.groups.includes(g)) })),
      ...(groups.length ? [separator] : []),
      item('new-group', 'New Group…', FolderPlus),
    ],
  };
}

/**
 * What can be done to contacts in the address book, for a row's right-click
 * menu and the card's ⋯ menu alike: one contact, or a selection of several.
 */
export function contactMenu(targets: readonly StoredContact[], groups: readonly string[], can: { message: boolean }): MenuEntry[] {
  if (targets.length !== 1) {
    const n = targets.length;
    return joined([
      [groupMenu(targets, groups)],
      [item('export', `Export ${n} vCards…`, Download)],
      [item('delete', `Delete ${n} Contacts…`, Trash2, { destructive: true })],
    ]);
  }
  const [c] = targets;
  return joined([
    [item('edit', 'Edit…', Pencil)],
    [
      ...(can.message && c.phones.length ? [item('message', 'Send Message', MessageCircle)] : []),
      ...(c.emails.length ? [item('email', 'Send Email', Mail)] : []),
    ],
    [groupMenu(targets, groups)],
    [item('copy', 'Copy Card', Copy), item('export', 'Export vCard…', Download)],
    [item('delete', 'Delete…', Trash2, { destructive: true })],
  ]);
}

/** A phone's contact: it's read-only here, so add it, or show the one it's already in. */
export function phoneContactMenu(c: Contact, inBook: boolean, can: { message: boolean }): MenuEntry[] {
  return joined([
    [inBook ? item('show', 'Show in My Contacts', UserRound) : item('add', 'Add to My Contacts', UserPlus)],
    can.message && c.phones.length ? [item('message', 'Send Message', MessageCircle)] : [],
    [item('copy', 'Copy Card', Copy), item('export', 'Export vCard…', Download)],
  ]);
}
