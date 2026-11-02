/** Which list is shown: everyone, a group, or a phone's own contacts. */
export type Source = { kind: 'all' } | { kind: 'group'; name: string } | { kind: 'phone'; id: string };

export function sameSource(a: Source, b: Source): boolean {
  if (a.kind === 'group' && b.kind === 'group') return a.name === b.name;
  if (a.kind === 'phone' && b.kind === 'phone') return a.id === b.id;
  return a.kind === 'all' && b.kind === 'all';
}

/** What a row of the list carries when it's dragged onto a group: the keys of what's dragged. */
export const CONTACT_DRAG = 'application/x-din-contacts';
