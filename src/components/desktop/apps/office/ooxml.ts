import { strFromU8, strToU8, unzipSync, zipSync, type Zippable } from 'fflate';

/**
 * Office Open XML packages (.docx, .xlsx, .pptx): a zip of XML parts tied
 * together by relationship files and a content-types list. The apps read a
 * package, turn the parts they understand into their own model, and write
 * those parts back, carrying everything else in the package along as it was.
 */

export const NS = {
  w: 'http://schemas.openxmlformats.org/wordprocessingml/2006/main',
  r: 'http://schemas.openxmlformats.org/officeDocument/2006/relationships',
  a: 'http://schemas.openxmlformats.org/drawingml/2006/main',
  p: 'http://schemas.openxmlformats.org/presentationml/2006/main',
  s: 'http://schemas.openxmlformats.org/spreadsheetml/2006/main',
  wp: 'http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing',
  pic: 'http://schemas.openxmlformats.org/drawingml/2006/picture',
  mc: 'http://schemas.openxmlformats.org/markup-compatibility/2006',
};

export const REL = {
  officeDocument: 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument',
  coreProps: 'http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties',
  extProps: 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/extended-properties',
  styles: 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles',
  numbering: 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/numbering',
  theme: 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/theme',
  settings: 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/settings',
  fontTable: 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/fontTable',
  webSettings: 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/webSettings',
  header: 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/header',
  footer: 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/footer',
  image: 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/image',
  hyperlink: 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/hyperlink',
  worksheet: 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet',
  sharedStrings: 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/sharedStrings',
  slide: 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/slide',
  slideLayout: 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/slideLayout',
  slideMaster: 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/slideMaster',
  notesSlide: 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/notesSlide',
  notesMaster: 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/notesMaster',
  presProps: 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/presProps',
  viewProps: 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/viewProps',
  tableStyles: 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/tableStyles',
};

export const CT = {
  rels: 'application/vnd.openxmlformats-package.relationships+xml',
  xml: 'application/xml',
  core: 'application/vnd.openxmlformats-package.core-properties+xml',
  app: 'application/vnd.openxmlformats-officedocument.extended-properties+xml',
  theme: 'application/vnd.openxmlformats-officedocument.theme+xml',
};

/** Image content types by extension, for `<Default>` entries. */
export const IMAGE_TYPES: Record<string, string> = {
  png: 'image/png',
  jpeg: 'image/jpeg',
  jpg: 'image/jpeg',
  gif: 'image/gif',
  bmp: 'image/bmp',
  webp: 'image/webp',
  svg: 'image/svg+xml',
  tif: 'image/tiff',
  tiff: 'image/tiff',
  emf: 'image/x-emf',
  wmf: 'image/x-wmf',
};

export const XML_HEADER = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n';

export interface Rel {
  id: string;
  type: string;
  /** The part it points at, as a package path without a leading slash; or the URL, if external. */
  target: string;
  external: boolean;
}

/** Package path of the relationships part for `part` ('' for the package itself). */
export function relsPath(part: string): string {
  const slash = part.lastIndexOf('/');
  return `${part.slice(0, slash + 1)}_rels/${part.slice(slash + 1)}.rels`;
}

/** A relationship target resolved against the part that holds it. */
export function resolveTarget(part: string, target: string): string {
  if (target.startsWith('/')) return target.slice(1);
  const base = part.slice(0, part.lastIndexOf('/') + 1).split('/').filter(Boolean);
  for (const seg of target.split('/')) {
    if (seg === '..') base.pop();
    else if (seg !== '.' && seg !== '') base.push(seg);
  }
  return base.join('/');
}

/** `to` relative to the folder `from` sits in, the way relationship files write targets. */
export function relativeTarget(from: string, to: string): string {
  const a = from.split('/').slice(0, -1);
  const b = to.split('/');
  let i = 0;
  while (i < a.length && i < b.length - 1 && a[i] === b[i]) i++;
  return [...Array(a.length - i).fill('..'), ...b.slice(i)].join('/');
}

export class OpcPackage {
  files = new Map<string, Uint8Array>();

  static read(bytes: Uint8Array): OpcPackage {
    const pkg = new OpcPackage();
    let entries: Record<string, Uint8Array>;
    try {
      entries = unzipSync(bytes);
    } catch {
      throw new Error('It isn’t a valid Office file (the package couldn’t be unzipped).');
    }
    for (const [name, data] of Object.entries(entries)) {
      if (!name.endsWith('/')) pkg.files.set(name.replace(/^\//, ''), data);
    }
    if (!pkg.files.has('[Content_Types].xml')) throw new Error('It isn’t an Office Open XML file.');
    return pkg;
  }

  has(path: string): boolean {
    return this.files.has(path);
  }

  bytes(path: string): Uint8Array | null {
    return this.files.get(path) ?? null;
  }

  text(path: string): string | null {
    const data = this.files.get(path);
    return data ? strFromU8(data) : null;
  }

  xml(path: string): Document | null {
    const text = this.text(path);
    return text === null ? null : parseXml(text);
  }

  setText(path: string, text: string): void {
    this.files.set(path, strToU8(text));
  }

  setBytes(path: string, data: Uint8Array): void {
    this.files.set(path, data);
  }

  delete(path: string): void {
    this.files.delete(path);
    this.files.delete(relsPath(path));
    this.removeOverride(path);
  }

  rels(part: string): Rel[] {
    const doc = this.xml(relsPath(part));
    if (!doc) return [];
    return kids(doc.documentElement, 'Relationship').map((el) => {
      const external = el.getAttribute('TargetMode') === 'External';
      const raw = el.getAttribute('Target') ?? '';
      return {
        id: el.getAttribute('Id') ?? '',
        type: el.getAttribute('Type') ?? '',
        target: external ? raw : resolveTarget(part, raw),
        external,
      };
    });
  }

  setRels(part: string, rels: Rel[]): void {
    const body = rels
      .map(
        (r) =>
          `<Relationship Id="${esc(r.id)}" Type="${esc(r.type)}" Target="${esc(r.external ? r.target : relativeTarget(part, r.target))}"${r.external ? ' TargetMode="External"' : ''}/>`,
      )
      .join('');
    this.setText(
      relsPath(part),
      `${XML_HEADER}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${body}</Relationships>`,
    );
  }

  rel(part: string, id: string): Rel | undefined {
    return this.rels(part).find((r) => r.id === id);
  }

  relOfType(part: string, type: string): Rel | undefined {
    return this.rels(part).find((r) => r.type === type);
  }

  /** Add a relationship from `part` and return its id (reusing an identical one). */
  addRel(part: string, type: string, target: string, external = false): string {
    const rels = this.rels(part);
    const same = rels.find((r) => r.type === type && r.target === target && r.external === external);
    if (same) return same.id;
    const used = new Set(rels.map((r) => r.id));
    let n = rels.length + 1;
    while (used.has(`rId${n}`)) n++;
    const id = `rId${n}`;
    this.setRels(part, [...rels, { id, type, target, external }]);
    return id;
  }

  /** The main part: word/document.xml, xl/workbook.xml or ppt/presentation.xml. */
  mainPart(): string | null {
    return this.relOfType('', REL.officeDocument)?.target ?? null;
  }

  private contentTypes(): Document {
    return parseXml(this.text('[Content_Types].xml') ?? '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"/>');
  }

  private saveContentTypes(doc: Document): void {
    this.setText('[Content_Types].xml', XML_HEADER + new XMLSerializer().serializeToString(doc.documentElement));
  }

  contentType(path: string): string | null {
    const doc = this.contentTypes();
    const over = kids(doc.documentElement, 'Override').find((el) => el.getAttribute('PartName') === `/${path}`);
    if (over) return over.getAttribute('ContentType');
    const ext = path.slice(path.lastIndexOf('.') + 1).toLowerCase();
    const def = kids(doc.documentElement, 'Default').find((el) => el.getAttribute('Extension')?.toLowerCase() === ext);
    return def?.getAttribute('ContentType') ?? null;
  }

  ensureDefault(ext: string, type: string): void {
    const doc = this.contentTypes();
    const root = doc.documentElement;
    if (kids(root, 'Default').some((el) => el.getAttribute('Extension')?.toLowerCase() === ext.toLowerCase())) return;
    const el = doc.createElementNS(root.namespaceURI, 'Default');
    el.setAttribute('Extension', ext);
    el.setAttribute('ContentType', type);
    root.insertBefore(el, root.firstChild);
    this.saveContentTypes(doc);
  }

  ensureOverride(path: string, type: string): void {
    const doc = this.contentTypes();
    const root = doc.documentElement;
    const existing = kids(root, 'Override').find((el) => el.getAttribute('PartName') === `/${path}`);
    if (existing) {
      if (existing.getAttribute('ContentType') === type) return;
      existing.setAttribute('ContentType', type);
    } else {
      const el = doc.createElementNS(root.namespaceURI, 'Override');
      el.setAttribute('PartName', `/${path}`);
      el.setAttribute('ContentType', type);
      root.appendChild(el);
    }
    this.saveContentTypes(doc);
  }

  removeOverride(path: string): void {
    const doc = this.contentTypes();
    const el = kids(doc.documentElement, 'Override').find((o) => o.getAttribute('PartName') === `/${path}`);
    if (!el) return;
    el.remove();
    this.saveContentTypes(doc);
  }

  /** A free name like `word/media/image7.png`. */
  freshName(prefix: string, ext: string): string {
    let n = 1;
    while (this.files.has(`${prefix}${n}.${ext}`)) n++;
    return `${prefix}${n}.${ext}`;
  }

  /** Store an image in the package and return its path. */
  addMedia(folder: string, data: Uint8Array, ext: string): string {
    const e = ext.toLowerCase() === 'jpg' ? 'jpeg' : ext.toLowerCase();
    const path = this.freshName(`${folder}/image`, e);
    this.setBytes(path, data);
    this.ensureDefault(e, IMAGE_TYPES[e] ?? 'application/octet-stream');
    return path;
  }

  write(): Uint8Array {
    const entries: Zippable = {};
    // [Content_Types].xml first, as Office writes it.
    const ct = this.files.get('[Content_Types].xml');
    if (ct) entries['[Content_Types].xml'] = ct;
    for (const [name, data] of this.files) {
      if (name === '[Content_Types].xml') continue;
      const stored = /\.(png|jpe?g|gif|webp)$/i.test(name);
      entries[name] = stored ? [data, { level: 0 }] : data;
    }
    return zipSync(entries, { level: 6 });
  }
}

/** Whether bytes look like a zip (and so possibly an OOXML package). */
export function isZip(bytes: Uint8Array): boolean {
  return bytes.length > 4 && bytes[0] === 0x50 && bytes[1] === 0x4b && bytes[2] === 0x03 && bytes[3] === 0x04;
}

/** The old binary Office formats (.doc, .xls, .ppt) start with this OLE signature. */
export function isOle(bytes: Uint8Array): boolean {
  return bytes.length > 8 && bytes[0] === 0xd0 && bytes[1] === 0xcf && bytes[2] === 0x11 && bytes[3] === 0xe0;
}

// ---- Reading XML -----------------------------------------------------------------

export function parseXml(text: string): Document {
  const doc = new DOMParser().parseFromString(text, 'application/xml');
  if (doc.getElementsByTagName('parsererror').length) throw new Error('A part of the file isn’t well-formed XML.');
  return doc;
}

/** Child elements with this local name (any prefix). */
export function kids(el: Element | null | undefined, local?: string): Element[] {
  if (!el) return [];
  const out: Element[] = [];
  for (let c = el.firstElementChild; c; c = c.nextElementSibling) {
    if (!local || c.localName === local) out.push(c);
  }
  return out;
}

/** The first child element with this local name. */
export function kid(el: Element | null | undefined, local: string): Element | null {
  if (!el) return null;
  for (let c = el.firstElementChild; c; c = c.nextElementSibling) if (c.localName === local) return c;
  return null;
}

/** Follow a path of local names: `at(el, 'rPr', 'sz')`. */
export function at(el: Element | null | undefined, ...path: string[]): Element | null {
  let cur: Element | null | undefined = el;
  for (const p of path) {
    cur = kid(cur, p);
    if (!cur) return null;
  }
  return cur ?? null;
}

/** Every descendant with this local name. */
export function descendants(el: Element | null | undefined, local: string): Element[] {
  if (!el) return [];
  return Array.from(el.getElementsByTagName('*')).filter((d) => d.localName === local);
}

/** An attribute by local name, whatever its prefix (`val` finds `w:val`). */
export function attr(el: Element | null | undefined, local: string): string | null {
  if (!el) return null;
  const direct = el.getAttribute(local);
  if (direct !== null) return direct;
  for (const a of Array.from(el.attributes)) if (a.localName === local) return a.value;
  return null;
}

export function numAttr(el: Element | null | undefined, local: string): number | null {
  const v = attr(el, local);
  if (v === null || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

/** An on/off property: present without a value means on. */
export function onOff(el: Element | null | undefined, local = 'val'): boolean | null {
  if (!el) return null;
  const v = attr(el, local);
  return v === null || !['0', 'false', 'off', 'none'].includes(v);
}

/** The relationship id attribute `r:id` / `r:embed`. */
export function rid(el: Element | null | undefined, local = 'id'): string | null {
  if (!el) return null;
  return el.getAttributeNS(NS.r, local) ?? attr(el, local);
}

export function serialize(el: Node): string {
  return new XMLSerializer().serializeToString(el);
}

// ---- Writing XML -----------------------------------------------------------------

const ESCAPES: Record<string, string> = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' };

export function esc(text: string | number): string {
  // XML 1.0 can't carry most control characters at all.
  // eslint-disable-next-line no-control-regex
  return String(text).replace(/[&<>"']/g, (c) => ESCAPES[c]).replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\ufffe\uffff]/g, '');
}

type AttrValue = string | number | boolean | null | undefined;

/** `<tag a="1">children</tag>`, leaving out null/undefined/false attributes. */
export function x(tag: string, attrs?: Record<string, AttrValue> | null, children?: string | (string | false | null | undefined)[]): string {
  let a = '';
  if (attrs) {
    for (const [k, v] of Object.entries(attrs)) {
      if (v === null || v === undefined || v === false) continue;
      a += ` ${k}="${esc(v === true ? 1 : v)}"`;
    }
  }
  const body = Array.isArray(children) ? children.filter(Boolean).join('') : (children ?? '');
  return body ? `<${tag}${a}>${body}</${tag}>` : `<${tag}${a}/>`;
}

// ---- Units -----------------------------------------------------------------------

/** English Metric Units: 914400 to the inch. */
export const EMU_PER_PX = 9525;
export const emuToPx = (emu: number) => emu / EMU_PER_PX;
export const pxToEmu = (px: number) => Math.round(px * EMU_PER_PX);
/** Twentieths of a point: 1440 to the inch. */
export const twipToPx = (tw: number) => tw / 15;
export const pxToTwip = (px: number) => Math.round(px * 15);
export const ptToPx = (pt: number) => (pt * 96) / 72;
export const pxToPt = (px: number) => (px * 72) / 96;

// ---- Images ----------------------------------------------------------------------

export function extOfPath(path: string): string {
  const name = path.slice(path.lastIndexOf('/') + 1);
  const i = name.lastIndexOf('.');
  return i > 0 ? name.slice(i + 1).toLowerCase() : '';
}

export function mimeOf(path: string): string {
  return IMAGE_TYPES[extOfPath(path)] ?? 'application/octet-stream';
}

/** An object URL for package bytes, for an <img>. */
export function blobUrl(data: Uint8Array, mime: string): string {
  return URL.createObjectURL(new Blob([data as BlobPart], { type: mime }));
}

/** A picture's natural size in pixels. */
export function imageSize(url: string): Promise<{ width: number; height: number }> {
  return new Promise((resolve) => {
    const img = new Image();
    img.onload = () => resolve({ width: img.naturalWidth || 100, height: img.naturalHeight || 100 });
    img.onerror = () => resolve({ width: 100, height: 100 });
    img.src = url;
  });
}

export function nowIso(): string {
  return new Date().toISOString().replace(/\.\d+Z$/, 'Z');
}

/** docProps/core.xml and app.xml, for new packages. */
export function addDocProps(pkg: OpcPackage, application: string): void {
  const now = nowIso();
  pkg.setText(
    'docProps/core.xml',
    `${XML_HEADER}<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:dcterms="http://purl.org/dc/terms/" xmlns:dcmitype="http://purl.org/dc/dcmitype/" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"><dc:title></dc:title><dc:creator></dc:creator><cp:lastModifiedBy></cp:lastModifiedBy><cp:revision>1</cp:revision><dcterms:created xsi:type="dcterms:W3CDTF">${now}</dcterms:created><dcterms:modified xsi:type="dcterms:W3CDTF">${now}</dcterms:modified></cp:coreProperties>`,
  );
  pkg.setText(
    'docProps/app.xml',
    `${XML_HEADER}<Properties xmlns="http://schemas.openxmlformats.org/officeDocument/2006/extended-properties" xmlns:vt="http://schemas.openxmlformats.org/officeDocument/2006/docPropsVTypes"><Application>${esc(application)}</Application></Properties>`,
  );
  pkg.ensureOverride('docProps/core.xml', CT.core);
  pkg.ensureOverride('docProps/app.xml', CT.app);
}

/** Bump docProps/core.xml's modified time, if there is one. */
export function touchModified(pkg: OpcPackage): void {
  const text = pkg.text('docProps/core.xml');
  if (!text) return;
  pkg.setText(
    'docProps/core.xml',
    text.replace(/(<dcterms:modified[^>]*>)[^<]*(<\/dcterms:modified>)/, `$1${nowIso()}$2`),
  );
}

/** A fresh package with just the content-types list and package relationships. */
export function emptyPackage(): OpcPackage {
  const pkg = new OpcPackage();
  pkg.setText(
    '[Content_Types].xml',
    `${XML_HEADER}<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="${CT.rels}"/><Default Extension="xml" ContentType="${CT.xml}"/></Types>`,
  );
  return pkg;
}
