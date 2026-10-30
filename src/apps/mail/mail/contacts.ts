import type { MailAddress } from '@/lib/mail';

/** People Mail has seen in messages and written to, for completing addresses. Kept in Mail's own storage. */
const KEY = 'din:mail:contacts';
const MAX = 800;

interface Entry {
  name: string;
  /** How much they matter: seen in a message counts 1, written to counts 5. */
  score: number;
}

function read(): Record<string, Entry> {
  try {
    const v: unknown = JSON.parse(localStorage.getItem(KEY) ?? '{}');
    return v && typeof v === 'object' ? (v as Record<string, Entry>) : {};
  } catch {
    return {};
  }
}

export function rememberAddresses(list: MailAddress[], weight = 1): void {
  if (!list.length) return;
  const all = read();
  let changed = false;
  for (const a of list) {
    const k = a.address.trim().toLowerCase();
    if (!k.includes('@') || /no-?reply|mailer-daemon|bounce/.test(k)) continue;
    const e = all[k] ?? { name: '', score: 0 };
    if (a.name && !e.name) e.name = a.name;
    e.score += weight;
    all[k] = e;
    changed = true;
  }
  if (!changed) return;
  const entries = Object.entries(all).sort((x, y) => y[1].score - x[1].score).slice(0, MAX);
  localStorage.setItem(KEY, JSON.stringify(Object.fromEntries(entries)));
}

export function suggestAddresses(prefix: string, exclude: Set<string>, limit = 6): MailAddress[] {
  const q = prefix.trim().toLowerCase();
  if (!q) return [];
  return Object.entries(read())
    .filter(([address, e]) => !exclude.has(address) && (address.includes(q) || e.name.toLowerCase().split(/\s+/).some((w) => w.startsWith(q)) || e.name.toLowerCase().startsWith(q)))
    .sort((x, y) => Number(y[0].startsWith(q)) - Number(x[0].startsWith(q)) || y[1].score - x[1].score)
    .slice(0, limit)
    .map(([address, e]) => ({ address, name: e.name }));
}
