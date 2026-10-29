import type { PubPara, PubRun } from './doc';
import type { CharStyle, ParaStyle, QuillText } from './quill';

/**
 * Quill's formatting as plain settings. A paragraph names a default style
 * (from STSH) that fills in what it doesn't say; bold, italic and the other
 * switches in a run turn the default's setting over rather than on.
 */

/** A file color value as '#rrggbb' (with the color it's relative to, for derived colors). */
export type Colors = (c: number, base?: number) => string;

const EMU = 12700;

const ALIGN: Record<number, PubPara['align']> = { 0: 'left', 1: 'right', 2: 'center', 6: 'justify' };

const UNDERLINE: Record<number, PubRun['underline']> = {
  1: 'single', 2: 'words', 3: 'double', 4: 'dotted', 6: 'thick', 7: 'dashed', 9: 'dashed', 10: 'dashed', 11: 'wave',
  0x10: 'wave', 0x11: 'dotted', 0x12: 'dashed', 0x13: 'dashed', 0x14: 'dashed', 0x15: 'dashed', 0x16: 'dashed', 0x17: 'wave',
};

export function storyParas(q: QuillText, id: number, color: Colors, textColor?: (entry: number) => string | undefined): PubPara[] {
  const story = q.stories.get(id);
  if (!story) return [];
  return story.map((p) => {
    const def = p.style.defaultStyle;
    const dp: ParaStyle = (def !== undefined ? q.defaultPara[def] : undefined) ?? {};
    const dc: CharStyle = q.defaultChar[def ?? 0] ?? {};
    const pick = <K extends keyof ParaStyle>(k: K) => p.style[k] ?? dp[k];
    const para: PubPara = { runs: [] };
    const align = pick('align');
    if (align !== undefined) para.align = ALIGN[align] ?? 'left';
    const ls = pick('lineSpacing');
    if (ls !== undefined) {
      if (ls & 1) para.lineSpacing = { pt: (ls - 1) / 8 / EMU };
      else if (ls & 2) {
        const lines = ((ls - 2) / 914400) * (72 / 96);
        if (Math.abs(lines - 1) > 0.01) para.lineSpacing = { lines };
      }
    }
    const emu = (k: 'spaceBefore' | 'spaceAfter' | 'firstIndent' | 'leftIndent' | 'rightIndent') => {
      const v = pick(k);
      return v ? v / EMU : undefined;
    };
    para.spaceBefore = emu('spaceBefore');
    para.spaceAfter = emu('spaceAfter');
    para.firstIndent = emu('firstIndent');
    para.leftIndent = emu('leftIndent');
    para.rightIndent = emu('rightIndent');
    const tabs = pick('tabs');
    if (tabs?.length) para.tabs = tabs.map((t) => t / EMU);
    if (pick('list')) {
      const b = pick('bullet');
      if (b) para.bullet = String.fromCharCode(b);
      else para.numbered = { start: pick('numberStart') ?? 1 };
    }
    const dl = pick('dropLines');
    if (dl) para.dropCap = { lines: dl, chars: pick('dropChars') ?? 1 };

    for (const sp of p.spans) {
      if (!sp.text) continue;
      const st = sp.style;
      const run: PubRun = { text: sp.text };
      if (!!st.bold !== !!dc.bold) run.bold = true;
      if (!!st.italic !== !!dc.italic) run.italic = true;
      if (!!st.outline !== !!dc.outline) run.outline = true;
      if (!!st.shadow !== !!dc.shadow) run.shadow = true;
      if (!!st.smallCaps !== !!dc.smallCaps) run.caps = 'small';
      else if (!!st.allCaps !== !!dc.allCaps) run.caps = 'all';
      const u = st.underline ?? dc.underline;
      if (u) run.underline = UNDERLINE[u] ?? 'single';
      const size = st.size ?? dc.size;
      if (size) run.size = size;
      const scale = st.scale ?? dc.scale;
      if (scale && scale !== 100) run.scale = scale;
      const c = st.color ?? dc.color;
      if (c !== undefined) {
        const fromEntry = textColor?.(c);
        if (fromEntry) run.color = fromEntry;
        else if (c < q.colors.length) run.color = color(q.colors[c]);
      }
      const f = st.font ?? dc.font ?? (q.fonts.length ? 0 : undefined);
      if (f !== undefined && q.fonts[f]) run.font = q.fonts[f];
      if (st.superSub === 1) run.position = 'super';
      else if (st.superSub === 2) run.position = 'sub';
      para.runs.push(run);
    }
    return para;
  });
}
