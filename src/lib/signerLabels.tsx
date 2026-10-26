import { KeyRound, Link2, Lock, Pen, UserRound } from 'lucide-react';
import type { ReactNode } from 'react';

import { getKindLabel } from '@/lib/kindLabels';
import type { SignerMethod } from '@/lib/signerPermissions';
import { middleEllipsis } from '@/lib/utils';

/** What the user is being asked about: a method, or connecting at all. */
export type SignerQuestion = SignerMethod | 'connect';

export function questionIcon(question: SignerQuestion): ReactNode {
  switch (question) {
    case 'signEvent':
      return <Pen className="size-5 text-amber-500" aria-hidden />;
    case 'nip04.encrypt':
    case 'nip44.encrypt':
      return <Lock className="size-5 text-blue-500" aria-hidden />;
    case 'nip04.decrypt':
    case 'nip44.decrypt':
      return <KeyRound className="size-5 text-violet-500" aria-hidden />;
    case 'getPublicKey':
    case 'getRelays':
      return <UserRound className="size-5 text-sky-500" aria-hidden />;
    case 'connect':
      return <Link2 className="size-5 text-emerald-500" aria-hidden />;
  }
}

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

export function questionDescription(question: SignerQuestion): string {
  switch (question) {
    case 'signEvent':
      return 'It wants to publish this as you.';
    case 'nip04.encrypt':
    case 'nip44.encrypt':
      return 'It wants to encrypt a message with your key.';
    case 'nip04.decrypt':
    case 'nip44.decrypt':
      return 'It wants to read a message encrypted to you.';
    case 'getPublicKey':
    case 'getRelays':
      return 'It will see your public key and relays. It still has to ask before signing or decrypting anything.';
    case 'connect':
      return 'It will be able to ask to sign and encrypt with your key from wherever it is running, until you disconnect it.';
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
