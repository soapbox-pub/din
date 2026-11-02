import { User } from 'lucide-react';
import { cn } from '@/lib/utils';
import { displayName, initials, type Contact } from '@/shared/vcard';

/** Soft, readable backgrounds for initials, picked by the name so a person keeps theirs. */
const TINTS = [
  'from-rose-400 to-rose-600',
  'from-orange-400 to-orange-600',
  'from-amber-500 to-amber-700',
  'from-emerald-500 to-emerald-700',
  'from-teal-500 to-teal-700',
  'from-sky-500 to-sky-700',
  'from-indigo-400 to-indigo-600',
  'from-violet-400 to-violet-600',
  'from-fuchsia-400 to-fuchsia-600',
  'from-slate-400 to-slate-600',
];

function tintOf(key: string): string {
  let h = 0;
  for (let i = 0; i < key.length; i++) h = (h * 31 + key.charCodeAt(i)) | 0;
  return TINTS[Math.abs(h) % TINTS.length];
}

export function Avatar({ contact, className }: { contact: Contact; className?: string }) {
  if (contact.photo) {
    return <img src={contact.photo} alt="" draggable={false} className={cn('shrink-0 rounded-full object-cover', className)} />;
  }
  const letters = initials(contact);
  return (
    <span
      aria-hidden
      className={cn(
        'grid shrink-0 select-none place-items-center rounded-full bg-gradient-to-br font-semibold text-white',
        letters ? tintOf(displayName(contact)) : 'from-zinc-300 to-zinc-500',
        className,
      )}
    >
      {letters || <User className="size-1/2" strokeWidth={2} />}
    </span>
  );
}
