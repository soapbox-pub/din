import { useState } from 'react';
import { cn } from '@/lib/utils';
import { nameOf } from './model';
import type { Profile } from './nostr';


export function Avatar({ pubkey, profile, className }: { pubkey: string; profile: Profile | undefined; className?: string }) {
  const [broken, setBroken] = useState(false);
  const name = nameOf(pubkey, profile);
  const hue = parseInt(pubkey.slice(0, 6), 16) % 360;
  return (
    <span
      aria-hidden
      className={cn('grid size-7 shrink-0 place-items-center overflow-hidden rounded-full text-[11px] font-semibold text-white', className)}
      style={{ backgroundColor: `oklch(0.6 0.12 ${hue})` }}
    >
      {profile?.picture && !broken ? (
        <img src={profile.picture} alt="" className="size-full object-cover" referrerPolicy="no-referrer" onError={() => setBroken(true)} />
      ) : (
        name.replace(/^npub1/, '').slice(0, 1).toUpperCase()
      )}
    </span>
  );
}
