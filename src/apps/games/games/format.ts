/** Words for how long and how lately a game's been played, and what goes on a system's shelf. */
import type { Game } from '@/lib/games';

export function playTimeText(seconds: number): string | null {
  if (seconds < 60) return null;
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes} minute${minutes === 1 ? '' : 's'} played`;
  const hours = Math.round((seconds / 3600) * 10) / 10;
  return `${hours} hour${hours === 1 ? '' : 's'} played`;
}

export function lastPlayedText(at: number | null): string | null {
  if (!at) return null;
  const days = Math.floor((Date.now() - at) / 86_400_000);
  if (days < 1) return 'Played today';
  if (days < 2) return 'Played yesterday';
  if (days < 7) return `Played ${days} days ago`;
  return `Played ${new Date(at).toLocaleDateString(undefined, { month: 'long', day: 'numeric', year: new Date(at).getFullYear() === new Date().getFullYear() ? undefined : 'numeric' })}`;
}

/** How many games a shelf holds. */
export const SHELF = 24;

function hash(text: string): number {
  let h = 0;
  for (const c of text) h = (h * 31 + c.charCodeAt(0)) % 1_000_003;
  return h;
}

/** The seed for a system's shelf: the same all day, a different one tomorrow. */
export function shelfSeed(system: string): number {
  return Math.floor(Date.now() / 86_400_000) + hash(system);
}

/** A day's worth of variety on each system's shelf, the same all day: not always the A's. */
export function sample(games: Game[], seed: number): Game[] {
  if (games.length <= SHELF) return games;
  // Games from here, with box art: what people know, not a shelf of imports and oddities.
  const picked = games.filter((g) => g.art?.boxart && g.local);
  const pool = picked.length >= SHELF ? picked : games;
  // The first SHELF of a Fisher-Yates shuffle, by mulberry32 from the seed.
  const order = pool.slice();
  let t = seed >>> 0;
  const random = () => {
    t = (t + 0x6d2b79f5) >>> 0;
    let r = Math.imul(t ^ (t >>> 15), 1 | t);
    r = (r + Math.imul(r ^ (r >>> 7), 61 | r)) ^ r;
    return ((r ^ (r >>> 14)) >>> 0) / 4294967296;
  };
  const n = Math.min(SHELF, order.length);
  for (let i = 0; i < n; i++) {
    const j = i + Math.floor(random() * (order.length - i));
    [order[i], order[j]] = [order[j], order[i]];
  }
  return order.slice(0, n);
}
