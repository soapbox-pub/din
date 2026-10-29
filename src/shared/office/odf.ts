import { strFromU8, strToU8, unzipSync, zipSync, type Zippable } from 'fflate';
import { attr, esc, extOfPath, IMAGE_TYPES, isZip, kid, kids, parseXml } from './ooxml';

/**
 * OpenDocument files (.odt, .ods, .odp), LibreOffice's own formats: a zip
 * whose first entry names the kind of document, with content.xml (the body
 * and its automatic styles), styles.xml (named styles, page layouts and
 * master pages), meta.xml and pictures. The flat variants (.fodt...) are the
 * same XML in a single file. The apps read these into their own models and
 * write them out fresh.
 */

export const ODF = {
  office: 'urn:oasis:names:tc:opendocument:xmlns:office:1.0',
  style: 'urn:oasis:names:tc:opendocument:xmlns:style:1.0',
  text: 'urn:oasis:names:tc:opendocument:xmlns:text:1.0',
  table: 'urn:oasis:names:tc:opendocument:xmlns:table:1.0',
  draw: 'urn:oasis:names:tc:opendocument:xmlns:drawing:1.0',
  fo: 'urn:oasis:names:tc:opendocument:xmlns:xsl-fo-compatible:1.0',
  xlink: 'http://www.w3.org/1999/xlink',
  dc: 'http://purl.org/dc/elements/1.1/',
  meta: 'urn:oasis:names:tc:opendocument:xmlns:meta:1.0',
  number: 'urn:oasis:names:tc:opendocument:xmlns:datastyle:1.0',
  presentation: 'urn:oasis:names:tc:opendocument:xmlns:presentation:1.0',
  svg: 'urn:oasis:names:tc:opendocument:xmlns:svg-compatible:1.0',
  chart: 'urn:oasis:names:tc:opendocument:xmlns:chart:1.0',
  dr3d: 'urn:oasis:names:tc:opendocument:xmlns:dr3d:1.0',
  math: 'http://www.w3.org/1998/Math/MathML',
  form: 'urn:oasis:names:tc:opendocument:xmlns:form:1.0',
  script: 'urn:oasis:names:tc:opendocument:xmlns:script:1.0',
  smil: 'urn:oasis:names:tc:opendocument:xmlns:smil-compatible:1.0',
  anim: 'urn:oasis:names:tc:opendocument:xmlns:animation:1.0',
  of: 'urn:oasis:names:tc:opendocument:xmlns:of:1.2',
  config: 'urn:oasis:names:tc:opendocument:xmlns:config:1.0',
  calcext: 'urn:org:documentfoundation:names:experimental:calc:xmlns:calcext:1.0',
  loext: 'urn:org:documentfoundation:names:experimental:office:xmlns:loext:1.0',
  tableooo: 'http://openoffice.org/2009/table',
  manifest: 'urn:oasis:names:tc:opendocument:xmlns:manifest:1.0',
};

export const ODF_MIME = {
  text: 'application/vnd.oasis.opendocument.text',
  textTemplate: 'application/vnd.oasis.opendocument.text-template',
  spreadsheet: 'application/vnd.oasis.opendocument.spreadsheet',
  spreadsheetTemplate: 'application/vnd.oasis.opendocument.spreadsheet-template',
  presentation: 'application/vnd.oasis.opendocument.presentation',
  presentationTemplate: 'application/vnd.oasis.opendocument.presentation-template',
};

/** Every namespace the writers use, declared on each root. */
export const ODF_NS_DECLS = Object.entries(ODF)
  .filter(([k]) => k !== 'manifest')
  .map(([k, v]) => `xmlns:${k}="${v}"`)
  .join(' ');

export const ODF_VERSION = '1.3';

const XML_DECL = '<?xml version="1.0" encoding="UTF-8"?>\n';

export type OdfKind = 'text' | 'spreadsheet' | 'presentation';

/** An OpenDocument file opened for reading: its parts, zipped or flat. */
export class OdfDocument {
  private files = new Map<string, Uint8Array>();
  content!: Document;
  /** styles.xml; the same document as `content` for a flat file. */
  styles!: Document;
  mimetype = '';

  static read(bytes: Uint8Array, kind: OdfKind, what: string): OdfDocument {
    const doc = new OdfDocument();
    if (isZip(bytes)) {
      let entries: Record<string, Uint8Array>;
      try {
        entries = unzipSync(bytes);
      } catch {
        throw new Error(`It isn’t a valid ${what} (the file couldn’t be unzipped).`);
      }
      for (const [name, data] of Object.entries(entries)) if (!name.endsWith('/')) doc.files.set(name.replace(/^\//, ''), data);
      doc.mimetype = doc.text('mimetype')?.trim() ?? '';
      const content = doc.text('content.xml');
      if (!content) {
        if (doc.files.has('[Content_Types].xml')) throw new Error(`It’s a Microsoft Office file with the wrong extension, not an OpenDocument ${what}.`);
        throw new Error(`It isn’t an OpenDocument ${what}.`);
      }
      doc.content = parseXml(content);
      const styles = doc.text('styles.xml');
      doc.styles = styles ? parseXml(styles) : parseXml(`<office:document-styles xmlns:office="${ODF.office}"/>`);
    } else {
      const text = strFromU8(bytes.subarray(0, Math.min(bytes.length, 512)));
      if (!/^\s*(<\?xml[^>]*>\s*)?(<!--[\s\S]*?-->\s*)*<[\w-]+:document[\s>]/.test(text)) throw new Error(`It isn’t an OpenDocument ${what}.`);
      doc.content = parseXml(strFromU8(bytes));
      doc.styles = doc.content;
      doc.mimetype = attr(doc.content.documentElement, 'mimetype') ?? '';
    }
    const body = kid(kid(doc.content.documentElement, 'body'), kind);
    if (!body) {
      const other = kids(kid(doc.content.documentElement, 'body'))[0]?.localName;
      const names: Record<string, string> = { text: 'a text document', spreadsheet: 'a spreadsheet', presentation: 'a presentation', drawing: 'a drawing' };
      throw new Error(other && names[other] ? `It’s ${names[other]}, not ${what === 'document' ? 'a text document' : `a ${what}`}.` : `It isn’t an OpenDocument ${what}.`);
    }
    return doc;
  }

  text(path: string): string | null {
    const data = this.files.get(path);
    return data ? strFromU8(data) : null;
  }

  /** Bytes a link (xlink:href) inside the document points at. */
  bytes(href: string): Uint8Array | null {
    const path = href.replace(/^\.\//, '').replace(/^\//, '');
    return this.files.get(path) ?? this.files.get(decodeURIComponent(path)) ?? null;
  }

  /** The office:text / office:spreadsheet / office:presentation element. */
  body(kind: OdfKind): Element {
    return kid(kid(this.content.documentElement, 'body'), kind)!;
  }

  /** office:settings (view settings: the active sheet, frozen panes, zoom). */
  settings(): Element | null {
    if (this.styles === this.content) return kid(this.content.documentElement, 'settings');
    const text = this.text('settings.xml');
    if (!text) return null;
    try {
      return kid(parseXml(text).documentElement, 'settings');
    } catch {
      return null;
    }
  }

  /** Whether a part the reader skips is present (embedded objects, macros). */
  hasPrefix(prefix: string): boolean {
    for (const k of this.files.keys()) if (k.startsWith(prefix)) return true;
    return false;
  }
}

/** A picture in a draw:image: from the package, or inline as office:binary-data. */
export function imageBytes(doc: OdfDocument, image: Element): { data: Uint8Array; ext: string } | null {
  const href = image.getAttributeNS(ODF.xlink, 'href') ?? attr(image, 'href');
  if (href && !/^[a-z]+:/i.test(href)) {
    const data = doc.bytes(href);
    if (data) return { data, ext: extOfPath(href) || sniffImage(data) };
  }
  const bin = kid(image, 'binary-data');
  if (bin?.textContent) {
    try {
      const raw = atob(bin.textContent.replace(/\s+/g, ''));
      const data = new Uint8Array(raw.length);
      for (let i = 0; i < raw.length; i++) data[i] = raw.charCodeAt(i);
      return { data, ext: sniffImage(data) };
    } catch {
      return null;
    }
  }
  return null;
}

function sniffImage(d: Uint8Array): string {
  if (d[0] === 0x89 && d[1] === 0x50) return 'png';
  if (d[0] === 0xff && d[1] === 0xd8) return 'jpeg';
  if (d[0] === 0x47 && d[1] === 0x49) return 'gif';
  if (d[0] === 0x42 && d[1] === 0x4d) return 'bmp';
  if (d[0] === 0x52 && d[1] === 0x49 && d[8] === 0x57) return 'webp';
  if (d[0] === 0x3c) return 'svg';
  return 'png';
}

/** Pictures browsers draw (others, like EMF and WMF, are left out). */
export const DRAWABLE_IMAGE = /^(png|jpe?g|gif|bmp|webp|svg)$/i;

// ---- Writing ---------------------------------------------------------------------------------

export interface OdfParts {
  mimetype: string;
  content: string;
  styles: string;
  /** Extra files: pictures (Pictures/...) and anything else, with their media types. */
  files?: { path: string; data: Uint8Array; mime: string }[];
  settings?: string;
  generator: string;
  /** One XML file (.fodt, .fods, .fodp) rather than a zip. */
  flat?: boolean;
}

/** The zip, with its mimetype entry first and uncompressed as the format requires. */
export function writeOdf(parts: OdfParts): Uint8Array {
  if (parts.flat) return writeFlat(parts);
  const entries: Zippable = {};
  entries.mimetype = [strToU8(parts.mimetype), { level: 0 }];
  const manifest: string[] = [`<manifest:file-entry manifest:full-path="/" manifest:version="${ODF_VERSION}" manifest:media-type="${parts.mimetype}"/>`];
  const add = (path: string, data: Uint8Array, mime: string, stored = false) => {
    entries[path] = stored ? [data, { level: 0 }] : data;
    manifest.push(`<manifest:file-entry manifest:full-path="${esc(path)}" manifest:media-type="${esc(mime)}"/>`);
  };
  add('content.xml', strToU8(parts.content), 'text/xml');
  add('styles.xml', strToU8(parts.styles), 'text/xml');
  add('meta.xml', strToU8(metaXml(parts.generator)), 'text/xml');
  if (parts.settings) add('settings.xml', strToU8(parts.settings), 'text/xml');
  for (const f of parts.files ?? []) add(f.path, f.data, f.mime, /\.(png|jpe?g|gif|webp)$/i.test(f.path));
  entries['META-INF/manifest.xml'] = strToU8(
    `${XML_DECL}<manifest:manifest xmlns:manifest="${ODF.manifest}" manifest:version="${ODF_VERSION}">${manifest.join('')}</manifest:manifest>`,
  );
  return zipSync(entries, { level: 6 });
}

function base64(data: Uint8Array): string {
  let bin = '';
  for (let i = 0; i < data.length; i += 0x8000) bin += String.fromCharCode(...data.subarray(i, i + 0x8000));
  return btoa(bin);
}

/** The flat form: styles and content in one office:document, pictures inline. */
function writeFlat(parts: OdfParts): Uint8Array {
  const content = parseXml(parts.content).documentElement;
  const styles = parseXml(parts.styles).documentElement;
  const files = new Map((parts.files ?? []).map((f) => [f.path, f.data]));
  for (const root of [content, styles]) {
    for (const img of Array.from(root.getElementsByTagNameNS(ODF.draw, 'image'))) {
      const href = img.getAttributeNS(ODF.xlink, 'href');
      const data = href ? files.get(href) : undefined;
      if (!data) continue;
      for (const a of ['href', 'type', 'show', 'actuate']) img.removeAttributeNS(ODF.xlink, a);
      const bin = img.ownerDocument.createElementNS(ODF.office, 'office:binary-data');
      bin.textContent = base64(data);
      img.insertBefore(bin, img.firstChild);
    }
  }
  const ser = new XMLSerializer();
  const inner = (el: Element | null) => (el ? Array.from(el.childNodes).map((n) => ser.serializeToString(n)).join('') : '');
  const fonts = new Map<string, string>();
  for (const root of [styles, content]) for (const f of kids(kid(root, 'font-face-decls'))) fonts.set(attr(f, 'name') ?? '', ser.serializeToString(f));
  const xml =
    `${XML_DECL}<office:document ${ODF_NS_DECLS} office:version="${ODF_VERSION}" office:mimetype="${parts.mimetype}">` +
    `<office:meta><meta:generator>${esc(parts.generator)}</meta:generator></office:meta>` +
    `<office:font-face-decls>${[...fonts.values()].join('')}</office:font-face-decls>` +
    `<office:styles>${inner(kid(styles, 'styles'))}</office:styles>` +
    `<office:automatic-styles>${inner(kid(styles, 'automatic-styles'))}${inner(kid(content, 'automatic-styles'))}</office:automatic-styles>` +
    `<office:master-styles>${inner(kid(styles, 'master-styles'))}</office:master-styles>` +
    `<office:body>${inner(kid(content, 'body'))}</office:body></office:document>`;
  return strToU8(xml);
}

function metaXml(generator: string): string {
  const now = new Date().toISOString().replace(/\.\d+Z$/, '');
  return `${XML_DECL}<office:document-meta ${ODF_NS_DECLS} office:version="${ODF_VERSION}"><office:meta><meta:generator>${esc(generator)}</meta:generator><meta:creation-date>${now}</meta:creation-date><dc:date>${now}</dc:date></office:meta></office:document-meta>`;
}

/** The root of content.xml or styles.xml. */
export function odfRoot(tag: 'office:document-content' | 'office:document-styles', inner: string): string {
  return `${XML_DECL}<${tag} ${ODF_NS_DECLS} office:version="${ODF_VERSION}">${inner}</${tag}>`;
}

/** Pictures gathered for Pictures/ while writing, each stored once. */
export class OdfMedia {
  files: { path: string; data: Uint8Array; mime: string }[] = [];
  private seen = new Map<Uint8Array, string>();

  add(data: Uint8Array, ext: string): string {
    const hit = this.seen.get(data);
    if (hit) return hit;
    const e = ext.toLowerCase() === 'jpg' ? 'jpeg' : ext.toLowerCase();
    const path = `Pictures/image${this.files.length + 1}.${e}`;
    this.files.push({ path, data, mime: IMAGE_TYPES[e] ?? 'application/octet-stream' });
    this.seen.set(data, path);
    return path;
  }
}

/** A pool of automatic styles: one per distinct set of properties, named P1, P2... */
export class AutoStyles {
  private byKey = new Map<string, string>();
  private list: string[] = [];

  constructor(private prefix: string) {}

  /** The name for a style whose body (everything inside style:style) is `body`. */
  name(family: string, body: string, attrs: Record<string, string | null | undefined> = {}): string {
    const extra = Object.entries(attrs)
      .filter(([, v]) => v !== null && v !== undefined && v !== '')
      .map(([k, v]) => ` ${k}="${esc(v!)}"`)
      .join('');
    const key = `${family}|${extra}|${body}`;
    let n = this.byKey.get(key);
    if (!n) {
      n = `${this.prefix}${this.list.length + 1}`;
      this.byKey.set(key, n);
      this.list.push(`<style:style style:name="${n}" style:family="${family}"${extra}>${body}</style:style>`);
    }
    return n;
  }

  /** Add a whole style element (list styles, number styles) under a name it already has. */
  raw(xml: string): void {
    this.list.push(xml);
  }

  xml(): string {
    return this.list.join('');
  }
}

/** Font declarations for the fonts a document names. */
export class FontFaces {
  private names = new Set<string>();

  use(name: string | null | undefined): string | null {
    if (!name) return null;
    const clean = name.replace(/^["']|["']$/g, '');
    this.names.add(clean);
    return clean;
  }

  xml(): string {
    return `<office:font-face-decls>${[...this.names]
      .map((n) => `<style:font-face style:name="${esc(n)}" svg:font-family="${esc(/\s/.test(n) ? `'${n}'` : n)}"/>`)
      .join('')}</office:font-face-decls>`;
  }
}

// ---- Units -------------------------------------------------------------------------------------

const UNIT_PX: Record<string, number> = { in: 96, cm: 96 / 2.54, mm: 96 / 25.4, pt: 96 / 72, pc: 16, px: 1 };

/** An ODF length ("2.54cm", "0.5in", "12pt") in CSS pixels; null if it isn't one. */
export function lengthPx(v: string | null | undefined): number | null {
  if (!v) return null;
  const m = /^\s*(-?[\d.]+(?:e-?\d+)?)\s*(in|cm|mm|pt|pc|px)?\s*$/i.exec(v);
  if (!m) return null;
  const n = parseFloat(m[1]);
  return Number.isFinite(n) ? n * UNIT_PX[(m[2] ?? 'px').toLowerCase()] : null;
}

export const lengthPt = (v: string | null | undefined): number | null => {
  const px = lengthPx(v);
  return px === null ? null : (px * 72) / 96;
};

const trim = (n: number, digits: number) => String(Math.round(n * 10 ** digits) / 10 ** digits);

/** Pixels as an ODF length in inches. */
export const inch = (px: number) => `${trim(px / 96, 4)}in`;
export const cm = (px: number) => `${trim((px * 2.54) / 96, 3)}cm`;
export const pt = (points: number) => `${trim(points, 2)}pt`;

/** "#RRGGBB" or "transparent" as hex without '#'; null for none. */
export function odfColor(v: string | null | undefined): string | null {
  if (!v) return null;
  const m = /^#([0-9a-f]{6})$/i.exec(v.trim());
  if (m) return m[1].toUpperCase();
  const s = /^#([0-9a-f]{3})$/i.exec(v.trim());
  return s ? s[1].split('').map((c) => c + c).join('').toUpperCase() : null;
}

// ---- Styles ------------------------------------------------------------------------------------

/** A style's properties, by kind (text, paragraph, graphic...) and local attribute name. */
export type Props = Record<string, Record<string, string>>;

export interface OdfStyle {
  name: string;
  family: string;
  parent: string | null;
  el: Element;
  props: Props;
  /** Whether it's an automatic style (formatting applied directly) rather than a named one. */
  automatic: boolean;
}

function readProps(el: Element): Props {
  const out: Props = {};
  for (const c of kids(el)) {
    if (!c.localName.endsWith('-properties')) continue;
    const kind = c.localName.slice(0, -'-properties'.length);
    const p: Record<string, string> = (out[kind] ??= {});
    for (const a of Array.from(c.attributes)) {
      if (a.name.startsWith('xmlns')) continue;
      // Asian and complex-script variants would overwrite the western ones.
      p[a.localName] = a.value;
    }
    // Child elements that carry properties of their own (tab stops, columns, background images).
    for (const sub of kids(c)) p[`@${sub.localName}`] = '1';
  }
  return out;
}

export function mergeProps(base: Props, over: Props): Props {
  const out: Props = { ...base };
  for (const [k, v] of Object.entries(over)) out[k] = { ...(out[k] ?? {}), ...v };
  return out;
}

/**
 * Every style a part can refer to, looked up by family and name: automatic
 * styles first (for content.xml, its own; for master pages, styles.xml's),
 * then the named styles, with parents and the family defaults merged in.
 */
export class OdfStyles {
  private map = new Map<string, OdfStyle>();
  private defaults = new Map<string, Props>();
  fonts = new Map<string, string>();
  /** number:*-style elements by name. */
  dataStyles = new Map<string, Element>();
  /** text:list-style elements by name. */
  listStyles = new Map<string, Element>();
  private cache = new Map<string, Props>();

  constructor(autoRoots: (Element | null)[], namedRoots: (Element | null)[], fontRoots: (Element | null)[]) {
    for (const root of fontRoots) {
      for (const f of kids(root, 'font-face')) {
        const name = attr(f, 'name');
        const family = attr(f, 'font-family');
        if (name) this.fonts.set(name, (family ?? name).replace(/^['"]|['"]$/g, ''));
      }
    }
    const take = (root: Element | null, automatic: boolean) => {
      for (const el of kids(root)) {
        const name = attr(el, 'name');
        if (el.localName === 'default-style') {
          const family = attr(el, 'family') ?? '';
          if (!this.defaults.has(family)) this.defaults.set(family, readProps(el));
          continue;
        }
        if (!name) continue;
        if (el.localName === 'style') {
          const family = attr(el, 'family') ?? '';
          const key = `${family}:${name}`;
          if (this.map.has(key)) continue;
          this.map.set(key, { name, family, parent: attr(el, 'parent-style-name'), el, props: readProps(el), automatic });
        } else if (el.localName === 'list-style') {
          if (!this.listStyles.has(name)) this.listStyles.set(name, el);
        } else if (el.localName.endsWith('-style') && el.namespaceURI === ODF.number) {
          if (!this.dataStyles.has(name)) this.dataStyles.set(name, el);
        }
      }
    };
    for (const r of autoRoots) take(r, true);
    for (const r of namedRoots) take(r, false);
  }

  get(family: string, name: string | null | undefined): OdfStyle | undefined {
    return name ? this.map.get(`${family}:${name}`) : undefined;
  }

  all(family: string): OdfStyle[] {
    return [...this.map.values()].filter((s) => s.family === family);
  }

  defaultProps(family: string): Props {
    return this.defaults.get(family) ?? {};
  }

  /** A style's properties with its parents' merged under them (and the family default, if asked). */
  resolve(family: string, name: string | null | undefined, withDefault = true): Props {
    const key = `${family}:${name ?? ''}:${withDefault ? 1 : 0}`;
    const hit = this.cache.get(key);
    if (hit) return hit;
    const chain: OdfStyle[] = [];
    let cur = this.get(family, name);
    const seen = new Set<string>();
    while (cur && !seen.has(cur.name)) {
      seen.add(cur.name);
      chain.unshift(cur);
      cur = this.get(family, cur.parent);
    }
    let props: Props = withDefault ? this.defaultProps(family) : {};
    for (const s of chain) props = mergeProps(props, s.props);
    this.cache.set(key, props);
    return props;
  }

  /** The typeface a text-properties set names. */
  fontOf(text: Record<string, string> | undefined): string | undefined {
    if (!text) return undefined;
    const name = text['font-name'];
    if (name) return this.fonts.get(name) ?? name;
    const family = text['font-family'];
    return family ? family.split(',')[0].trim().replace(/^['"]|['"]$/g, '') : undefined;
  }
}

/** The styles for content.xml's body. */
export function contentStyles(doc: OdfDocument): OdfStyles {
  const c = doc.content.documentElement;
  const s = doc.styles.documentElement;
  const auto = [kid(c, 'automatic-styles')];
  if (doc.styles !== doc.content) auto.push(kid(s, 'automatic-styles'));
  return new OdfStyles(auto, [kid(s, 'styles')], [kid(c, 'font-face-decls'), kid(s, 'font-face-decls')]);
}

/** The styles for master pages (headers, footers, slide masters), which use styles.xml's automatic styles. */
export function masterStyles(doc: OdfDocument): OdfStyles {
  const s = doc.styles.documentElement;
  const c = doc.content.documentElement;
  return new OdfStyles([kid(s, 'automatic-styles'), kid(c, 'automatic-styles')], [kid(s, 'styles')], [kid(s, 'font-face-decls'), kid(c, 'font-face-decls')]);
}

// ---- Text ----------------------------------------------------------------------------------------

/** Characters of a text node with ODF's white-space rule: runs of spaces, tabs and newlines become one space. */
export function collapse(text: string, afterSpace: boolean): { text: string; endsSpace: boolean } {
  let out = text.replace(/[ \t\r\n]+/g, ' ');
  if (afterSpace) out = out.replace(/^ /, '');
  return { text: out, endsSpace: out ? out.endsWith(' ') : afterSpace };
}

/** Text for writing: runs of spaces become text:s, tabs text:tab, newlines text:line-break. */
export function textXml(s: string): string {
  let out = '';
  const parts = s.split(/(\t|\n| {2,}|^ | $)/);
  for (const p of parts) {
    if (!p) continue;
    if (p === '\t') out += '<text:tab/>';
    else if (p === '\n') out += '<text:line-break/>';
    else if (/^ +$/.test(p)) out += p.length === 1 ? '<text:s/>' : `<text:s text:c="${p.length}"/>`;
    else out += esc(p);
  }
  return out;
}

/**
 * Paragraphs at list levels (0 is the outermost) as one text:list, deeper
 * levels nested inside the item before them as ODF has it. `attrs` go on
 * the outer list (its style, whether it continues an earlier one).
 */
export function nestedList(items: { level: number; xml: string }[], listAttrs: string): string {
  let out = `<text:list${listAttrs}>`;
  let depth = 0;
  const open = [false];
  for (const { level, xml } of items) {
    const lvl = Math.max(0, Math.min(9, level));
    while (depth > lvl) {
      out += open[depth] ? '</text:list-item></text:list>' : '</text:list>';
      open.pop();
      depth--;
    }
    if (depth === lvl && open[depth]) out += '</text:list-item>';
    while (depth < lvl) {
      if (!open[depth]) out += '<text:list-item>';
      open[depth] = true;
      out += '<text:list>';
      depth++;
      open[depth] = false;
    }
    out += `<text:list-item>${xml}`;
    open[depth] = true;
  }
  while (depth >= 0) {
    out += open[depth] ? '</text:list-item></text:list>' : '</text:list>';
    depth--;
  }
  return out;
}

/** The plain text of a text:p/text:h, for cells and notes. */
export function paragraphText(p: Element): string {
  let out = '';
  let space = true;
  const walk = (el: Element) => {
    for (let n = el.firstChild; n; n = n.nextSibling) {
      if (n.nodeType === 3) {
        const c = collapse(n.nodeValue ?? '', space);
        out += c.text;
        space = c.endsSpace;
      } else if (n.nodeType === 1) {
        const e = n as Element;
        switch (e.localName) {
          case 's':
            out += ' '.repeat(Math.max(1, Number(attr(e, 'c') ?? 1) || 1));
            space = true;
            break;
          case 'tab':
            out += '\t';
            space = false;
            break;
          case 'line-break':
            out += '\n';
            space = true;
            break;
          case 'note':
          case 'annotation':
          case 'bookmark-start':
          case 'bookmark-end':
            break;
          default:
            walk(e);
        }
      }
    }
  };
  walk(p);
  return out;
}

/** The text of a style or attribute as written for XML elements built by hand. */
export function attrs(a: Record<string, string | number | null | undefined | false>): string {
  return Object.entries(a)
    .filter(([, v]) => v !== null && v !== undefined && v !== false && v !== '')
    .map(([k, v]) => ` ${k}="${esc(String(v))}"`)
    .join('');
}

/** Named styles are written with spaces encoded, as LibreOffice names them: "Heading 1" → "Heading_20_1". */
export function encodeStyleName(display: string): string {
  return display.replace(/[^A-Za-z0-9-]/g, (c) => `_${c.charCodeAt(0).toString(16)}_`).replace(/^(\d)/, '_3$1_');
}

export function decodeStyleName(name: string): string {
  return name.replace(/_([0-9a-f]{1,4})_/gi, (_, h: string) => String.fromCharCode(parseInt(h, 16)));
}
