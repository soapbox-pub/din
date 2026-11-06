import { cn } from '@/lib/utils';
import type { EntryApi } from './Home';

type Action = Parameters<EntryApi['key']>[0];

interface Key {
  label: string;
  /** Text inserted, or an entry-line action. */
  insert?: string;
  action?: Action;
  title?: string;
  tone?: 'fn' | 'num' | 'op' | 'enter' | 'clear';
  wide?: boolean;
}

const KEYS: Key[] = [
  { label: '∫', insert: '∫(', title: '∫(expression, variable [, lower, upper])', tone: 'fn' },
  { label: 'd/dx', insert: 'd(', title: 'd(expression, variable) – derivative', tone: 'fn' },
  { label: 'Σ', insert: 'Σ(', title: 'Σ(expression, variable, low, high)', tone: 'fn' },
  { label: 'lim', insert: 'limit(', title: 'limit(expression, variable, point)', tone: 'fn' },
  { label: 'solve', insert: 'solve(', title: 'solve(equation, variable)', tone: 'fn' },

  { label: 'sin', insert: 'sin(', tone: 'fn' },
  { label: 'cos', insert: 'cos(', tone: 'fn' },
  { label: 'tan', insert: 'tan(', tone: 'fn' },
  { label: 'ln', insert: 'ln(', tone: 'fn' },
  { label: 'log', insert: 'log(', tone: 'fn' },

  { label: 'sin⁻¹', insert: 'sin⁻¹(', tone: 'fn' },
  { label: 'cos⁻¹', insert: 'cos⁻¹(', tone: 'fn' },
  { label: 'tan⁻¹', insert: 'tan⁻¹(', tone: 'fn' },
  { label: 'eˣ', insert: 'e^(', tone: 'fn' },
  { label: '√', insert: '√(', tone: 'fn' },

  { label: 'x', insert: 'x', tone: 'fn' },
  { label: 'y', insert: 'y', tone: 'fn' },
  { label: 'π', insert: 'π', tone: 'fn' },
  { label: 'i', insert: 'i', title: 'Imaginary unit', tone: 'fn' },
  { label: '∞', insert: '∞', tone: 'fn' },

  { label: '(', insert: '(', tone: 'op' },
  { label: ')', insert: ')', tone: 'op' },
  { label: ',', insert: ',', tone: 'op' },
  { label: 'x²', insert: '^2', tone: 'op' },
  { label: '^', insert: '^', tone: 'op' },

  { label: '=', insert: '=', tone: 'op' },
  { label: '|', insert: '|', title: 'with: x^2|x=3', tone: 'op' },
  { label: '→', insert: '→', title: 'Store: 5→a', tone: 'op' },
  { label: '{', insert: '{', title: 'List', tone: 'op' },
  { label: '}', insert: '}', tone: 'op' },

  { label: '7', insert: '7', tone: 'num' },
  { label: '8', insert: '8', tone: 'num' },
  { label: '9', insert: '9', tone: 'num' },
  { label: '÷', insert: '/', tone: 'op' },
  { label: '⌫', action: 'backspace', title: 'Backspace', tone: 'clear' },

  { label: '4', insert: '4', tone: 'num' },
  { label: '5', insert: '5', tone: 'num' },
  { label: '6', insert: '6', tone: 'num' },
  { label: '×', insert: '*', tone: 'op' },
  { label: 'CLEAR', action: 'clear', title: 'Clear the entry line (Esc)', tone: 'clear' },

  { label: '1', insert: '1', tone: 'num' },
  { label: '2', insert: '2', tone: 'num' },
  { label: '3', insert: '3', tone: 'num' },
  { label: '−', insert: '-', tone: 'op' },
  { label: 'ans', insert: 'ans(1)', title: 'The last answer', tone: 'fn' },

  { label: '0', insert: '0', tone: 'num' },
  { label: '.', insert: '.', tone: 'num' },
  { label: 'EE', insert: 'ᴇ', title: 'Times ten to the', tone: 'num' },
  { label: '+', insert: '+', tone: 'op' },
  { label: '≈', action: 'approx', title: 'Evaluate to a decimal (Ctrl+Enter)', tone: 'enter' },

  { label: 'ENTER', action: 'enter', tone: 'enter', wide: true },
];

const TONES: Record<NonNullable<Key['tone']>, string> = {
  fn: 'bg-muted text-foreground hover:bg-muted/70',
  num: 'bg-background text-foreground hover:bg-accent text-base font-medium',
  op: 'bg-secondary text-secondary-foreground hover:bg-secondary/70',
  enter: 'bg-pigment text-primary-foreground clay-pigment hover:brightness-110',
  clear: 'bg-muted text-foreground hover:bg-destructive/15',
};

/** On-screen keys for the symbols a keyboard lacks: ∫, Σ, √, π, →. */
export function Keypad({ onInsert, onKey }: { onInsert: (text: string) => void; onKey: (action: Action) => void }) {
  return (
    <div className="grid grid-cols-5 gap-1.5 p-3" role="group" aria-label="Keypad">
      {KEYS.map((key) => (
        <button
          key={key.label}
          type="button"
          title={key.title}
          aria-label={key.title ?? key.label}
          // Keep focus (and the caret) in the entry line.
          onMouseDown={(e) => e.preventDefault()}
          onClick={() => (key.action ? onKey(key.action) : key.insert && onInsert(key.insert))}
          className={cn(
            'h-9 select-none rounded-lg border border-border/50 text-sm shadow-xs transition-colors active:translate-y-px focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
            TONES[key.tone ?? 'num'],
            key.label === 'CLEAR' && 'text-[0.7rem] font-semibold tracking-wide',
            key.wide && 'col-span-5 h-10 text-sm font-semibold tracking-wide',
          )}
        >
          {key.label}
        </button>
      ))}
    </div>
  );
}
