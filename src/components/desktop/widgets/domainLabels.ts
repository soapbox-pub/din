import type { Domain } from '@/lib/widgets';

/** What each NAP domain lets a widget do, as the user reads it. */
export const DOMAIN_LABELS: Record<Domain, string> = {
  shell: 'Know which of these it has',
  theme: 'Match your desktop\'s colors',
  identity: 'See who you\'re signed in as: your profile, relays and follows',
  storage: 'Keep its own notes and settings on this computer',
};
