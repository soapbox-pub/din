import { evaluateNumber } from './compile';
import { parse } from './expr';
import { tidy } from './present';
import { toText } from './text';

/** The data editor's lists, which are also variables on the home screen. */
export const LIST_NAMES = ['L1', 'L2', 'L3', 'L4', 'L5', 'L6'];

/** A stored list's elements as entry-line text, or [] if it isn't a list. */
export function listItems(value: string | undefined): string[] {
  if (!value) return [];
  try {
    const node = tidy(parse(value, { giac: true }));
    if (node.t !== 'list' || node.items.some((i) => i.t === 'list')) return [];
    return node.items.map(toText);
  } catch {
    return [];
  }
}

/** A stored list's numeric values (NaN where an element isn't a number). */
export function listValues(value: string | undefined): number[] {
  return listItems(value).map((text) => evaluateNumber(text) ?? NaN);
}

export interface ScatterSettings {
  enabled: boolean;
  x: string;
  y: string;
}
