import { User, Users } from 'lucide-react';
import { cn } from '@/lib/utils';
import { avatarColor, initials } from './format';

export function Avatar({ name, group, className }: { name: string; group?: boolean; className?: string }) {
  const letters = group ? null : initials(name);
  const Icon = group ? Users : User;
  return (
    <span
      aria-hidden
      className={cn(
        'grid shrink-0 place-items-center rounded-full bg-gradient-to-b font-medium text-white select-none',
        letters ? avatarColor(name) : 'from-zinc-400 to-zinc-500',
        className,
      )}
    >
      {letters ?? <Icon className="size-1/2" />}
    </span>
  );
}
