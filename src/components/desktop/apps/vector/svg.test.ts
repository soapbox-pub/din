import { describe, expect, it } from 'vitest';

import { newDoc, type GroupItem, type PathItem } from './model';
import { rectPath } from './ops';
import { readSvg, writeSvg } from './svg';

// As Inkscape 1.4 saves it: mm units, a sublayer, a hidden and a locked layer, two pages.
const INKSCAPE_SVG = `<?xml version="1.0" encoding="UTF-8" standalone="no"?>
<svg width="210mm" height="297mm" viewBox="0 0 210 297" version="1.1" id="svg1"
   xmlns:inkscape="http://www.inkscape.org/namespaces/inkscape"
   xmlns:sodipodi="http://sodipodi.sourceforge.net/DTD/sodipodi-0.dtd"
   xmlns="http://www.w3.org/2000/svg" xmlns:svg="http://www.w3.org/2000/svg">
  <sodipodi:namedview id="namedview1" pagecolor="#ffffff" inkscape:document-units="mm" bordercolor="#666666">
    <inkscape:page x="0" y="0" width="210" height="297" id="page1" inkscape:label="Cover &amp; Front" margin="0" bleed="0" />
    <inkscape:page x="220" y="0" width="148" height="105" id="page2" inkscape:label="Postcard" />
  </sodipodi:namedview>
  <defs id="defs1" />
  <g inkscape:groupmode="layer" id="layer1" inkscape:label="Background">
    <rect id="rect1" x="0" y="0" width="210" height="297" style="fill:#ffeecc" />
    <g inkscape:groupmode="layer" id="layer4" inkscape:label="Sub layer" sodipodi:insensitive="true">
      <circle id="circle1" inkscape:label="Sun" cx="105" cy="80" r="30" style="fill:#ffaa00" />
    </g>
  </g>
  <g inkscape:groupmode="layer" id="layer2" inkscape:label="Hidden notes" style="display:none">
    <rect id="rect2" x="20" y="200" width="50" height="20" style="fill:#0000ff" />
  </g>
  <g inkscape:groupmode="layer" id="layer3" inkscape:label="Locked" sodipodi:insensitive="true" transform="translate(220,0)" style="opacity:0.5">
    <rect id="rect3" inkscape:label="Card" x="10" y="10" width="128" height="85" style="fill:#00aa00" />
  </g>
  <g inkscape:groupmode="layer" id="layer5" inkscape:label="Empty" />
</svg>`;

const MM = 72 / 25.4;

describe('Inkscape SVG', () => {
  it('reads layers, names, visibility, units and pages', async () => {
    const doc = await readSvg(INKSCAPE_SVG);
    expect(doc.units).toBe('mm');
    expect(doc.artboards.map((a) => a.name)).toEqual(['Cover & Front', 'Postcard']);
    expect(doc.artboards[0].w).toBeCloseTo(210 * MM);
    expect(doc.artboards[1].x).toBeCloseTo(220 * MM);
    expect(doc.artboards[1].h).toBeCloseTo(105 * MM);

    expect(doc.layers.map((l) => [l.name, l.hidden, l.locked])).toEqual([
      ['Background', false, false],
      ['Hidden notes', true, false],
      ['Locked', false, true],
      ['Empty', false, false],
    ]);
    const [bg, hidden, locked] = doc.layers;
    expect(bg.children[0].name).toBe('');
    const sub = bg.children[1] as GroupItem;
    expect([sub.type, sub.name, sub.locked]).toEqual(['group', 'Sub layer', true]);
    expect(sub.children[0].name).toBe('Sun');
    expect(hidden.children).toHaveLength(1);

    // The layer's opacity stays on a group; its transform is applied.
    const wrap = locked.children[0] as GroupItem;
    expect(wrap.opacity).toBe(0.5);
    const card = wrap.children[0] as PathItem;
    expect(card.name).toBe('Card');
    expect(card.paths[0].nodes[0].x).toBeCloseTo(230 * MM);
  });

  it('writes layers and pages Inkscape reads, and reads them back', async () => {
    const doc = newDoc(200, 100, 'rgb', 'mm', 2);
    doc.artboards[1].name = 'Back "side" <2>';
    const box: PathItem = { id: 1, type: 'path', name: 'Box & co', opacity: 1, blend: 'normal', paths: [rectPath(10, 10, 50, 50, 0)], fill: { type: 'color', color: { space: 'rgb', c: [1, 0, 0] } }, stroke: { paint: { type: 'none' }, width: 1, cap: 0, join: 0, miter: 10, dash: [], dashOffset: 0 }, evenOdd: false };
    doc.layers[0].children.push(box, { ...box, id: 2, name: 'Box & co', hidden: true, locked: true });
    doc.layers.push({ ...doc.layers[0], id: 3, name: 'Guides', hidden: true, locked: true, children: [] });

    const svg = writeSvg(doc, doc.artboards[0]);
    expect(svg).toContain('xmlns:inkscape="http://www.inkscape.org/namespaces/inkscape"');
    expect(svg).toContain('inkscape:document-units="mm"');
    expect(svg).toContain(`width="${Math.round((200 / MM) * 1000) / 1000}mm"`);
    expect(svg).toContain('inkscape:label="Back &quot;side&quot; &lt;2&gt;"');
    expect(svg).toContain('<g inkscape:groupmode="layer" id="Guides" inkscape:label="Guides" style="display:none" sodipodi:insensitive="true">');
    const ids = [...svg.matchAll(/ id="([^"]+)"/g)].map((m) => m[1]);
    expect(new Set(ids).size).toBe(ids.length);

    const back = await readSvg(svg);
    expect(back.units).toBe('mm');
    expect(back.artboards.map((a) => [a.name, Math.round(a.x), Math.round(a.w)])).toEqual(doc.artboards.map((a) => [a.name, Math.round(a.x), Math.round(a.w)]));
    expect(back.layers.map((l) => [l.name, l.hidden, l.locked])).toEqual([
      ['Layer 1', false, false],
      ['Guides', true, true],
    ]);
    expect(back.layers[0].children.map((c) => [c.name, !!c.hidden, !!c.locked])).toEqual([
      ['Box & co', false, false],
      ['Box & co', true, true],
    ]);
  });
});
