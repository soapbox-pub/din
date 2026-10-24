import { createContext, useContext } from 'react';
import { cn } from '@/lib/utils';

export type OfficeApp = 'word' | 'excel' | 'powerpoint';

interface Accent {
  accent: string;
  dark: string;
  light: string;
  /** What the app is called in its title bar, like "Word" in "Document1 - Word". */
  name: string;
}

export const ACCENTS: Record<OfficeApp, Accent> = {
  word: { accent: '#185abd', dark: '#123f87', light: '#d5e1f5', name: 'Word Processor' },
  excel: { accent: '#107c41', dark: '#0a5a2e', light: '#d3eadb', name: 'Spreadsheet' },
  powerpoint: { accent: '#c43e1c', dark: '#9c2f13', light: '#f8dcd3', name: 'Slides' },
};

export const AppContext = createContext<OfficeApp>('word');
export const useOfficeApp = () => useContext(AppContext);

export const FOCUS = 'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--office-accent)] focus-visible:ring-offset-1';

/** Keeps a click on the ribbon from taking focus (and the selection) away from the document. */
export const keepFocus = (e: React.MouseEvent) => {
  if (!(e.target as HTMLElement).closest('input, select, textarea')) e.preventDefault();
};

export const FIELD = cn(
  'h-7 rounded-[4px] border border-[#c8c8c8] bg-white px-2 text-[13px] text-[#242424] outline-none select-text hover:border-[#9e9e9e] focus:border-[var(--office-accent)] focus:ring-1 focus:ring-[var(--office-accent)]',
);

/**
 * After a menu closes, focus goes back into the app (its frame, which hands it
 * on to the document) unless the command already put it somewhere, so the
 * app's keyboard shortcuts keep working.
 */
export function refocusFrame(from: Element | null): void {
  requestAnimationFrame(() => {
    const active = document.activeElement;
    if (active && active !== document.body) return;
    (from?.closest('.office-frame') as HTMLElement | null)?.focus({ preventScroll: true });
  });
}
