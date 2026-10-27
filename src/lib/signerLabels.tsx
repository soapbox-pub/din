import { getKindLabel } from '@/lib/kindLabels';
import type { SignerMethod } from '@/lib/signerPermissions';
import { middleEllipsis } from '@/lib/utils';

/** What the user is being asked about: a method, or connecting at all. */
export type SignerQuestion = SignerMethod | 'connect';

export function questionTitle(question: SignerQuestion, kind?: number): string {
  switch (question) {
    case 'signEvent':
      return kind !== undefined ? `Sign: ${getKindLabel(kind)}` : 'Sign an event';
    case 'nip04.encrypt':
      return 'Encrypt a message (NIP-04)';
    case 'nip04.decrypt':
      return 'Decrypt a message (NIP-04)';
    case 'nip44.encrypt':
      return 'Encrypt a message (NIP-44)';
    case 'nip44.decrypt':
      return 'Decrypt a message (NIP-44)';
    case 'getPublicKey':
    case 'getRelays':
      return 'See who you are';
    case 'connect':
      return 'Use your account';
  }
}

/** A short label for a remembered rule ("Short text note", "Decrypt (NIP-44)"). */
export function ruleLabel(method: SignerMethod, kind?: number): string {
  if (method === 'signEvent') return kind !== undefined ? getKindLabel(kind) : 'Any event';
  return questionTitle(method).replace(' a message', '');
}

/**
 * How to name an origin to the user: the host for a web site, and for an
 * nsite its key, shortened.
 */
export function originLabel(origin: string): string {
  if (origin.startsWith('nsite://')) {
    return middleEllipsis(origin.replace(/^nsite:\/\//, ''), 40);
  }
  try {
    return new URL(origin).host || origin;
  } catch {
    return origin;
  }
}
