import { describe, expect, it } from 'vitest';
import { strFromU8, strToU8 } from 'fflate';
import { blendFromOra, blendToOra, packOra, parseStackXml, stackXml, unpackOra, type OraImage } from './ora';

const image: OraImage = {
  width: 640,
  height: 480,
  xres: 300,
  yres: 300,
  nodes: [
    {
      type: 'stack',
      name: 'Group "A" & co',
      opacity: 0.5,
      hidden: false,
      op: 'svg:src-over',
      locked: false,
      isolated: false,
      children: [{ type: 'layer', name: 'Shade', opacity: 1, hidden: false, op: 'svg:multiply', locked: false, src: 'data/layer3.png', x: -12, y: 40, text: null }],
    },
    {
      type: 'layer',
      name: 'Title',
      opacity: 0.75,
      hidden: true,
      op: 'svg:src-over',
      locked: true,
      src: 'data/layer2.png',
      x: 10,
      y: 20,
      text: { text: 'Hi\n"there"', font: 'Inter', size: 48, color: '#ff0000', bold: true, italic: false, align: 'center', x: 10, y: 60 },
    },
    { type: 'layer', name: 'Background', opacity: 1, hidden: false, op: 'svg:src-over', locked: false, src: 'data/layer1.png', x: 0, y: 0, text: null },
  ],
};

describe('OpenRaster', () => {
  it('reads back the stack it writes', () => {
    expect(parseStackXml(stackXml(image))).toEqual(image);
  });

  it('reads what other apps write', () => {
    const xml = `<?xml version='1.0' encoding='UTF-8'?>
      <image version="0.0.3" w="300" h="177">
        <stack>
          <stack name="Inks" composite-op="svg:screen">
            <layer name="Logo" src="data/hw.png" x="15" y="5" opacity="0.4" visibility="hidden" selected="true"/>
          </stack>
          <layer src="./data/image1.png" composite-op="krita:linear_burn"/>
        </stack>
      </image>`;
    const img = parseStackXml(xml);
    expect(img).toMatchObject({ width: 300, height: 177, xres: 72, yres: 72 });
    const [group, layer] = img.nodes;
    expect(group).toMatchObject({ type: 'stack', name: 'Inks', isolated: true, op: 'svg:screen' });
    expect(group.type === 'stack' && group.children[0]).toMatchObject({ src: 'data/hw.png', x: 15, y: 5, opacity: 0.4, hidden: true });
    expect(layer).toMatchObject({ type: 'layer', src: './data/image1.png', x: 0, y: 0, opacity: 1, hidden: false, text: null });
    expect(blendFromOra('krita:linear_burn')).toBe('linear burn');
  });

  it('maps blend modes both ways and falls back to normal', () => {
    for (const mode of ['normal', 'multiply', 'screen', 'color dodge', 'linear dodge', 'vivid light', 'hard mix', 'subtract'] as const) {
      expect(blendFromOra(blendToOra(mode))).toBe(mode);
    }
    expect(blendToOra('multiply')).toBe('svg:multiply');
    expect(blendToOra('linear dodge')).toBe('svg:plus');
    expect(blendFromOra('krita:add')).toBe('linear dodge');
    expect(blendFromOra('svg:dst-out')).toBe('normal');
    expect(blendFromOra('pigment')).toBe('normal');
    expect(blendFromOra(null)).toBe('normal');
  });

  it('writes the mimetype first and uncompressed', () => {
    const bytes = packOra({
      stack: stackXml(image),
      data: new Map([['data/layer1.png', new Uint8Array([1, 2, 3])]]),
      thumbnail: new Uint8Array([4]),
      merged: new Uint8Array([5]),
    });
    const view = new DataView(bytes.buffer, bytes.byteOffset);
    expect(view.getUint32(0, true)).toBe(0x04034b50);
    expect(view.getUint16(8, true)).toBe(0);
    const nameLength = view.getUint16(26, true);
    const extraLength = view.getUint16(28, true);
    expect(strFromU8(bytes.subarray(30, 30 + nameLength))).toBe('mimetype');
    const start = 30 + nameLength + extraLength;
    expect(strFromU8(bytes.subarray(start, start + 16))).toBe('image/openraster');

    const entries = unpackOra(bytes);
    expect(Object.keys(entries)).toEqual(['mimetype', 'stack.xml', 'data/layer1.png', 'Thumbnails/thumbnail.png', 'mergedimage.png']);
    expect(parseStackXml(strFromU8(entries['stack.xml']))).toEqual(image);
  });

  it('turns away files that aren’t OpenRaster', () => {
    expect(() => unpackOra(strToU8('8BPS not a zip'))).toThrow('isn’t an OpenRaster file');
  });
});
