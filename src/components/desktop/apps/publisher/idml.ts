import { strFromU8, strToU8, unzipSync, zipSync, type Zippable } from 'fflate';

/**
 * IDML packages: a zip of XML parts (designmap.xml, Spreads/, MasterSpreads/,
 * Stories/, Resources/...). Publisher keeps every part as the DOM it was
 * read into and edits those in place, so whatever it doesn't understand is
 * written back as it came. A package never changes: an edit makes a new one
 * that shares every part it didn't touch, which is what makes undo cheap.
 */

export const IDML_MIME = 'application/vnd.adobe.indesign-idml-package';

export interface Pkg {
  /** XML parts by path. */
  readonly xml: ReadonlyMap<string, XMLDocument>;
  /** Other parts, byte for byte. */
  readonly bin: ReadonlyMap<string, Uint8Array>;
  /** Part order in the zip. */
  readonly order: readonly string[];
  /** Where new `Self` ids come from; shared by every version of the document. */
  readonly ids: { next: number };
}

const PARSER = () => new DOMParser();

export function parseXml(text: string, name = 'part'): XMLDocument {
  const doc = PARSER().parseFromString(text, 'application/xml');
  if (doc.getElementsByTagName('parsererror').length) throw new Error(`Its ${name} isn’t well-formed XML.`);
  return doc;
}

export function serializeXml(doc: XMLDocument): string {
  const body = new XMLSerializer().serializeToString(doc);
  return body.startsWith('<?xml') ? body : `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n${body}`;
}

/** Whether bytes are a zip whose first entry is IDML's mimetype. */
export function looksLikeIdml(bytes: Uint8Array): boolean {
  if (bytes.length < 40 || bytes[0] !== 0x50 || bytes[1] !== 0x4b) return false;
  const head = strFromU8(bytes.subarray(30, Math.min(bytes.length, 30 + 8 + 43)), true);
  return head.includes('mimetype') || head.includes('indesign');
}

export function readPackage(bytes: Uint8Array): Pkg {
  let entries: Record<string, Uint8Array>;
  try {
    entries = unzipSync(bytes);
  } catch {
    throw new Error('It isn’t a valid IDML file (the package couldn’t be unzipped).');
  }
  if (!entries['designmap.xml']) throw new Error('It isn’t an IDML package (there’s no designmap.xml).');
  const xml = new Map<string, XMLDocument>();
  const bin = new Map<string, Uint8Array>();
  const order: string[] = [];
  let max = 0;
  for (const [name, data] of Object.entries(entries)) {
    if (name.endsWith('/')) continue;
    order.push(name);
    if (name.endsWith('.xml')) {
      const text = strFromU8(data);
      for (const m of text.matchAll(/\bSelf="u([0-9a-f]+)"/g)) {
        const v = parseInt(m[1], 16);
        if (v > max && v < 0x7fffffff) max = v;
      }
      xml.set(name, parseXml(text, name));
    } else bin.set(name, data);
  }
  if (!bin.has('mimetype')) {
    bin.set('mimetype', strToU8(IDML_MIME));
    order.unshift('mimetype');
  }
  return { xml, bin, order, ids: { next: max + 1 } };
}

export function writePackage(pkg: Pkg): Uint8Array {
  const out: Zippable = {};
  // The mimetype comes first and uncompressed, as the spec (and InDesign) want.
  out.mimetype = [pkg.bin.get('mimetype') ?? strToU8(IDML_MIME), { level: 0 }];
  for (const name of pkg.order) {
    if (name === 'mimetype') continue;
    const doc = pkg.xml.get(name);
    if (doc) out[name] = [strToU8(serializeXml(doc)), { level: 6 }];
    else {
      const b = pkg.bin.get(name);
      if (b) out[name] = [b, { level: 6 }];
    }
  }
  return zipSync(out);
}

/** A fresh `Self` id in InDesign's style ("u1a2b"). */
export function newId(pkg: Pkg): string {
  return `u${(pkg.ids.next++).toString(16)}`;
}

// ---- Copy-on-write edits ------------------------------------------------------------

const VERSIONS = new WeakMap<XMLDocument, number>();

/** Bumped whenever a draft hands a part out for changing, so readings of it can tell they're stale. */
export const docVersion = (doc: XMLDocument) => VERSIONS.get(doc) ?? 0;
const touch = (doc: XMLDocument) => VERSIONS.set(doc, docVersion(doc) + 1);

/**
 * Edits parts of a package: `part(name)` hands out a private copy of a part
 * (made once per edit), everything else is shared with the original.
 */
export class Draft {
  private changed = new Map<string, XMLDocument>();
  private added: string[] = [];
  private removed = new Set<string>();
  private binChanged = new Map<string, Uint8Array>();
  constructor(readonly base: Pkg) {}

  part(name: string): XMLDocument {
    let d = this.changed.get(name);
    if (d) {
      touch(d);
      return d;
    }
    const orig = this.base.xml.get(name);
    if (!orig) throw new Error(`The document has no ${name}.`);
    d = orig.cloneNode(true) as XMLDocument;
    this.changed.set(name, d);
    return d;
  }

  /** The part as it is now in this draft, without copying it. */
  peek(name: string): XMLDocument | undefined {
    return this.changed.get(name) ?? (this.removed.has(name) ? undefined : this.base.xml.get(name));
  }

  has(name: string): boolean {
    return !!this.peek(name);
  }

  add(name: string, doc: XMLDocument) {
    this.changed.set(name, doc);
    this.removed.delete(name);
    if (!this.base.xml.has(name) && !this.added.includes(name)) this.added.push(name);
  }

  addBin(name: string, data: Uint8Array) {
    this.binChanged.set(name, data);
    if (!this.base.bin.has(name) && !this.added.includes(name)) this.added.push(name);
  }

  remove(name: string) {
    this.changed.delete(name);
    this.removed.add(name);
  }

  get dirty() {
    return this.changed.size > 0 || this.removed.size > 0 || this.binChanged.size > 0;
  }

  newId(): string {
    return newId(this.base);
  }

  done(): Pkg {
    if (!this.dirty) return this.base;
    const xml = new Map(this.base.xml);
    for (const [k, v] of this.changed) xml.set(k, v);
    for (const k of this.removed) xml.delete(k);
    const bin = new Map(this.base.bin);
    for (const [k, v] of this.binChanged) bin.set(k, v);
    const order = this.base.order.filter((n) => !this.removed.has(n));
    for (const n of this.added) if (!order.includes(n) && !this.removed.has(n)) order.push(n);
    return { xml, bin, order, ids: this.base.ids };
  }
}

// ---- XML helpers -----------------------------------------------------------------------

export function kids(el: Element | null | undefined, name?: string): Element[] {
  const out: Element[] = [];
  if (!el) return out;
  for (let c = el.firstElementChild; c; c = c.nextElementSibling) if (!name || c.localName === name || c.nodeName === name) out.push(c);
  return out;
}

export function child(el: Element | null | undefined, name: string): Element | null {
  if (!el) return null;
  for (let c = el.firstElementChild; c; c = c.nextElementSibling) if (c.localName === name || c.nodeName === name) return c;
  return null;
}

export const propsOf = (el: Element) => child(el, 'Properties');

/** A value kept as an attribute or, for list-like and some text values, under <Properties>. */
export function prop(el: Element | null | undefined, name: string): string | null {
  if (!el) return null;
  const a = el.getAttribute(name);
  if (a !== null) return a;
  const p = propsOf(el);
  const c = p && child(p, name);
  return c ? (c.textContent ?? '') : null;
}

export function propEl(el: Element | null | undefined, name: string): Element | null {
  const p = el && propsOf(el);
  return p ? child(p, name) : null;
}

/** Values InDesign keeps under <Properties> rather than as attributes. */
const PROPERTY_FORM = new Set(['AppliedFont', 'Leading', 'BasedOn', 'Label', 'PreviewColor', 'Contents']);
const PROPERTY_TYPES: Record<string, string> = {
  AppliedFont: 'string',
  BasedOn: 'object',
  Label: 'string',
};

export function ensureProps(el: Element): Element {
  let p = propsOf(el);
  if (!p) {
    p = el.ownerDocument.createElement('Properties');
    el.insertBefore(p, el.firstChild);
  }
  return p;
}

/** Sets a value where InDesign keeps it; null removes it (so it's inherited again). */
export function setProp(el: Element, name: string, value: string | number | null) {
  const p = propsOf(el);
  const c = p && child(p, name);
  if (value === null) {
    el.removeAttribute(name);
    if (c) c.remove();
    if (p && !p.firstElementChild) p.remove();
    return;
  }
  const v = String(value);
  if (PROPERTY_FORM.has(name) && el.getAttribute(name) === null) {
    if (c) {
      c.textContent = v;
      if (name === 'Leading') c.setAttribute('type', v === 'Auto' ? 'enumeration' : 'unit');
    } else {
      const e = el.ownerDocument.createElement(name);
      e.setAttribute('type', name === 'Leading' ? (v === 'Auto' ? 'enumeration' : 'unit') : (PROPERTY_TYPES[name] ?? 'string'));
      e.textContent = v;
      ensureProps(el).appendChild(e);
    }
    return;
  }
  if (c) c.remove();
  el.setAttribute(name, v);
}

export const num = (s: string | null | undefined, d = 0) => {
  if (s === null || s === undefined || s === '') return d;
  const v = parseFloat(s);
  return Number.isFinite(v) ? v : d;
};

/** Every element with this local name, in document order. */
export function all(root: Element | XMLDocument, name: string): Element[] {
  return Array.from(root.getElementsByTagName(name));
}

/** Finds the element with a `Self` in a part. */
export function bySelf(doc: XMLDocument, self: string): Element | null {
  return byIdIndex(doc).get(self) ?? null;
}

const INDEXES = new WeakMap<XMLDocument, Map<string, Element>>();
function byIdIndex(doc: XMLDocument): Map<string, Element> {
  let m = INDEXES.get(doc);
  if (m) {
    // Edits add and remove elements; check the hit is still in place.
    return m;
  }
  m = new Map();
  const walk = (el: Element) => {
    const s = el.getAttribute('Self');
    if (s) m!.set(s, el);
    for (let c = el.firstElementChild; c; c = c.nextElementSibling) {
      // Embedded image data is big and has no ids.
      if (c.localName !== 'Contents' && c.localName !== 'MetadataPacketPreference') walk(c);
    }
  };
  if (doc.documentElement) walk(doc.documentElement);
  INDEXES.set(doc, m);
  return m;
}

/** Looks an element up again after edits (the index may be stale). */
export function findSelf(doc: XMLDocument, self: string): Element | null {
  const hit = byIdIndex(doc).get(self);
  if (hit && hit.ownerDocument === doc && doc.documentElement.contains(hit) && hit.getAttribute('Self') === self) return hit;
  INDEXES.delete(doc);
  return byIdIndex(doc).get(self) ?? null;
}

/** The root element of a part below its idPkg wrapper (Spread, Story, MasterSpread...). */
export function partRoot(doc: XMLDocument): Element | null {
  const r = doc.documentElement;
  if (!r) return null;
  // Spreads, master spreads and stories wrap one element of their own name; resources hold many.
  if (r.prefix === 'idPkg' && WRAPPED.has(r.localName)) return child(r, r.localName === 'BackingStory' ? 'XmlStory' : r.localName) ?? r.firstElementChild;
  return r;
}

const WRAPPED = new Set(['Spread', 'MasterSpread', 'Story', 'BackingStory']);

export const IDPKG_NS = 'http://ns.adobe.com/AdobeInDesign/idml/1.0/packaging';

/** A new part wrapping one element: `<idPkg:Story ...><Story/></idPkg:Story>`. */
export function newPart(kind: 'Story' | 'Spread' | 'MasterSpread', domVersion: string): XMLDocument {
  return parseXml(
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<idPkg:${kind} xmlns:idPkg="${IDPKG_NS}" DOMVersion="${domVersion}"></idPkg:${kind}>`,
  );
}

export function el(doc: XMLDocument, name: string, attrs: Record<string, string | number> = {}, children: Element[] = []): Element {
  const e = doc.createElement(name);
  for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, String(v));
  for (const c of children) e.appendChild(c);
  return e;
}

/** Base64 to bytes, for embedded graphics. */
export function fromBase64(s: string): Uint8Array {
  const bin = atob(s.replace(/\s+/g, ''));
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}
