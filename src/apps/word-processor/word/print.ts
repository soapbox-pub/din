import type { JSONContent } from '@tiptap/core';
import { EDITOR_CSS } from './css';
import { imageStore, type HeaderFooter, type Section } from './read';

/**
 * Printing: the document as one self-contained HTML page for Din's print
 * dialog (which renders it with scripts off): the page size and margins as
 * @page rules, headers and footers in the page margins, and the pictures and
 * fonts it uses inlined, since the print renderer sees none of this window's.
 */

const FONT_FAMILIES = ['Carlito', 'Caladea', 'Arimo', 'Tinos', 'Cousine'];
let fontCss: Promise<string> | null = null;

function dataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(blob);
  });
}

/** The @font-face rules for the stand-in fonts, latin subset, with the font files inlined. */
function inlineFonts(): Promise<string> {
  fontCss ??= (async () => {
    const rules: string[] = [];
    for (const sheet of Array.from(document.styleSheets)) {
      let list: CSSRuleList;
      try {
        list = sheet.cssRules;
      } catch {
        continue;
      }
      for (const rule of Array.from(list)) {
        if (!(rule instanceof CSSFontFaceRule)) continue;
        const family = rule.style.getPropertyValue('font-family').replace(/["']/g, '').trim();
        if (!FONT_FAMILIES.includes(family)) continue;
        const range = rule.style.getPropertyValue('unicode-range');
        // Just the Latin subset: everything a Western document needs, at a fraction of the size.
        if (range && !/U\+0000-00FF/i.test(range)) continue;
        const url = /url\(["']?([^"')]+\.woff2)["']?\)/.exec(rule.style.getPropertyValue('src'))?.[1];
        if (!url) continue;
        try {
          const res = await fetch(new URL(url, sheet.href ?? location.href));
          const data = await dataUrl(await res.blob());
          rules.push(
            `@font-face { font-family: '${family}'; font-style: ${rule.style.getPropertyValue('font-style') || 'normal'}; font-weight: ${rule.style.getPropertyValue('font-weight') || '400'}; src: url(${data}) format('woff2'); }`,
          );
        } catch {
          // A font that won't load prints in a fallback.
        }
      }
    }
    return rules.join('\n');
  })();
  return fontCss;
}

/** Text for a margin box: CSS strings with page counters where the PAGE fields were. */
function marginContent(hf: HeaderFooter | undefined): { align: 'left' | 'center' | 'right'; content: string } | null {
  const para = hf?.content.find((b) => b.type === 'paragraph' && (b.content?.length ?? 0) > 0);
  if (!para) return null;
  const quote = (t: string) => `"${t.replace(/[\\"]/g, (c) => `\\${c}`).replace(/[\n\r]/g, ' ')}"`;
  const parts = (para.content ?? []).map((n: JSONContent) =>
    n.type === 'text' ? quote((n.text ?? '').replace(/\t/g, ' ')) : n.type === 'field' ? (n.attrs?.kind === 'numpages' ? 'counter(pages)' : 'counter(page)') : '',
  );
  const content = parts.filter(Boolean).join(' ');
  if (!content) return null;
  const a = para.attrs?.align;
  return { align: a === 'center' || a === 'right' ? a : 'left', content };
}

export async function printHtml(opts: {
  title: string;
  dom: HTMLElement;
  docCss: string;
  scope: string;
  section: Section;
  header?: HeaderFooter;
  footer?: HeaderFooter;
}): Promise<string> {
  const { dom, section } = opts;
  const clone = dom.cloneNode(true) as HTMLElement;
  for (const el of Array.from(clone.querySelectorAll('.wp-spacer, .wp-spacer-inline, .wp-img-handle, .ProseMirror-gapcursor, .column-resize-handle'))) el.remove();
  for (const el of Array.from(clone.querySelectorAll('[contenteditable]'))) el.removeAttribute('contenteditable');
  for (const el of Array.from(clone.querySelectorAll<HTMLElement>('tr.wp-row-break'))) {
    el.classList.remove('wp-row-break');
    el.style.removeProperty('--wp-gap');
  }
  for (const img of Array.from(clone.querySelectorAll('img'))) {
    const stored = imageStore.get(img.getAttribute('src') ?? '');
    if (stored) img.setAttribute('src', await dataUrl(new Blob([stored.data as BlobPart], { type: `image/${stored.ext === 'jpg' ? 'jpeg' : stored.ext}` })));
    else if (!(img.getAttribute('src') ?? '').startsWith('data:image/')) img.remove();
  }
  const inch = (px: number) => `${(px / 96).toFixed(3)}in`;
  const boxes: string[] = [];
  const header = marginContent(opts.header);
  const footer = marginContent(opts.footer);
  const box = (where: 'top' | 'bottom', m: { align: string; content: string }) =>
    `@${where}-${m.align} { content: ${m.content}; font: 10pt "Carlito", sans-serif; vertical-align: ${where === 'top' ? 'bottom' : 'top'}; }`;
  if (header) boxes.push(box('top', header));
  if (footer) boxes.push(box('bottom', footer));
  const css = [
    await inlineFonts(),
    `@page { size: ${inch(section.pageW)} ${inch(section.pageH)}; margin: ${inch(section.mTop)} ${inch(section.mRight)} ${inch(section.mBottom)} ${inch(section.mLeft)}; ${boxes.join(' ')} }`,
    EDITOR_CSS,
    // Shading and highlights are part of a document, not page decoration: they print.
    'html, body { margin: 0; background: #fff; } * { -webkit-print-color-adjust: exact; print-color-adjust: exact; } .wp-doc { flex: none !important; }',
    '.wp-doc .wp-pagebreak { break-after: page; height: 0; }',
    // Gridlines are for the screen.
    '.wp-doc table td { border: none; } .wp-doc table.wp-noborders > tbody > tr > td { border: none !important; }',
    opts.docCss,
  ].join('\n');
  const title = opts.title.replace(/[<>&"]/g, '');
  return `<!doctype html><html><head><meta charset="utf-8"><title>${title}</title><style>${css.replace(/<\/style/gi, '')}</style></head><body><div class="${opts.scope}"><div class="${clone.className}">${clone.innerHTML}</div></div></body></html>`;
}
