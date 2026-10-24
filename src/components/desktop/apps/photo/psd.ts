import { readPsd, writePsdUint8Array, type Color, type Layer as PsdLayer, type LayerMaskData, type Psd } from 'ag-psd';
import { colorToRgb } from './adjust';
import { allLayers, blankLayer, ctx2d, makeCanvas, type Doc, type Layer, type LayerKind, type Mask, type TextData } from './model';
import { rgbToHex } from './paint';
import { flatten } from './render';

/** Bigger than this on a side isn't opened: a browser canvas can't hold it well. */
export const MAX_SIDE = 16384;

export const OPEN_EXTENSIONS = ['.psd', '.png', '.jpg', '.jpeg', '.gif', '.bmp', '.webp', '.avif', '.ico', '.svg'];
const RASTER_MIME: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  bmp: 'image/bmp',
  webp: 'image/webp',
  avif: 'image/avif',
  ico: 'image/x-icon',
  svg: 'image/svg+xml',
};

export const SAVE_TYPES = [
  { name: 'Photoshop (keeps layers)', patterns: ['*.psd'], mimeTypes: ['image/vnd.adobe.photoshop'] },
  { name: 'PNG', patterns: ['*.png'], mimeTypes: ['image/png'] },
  { name: 'JPEG', patterns: ['*.jpg', '*.jpeg'], mimeTypes: ['image/jpeg'] },
  { name: 'WebP', patterns: ['*.webp'], mimeTypes: ['image/webp'] },
];

export const extOf = (path: string) => {
  const name = path.slice(path.lastIndexOf('/') + 1);
  const i = name.lastIndexOf('.');
  return i > 0 ? name.slice(i + 1).toLowerCase() : '';
};

export const isPsd = (path: string) => extOf(path) === 'psd';
export const savesAs = (path: string) => ['psd', 'png', 'jpg', 'jpeg', 'webp'].includes(extOf(path));

// ---- Reading ---------------------------------------------------------------------

const PS_FONT_NAMES: Record<string, string> = {
  Arial: 'ArialMT',
  'Times New Roman': 'TimesNewRomanPSMT',
  'Courier New': 'CourierNewPSMT',
  Georgia: 'Georgia',
  Verdana: 'Verdana',
  Helvetica: 'Helvetica',
  Inter: 'Inter-Regular',
};

function maskFrom(m: LayerMaskData | undefined): Mask | null {
  if (!m) return null;
  const left = m.left ?? 0;
  const top = m.top ?? 0;
  const defaultColor = m.defaultColor ?? 0;
  let canvas = m.canvas;
  if (!canvas) {
    // An empty mask is all its default color.
    canvas = makeCanvas(1, 1);
    const c = ctx2d(canvas);
    c.fillStyle = `rgb(${defaultColor},${defaultColor},${defaultColor})`;
    c.fillRect(0, 0, 1, 1);
  }
  return { canvas, left, top, defaultColor, disabled: !!m.disabled };
}

/** "TimesNewRomanPSMT" → "Times New Roman", near enough for CSS to find it. */
function cssFamily(postscript: string): string {
  const known = Object.entries(PS_FONT_NAMES).find(([, ps]) => ps === postscript);
  if (known) return known[0];
  return postscript.split('-')[0].replace(/(PS)?MT$/, '').replace(/([a-z])([A-Z])/g, '$1 $2');
}

function textFrom(pl: PsdLayer): TextData | null {
  const t = pl.text;
  if (!t) return null;
  const tr = t.transform ?? [1, 0, 0, 1, pl.left ?? 0, pl.top ?? 0];
  const scale = Math.hypot(tr[2], tr[3]) || 1;
  const style = t.styleRuns?.[0]?.style ?? t.style ?? {};
  const just = t.paragraphStyle?.justification ?? t.paragraphStyleRuns?.[0]?.style.justification;
  const [r, g, b] = colorToRgb(style.fillColor as Color | undefined);
  return {
    text: t.text.replace(/\r/g, '\n'),
    font: cssFamily(style.font?.name ?? 'Arial'),
    size: (style.fontSize ?? 12) * scale,
    color: rgbToHex(r, g, b),
    bold: !!style.fauxBold || /bold|black|heavy/i.test(style.font?.name ?? ''),
    italic: !!style.fauxItalic || /italic|oblique/i.test(style.font?.name ?? ''),
    align: just === 'center' ? 'center' : just === 'right' ? 'right' : 'left',
    x: tr[4],
    y: tr[5],
  };
}

function kindOf(pl: PsdLayer): LayerKind {
  if (pl.children) return 'group';
  if (pl.adjustment) return 'adjustment';
  if (pl.text) return 'text';
  if (pl.placedLayer) return 'smart';
  if (pl.vectorFill || pl.vectorMask || pl.vectorOrigination) return 'shape';
  return 'pixel';
}

function fromPsdLayer(pl: PsdLayer): Layer {
  const kind = kindOf(pl);
  // A mask made from vector data is the shape's outline; the user's own mask is then the "real" one.
  const fromVector = !!pl.mask?.fromVectorData;
  const source: PsdLayer = { ...pl, canvas: undefined, imageData: undefined, children: undefined, mask: undefined, realMask: undefined };
  return {
    ...blankLayer(pl.name ?? 'Layer', { width: 1, height: 1 }),
    kind,
    canvas: kind === 'group' || kind === 'adjustment' ? null : (pl.canvas ?? null),
    left: pl.left ?? 0,
    top: pl.top ?? 0,
    opacity: pl.opacity ?? 1,
    fill: pl.fillOpacity ?? 1,
    blendMode: pl.blendMode ?? (kind === 'group' ? 'pass through' : 'normal'),
    hidden: !!pl.hidden,
    clipping: !!pl.clipping,
    locked: !!(pl.protected?.position && pl.protected?.composite),
    lockAlpha: !!(pl.protected?.transparency || pl.transparencyProtected),
    mask: maskFrom(fromVector ? pl.realMask : pl.mask),
    vectorMask: fromVector ? maskFrom(pl.mask) : null,
    children: (pl.children ?? []).map(fromPsdLayer),
    open: pl.opened ?? false,
    adjustment: pl.adjustment ?? null,
    text: textFrom(pl),
    effects: pl.effects ?? null,
    source,
    sourceCanvas: pl.canvas ?? null,
  };
}

/** Read a PSD into a document. Throws a sentence a person can read. */
export function readPsdDoc(bytes: Uint8Array): Doc {
  if (bytes.length < 26 || String.fromCharCode(...bytes.subarray(0, 4)) !== '8BPS') {
    throw new Error('It isn’t a Photoshop file.');
  }
  const version = (bytes[4] << 8) | bytes[5];
  if (version === 2) throw new Error('It’s a Large Document (PSB), which Photo Editor can’t open yet.');
  const depth = (bytes[22] << 8) | bytes[23];
  if (depth !== 8) throw new Error(`It uses ${depth} bits per channel; Photo Editor opens 8-bit documents.`);
  let psd: Psd;
  try {
    psd = readPsd(bytes, { skipThumbnail: true });
  } catch (error) {
    const why = error instanceof Error ? error.message : String(error);
    if (/color mode/i.test(why)) throw new Error('Its color mode isn’t supported. Photo Editor opens RGB and grayscale documents.', { cause: error });
    throw new Error(`It couldn’t be read (${why}).`, { cause: error });
  }
  if (psd.width > MAX_SIDE || psd.height > MAX_SIDE) {
    throw new Error(`It’s too big (${psd.width} × ${psd.height}; up to ${MAX_SIDE} on a side).`);
  }
  let layers = (psd.children ?? []).map(fromPsdLayer);
  if (layers.length === 0) {
    // A flat file: its composite is its only layer.
    const bg = blankLayer('Background', psd);
    if (psd.canvas) ctx2d(bg.canvas!).drawImage(psd.canvas, 0, 0);
    layers = [bg];
  }
  const source: Psd = { ...psd, children: undefined, canvas: undefined, imageData: undefined };
  return { width: psd.width, height: psd.height, layers, source };
}

/** Decode a PNG, JPEG and the like into a canvas. */
export async function decodeImage(bytes: Uint8Array, path: string): Promise<HTMLCanvasElement> {
  const blob = new Blob([bytes as BlobPart], { type: RASTER_MIME[extOf(path)] ?? '' });
  const url = URL.createObjectURL(blob);
  try {
    const img = new Image();
    img.src = url;
    await img.decode();
    const w = img.naturalWidth || 300;
    const h = img.naturalHeight || 150;
    if (w > MAX_SIDE || h > MAX_SIDE) throw new Error(`It’s too big (${w} × ${h}; up to ${MAX_SIDE} on a side).`);
    const canvas = makeCanvas(w, h);
    ctx2d(canvas).drawImage(img, 0, 0, w, h);
    return canvas;
  } catch (error) {
    if (error instanceof Error && error.message.startsWith('It’s')) throw error;
    throw new Error('It doesn’t look like a picture Photo Editor can open.', { cause: error });
  } finally {
    URL.revokeObjectURL(url);
  }
}

/** Open any supported file as a document. */
export async function readDoc(bytes: Uint8Array, path: string): Promise<Doc> {
  if (isPsd(path)) return readPsdDoc(bytes);
  const canvas = await decodeImage(bytes, path);
  const bg = blankLayer('Background', canvas, { canvas });
  return { width: canvas.width, height: canvas.height, layers: [bg], source: null };
}

// ---- Writing ---------------------------------------------------------------------

function maskData(m: Mask, fromVectorData = false): LayerMaskData {
  return {
    canvas: m.canvas,
    left: m.left,
    top: m.top,
    right: m.left + m.canvas.width,
    bottom: m.top + m.canvas.height,
    defaultColor: m.defaultColor,
    disabled: m.disabled,
    positionRelativeToLayer: false,
    fromVectorData,
  };
}

function hexColor(hex: string) {
  const n = parseInt(hex.slice(1), 16);
  return { r: (n >> 16) & 255, g: (n >> 8) & 255, b: n & 255 };
}

function shift(points: number[], dx: number, dy: number): number[] {
  return points.map((v, i) => v + (i % 2 ? dy : dx));
}

function toPsdLayer(l: Layer, usedIds: Set<number>): PsdLayer {
  const src: PsdLayer = { ...(l.source ?? {}) };
  if (src.id !== undefined) {
    if (usedIds.has(src.id)) delete src.id;
    else usedIds.add(src.id);
  }
  // A rasterized shape, smart object or type layer is a plain layer now.
  if (l.kind === 'pixel') {
    delete src.placedLayer;
    delete src.vectorFill;
    delete src.vectorStroke;
    delete src.vectorMask;
    delete src.vectorOrigination;
    delete src.text;
  }
  // A moved shape or smart object takes its vector data along.
  const dx = l.left - (l.source?.left ?? l.left);
  const dy = l.top - (l.source?.top ?? l.top);
  if ((dx || dy) && l.kind !== 'pixel') {
    if (src.vectorMask) {
      src.vectorMask = {
        ...src.vectorMask,
        paths: src.vectorMask.paths.map((p) => ({ ...p, knots: p.knots.map((k) => ({ ...k, points: shift(k.points, dx, dy) })) })),
      };
    }
    if (src.placedLayer) {
      src.placedLayer = {
        ...src.placedLayer,
        transform: shift(src.placedLayer.transform, dx, dy),
        nonAffineTransform: src.placedLayer.nonAffineTransform && shift(src.placedLayer.nonAffineTransform, dx, dy),
      };
    }
  }
  const out: PsdLayer = {
    ...src,
    name: l.name,
    hidden: l.hidden,
    opacity: l.opacity,
    fillOpacity: l.fill,
    blendMode: l.blendMode,
    clipping: l.clipping,
    left: l.left,
    top: l.top,
    canvas: l.canvas ?? undefined,
    protected: { ...src.protected, transparency: l.lockAlpha, position: l.locked, composite: l.locked },
    transparencyProtected: l.lockAlpha,
    effects: l.effects ?? undefined,
    adjustment: l.kind === 'adjustment' ? (l.adjustment ?? undefined) : undefined,
  };
  if (l.canvas) {
    out.right = l.left + l.canvas.width;
    out.bottom = l.top + l.canvas.height;
  } else {
    out.right = l.left;
    out.bottom = l.top;
  }
  if (l.vectorMask && l.kind !== 'pixel') {
    out.mask = maskData({ ...l.vectorMask, left: l.vectorMask.left, top: l.vectorMask.top }, true);
    out.realMask = l.mask ? maskData(l.mask) : undefined;
  } else {
    out.mask = l.mask ? maskData(l.mask) : undefined;
    out.realMask = undefined;
  }
  if (l.kind === 'group') {
    out.children = l.children.map((c) => toPsdLayer(c, usedIds));
    out.opened = l.open;
  } else {
    delete out.children;
    delete out.sectionDivider;
  }
  if (l.kind === 'text' && l.text) {
    const t = l.text;
    if (l.textEdited || !src.text) {
      const base = src.text;
      const style = {
        ...(base?.styleRuns?.[0]?.style ?? base?.style ?? {}),
        font: { name: PS_FONT_NAMES[t.font] ?? t.font },
        fontSize: t.size,
        fauxBold: t.bold,
        fauxItalic: t.italic,
        fillColor: hexColor(t.color),
      };
      out.text = {
        ...(base ?? {}),
        text: t.text.replace(/\n/g, '\r'),
        transform: [1, 0, 0, 1, t.x, t.y],
        style,
        styleRuns: undefined,
        paragraphStyle: { ...(base?.paragraphStyle ?? {}), justification: t.align },
        paragraphStyleRuns: undefined,
        shapeType: 'point',
        boxBounds: undefined,
        warp: base?.warp,
      };
    } else if ((dx || dy) && src.text.transform) {
      const [a, b, c, d, x, y] = src.text.transform;
      out.text = { ...src.text, transform: [a, b, c, d, x + dx, y + dy] };
    }
  }
  return out;
}

/** A PSD of the document, composite included so viewers that only read that see it right. */
export function writePsdDoc(doc: Doc): Uint8Array {
  const src = doc.source ?? { width: doc.width, height: doc.height };
  const resources = { ...(src.imageResources ?? {}) };
  // These index into the layer list as it was; they'd point at the wrong layers now.
  delete resources.layerState;
  delete resources.layerSelectionIds;
  delete resources.layerComps;
  delete resources.sheetDisclosure;
  delete resources.animations;
  delete resources.timelineInformation;
  delete resources.onionSkins;
  delete resources.thumbnail;
  delete resources.thumbnailRaw;
  const usedIds = new Set<number>();
  const psd: Psd = {
    ...src,
    width: doc.width,
    height: doc.height,
    channels: 3,
    bitsPerChannel: 8,
    colorMode: 3,
    imageResources: resources,
    children: doc.layers.map((l) => toPsdLayer(l, usedIds)),
    canvas: flatten(doc),
    imageData: undefined,
  };
  const invalidateTextLayers = allLayers(doc.layers).some((l) => l.kind === 'text' && l.textEdited);
  return writePsdUint8Array(psd, { generateThumbnail: true, trimImageData: true, invalidateTextLayers, noBackground: !doc.layers[0] || doc.layers[0].name !== 'Background' });
}

function blobOf(canvas: HTMLCanvasElement, type: string, quality?: number): Promise<Blob> {
  return new Promise((resolve, reject) =>
    canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('The picture couldn’t be encoded.'))), type, quality),
  );
}

/** Encode the document for saving, by the file's extension. Anything but PSD is flattened. */
export async function encodeDoc(doc: Doc, path: string, quality = 0.92): Promise<Uint8Array> {
  const ext = extOf(path);
  if (ext === 'psd') return writePsdDoc(doc);
  const flat = flatten(doc);
  let blob: Blob;
  if (ext === 'jpg' || ext === 'jpeg') {
    const c = makeCanvas(doc.width, doc.height);
    const x = ctx2d(c);
    x.fillStyle = '#ffffff';
    x.fillRect(0, 0, doc.width, doc.height);
    x.drawImage(flat, 0, 0);
    blob = await blobOf(c, 'image/jpeg', quality);
  } else if (ext === 'webp') {
    blob = await blobOf(flat, 'image/webp', quality);
  } else {
    blob = await blobOf(flat, 'image/png');
  }
  return new Uint8Array(await blob.arrayBuffer());
}

export function pngBlob(c: HTMLCanvasElement): Promise<Blob> {
  return blobOf(c, 'image/png');
}
