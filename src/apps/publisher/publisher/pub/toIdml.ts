import { fmtNum } from '../geom';
import { all, kids, newId, newPart, parseXml, partRoot, type Pkg } from '../idml';
import { newDocument } from '../newdoc';
import type { PubDoc, PubFill, PubImage, PubLine, PubPage, PubPara, PubPath, PubRun, PubShape } from './doc';

/**
 * A Publisher document as IDML, which the editor works on: a page per page
 * (all single, as Publisher's are), a master spread per master page, a
 * story per piece of text with its text boxes threaded in Publisher's
 * order, swatches for the colors used, and pictures embedded in their
 * frames. Metafile pictures (WMF and EMF), which nothing here draws, are
 * turned into PNGs by `raster` first.
 */

export interface Raster {
  png: Uint8Array;
  width: number;
  height: number;
}

/** Turns a picture the editor can't draw (a metafile) into a PNG, for a frame this many points across. */
export type Rasterize = (img: PubImage, w: number, h: number) => Promise<Raster | null>;

const n = fmtNum;
const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
/** XML can't hold most control characters, even escaped. */
const clean = (s: string) => Array.from(s).filter((ch) => { const c = ch.charCodeAt(0); return c >= 0x20 || c === 9 || c === 10 || c === 13; }).join('').replace(/[\ufffe\uffff]/g, '');

type M = [number, number, number, number, number, number];
const mul = (a: M, b: M): M => [a[0] * b[0] + a[2] * b[1], a[1] * b[0] + a[3] * b[1], a[0] * b[2] + a[2] * b[3], a[1] * b[2] + a[3] * b[3], a[0] * b[4] + a[2] * b[5] + a[4], a[1] * b[4] + a[3] * b[5] + a[5]];
const fmtM = (m: M) => m.map((v) => n(Math.abs(v) < 1e-9 ? 0 : v)).join(' ');

export async function pubToIdml(doc: PubDoc, raster: Rasterize | null): Promise<Pkg> {
  const pkg = newDocument({
    width: doc.width,
    height: doc.height,
    pages: doc.pages.length,
    facing: false,
    startPage: 1,
    columns: 1,
    gutter: 12,
    margins: { top: 36, bottom: 36, inside: 36, outside: 36 },
    bleed: { top: 0, bottom: 0, inside: 0, outside: 0 },
    unit: 'in',
    primaryTextFrame: false,
  });
  const xml = pkg.xml as Map<string, XMLDocument>;
  const order = pkg.order as string[];
  const dm = xml.get('designmap.xml')!;
  const root = dm.documentElement;
  const layer = root.getAttribute('ActiveLayer') ?? '';
  const graphic = xml.get('Resources/Graphic.xml')!;
  const gRoot = graphic.documentElement;

  // Swatches for the colors used, black and white as InDesign's own.
  const swatches = new Map<string, string>([['#000000', 'Color/Black'], ['#ffffff', 'Color/Paper']]);
  const swatch = (hex: string) => {
    const k = hex.toLowerCase();
    let self = swatches.get(k);
    if (!self) {
      const [r, g, b] = [1, 3, 5].map((i) => parseInt(k.slice(i, i + 2), 16));
      const name = `R=${r} G=${g} B=${b}`;
      self = `Color/${name}`;
      swatches.set(k, self);
      gRoot.appendChild(xmlEl(graphic, `<Color Self="${self}" Model="Process" Space="RGB" ColorValue="${r} ${g} ${b}" ColorOverride="Normal" AlternateSpace="NoAlternateColor" AlternateColorValue="" Name="${name}" ColorEditable="true" ColorRemovable="true" Visible="true" SwatchCreatorID="7937"/>`));
    }
    return self;
  };
  const gradient = (f: Extract<PubFill, { type: 'gradient' }>) => {
    const self = `Gradient/${newId(pkg)}`;
    const stops = f.stops.map((st, i) => `<GradientStop Self="${self}GradientStop${i}" StopColor="${swatch(st.color)}" Location="${n(st.at)}"${i ? ' Midpoint="50"' : ''}/>`).join('');
    gRoot.appendChild(xmlEl(graphic, `<Gradient Self="${self}" Type="${f.radial ? 'Radial' : 'Linear'}" Name="$ID/" ColorEditable="true" ColorRemovable="true" Visible="false" SwatchCreatorID="7937">${stops}</Gradient>`));
    return self;
  };

  // Pictures as embedded data, sized; metafiles turned into PNGs (once per size they're shown at).
  const pictures = new Map<string, { data: Uint8Array; w: number; h: number; format: string } | null>();
  const picture = async (index: number, w: number, h: number) => {
    const img = doc.images[index];
    if (!img) return null;
    const meta = img.kind === 'wmf' || img.kind === 'emf' || img.kind === 'pict';
    const key = meta ? `${index}:${Math.round(w)}x${Math.round(h)}` : String(index);
    if (pictures.has(key)) return pictures.get(key)!;
    let out: { data: Uint8Array; w: number; h: number; format: string } | null = null;
    if (meta) {
      const r = raster ? await raster(img, w, h).catch(() => null) : null;
      if (r) out = { data: r.png, w: r.width, h: r.height, format: '$ID/PNG' };
      else doc.warnings.add('Some pictures are in old Windows formats (WMF, EMF or PICT) that couldn’t be drawn.');
    } else {
      const size = imageSize(img.data);
      if (size) out = { data: img.data, w: size.w, h: size.h, format: FORMAT[img.kind] ?? '$ID/JPEG' };
      else doc.warnings.add('Some pictures couldn’t be read.');
    }
    pictures.set(key, out);
    return out;
  };

  // Stories, made as text boxes reach them; each story's boxes in thread order.
  const storyOf = new Map<number, string>();
  const threads = new Map<string, { self: string; link: number }[]>();
  const tables = new Map<string, PubShape>();
  const story = (id: number) => {
    let self = storyOf.get(id);
    if (!self) {
      self = newId(pkg);
      storyOf.set(id, self);
      threads.set(self, []);
    }
    return self;
  };

  const fillAttrs = (fill: PubFill | null | undefined, w: number, h: number): string => {
    if (!fill || fill.type === 'picture') return ' FillColor="Swatch/None"';
    if (fill.type === 'solid') return ` FillColor="${swatch(fill.color)}"`;
    const self = gradient(fill);
    if (fill.radial) return ` FillColor="${self}" GradientFillStart="0 0" GradientFillLength="${n(Math.hypot(w, h) / 2)}" GradientFillAngle="0"`;
    const a = (-fill.angle * Math.PI) / 180;
    const len = Math.abs(w * Math.cos(a)) + Math.abs(h * Math.sin(a));
    return ` FillColor="${self}" GradientFillStart="${n((-Math.cos(a) * len) / 2)} ${n((-Math.sin(a) * len) / 2)}" GradientFillLength="${n(len)}" GradientFillAngle="${n(fill.angle)}"`;
  };
  const strokeAttrs = (line: PubLine | null | undefined, inside: boolean): string => {
    if (!line || line.width <= 0) return ' StrokeColor="Swatch/None" StrokeWeight="0"';
    const type = line.dash === 'dot' ? 'StrokeStyle/$ID/Canned Dotted' : line.dash ? 'StrokeStyle/$ID/Dashed' : 'StrokeStyle/$ID/Solid';
    return ` StrokeColor="${swatch(line.color)}" StrokeWeight="${n(line.width)}" StrokeType="${type}" StrokeAlignment="${inside ? 'InsideAlignment' : 'CenterAlignment'}"`;
  };
  const wrapXml = (sh: PubShape) =>
    sh.wrap
      ? `<TextWrapPreference Inverse="false" ApplyToMasterPageOnly="false" TextWrapSide="BothSides" TextWrapMode="BoundingBoxTextWrap"><Properties><TextWrapOffset Top="${n(sh.wrap[0])}" Left="${n(sh.wrap[1])}" Bottom="${n(sh.wrap[2])}" Right="${n(sh.wrap[3])}"/></Properties></TextWrapPreference>`
      : '';
  const effects = (sh: PubShape): string => {
    const parts: string[] = [];
    const op = sh.fill && sh.fill.type === 'solid' && sh.fill.opacity < 1 ? sh.fill.opacity : null;
    if (op !== null) parts.push(`<BlendingSetting Opacity="${n(op * 100)}"/>`);
    if (sh.shadow) parts.push(`<DropShadowSetting Mode="Drop" EffectColor="${swatch(sh.shadow.color)}" Opacity="${n(sh.shadow.opacity * 100)}" XOffset="${n(sh.shadow.x)}" YOffset="${n(sh.shadow.y)}" Size="0" Spread="0" Noise="0"/>`);
    return parts.length ? `<TransparencySetting>${parts.join('')}</TransparencySetting>` : '';
  };

  /** The box's outline in its own coordinates (centered on the box), as IDML path geometry. */
  const geometry = (paths: PubPath[], w: number, h: number) => {
    const p = (q: { x: number; y: number }) => `${n((q.x - 0.5) * w)} ${n((q.y - 0.5) * h)}`;
    return `<Properties><PathGeometry>${paths.map((sp) => `<GeometryPathType PathOpen="${sp.open}"><PathPointArray>${sp.points.map((pt) => `<PathPointType Anchor="${p(pt.anchor)}" LeftDirection="${p(pt.left)}" RightDirection="${p(pt.right)}"/>`).join('')}</PathPointArray></GeometryPathType>`).join('')}</PathGeometry></Properties>`;
  };
  const rectPath = (): PubPath[] => [{ open: false, points: [[0, 0], [0, 1], [1, 1], [1, 0]].map(([x, y]) => ({ anchor: { x, y }, left: { x, y }, right: { x, y } })) }];
  const ellipsePath = (): PubPath[] => {
    const k = 0.5523 / 2;
    const P = (x: number, y: number) => ({ x, y });
    return [{
      open: false,
      points: [
        { anchor: P(0.5, 0), left: P(0.5 + k, 0), right: P(0.5 - k, 0) },
        { anchor: P(0, 0.5), left: P(0, 0.5 - k), right: P(0, 0.5 + k) },
        { anchor: P(0.5, 1), left: P(0.5 - k, 1), right: P(0.5 + k, 1) },
        { anchor: P(1, 0.5), left: P(1, 0.5 + k), right: P(1, 0.5 - k) },
      ],
    }];
  };

  /** Page coordinates to spread coordinates (each page is centered on its spread's x axis). */
  const dy = -doc.height / 2;

  const shapeXml = async (sh: PubShape): Promise<string> => {
    const self = newId(pkg);
    const cx = sh.x + sh.w / 2;
    const cy = sh.y + sh.h / 2 + dy;
    const rad = (sh.rotation * Math.PI) / 180;
    const rot: M = [Math.cos(rad), Math.sin(rad), -Math.sin(rad), Math.cos(rad), cx, cy];
    const flips = !sh.text && (sh.flipH || sh.flipV);
    const t = flips ? mul(rot, [sh.flipH ? -1 : 1, 0, 0, sh.flipV ? -1 : 1, 0, 0]) : rot;
    const common = `Self="${self}" ItemLayer="${layer}" Visible="true" Locked="false" Name="$ID/" ItemTransform="${fmtM(t)}"`;
    const w = Math.max(sh.w, 0.01);
    const h = Math.max(sh.h, 0.01);

    if (sh.kind === 'group') {
      const inner: string[] = [];
      for (const c of sh.children ?? []) inner.push(await shapeXml(c));
      // Children are placed on the page; the group itself doesn't move them.
      return `<Group Self="${self}" ItemLayer="${layer}" Visible="true" Locked="false" Name="$ID/" ItemTransform="1 0 0 1 0 0">${wrapXml(sh)}${inner.join('')}</Group>`;
    }
    if (sh.kind === 'line') {
      const a = sh.flipH !== sh.flipV ? [{ x: 1, y: 0 }, { x: 0, y: 1 }] : [{ x: 0, y: 0 }, { x: 1, y: 1 }];
      const path: PubPath[] = [{ open: true, points: a.map((p) => ({ anchor: p, left: p, right: p })) }];
      if (sh.arrows) doc.warnings.add('Arrowheads on lines aren’t shown.');
      return `<GraphicLine Self="${self}" ItemLayer="${layer}" Visible="true" Locked="false" Name="$ID/" ItemTransform="${fmtM(rot)}"${strokeAttrs(sh.line ?? { color: '#000000', width: 0.75 }, false)} FillColor="Swatch/None">${geometry(path, w, h)}</GraphicLine>`;
    }

    const paths = sh.kind === 'path' && sh.paths ? sh.paths : sh.kind === 'ellipse' ? ellipsePath() : rectPath();
    const tag = sh.text ? 'TextFrame' : sh.kind === 'ellipse' ? 'Oval' : sh.kind === 'path' ? 'Polygon' : 'Rectangle';
    const corner = sh.corner ? ` CornerOption="RoundedCorner" CornerRadius="${n(sh.corner)}"` : '';
    const stroke = strokeAttrs(sh.line, sh.lineInside ?? true);
    let body = geometry(paths, w, h);
    let extra = '';

    // Borders that differ side to side become lines of their own, drawn over the box.
    let sideLines = '';
    if (sh.sides) {
      const corners = [[0, 0, 1, 0], [1, 0, 1, 1], [0, 1, 1, 1], [0, 0, 0, 1]];
      sh.sides.forEach((line, i) => {
        if (!line) return;
        const [x0, y0, x1, y1] = corners[i];
        const off = line.width / 2;
        const p0 = { x: x0 * w - w / 2 + (i === 1 ? -off : i === 3 ? off : 0), y: y0 * h - h / 2 + (i === 0 ? off : i === 2 ? -off : 0) };
        const p1 = { x: x1 * w - w / 2 + (i === 1 ? -off : i === 3 ? off : 0), y: y1 * h - h / 2 + (i === 0 ? off : i === 2 ? -off : 0) };
        const pt = (p: { x: number; y: number }) => `<PathPointType Anchor="${n(p.x)} ${n(p.y)}" LeftDirection="${n(p.x)} ${n(p.y)}" RightDirection="${n(p.x)} ${n(p.y)}"/>`;
        sideLines += `<GraphicLine Self="${newId(pkg)}" ItemLayer="${layer}" Visible="true" Locked="false" Name="$ID/" ItemTransform="${fmtM(rot)}"${strokeAttrs(line, false)} FillColor="Swatch/None"><Properties><PathGeometry><GeometryPathType PathOpen="true"><PathPointArray>${pt(p0)}${pt(p1)}</PathPointArray></GeometryPathType></PathGeometry></Properties></GraphicLine>`;
      });
    }

    if (sh.text) {
      const st = story(sh.text.story);
      threads.get(st)!.push({ self, link: sh.text.link });
      if (sh.table) tables.set(st, sh);
      const [l, tp, r, b] = sh.text.margins;
      const vj = sh.text.valign === 'middle' ? 'CenterAlign' : sh.text.valign === 'bottom' ? 'BottomAlign' : 'TopAlign';
      const inner = Math.max(1, w - l - r);
      const cols = Math.max(1, sh.text.columns);
      const gutter = sh.text.gutter || (cols > 1 ? 12 : 0);
      extra = `<TextFramePreference TextColumnCount="${cols}" TextColumnGutter="${n(gutter)}" TextColumnFixedWidth="${n((inner - gutter * (cols - 1)) / cols)}" VerticalJustification="${vj}" FirstBaselineOffset="AscentOffset" AutoSizingType="Off" IgnoreWrap="${!!sh.text.ignoreWrap}"><Properties><InsetSpacing type="list"><ListItem type="unit">${n(tp)}</ListItem><ListItem type="unit">${n(l)}</ListItem><ListItem type="unit">${n(b)}</ListItem><ListItem type="unit">${n(r)}</ListItem></InsetSpacing></Properties></TextFramePreference>`;
      const frame = `<TextFrame ${common} ParentStory="${st}" PreviousTextFrame="@@PREV:${self}@@" NextTextFrame="@@NEXT:${self}@@" ContentType="TextType" AppliedObjectStyle="ObjectStyle/$ID/[Normal Text Frame]"${fillAttrs(sh.fill, w, h)}${stroke}${corner}>${body}${extra}${wrapXml(sh)}${effects(sh)}</TextFrame>`;
      return frame + sideLines;
    }

    let content = '';
    let contentType = 'Unassigned';
    const pic = sh.image !== undefined ? sh.image : sh.fill?.type === 'picture' ? sh.fill.image : undefined;
    if (pic !== undefined) {
      const p = await picture(pic, w, h);
      if (p) {
        // Pictures are stretched to their box, less what's cropped away.
        const [cl, ct, cr, cb] = sh.crop ?? [0, 0, 0, 0];
        const vw = Math.max(1e-6, 1 - cl - cr);
        const vh = Math.max(1e-6, 1 - ct - cb);
        const sx = w / (p.w * vw);
        const sy = h / (p.h * vh);
        const im: M = [sx, 0, 0, sy, -w / 2 - cl * p.w * sx, -h / 2 - ct * p.h * sy];
        content = `<Image Self="${newId(pkg)}" Space="$ID/#Links_RGB" ActualPpi="72 72" EffectivePpi="${Math.round(72 / sx)} ${Math.round(72 / sy)}" ImageRenderingIntent="UseColorSettings" LocalDisplaySetting="Default" ImageTypeName="${p.format}" AppliedObjectStyle="ObjectStyle/$ID/[None]" ItemTransform="${fmtM(im)}" Visible="true" Name="$ID/"><Properties><Profile type="string">$ID/None</Profile><GraphicBounds Left="0" Top="0" Right="${n(p.w)}" Bottom="${n(p.h)}"/><Contents>${b64(p.data)}</Contents></Properties><Link Self="${newId(pkg)}" AssetURL="$ID/" AssetID="$ID/" LinkResourceURI="" LinkResourceFormat="${p.format}" StoredState="Embedded" LinkClassID="35906" LinkClientID="257" LinkResourceModified="false" LinkObjectModified="false" ShowInUI="true" CanEmbed="true" CanUnembed="false" CanPackage="true" ImportPolicy="NoAutoImport" ExportPolicy="NoAutoExport"/></Image>`;
        contentType = 'GraphicType';
        extra = `<FrameFittingOption AutoFit="false" LeftCrop="0" TopCrop="0" RightCrop="0" BottomCrop="0" FittingOnEmptyFrame="None"/>`;
      }
    }
    const fillXml = sh.image !== undefined ? fillAttrs(sh.fill, w, h) : fillAttrs(sh.fill?.type === 'picture' ? null : sh.fill, w, h);
    body = `${body}${extra}${wrapXml(sh)}${effects(sh)}${content}`;
    return `<${tag} ${common} ContentType="${contentType}"${fillXml}${stroke}${corner}>${body}</${tag}>${sideLines}`;
  };

  const pageItems = async (page: PubPage): Promise<string> => {
    const out: string[] = [];
    if (page.background && page.background.type !== 'picture') {
      out.push(await shapeXml({ kind: 'rect', x: 0, y: 0, w: doc.width, h: doc.height, rotation: 0, flipH: false, flipV: false, fill: page.background }));
    } else if (page.background?.type === 'picture') {
      out.push(await shapeXml({ kind: 'rect', x: 0, y: 0, w: doc.width, h: doc.height, rotation: 0, flipH: false, flipV: false, image: page.background.image }));
    }
    for (const sh of page.shapes) out.push(await shapeXml(sh));
    return out.join('');
  };

  // Masters: the first replaces the new document's own; the rest are added after it.
  const masterRefs = kids(root, 'idPkg:MasterSpread');
  const firstMasterPart = masterRefs[0]?.getAttribute('src') ?? '';
  const firstMaster = partRoot(xml.get(firstMasterPart)!)!;
  const masterSelves: string[] = [];
  for (let i = 0; i < doc.masters.length; i++) {
    let mroot = firstMaster;
    if (i > 0) {
      const self = newId(pkg);
      const part = `MasterSpreads/MasterSpread_${self}.xml`;
      const d = newPart('MasterSpread', '18.0');
      const clone = firstMaster.cloneNode(true) as Element;
      clone.setAttribute('Self', self);
      const letter = String.fromCharCode(65 + (i % 26));
      clone.setAttribute('Name', `${letter}-Master`);
      clone.setAttribute('NamePrefix', letter);
      for (const p of all(clone, 'Page')) p.setAttribute('Self', newId(pkg));
      for (const c of Array.from(clone.children)) if (c.localName !== 'Page' && c.localName !== 'Properties') c.remove();
      d.documentElement.appendChild(d.importNode(clone, true));
      xml.set(part, d);
      order.splice(order.indexOf(firstMasterPart) + i, 0, part);
      const ref = dm.createElement('idPkg:MasterSpread');
      ref.setAttribute('src', part);
      masterRefs[masterRefs.length - 1].after(ref);
      masterRefs.push(ref);
      mroot = partRoot(d)!;
    }
    masterSelves.push(mroot.getAttribute('Self') ?? '');
    appendXml(mroot, await pageItems(doc.masters[i]));
  }

  const spreadRefs = kids(root, 'idPkg:Spread');
  for (let i = 0; i < doc.pages.length; i++) {
    const part = spreadRefs[i]?.getAttribute('src');
    const sroot = part && xml.get(part) ? partRoot(xml.get(part)!) : null;
    if (!sroot) continue;
    const pageEl = kids(sroot, 'Page')[0];
    const m = doc.pages[i].master;
    pageEl?.setAttribute('AppliedMaster', m !== null && masterSelves[m] ? masterSelves[m] : 'n');
    appendXml(sroot, await pageItems(doc.pages[i]));
  }

  // Thread each story's boxes in Publisher's order.
  const links = new Map<string, { prev: string; next: string }>();
  for (const list of threads.values()) {
    list.sort((a, b) => a.link - b.link);
    list.forEach((f, i) => links.set(f.self, { prev: list[i - 1]?.self ?? 'n', next: list[i + 1]?.self ?? 'n' }));
  }
  for (const part of [...xml.keys()].filter((k) => k.startsWith('Spreads/') || k.startsWith('MasterSpreads/'))) {
    const d = xml.get(part)!;
    for (const f of all(d.documentElement, 'TextFrame')) {
      const self = f.getAttribute('Self') ?? '';
      const l = links.get(self);
      f.setAttribute('PreviousTextFrame', l?.prev ?? 'n');
      f.setAttribute('NextTextFrame', l?.next ?? 'n');
    }
  }

  // Stories.
  const storyRefs: string[] = [];
  for (const [id, self] of storyOf) {
    const table = tables.get(self);
    const body = table?.table ? tableXml(table, pkg, swatch) : storyBody(doc.stories.get(id) ?? [], swatch);
    const part = `Stories/Story_${self}.xml`;
    const d = parseXml(
      `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<idPkg:Story xmlns:idPkg="http://ns.adobe.com/AdobeInDesign/idml/1.0/packaging" DOMVersion="18.0"><Story Self="${self}" AppliedTOCStyle="n" TrackChanges="false" StoryTitle="$ID/" AppliedNamedGrid="n"><StoryPreference OpticalMarginAlignment="false" OpticalMarginSize="12" FrameType="TextFrameType" StoryOrientation="Horizontal" StoryDirection="LeftToRightDirection"/>${body}</Story></idPkg:Story>`,
      part,
    );
    xml.set(part, d);
    order.push(part);
    storyRefs.push(self);
    const ref = dm.createElement('idPkg:Story');
    ref.setAttribute('src', part);
    root.appendChild(ref);
  }
  root.setAttribute('StoryList', storyRefs.join(' '));
  return pkg;
}

const FORMAT: Partial<Record<PubImage['kind'], string>> = { png: '$ID/PNG', jpeg: '$ID/JPEG', bmp: '$ID/Windows Bitmap', gif: '$ID/GIF', tiff: '$ID/TIFF' };

function xmlEl(doc: XMLDocument, text: string): Element {
  const d = parseXml(`<x>${text}</x>`);
  return doc.importNode(d.documentElement.firstElementChild!, true) as Element;
}

function appendXml(parent: Element, text: string) {
  if (!text) return;
  const d = parseXml(`<x>${text}</x>`);
  for (const c of Array.from(d.documentElement.children)) parent.appendChild(parent.ownerDocument.importNode(c, true));
}

function b64(bytes: Uint8Array): string {
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
}

const JUSTIFY: Record<string, string> = { left: 'LeftAlign', center: 'CenterAlign', right: 'RightAlign', justify: 'LeftJustified' };

function paraAttrs(p: PubPara): { attrs: string; props: string } {
  const a: string[] = [];
  const props: string[] = [];
  if (p.align) a.push(`Justification="${JUSTIFY[p.align]}"`);
  if (p.spaceBefore) a.push(`SpaceBefore="${n(p.spaceBefore)}"`);
  if (p.spaceAfter) a.push(`SpaceAfter="${n(p.spaceAfter)}"`);
  if (p.leftIndent) a.push(`LeftIndent="${n(p.leftIndent)}"`);
  if (p.rightIndent) a.push(`RightIndent="${n(p.rightIndent)}"`);
  if (p.firstIndent) a.push(`FirstLineIndent="${n(p.firstIndent)}"`);
  if (p.lineSpacing && 'lines' in p.lineSpacing) a.push(`AutoLeading="${n(120 * p.lineSpacing.lines)}"`);
  if (p.lineSpacing && 'pt' in p.lineSpacing) props.push(`<Leading type="unit">${n(p.lineSpacing.pt)}</Leading>`);
  if (p.dropCap) a.push(`DropCapLines="${p.dropCap.lines}" DropCapCharacters="${p.dropCap.chars}"`);
  if (p.bullet) {
    a.push('BulletsAndNumberingListType="BulletList"');
    props.push(`<BulletChar BulletCharacterType="UnicodeOnly" BulletCharacterValue="${p.bullet.charCodeAt(0) >= 0xf000 ? 8226 : p.bullet.charCodeAt(0)}"/>`);
  } else if (p.numbered) a.push(`BulletsAndNumberingListType="NumberedList" NumberingStartAt="${p.numbered.start}" NumberingContinue="true"`);
  if (p.tabs?.length) {
    props.push(`<TabList type="list">${p.tabs.map((t) => `<ListItem type="record"><Alignment type="enumeration">LeftAlign</Alignment><AlignmentCharacter type="string">.</AlignmentCharacter><Leader type="string"></Leader><Position type="unit">${n(t)}</Position></ListItem>`).join('')}</TabList>`);
  }
  return { attrs: a.length ? ` ${a.join(' ')}` : '', props: props.length ? `<Properties>${props.join('')}</Properties>` : '' };
}

function runAttrs(r: PubRun, swatch: (hex: string) => string): string {
  const style = r.bold && r.italic ? 'Bold Italic' : r.bold ? 'Bold' : r.italic ? 'Italic' : 'Regular';
  const a = [`FontStyle="${style}"`, `PointSize="${n(r.size ?? 10)}"`, `FillColor="${swatch(r.color ?? '#000000')}"`];
  if (r.underline) a.push('Underline="true"');
  if (r.caps === 'all') a.push('Capitalization="AllCaps"');
  if (r.caps === 'small') a.push('Capitalization="SmallCaps"');
  if (r.position === 'super') a.push('Position="Superscript"');
  if (r.position === 'sub') a.push('Position="Subscript"');
  if (r.scale) a.push(`HorizontalScale="${n(r.scale)}"`);
  return a.join(' ');
}

function storyBody(paras: PubPara[], swatch: (hex: string) => string): string {
  if (!paras.length) paras = [{ runs: [{ text: '' }] }];
  return paras
    .map((p, i) => {
      const { attrs, props } = paraAttrs(p);
      const runs = p.runs.length ? p.runs : [{ text: '' }];
      const last = i === paras.length - 1;
      const csrs = runs
        .map((r, j) => {
          const br = !last && j === runs.length - 1 ? '<Br/>' : '';
          const font = esc(r.font ?? 'Times New Roman');
          return `<CharacterStyleRange AppliedCharacterStyle="CharacterStyle/$ID/[No character style]" ${runAttrs(r, swatch)}><Properties><AppliedFont type="string">${font}</AppliedFont></Properties>${r.text ? `<Content>${esc(clean(r.text))}</Content>` : ''}${br}</CharacterStyleRange>`;
        })
        .join('');
      return `<ParagraphStyleRange AppliedParagraphStyle="ParagraphStyle/$ID/NormalParagraphStyle"${attrs}>${props}${csrs}</ParagraphStyleRange>`;
    })
    .join('');
}

function tableXml(sh: PubShape, pkg: Pkg, swatch: (hex: string) => string): string {
  const t = sh.table!;
  const self = newId(pkg);
  const rows = t.rows.map((h, i) => `<Row Self="${self}Row${i}" Name="${i}" SingleRowHeight="${n(h)}" MinimumHeight="3" AutoGrow="true"/>`).join('');
  const cols = t.cols.map((w, i) => `<Column Self="${self}Column${i}" Name="${i}" SingleColumnWidth="${n(w)}"/>`).join('');
  const edges = ['Top', 'Left', 'Bottom', 'Right'].map((s) => `${s}EdgeStrokeWeight="0" ${s}EdgeStrokeColor="Swatch/None"`).join(' ');
  const cells = t.cells
    .map((c, i) => `<Cell Self="${self}i${i}" Name="${c.col}:${c.row}" RowSpan="${c.rows}" ColumnSpan="${c.cols}" AppliedCellStyle="CellStyle/$ID/[None]" ${edges} TextTopInset="2.88" TextLeftInset="2.88" TextBottomInset="2.88" TextRightInset="2.88">${storyBody(c.paras, swatch)}</Cell>`)
    .join('');
  const table = `<Table Self="${self}" HeaderRowCount="0" FooterRowCount="0" BodyRowCount="${t.rows.length}" ColumnCount="${t.cols.length}" AppliedTableStyle="TableStyle/$ID/[Basic Table]" TableDirection="LeftToRightDirection">${rows}${cols}${cells}</Table>`;
  return `<ParagraphStyleRange AppliedParagraphStyle="ParagraphStyle/$ID/NormalParagraphStyle"><CharacterStyleRange AppliedCharacterStyle="CharacterStyle/$ID/[No character style]">${table}</CharacterStyleRange></ParagraphStyleRange>`;
}

/** A picture's size in pixels, from its header. */
export function imageSize(b: Uint8Array): { w: number; h: number } | null {
  const v = new DataView(b.buffer, b.byteOffset, b.byteLength);
  if (b.length > 24 && b[0] === 0x89 && b[1] === 0x50) return { w: v.getUint32(16), h: v.getUint32(20) };
  if (b.length > 10 && b[0] === 0x47 && b[1] === 0x49) return { w: v.getUint16(6, true), h: v.getUint16(8, true) };
  if (b.length > 26 && b[0] === 0x42 && b[1] === 0x4d) return { w: Math.abs(v.getInt32(18, true)), h: Math.abs(v.getInt32(22, true)) };
  if (b.length > 4 && b[0] === 0xff && b[1] === 0xd8) {
    let o = 2;
    while (o + 9 < b.length) {
      if (b[o] !== 0xff) {
        o++;
        continue;
      }
      const m = b[o + 1];
      const len = v.getUint16(o + 2);
      if ((m >= 0xc0 && m <= 0xc3) || (m >= 0xc5 && m <= 0xc7) || (m >= 0xc9 && m <= 0xcb) || (m >= 0xcd && m <= 0xcf)) return { w: v.getUint16(o + 7), h: v.getUint16(o + 5) };
      o += 2 + len;
    }
    return null;
  }
  if (b.length > 8 && ((b[0] === 0x49 && b[1] === 0x49) || (b[0] === 0x4d && b[1] === 0x4d))) {
    const le = b[0] === 0x49;
    const ifd = v.getUint32(4, le);
    const count = ifd + 2 <= b.length ? v.getUint16(ifd, le) : 0;
    let w = 0;
    let h = 0;
    for (let i = 0; i < count; i++) {
      const e = ifd + 2 + i * 12;
      if (e + 12 > b.length) break;
      const tag = v.getUint16(e, le);
      const type = v.getUint16(e + 2, le);
      const val = type === 3 ? v.getUint16(e + 8, le) : v.getUint32(e + 8, le);
      if (tag === 256) w = val;
      if (tag === 257) h = val;
    }
    return w && h ? { w, h } : null;
  }
  return null;
}
