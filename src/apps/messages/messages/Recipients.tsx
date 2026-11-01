import { useMemo, useState } from 'react';
import { X } from 'lucide-react';
import type { PhoneContact } from '@/lib/phone';
import { formatAddress, phoneDigits } from '@/shared/phone';
import { cn } from '@/lib/utils';
import { Avatar } from './Avatar';

export interface Recipient {
  name: string;
  address: string;
}

const NUMBER = /^\+?[\d\s().-]{3,}$/;

/**
 * The To: field of a new message: contacts by name or number as you type,
 * or any number. Enter, Tab or a comma takes what's typed; Backspace in an
 * empty field takes the last one back.
 */
export function Recipients({
  recipients,
  contacts,
  onChange,
}: {
  recipients: Recipient[];
  contacts: PhoneContact[];
  onChange: (recipients: Recipient[]) => void;
}) {
  const [query, setQuery] = useState('');
  const [active, setActive] = useState(0);

  const matches = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return [];
    const digits = q.replace(/\D/g, '');
    const out: Recipient[] = [];
    for (const c of contacts) {
      const byName = c.name.toLowerCase().includes(q);
      for (const n of c.numbers) {
        if (byName || (digits.length >= 3 && n.replace(/\D/g, '').includes(digits))) out.push({ name: c.name, address: n });
      }
      if (out.length >= 8) break;
    }
    return out;
  }, [query, contacts]);

  const add = (r: Recipient) => {
    if (!recipients.some((x) => phoneDigits(x.address) === phoneDigits(r.address))) onChange([...recipients, r]);
    setQuery('');
    setActive(0);
  };

  const take = () => {
    const pick = matches[active];
    const typed = query.trim();
    if (pick) add(pick);
    else if (NUMBER.test(typed)) add({ name: formatAddress(typed), address: typed });
    else return false;
    return true;
  };

  return (
    <div className="relative shrink-0 border-b border-border/60 px-4 py-2">
      <div className="flex flex-wrap items-center gap-1.5">
        <span className="text-sm text-muted-foreground">To:</span>
        {recipients.map((r) => (
          <span key={r.address} className="flex items-center gap-1 rounded-full bg-primary/15 py-0.5 pr-1 pl-2.5 text-sm text-foreground">
            {r.name}
            <button
              type="button"
              aria-label={`Remove ${r.name}`}
              onClick={() => onChange(recipients.filter((x) => x !== r))}
              className="grid size-4 place-items-center rounded-full hover:bg-foreground/15 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            >
              <X className="size-3" />
            </button>
          </span>
        ))}
        <input
          autoFocus
          value={query}
          onChange={(e) => {
            setQuery(e.target.value);
            setActive(0);
          }}
          onKeyDown={(e) => {
            if ((e.key === 'Enter' || e.key === 'Tab' || e.key === ',') && query.trim()) {
              if (take()) e.preventDefault();
            } else if (e.key === 'Backspace' && !query && recipients.length) {
              onChange(recipients.slice(0, -1));
            } else if (e.key === 'ArrowDown' && matches.length) {
              e.preventDefault();
              setActive((a) => Math.min(matches.length - 1, a + 1));
            } else if (e.key === 'ArrowUp' && matches.length) {
              e.preventDefault();
              setActive((a) => Math.max(0, a - 1));
            }
          }}
          onBlur={() => {
            if (NUMBER.test(query.trim())) take();
          }}
          placeholder={recipients.length ? '' : 'Name or number'}
          aria-label="To"
          role="combobox"
          aria-expanded={matches.length > 0}
          aria-controls="recipient-suggestions"
          className="min-w-32 flex-1 bg-transparent py-1 text-sm text-foreground outline-none placeholder:text-muted-foreground"
        />
      </div>
      {matches.length > 0 && (
        <ul
          id="recipient-suggestions"
          role="listbox"
          className="absolute top-full right-4 left-4 z-20 mt-1 max-h-72 overflow-y-auto rounded-xl border border-border/60 bg-popover p-1 shadow-lg"
        >
          {matches.map((m, i) => (
            <li
              key={`${m.name}\u0000${m.address}`}
              role="option"
              aria-selected={i === active}
              onMouseDown={(e) => {
                e.preventDefault();
                add(m);
              }}
              onMouseEnter={() => setActive(i)}
              className={cn('flex cursor-default items-center gap-2.5 rounded-lg px-2 py-1.5', i === active && 'bg-accent')}
            >
              <Avatar name={m.name} className="size-7 text-xs" />
              <span className="min-w-0 flex-1 truncate text-sm text-foreground">{m.name}</span>
              <span className="shrink-0 text-xs text-muted-foreground">{formatAddress(m.address)}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
