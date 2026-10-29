import type { JSONContent } from '@tiptap/core';
import { parseXml } from '@/shared/office/ooxml';
import { OFFICE_THEME } from '@/shared/office/theme';
import { newList, parseNumbering, type Numbering } from './numbering';
import { LETTER, type WordDoc } from './read';
import { defaultStylesXml, parseStyles } from './styles';

/** New documents: a blank one, and a few to start from, as File > New offers. */

export function newWordDoc(content?: (n: Numbering) => JSONContent[]): WordDoc {
  const theme = OFFICE_THEME;
  const numbering = parseNumbering(null);
  return {
    pkg: null,
    docPart: 'word/document.xml',
    content: { type: 'doc', content: content?.(numbering) ?? [{ type: 'paragraph' }] },
    styles: parseStyles(parseXml(defaultStylesXml()), theme),
    numbering,
    section: { ...LETTER },
    headers: {},
    footers: {},
    theme,
    warnings: [],
  };
}

type Attrs = Record<string, unknown>;

const t = (text: string, marks?: JSONContent['marks']): JSONContent => ({ type: 'text', text, marks });
const p = (text: string | JSONContent[], attrs: Attrs = {}): JSONContent => ({
  type: 'paragraph',
  attrs,
  content: typeof text === 'string' ? (text ? [t(text)] : undefined) : text,
});

export interface WordTemplate {
  id: string;
  name: string;
  build: (n: Numbering) => JSONContent[];
}

export const TEMPLATES: WordTemplate[] = [
  { id: 'blank', name: 'Blank document', build: () => [p('')] },
  { id: 'single', name: 'Single spaced (blank)', build: () => [p('', { styleId: 'NoSpacing' })] },
  {
    id: 'report',
    name: 'Report',
    build: (n) => {
      const bullets = newList(n, { bullet: 'disc' });
      return [
        p('Report Title', { styleId: 'Title' }),
        p('Subtitle or date', { styleId: 'Subtitle' }),
        p('Introduction', { styleId: 'Heading1' }),
        p('To get started right away, just click any placeholder text (such as this) and start typing to replace it with your own.'),
        p('Background', { styleId: 'Heading1' }),
        p('Want to insert a picture from your files or add a table? Go to the Insert tab and pick what you need.'),
        p('Make a point in a bulleted list', { numId: bullets, ilvl: 0 }),
        p('And another one right after it', { numId: bullets, ilvl: 0 }),
        p('Findings', { styleId: 'Heading2' }),
        p('Use the styles on the Home tab to keep headings and body text looking consistent throughout the report.'),
        p('“Quote something important here to make it stand out.”', { styleId: 'Quote' }),
        p('Conclusion', { styleId: 'Heading1' }),
        p('Summarize the report in a paragraph or two.'),
      ];
    },
  },
  {
    id: 'letter',
    name: 'Letter',
    build: () => [
      p('Your Name', { styleId: 'NoSpacing' }),
      p('Street Address', { styleId: 'NoSpacing' }),
      p('City, ST ZIP Code', { styleId: 'NoSpacing', spAfter: 24 }),
      p(new Date().toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' }), { styleId: 'NoSpacing', spAfter: 24 }),
      p('Recipient Name', { styleId: 'NoSpacing' }),
      p('Title', { styleId: 'NoSpacing' }),
      p('Company', { styleId: 'NoSpacing' }),
      p('Street Address', { styleId: 'NoSpacing' }),
      p('City, ST ZIP Code', { styleId: 'NoSpacing', spAfter: 24 }),
      p('Dear Recipient Name,'),
      p('If you’re ready to write, just select a line of text and start typing to replace it with your own. Don’t include space to the left or right of the characters in your selection.'),
      p('Apply any text formatting you see on this page with just a click from the Home tab, under Styles.'),
      p('Sincerely,', { spAfter: 36 }),
      p('Your Name'),
    ],
  },
  {
    id: 'resume',
    name: 'Resume',
    build: (n) => {
      const bullets = newList(n, { bullet: 'disc' });
      const b = (text: string) => p(text, { numId: bullets, ilvl: 0 });
      return [
        p('YOUR NAME', { styleId: 'Title' }),
        p('Address · City, ST ZIP · Phone · Email', { styleId: 'NoSpacing', spAfter: 12 }),
        p('Objective', { styleId: 'Heading1' }),
        p('To replace this text with your own, just select it and start typing. Briefly state your career objective or summarize what makes you stand out.'),
        p('Experience', { styleId: 'Heading1' }),
        p([t('Job Title', [{ type: 'bold' }]), t(' · Company · Dates From – To')]),
        b('Describe your responsibilities and achievements in terms of impact and results.'),
        b('Use examples, but keep it short.'),
        p('Education', { styleId: 'Heading1' }),
        p([t('Degree', [{ type: 'bold' }]), t(' · Date Earned · School')]),
        p('Skills', { styleId: 'Heading1' }),
        b('List one of your strengths'),
        b('List another'),
      ];
    },
  },
];
