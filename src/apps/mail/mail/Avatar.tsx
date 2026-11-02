import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { cn } from '@/lib/utils';
import type { MailAddress } from '@/lib/mail';
import { useMail } from './api';
import { initials } from './format';

/** Each sender's own color, from their address, as Gmail does. */
const COLORS = ['bg-rose-600', 'bg-orange-600', 'bg-amber-700', 'bg-lime-700', 'bg-emerald-700', 'bg-teal-700', 'bg-cyan-700', 'bg-sky-700', 'bg-blue-600', 'bg-indigo-600', 'bg-violet-600', 'bg-fuchsia-700', 'bg-pink-600', 'bg-slate-600'];

function colorOf(key: string): string {
  let h = 0;
  for (let i = 0; i < key.length; i++) h = (h * 31 + key.charCodeAt(i)) | 0;
  return COLORS[Math.abs(h) % COLORS.length];
}

/**
 * A sender's picture, from their domain (see electron/mail-avatars.mts),
 * only for senders the server vouched for; else their initials on their color.
 */
export function Avatar({ who, verified, className }: { who: MailAddress | undefined; verified?: boolean; className?: string }) {
  const mail = useMail();
  const address = who?.address.trim().toLowerCase() ?? '';
  const picture = useQuery({
    queryKey: ['mail', 'avatar', address],
    queryFn: () => mail!.avatar(address),
    enabled: !!mail && !!verified && address.includes('@'),
    staleTime: Infinity,
    retry: false,
  });
  const [broken, setBroken] = useState<string | null>(null);
  const src = picture.data && picture.data !== broken ? picture.data : null;
  return (
    <div
      aria-hidden
      className={cn(
        'grid size-10 shrink-0 place-items-center overflow-hidden rounded-full text-sm font-semibold text-white select-none',
        src ? 'bg-white' : colorOf(address || who?.name || '?'),
        className,
      )}
    >
      {src ? <img src={src} alt="" draggable={false} onError={() => setBroken(src)} className="size-full object-cover" /> : initials(who)}
    </div>
  );
}
