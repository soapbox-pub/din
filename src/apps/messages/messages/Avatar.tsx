import { User } from 'lucide-react';
import { cn } from '@/lib/utils';
import { colorsFor, initials, type Person, type PersonColor } from './format';

/**
 * Someone's avatar, or a group's. A person's is a circle in their own color
 * (by their number, so someone who isn't a contact has one too) with their
 * initials, or a person glyph for a bare number. A group's is a mosaic of
 * its people's tiles in theirs, as a group chat's is on a phone: two side by
 * side, three as one beside two, four or more as four, the last saying how
 * many more there are. The letters scale with the avatar's font size.
 */
export function Avatar({
  people,
  colors,
  className,
}: {
  people: Person[];
  /** The conversation's colors (colorsFor), so a person's here match theirs over their messages. */
  colors?: (address: string) => PersonColor;
  className?: string;
}) {
  const colorOf = colors ?? colorsFor(people.map((p) => p.address || p.name));
  if (people.length <= 1) {
    const person = people[0] ?? { name: '', address: '' };
    return (
      <span
        aria-hidden
        className={cn(
          'grid shrink-0 place-items-center rounded-full bg-gradient-to-b font-medium text-white select-none',
          colorOf(person.address || person.name).avatar,
          className,
        )}
      >
        <Face person={person} />
      </span>
    );
  }
  const shown = people.length > 4 ? people.slice(0, 3) : people;
  const more = people.length - shown.length;
  return (
    <span
      aria-hidden
      className={cn(
        'grid shrink-0 gap-[1.5px] overflow-hidden rounded-full bg-background font-semibold text-white select-none',
        people.length === 2 ? 'grid-cols-2' : 'grid-cols-2 grid-rows-2',
        className,
      )}
    >
      {shown.map((person, i) => (
        <span
          key={`${person.address}\u0000${i}`}
          className={cn(
            'grid min-h-0 min-w-0 place-items-center bg-gradient-to-b text-[0.62em] leading-none',
            colorOf(person.address || person.name).avatar,
            // Three: the first takes the left half.
            people.length === 3 && i === 0 && 'row-span-2',
            people.length === 2 && 'row-span-2',
          )}
        >
          <Face person={person} small />
        </span>
      ))}
      {more > 0 && (
        <span className="grid min-h-0 min-w-0 place-items-center bg-gradient-to-b from-zinc-400 to-zinc-600 text-[0.58em] leading-none">
          +{more}
        </span>
      )}
    </span>
  );
}

function Face({ person, small }: { person: Person; small?: boolean }) {
  const letters = initials(person.name);
  if (!letters) return <User className={small ? 'size-[55%]' : 'size-1/2'} strokeWidth={2.25} />;
  // A tile shows a first initial; there's no room for two.
  return <>{small ? letters[0] : letters}</>;
}
