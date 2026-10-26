import { EmbeddedFont, readSfnt } from '../vector/pdf/sfnt';
import type { PdfWriter } from '../vector/pdf/writer';

/**
 * Which font file the canvas drew each character with, so a PDF can embed
 * that same file: the page's @font-face rules (the bundled stand-ins for
 * document fonts) matched the way CSS matches them, by family, weight,
 * style and unicode-range, falling through a family list to the next one
 * that has the character.
 */

interface FaceRule {
  family: string;
  weight: [number, number];
  italic: boolean;
  ranges: [number, number][] | null;
  url: string;
}

let rulesCache: FaceRule[] | null = null;

function parseRanges(s: string): [number, number][] | null {
  if (!s.trim()) return null;
  const out: [number, number][] = [];
  for (const part of s.split(',')) {
    const m = /U\+([0-9a-f?]+)(?:-([0-9a-f]+))?/i.exec(part.trim());
    if (!m) continue;
    if (m[1].includes('?')) out.push([parseInt(m[1].replace(/\?/g, '0'), 16), parseInt(m[1].replace(/\?/g, 'f'), 16)]);
    else out.push([parseInt(m[1], 16), parseInt(m[2] ?? m[1], 16)]);
  }
  return out;
}

function faceRules(): FaceRule[] {
  if (rulesCache) return rulesCache;
  const out: FaceRule[] = [];
  for (const sheet of Array.from(document.styleSheets)) {
    let list: CSSRuleList;
    try {
      list = sheet.cssRules;
    } catch {
      continue;
    }
    for (const rule of Array.from(list)) {
      if (!(rule instanceof CSSFontFaceRule)) continue;
      const st = rule.style;
      const src = st.getPropertyValue('src');
      // WOFF2 needs Brotli, which isn't here; WOFF and TrueType inflate with zlib.
      const url = /url\(["']?([^"')]+)["']?\)\s*format\(["']?(?:woff|truetype)["']?\)/.exec(src)?.[1];
      if (!url) continue;
      const w = st.getPropertyValue('font-weight').trim().split(/\s+/).map((x) => (x === 'bold' ? 700 : x === 'normal' || !x ? 400 : Number(x)));
      out.push({
        family: st.getPropertyValue('font-family').replace(/["']/g, '').trim().toLowerCase(),
        weight: [w[0] || 400, w[1] || w[0] || 400],
        italic: /italic|oblique/.test(st.getPropertyValue('font-style')),
        ranges: parseRanges(st.getPropertyValue('unicode-range')),
        url: new URL(url, sheet.href ?? location.href).href,
      });
    }
  }
  rulesCache = out;
  return out;
}

/** CSS's weight matching: the faces of the weight the browser would pick. */
function matchWeight(faces: FaceRule[], want: number): FaceRule[] {
  if (!faces.length) return faces;
  const has = (w: number) => faces.filter((f) => f.weight[0] <= w && w <= f.weight[1]);
  const exact = has(want);
  if (exact.length) return exact;
  const weights = [...new Set(faces.flatMap((f) => f.weight))].sort((a, b) => a - b);
  const up = weights.filter((w) => w > want);
  const down = weights.filter((w) => w < want).reverse();
  let order: number[];
  if (want >= 400 && want <= 500) order = [...up.filter((w) => w <= 500), ...down, ...up.filter((w) => w > 500)];
  else if (want < 400) order = [...down, ...up];
  else order = [...up, ...down];
  return has(order[0]);
}

/** A canvas font string ("italic 700 100px "A", "B", serif") taken apart. */
function parseFont(font: string): { italic: boolean; weight: number; families: string[] } {
  const m = /^(italic\s+)?(\d+)\s+[\d.]+px\s+(.*)$/.exec(font.trim());
  const families = (m?.[3] ?? font).split(',').map((f) => f.trim().replace(/^["']|["']$/g, '').toLowerCase());
  return { italic: !!m?.[1], weight: Number(m?.[2] ?? 400), families };
}

export class WebFonts {
  private files = new Map<string, Promise<EmbeddedFont | null>>();
  private picks = new Map<string, EmbeddedFont | null>();
  private installed = new Map<string, boolean>();
  private names = new Map<EmbeddedFont, string>();

  constructor(
    readonly w: PdfWriter,
    readonly notes: Set<string>,
  ) {}

  private file(url: string): Promise<EmbeddedFont | null> {
    let p = this.files.get(url);
    if (!p) {
      p = fetch(url)
        .then((r) => r.arrayBuffer())
        .then((b) => {
          const f = readSfnt(new Uint8Array(b));
          return f ? new EmbeddedFont(this.w, f) : null;
        })
        .catch(() => null);
      this.files.set(url, p);
    }
    return p;
  }

  /** Whether a family the page has no @font-face for is installed (the canvas then draws with it). */
  private isInstalled(family: string): boolean {
    let v = this.installed.get(family);
    if (v === undefined) {
      const c = document.createElement('canvas').getContext('2d')!;
      const probe = 'mmmmmmmmmmlli1WQ@#';
      v = ['monospace', 'serif', 'sans-serif'].some((g) => {
        c.font = `72px ${g}`;
        const a = c.measureText(probe).width;
        c.font = `72px "${family}", ${g}`;
        return c.measureText(probe).width !== a;
      });
      this.installed.set(family, v);
    }
    return v;
  }

  /** The embedded font the canvas drew a character with in a font; null where it isn't one of the page's own. */
  async pick(font: string, ch: string): Promise<EmbeddedFont | null> {
    const cp = ch.codePointAt(0) ?? 0;
    const key = `${font}\u0000${cp}`;
    if (this.picks.has(key)) return this.picks.get(key)!;
    const { italic, weight, families } = parseFont(font);
    const rules = faceRules();
    let found: EmbeddedFont | null = null;
    for (const family of families) {
      const faces = rules.filter((r) => r.family === family);
      if (!faces.length) {
        // The document's own font, installed here: the canvas drew with it.
        if (family === families[0] && this.isInstalled(family)) {
          this.notes.add(`“${family}” is installed on this computer but its file can’t be read here; its text uses the stand-in font in the PDF.`);
        }
        continue;
      }
      const styled = faces.filter((f) => f.italic === italic);
      const pool = matchWeight(styled.length ? styled : faces, weight);
      const face = pool.find((f) => !f.ranges || f.ranges.some(([a, z]) => cp >= a && cp <= z));
      if (!face) continue;
      const ef = await this.file(face.url);
      if (ef && ef.has(cp)) {
        found = ef;
        break;
      }
    }
    this.picks.set(key, found);
    return found;
  }

  /** A font's name in page resources. */
  name(font: EmbeddedFont): string {
    let n = this.names.get(font);
    if (!n) this.names.set(font, (n = `F${this.names.size}`));
    return n;
  }

  /** Write every font that was used. */
  async finish() {
    for (const p of this.files.values()) (await p)?.finish();
  }
}
