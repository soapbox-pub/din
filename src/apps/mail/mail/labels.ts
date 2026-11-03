import { LABEL_COLORS, type LabelColor, type MailLabel, type MailLabels } from '@/lib/mail';
import type { Item } from './api';

/** Each color's dot, and its chip (dark enough text on its tint for 4.5:1, in either theme). */
export const LABEL_STYLES: Record<LabelColor, { dot: string; chip: string; icon: string }> = {
  gray: { dot: 'bg-slate-500', chip: 'bg-slate-500/15 text-slate-700 dark:text-slate-200', icon: 'text-slate-500' },
  red: { dot: 'bg-red-500', chip: 'bg-red-500/15 text-red-700 dark:text-red-300', icon: 'text-red-500' },
  orange: { dot: 'bg-orange-500', chip: 'bg-orange-500/15 text-orange-800 dark:text-orange-300', icon: 'text-orange-500' },
  amber: { dot: 'bg-amber-500', chip: 'bg-amber-500/20 text-amber-800 dark:text-amber-300', icon: 'text-amber-500' },
  green: { dot: 'bg-green-600', chip: 'bg-green-600/15 text-green-800 dark:text-green-300', icon: 'text-green-600' },
  teal: { dot: 'bg-teal-600', chip: 'bg-teal-600/15 text-teal-800 dark:text-teal-300', icon: 'text-teal-600' },
  blue: { dot: 'bg-blue-500', chip: 'bg-blue-500/15 text-blue-700 dark:text-blue-300', icon: 'text-blue-500' },
  indigo: { dot: 'bg-indigo-500', chip: 'bg-indigo-500/15 text-indigo-700 dark:text-indigo-300', icon: 'text-indigo-500' },
  purple: { dot: 'bg-purple-500', chip: 'bg-purple-500/15 text-purple-700 dark:text-purple-300', icon: 'text-purple-500' },
  pink: { dot: 'bg-pink-500', chip: 'bg-pink-500/15 text-pink-700 dark:text-pink-300', icon: 'text-pink-500' },
};

export const COLOR_NAMES: Record<LabelColor, string> = {
  gray: 'Gray',
  red: 'Red',
  orange: 'Orange',
  amber: 'Yellow',
  green: 'Green',
  teal: 'Teal',
  blue: 'Blue',
  indigo: 'Indigo',
  purple: 'Purple',
  pink: 'Pink',
};

/** A label's color: its own, or one picked from its id (never gray, which is chosen). */
export function labelColor(label: Pick<MailLabel, 'id' | 'color'>): LabelColor {
  if (label.color && label.color in LABEL_STYLES) return label.color;
  let h = 0;
  for (const c of label.id) h = (h * 31 + c.charCodeAt(0)) >>> 0;
  return LABEL_COLORS[1 + (h % (LABEL_COLORS.length - 1))];
}

/**
 * The labels a message has, by its account's: those kept on it, and on
 * Gmail the label of the mailbox it was read from (Gmail may leave that
 * one out).
 */
export function labelsOfItem(item: Item, info: MailLabels | undefined): MailLabel[] {
  if (!info?.labels.length) return [];
  const ids = new Set(item.labels ?? []);
  return info.labels.filter((l) => ids.has(l.id) || (!!l.path && l.path === item.path));
}

/** The labels of any of these messages, by name. */
export function labelsOfItems(items: Item[], info: MailLabels | undefined): MailLabel[] {
  const out = new Map<string, MailLabel>();
  for (const i of items) for (const l of labelsOfItem(i, info)) out.set(l.id, l);
  return [...out.values()].sort((x, y) => x.name.localeCompare(y.name));
}
