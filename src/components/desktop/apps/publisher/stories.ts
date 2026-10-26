import { compose, type Composition, type FrameSpec } from './compose';
import { boundsOf, invert, mul, rectCorners, apply, type Rect } from './geom';
import { docVersion, partRoot } from './idml';
import type { Item, Model, Page } from './model';

/**
 * Keeps each story's composition until its text, its styles, or its
 * frames change; works out the frames' text areas and what they wrap
 * around.
 */

interface Entry {
  story: XMLDocument;
  styles: unknown;
  key: string;
  comp: Composition;
}

export class Stories {
  private cache = new Map<string, Entry>();
  /** Bumped when fonts load, so lines get measured again. */
  version = 0;

  clear() {
    this.cache.clear();
    this.version++;
  }

  /** The frames a story flows through, as they are now (overrides are mid-gesture items). */
  frames(model: Model, story: string, overrides?: Map<string, Item>): Item[] {
    return (model.threads.get(story) ?? []).map((f) => overrides?.get(f.self) ?? f);
  }

  comp(model: Model, story: string, page: Page | null, overrides?: Map<string, Item>): Composition | null {
    const part = model.stories.get(story);
    const doc = part ? model.pkg.xml.get(part) : undefined;
    const root = doc && partRoot(doc);
    if (!doc || !root) return null;
    const frames = this.frames(model, story, overrides);
    if (!frames.length) return null;
    // Only stories with page number markers set differently page to page.
    const pageName = usesPageNumbers(root) ? (page?.name ?? '1') : '';
    const nextPage = pageName ? (model.pages[(page ? model.pages.findIndex((p) => p.self === page.self) : 0) + 1]?.name ?? pageName) : '';
    const specs = frames.map((f) => frameSpec(model, f, pageName, nextPage, overrides));
    const key = `${this.version}|${docVersion(doc)}|${pageName}|${JSON.stringify(specs)}`;
    const cacheKey = `${story}|${pageName}`;
    const hit = this.cache.get(cacheKey);
    if (hit && hit.story === doc && hit.styles === model.styles && hit.key === key) return hit.comp;
    const comp = compose(root, model.styles, specs, model.prefs.text);
    this.cache.set(cacheKey, { story: doc, styles: model.styles, key, comp });
    return comp;
  }
}

const MARKERS = new WeakMap<Element, { version: number; uses: boolean }>();

function usesPageNumbers(story: Element): boolean {
  const v = docVersion(story.ownerDocument as XMLDocument);
  const hit = MARKERS.get(story);
  if (hit && hit.version === v) return hit.uses;
  let uses = false;
  const walker = story.ownerDocument.createTreeWalker(story, 0x40 /* NodeFilter.SHOW_PROCESSING_INSTRUCTION */);
  for (let n = walker.nextNode(); n; n = walker.nextNode()) {
    const d = (n as ProcessingInstruction).data.trim();
    if ((n as ProcessingInstruction).target === 'ACE' && (d === '18' || d === '19')) {
      uses = true;
      break;
    }
  }
  MARKERS.set(story, { version: v, uses });
  return uses;
}

/** The text area and columns of a frame, in its own coordinates. */
export function textArea(f: Item): Rect {
  const p = f.text!.prefs;
  const b = f.box;
  return { x: b.x + p.inset[1], y: b.y + p.inset[0], w: Math.max(0, b.w - p.inset[1] - p.inset[3]), h: Math.max(0, b.h - p.inset[0] - p.inset[2]) };
}

function frameSpec(model: Model, f: Item, page: string, nextPage: string, overrides?: Map<string, Item>): FrameSpec {
  const p = f.text!.prefs;
  return {
    self: f.self,
    area: textArea(f),
    columns: p.columns,
    gutter: p.gutter,
    fixedWidth: p.fixedWidth,
    vj: p.vj,
    firstBaseline: p.firstBaseline,
    minFirstBaseline: p.minFirstBaseline,
    page,
    nextPage,
    wraps: p.ignoreWrap ? [] : wrapsFor(model, f, overrides),
  };
}

/** Items on the frame's spread that push its text away, as rectangles in the frame's coordinates. */
function wrapsFor(model: Model, f: Item, overrides?: Map<string, Item>): { rect: Rect; mode: string }[] {
  const spread = model.spreadOf.get(f.self);
  if (!spread) return [];
  const out: { rect: Rect; mode: string }[] = [];
  const inv = invert(f.m);
  const fb = boundsOf(rectCorners(f.box).map((q) => apply(f.m, q)));
  const story = f.text!.story;
  const hiddenLayers = new Set(model.layers.filter((l) => !l.visible).map((l) => l.self));
  const visit = (list: Item[], parentM: Item['m'] | null) => {
    for (const it0 of list) {
      const it = overrides?.get(it0.self) ?? it0;
      if (it.self === f.self || hiddenLayers.has(it.layer) || !it.visible) continue;
      if (it.kind === 'text' && it.text?.story === story) continue;
      const m = parentM ? mul(parentM, it.local) : it.m;
      if (it.wrap && it.wrap.mode !== 'None' && !it.wrap.inverse) {
        const b = boundsOf(rectCorners(it.box).map((q) => apply(m, q)));
        const [t, l, bo, r] = it.wrap.offsets;
        const grown = { x: b.x - l, y: b.y - t, w: b.w + l + r, h: b.h + t + bo };
        if (grown.x < fb.x + fb.w && fb.x < grown.x + grown.w && grown.y < fb.y + fb.h && fb.y < grown.y + grown.h) {
          const local = boundsOf(rectCorners(grown).map((q) => apply(inv, q)));
          out.push({ rect: local, mode: it.wrap.mode });
        }
      }
      if (it.kind === 'group') visit(it.children, m);
    }
  };
  visit(spread.items, null);
  return out;
}
