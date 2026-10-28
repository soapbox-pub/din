import zlib from 'node:zlib';
import { describe, expect, it, vi } from 'vitest';
import { cleanPath, readZip, resolve, type Tree } from './archive';
import { Budget, DAMAGED, LIMITS, TOO_BIG, inflate } from './bytes';
import { convertCursors, type Decoder } from './convert';
import { runScript } from './cursorfx';
import { parsePlist } from './plist';
import { decodeTiff } from './tiff';

// ---------------------------------------------------------------------------
// Builders for hand-made (and hostile) inputs
// ---------------------------------------------------------------------------

const encoder = new TextEncoder();
const bytes = (s: string) => encoder.encode(s);

function u32(n: number): number[] {
  return [n & 0xff, (n >>> 8) & 0xff, (n >>> 16) & 0xff, (n >>> 24) & 0xff];
}
function u16(n: number): number[] {
  return [n & 0xff, (n >>> 8) & 0xff];
}

interface ZipItem {
  name: string;
  data: Uint8Array;
  deflate?: boolean;
  /** The uncompressed size to claim, if not the real one. */
  claim?: number;
  /** Point this entry at another's local header. */
  sameAs?: number;
  symlink?: boolean;
}

function zip(items: ZipItem[]): Uint8Array {
  const local: number[] = [];
  const central: number[] = [];
  const offsets: number[] = [];
  const sizes: { compressed: number; size: number; method: number }[] = [];
  items.forEach((item, i) => {
    const name = bytes(item.name);
    const body = item.deflate ? new Uint8Array(zlib.deflateRawSync(item.data)) : item.data;
    const method = item.deflate ? 8 : 0;
    const size = item.claim ?? item.data.length;
    if (item.sameAs === undefined) {
      offsets[i] = local.length;
      sizes[i] = { compressed: body.length, size, method };
      local.push(...u32(0x04034b50), ...u16(20), ...u16(0), ...u16(method), ...u32(0), ...u32(0));
      local.push(...u32(body.length), ...u32(size), ...u16(name.length), ...u16(0), ...name, ...body);
    } else {
      offsets[i] = offsets[item.sameAs];
      sizes[i] = { ...sizes[item.sameAs], size };
    }
    const madeBy = item.symlink ? 0x0314 : 20;
    const external = item.symlink ? 0o120777 << 16 : 0;
    central.push(...u32(0x02014b50), ...u16(madeBy), ...u16(20), ...u16(0), ...u16(sizes[i].method), ...u32(0), ...u32(0));
    central.push(...u32(sizes[i].compressed), ...u32(sizes[i].size), ...u16(name.length), ...u16(0), ...u16(0));
    central.push(...u16(0), ...u16(0), ...u32(external), ...u32(offsets[i]), ...name);
  });
  const end = [...u32(0x06054b50), ...u16(0), ...u16(0), ...u16(items.length), ...u16(items.length)];
  end.push(...u32(central.length), ...u32(local.length), ...u16(0));
  return new Uint8Array([...local, ...central, ...end]);
}

/** Just enough PNG for the header check: the signature and an IHDR. */
function fakePng(width: number, height: number): Uint8Array {
  const be = (n: number) => [(n >>> 24) & 0xff, (n >>> 16) & 0xff, (n >>> 8) & 0xff, n & 0xff];
  return new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, ...be(13), ...bytes('IHDR'), ...be(width), ...be(height), 8, 6, 0, 0, 0]);
}

function readPngSize(data: Uint8Array) {
  const view = new DataView(data.buffer, data.byteOffset);
  return { width: view.getUint32(16), height: view.getUint32(20) };
}

/** Opaque red pixels the size the header says, for PNGs and SVGs alike. */
function fakeDecoder(): Decoder & { decodePng: ReturnType<typeof vi.fn>; renderSvg: ReturnType<typeof vi.fn> } {
  const solid = (width: number, height: number) => {
    const data = new Uint8Array(width * height * 4);
    for (let i = 0; i < data.length; i += 4) data.set([255, 0, 0, 255], i);
    return { width, height, data };
  };
  return {
    decodePng: vi.fn(async (data: Uint8Array) => {
      const { width, height } = readPngSize(data);
      return solid(width, height);
    }),
    renderSvg: vi.fn(async (_data: Uint8Array, size: number) => solid(size, size)),
  };
}

const single = (name: string, data: Uint8Array) => ({ name, entries: [{ path: name, data }] });

/** A .CursorFX file of the given records (already laid out), its header saying `claim` for the inflated size. */
function cursorFX(records: Uint8Array, options: { claim?: number; name?: string } = {}): Uint8Array {
  const info = new Uint8Array([...new Uint8Array(new Uint16Array([...(options.name ?? 'Test')].map((c) => c.charCodeAt(0))).buffer), 0, 0]);
  const body = new Uint8Array([...info, ...records]);
  const header = [...u32(1), ...u32(24), ...u32(options.claim ?? body.length), ...u32(0), ...u32(0), ...u32(info.length)];
  return new Uint8Array([...header, ...zlib.deflateSync(body)]);
}

/** One pointer record: `frames` frames of `w`×`h`, side by side, straight BGRA bottom-up. */
function cfxPointer(options: { index: number; frames: number; w: number; h: number; hot: [number, number]; animation?: number; script?: string; lie?: boolean }): Uint8Array {
  const { index, frames, w, h, hot } = options;
  const width = w * frames;
  const image = new Uint8Array(width * h * 4);
  // One opaque pixel per frame, at the frame's centre.
  for (let f = 0; f < frames; f++) {
    const x = f * w + Math.floor(w / 2);
    const y = Math.floor(h / 2);
    image.set([0, 0, 255, 255], ((h - 1 - y) * width + x) * 4);
  }
  const script = options.script ? new Uint8Array([...new Uint8Array(new Uint16Array([...options.script].map((c) => c.charCodeAt(0))).buffer), 0, 0]) : new Uint8Array();
  const headerSize = 12 + 16 * 4;
  const imageSize = options.lie ? image.length + 4 : image.length;
  const total = headerSize + script.length + image.length;
  const fields = [0, index, 1, 0, frames, width, h, 50, options.animation ?? 2, 0, hot[0], hot[1], headerSize + script.length, imageSize, headerSize, script.length];
  return new Uint8Array([...u32(2), ...u32(headerSize), ...u32(total), ...fields.flatMap(u32), ...script, ...image]);
}

// ---------------------------------------------------------------------------

describe('archives', () => {
  it('keeps paths inside the import', async () => {
    expect(cleanPath('../etc/passwd')).toBeNull();
    expect(cleanPath('a/../../b')).toBeNull();
    expect(cleanPath('/abs/./x')).toBe('abs/x');
    expect(cleanPath('a\\b')).toBe('a/b');

    const tree: Tree = new Map();
    await readZip(
      zip([
        { name: '../escape', data: bytes('x') },
        { name: 'ok/file', data: bytes('y') },
        { name: 'ok/out', data: bytes('/etc/passwd'), symlink: true },
        { name: 'ok/up', data: bytes('../../../etc/passwd'), symlink: true },
        { name: 'ok/in', data: bytes('file'), symlink: true },
      ]),
      tree,
      new Budget(),
    );
    expect([...tree.keys()].sort()).toEqual(['ok/file', 'ok/in', 'ok/out', 'ok/up']);
    expect(resolve(tree, 'ok/out')).toBeNull();
    expect(resolve(tree, 'ok/up')).toBeNull();
    expect(resolve(tree, 'ok/in')?.path).toBe('ok/file');
  });

  it('stops a symlink loop', () => {
    const tree: Tree = new Map([
      ['a', { link: 'b' }],
      ['b', { link: 'a' }],
    ]);
    expect(resolve(tree, 'a')).toBeNull();
  });

  it('stops an entry that inflates past its declared size', async () => {
    const tree: Tree = new Map();
    const bomb = zip([{ name: 'bomb', data: new Uint8Array(4 * 1024 * 1024), deflate: true, claim: 100 }]);
    await expect(readZip(bomb, tree, new Budget())).rejects.toThrow(TOO_BIG);
  });

  it('refuses an entry declared bigger than the budget, before inflating it', async () => {
    const tree: Tree = new Map();
    const huge = zip([{ name: 'huge', data: new Uint8Array(10), deflate: true, claim: LIMITS.expandedBytes + 1 }]);
    await expect(readZip(huge, tree, new Budget())).rejects.toThrow(TOO_BIG);
  });

  it('charges entries that share one stream for each of them', async () => {
    const size = 8 * 1024 * 1024;
    const items: ZipItem[] = [{ name: 'f0', data: new Uint8Array(size), deflate: true }];
    for (let i = 1; i < 20; i++) items.push({ name: `f${i}`, data: new Uint8Array(size), deflate: true, sameAs: 0 });
    await expect(readZip(zip(items), new Map(), new Budget())).rejects.toThrow(TOO_BIG);
  });

  it('caps any stream it inflates', async () => {
    const gz = new Uint8Array(zlib.gzipSync(new Uint8Array(1024 * 1024)));
    await expect(inflate(gz, 'gzip', 1000)).rejects.toThrow(TOO_BIG);
    await expect(inflate(new Uint8Array([1, 2, 3, 4]), 'gzip', 1000)).rejects.toThrow(DAMAGED);
  });

  it('refuses a tar whose entry runs past its end', async () => {
    const header = new Uint8Array(512);
    header.set(bytes('cursors/left_ptr'), 0);
    header.set(bytes('77777777777'), 124);
    header.set(bytes('ustar'), 257);
    await expect(convertCursors(single('x.tar', header), fakeDecoder())).rejects.toThrow(DAMAGED);
  });

  it('says so when nothing in it is cursors', async () => {
    await expect(convertCursors(single('notes.zip', zip([{ name: 'readme.txt', data: bytes('hi') }])), fakeDecoder())).rejects.toThrow(
      'No cursor themes were found in it.',
    );
  });
});

describe('images', () => {
  it("never decodes an image too big to hold, as its header gives it", async () => {
    const decoder = fakeDecoder();
    const scheme = '[Arrow]\nFrames=1\n';
    const theme = zip([
      { name: 'Scheme.ini', data: bytes(scheme) },
      { name: 'Arrow.png', data: fakePng(100_000, 100_000) },
    ]);
    await expect(convertCursors(single('big.CurXPTheme', theme), decoder)).rejects.toThrow(TOO_BIG);
    expect(decoder.decodePng).not.toHaveBeenCalled();
  });

  it('keeps every frame within the frame limit', async () => {
    const theme = zip([
      { name: 'Scheme.ini', data: bytes('[Arrow]\nFrames=1\nHot spot x=1999\nHot spot y=0\n') },
      { name: 'Arrow.png', data: fakePng(2000, 1000) },
    ]);
    const [result] = await convertCursors(single('wide.CurXPTheme', theme), fakeDecoder());
    const [frame] = result.cursors[0].frames;
    expect(frame.width).toBe(LIMITS.frameDimension);
    expect(frame.height).toBe(LIMITS.frameDimension / 2);
    expect(frame.hotX).toBeLessThan(frame.width);
  });
});

describe('CursorXP', () => {
  it('reads cursors, frames and hotspots', async () => {
    const theme = zip([
      { name: 'Scheme.ini', data: bytes('[Arrow]\nFrames=4\nInterval=40\nHot spot x=3\nHot spot y=5\n[Hand]\nFrames=1\n') },
      { name: 'Arrow.png', data: fakePng(64, 16) },
      { name: 'Hand.png', data: fakePng(16, 16) },
    ]);
    const [result] = await convertCursors(single('Mine.CurXPTheme', theme), fakeDecoder());
    expect(result.name).toBe('Mine');
    const arrow = result.cursors.find((c) => c.name === 'left_ptr');
    expect(arrow?.frames).toHaveLength(4);
    expect(arrow?.frames[0]).toMatchObject({ width: 16, height: 16, size: 16, hotX: 3, hotY: 5, delay: 40 });
    expect(result.links).toContainEqual(['hand2', 'pointer']);
  });

  it('opens a theme zipped inside another archive, only one level deep', async () => {
    const inner = zip([
      { name: 'Scheme.ini', data: bytes('[Arrow]\nFrames=1\n') },
      { name: 'Arrow.png', data: fakePng(16, 16) },
    ]);
    const outer = zip([{ name: 'Inner.CurXPTheme', data: inner }]);
    const [result] = await convertCursors(single('pack.zip', outer), fakeDecoder());
    expect(result.name).toBe('Inner');
  });
});

describe('CursorFX', () => {
  it('reads pointers, upside down and with margins, into trimmed frames', async () => {
    const file = cursorFX(cfxPointer({ index: 0, frames: 2, w: 9, h: 7, hot: [4, 3] }), { name: 'Fx' });
    const [result] = await convertCursors(single('Fx.CursorFX', file), fakeDecoder());
    expect(result.name).toBe('Fx');
    const [arrow] = result.cursors;
    expect(arrow.name).toBe('left_ptr');
    expect(arrow.frames).toHaveLength(2);
    // Only the centre pixel (and the hotspot on it) is kept.
    expect(arrow.frames[0]).toMatchObject({ width: 1, height: 1, hotX: 0, hotY: 0, delay: 50 });
    expect([...arrow.frames[0].pixels]).toEqual([0, 0, 255, 255]);
  });

  it('refuses a header that claims more than the budget', async () => {
    const file = cursorFX(cfxPointer({ index: 0, frames: 1, w: 4, h: 4, hot: [0, 0] }), { claim: LIMITS.expandedBytes + 1 });
    await expect(convertCursors(single('x.CursorFX', file), fakeDecoder())).rejects.toThrow(TOO_BIG);
  });

  it('stops a stream that inflates past what its header claims', async () => {
    const records = new Uint8Array(1024 * 1024);
    const file = cursorFX(records, { claim: 64 });
    await expect(convertCursors(single('x.CursorFX', file), fakeDecoder())).rejects.toThrow(TOO_BIG);
  });

  it('refuses a record whose image size lies', async () => {
    const file = cursorFX(cfxPointer({ index: 0, frames: 1, w: 4, h: 4, hot: [0, 0], lie: true }));
    await expect(convertCursors(single('x.CursorFX', file), fakeDecoder())).rejects.toThrow(DAMAGED);
  });

  it('plays frame scripts, and gives up on ones it can’t', () => {
    expect(runScript('1-3,20;2', 3, 50)?.map((s) => s.index)).toEqual([0, 1, 2, 1]);
    expect(runScript('3-1', 3, 50)?.map((s) => s.index)).toEqual([2, 1, 0]);
    expect(runScript('repeat 2;1;end repeat;2,10', 2, 50)).toEqual([
      { index: 0, delay: 50 },
      { index: 0, delay: 50 },
      { index: 1, delay: 10 },
    ]);
    expect(runScript('1-9', 3, 50)).toBeNull();
    expect(runScript('jump 1', 3, 50)).toBeNull();
    // Repeats nested past any sense end quickly, and capped.
    const nested = 'repeat 999;'.repeat(40) + '1' + ';end repeat'.repeat(40);
    expect(runScript(nested, 1, 50)).toBeNull();
    const wide = runScript('repeat 999;repeat 999;1;end repeat;end repeat', 1, 50);
    expect(wide?.length).toBe(LIMITS.framesPerCursor);
  });
});

describe('Mousecape', () => {
  const cape = (cursor: string) =>
    bytes(`<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>CapeName</key><string>Cape &amp; Co</string>
  <key>Cursors</key><dict>${cursor}</dict>
</dict></plist>`);
  const png = Buffer.from(fakePng(64, 128)).toString('base64');
  const arrow = `<key>com.apple.coregraphics.Arrow</key><dict>
    <key>FrameCount</key><integer>2</integer><key>FrameDuration</key><real>0.05</real>
    <key>HotSpotX</key><real>4</real><key>HotSpotY</key><real>8</real>
    <key>PointsWide</key><real>32</real><key>PointsHigh</key><real>32</real>
    <key>Representations</key><array><data>${png}</data></array></dict>`;

  it('makes each cursor at every standard size, from its frames stacked top to bottom', async () => {
    const [result] = await convertCursors(single('x.cape', cape(arrow)), fakeDecoder());
    expect(result.name).toBe('Cape & Co');
    const [cursor] = result.cursors;
    expect(cursor.name).toBe('left_ptr');
    expect(cursor.frames).toHaveLength(12);
    expect(cursor.frames.find((f) => f.size === 32)).toMatchObject({ width: 32, height: 32, hotX: 4, hotY: 8, delay: 50 });
    expect(cursor.frames.find((f) => f.size === 64)).toMatchObject({ width: 64, height: 64, hotX: 8, hotY: 16 });
  });

  it('never expands entities, and refuses ones it doesn’t know', () => {
    const laughs = `<?xml version="1.0"?><!DOCTYPE plist [<!ENTITY a "aaaaaaaaaa"><!ENTITY b "&a;&a;&a;&a;">]>
<plist><string>&b;</string></plist>`;
    expect(() => parsePlist(laughs)).toThrow(DAMAGED);
    expect(parsePlist('<plist><string>&lt;&#65;&#x42;</string></plist>')).toBe('<AB');
  });

  it('refuses nesting past the limit', () => {
    const deep = '<plist>' + '<array>'.repeat(100) + '</array>'.repeat(100) + '</plist>';
    expect(() => parsePlist(deep)).toThrow(DAMAGED);
  });

  it('reads an uncompressed TIFF, and refuses one that points outside itself', async () => {
    const be16 = (n: number) => [(n >> 8) & 0xff, n & 0xff];
    const be32 = (n: number) => [(n >>> 24) & 0xff, (n >>> 16) & 0xff, (n >>> 8) & 0xff, n & 0xff];
    const tiff = (stripOffset: number, width = 1, height = 1) => {
      const tags: [number, number, number, number][] = [
        [256, 4, 1, width],
        [257, 4, 1, height],
        [259, 3, 1, 1],
        [273, 4, 1, stripOffset],
        [277, 3, 1, 4],
        [278, 4, 1, height],
        [279, 4, 1, 4],
        [338, 3, 1, 2],
      ];
      const ifd = [...be16(tags.length)];
      for (const [tag, type, count, value] of tags) {
        ifd.push(...be16(tag), ...be16(type), ...be32(count), ...(type === 3 ? [...be16(value), 0, 0] : be32(value)));
      }
      ifd.push(...be32(0));
      return new Uint8Array([0x4d, 0x4d, 0, 42, ...be32(8), ...ifd, 10, 20, 30, 255]);
    };
    const good = tiff(8 + 2 + 8 * 12 + 4);
    expect(await decodeTiff(good, new Budget())).toEqual({ width: 1, height: 1, pixels: new Uint8Array([30, 20, 10, 255]) });
    await expect(decodeTiff(tiff(1_000_000), new Budget())).rejects.toThrow(DAMAGED);
    await expect(decodeTiff(tiff(8, 100_000, 100_000), new Budget())).rejects.toThrow(TOO_BIG);
  });
});

describe('Hyprcursor', () => {
  it('draws SVG cursors at every standard size, with their overrides as links', async () => {
    const hlc = zip([
      { name: 'meta.hl', data: bytes('hotspot_x = 0.5\nhotspot_y = 0.25\ndefine_override = arrow\ndefine_size = 0, a.svg\ndefine_size = 0, b.svg\n') },
      { name: 'a.svg', data: bytes('<svg/>') },
      { name: 'b.svg', data: bytes('<svg/>') },
    ]);
    const decoder = fakeDecoder();
    const [result] = await convertCursors(
      {
        name: 'theme',
        entries: [
          { path: 'theme/manifest.hl', data: bytes('name = Hypr Test\ncursors_directory = hyprcursors\n') },
          { path: 'theme/hyprcursors/left_ptr.hlc', data: hlc },
        ],
      },
      decoder,
    );
    expect(result.name).toBe('Hypr Test');
    const [cursor] = result.cursors;
    expect(cursor.frames).toHaveLength(12);
    expect(cursor.frames.find((f) => f.size === 48)).toMatchObject({ width: 48, hotX: 24, hotY: 12, delay: 33 });
    expect(result.links).toContainEqual(['arrow', 'left_ptr']);
    expect(decoder.renderSvg).toHaveBeenCalledTimes(12);
  });

  it('keeps its cursors directory inside the theme', async () => {
    await expect(
      convertCursors(
        {
          name: 'theme',
          entries: [
            { path: 'manifest.hl', data: bytes('cursors_directory = ../../etc\n') },
            { path: 'etc/left_ptr.hlc', data: new Uint8Array() },
          ],
        },
        fakeDecoder(),
      ),
    ).rejects.toThrow(DAMAGED);
  });
});

describe('Windows', () => {
  it('reads a 1-bit .cur, its mask making transparency', async () => {
    // 2×2: top row white and transparent, bottom row black and inverting.
    const dib = [
      ...u32(40), ...u32(2), ...u32(4), ...u16(1), ...u16(1), ...u32(0), ...u32(0), ...u32(0), ...u32(0), ...u32(2), ...u32(0),
      0, 0, 0, 0, 255, 255, 255, 0, // palette: black, white
      0b01000000, 0, 0, 0, // bottom row colors: black, white
      0b10000000, 0, 0, 0, // top row colors: white, black
      0b01000000, 0, 0, 0, // bottom row mask: second masked
      0b01000000, 0, 0, 0, // top row mask: second masked
    ];
    const cur = new Uint8Array([...u16(0), ...u16(2), ...u16(1), 2, 2, 0, 0, ...u16(1), ...u16(1), ...u32(dib.length), ...u32(22), ...dib]);
    const [result] = await convertCursors(single('one.cur', cur), fakeDecoder());
    const [frame] = result.cursors[0].frames;
    expect(frame).toMatchObject({ width: 2, height: 2, hotX: 1, hotY: 1 });
    expect([...frame.pixels]).toEqual([255, 255, 255, 255, 0, 0, 0, 0, 0, 0, 0, 255, 0, 0, 0, 255]);
  });

  it('refuses an .ani nested past the limit', async () => {
    let list: number[] = [];
    for (let i = 0; i < 64; i++) list = [...bytes('LIST'), ...u32(list.length + 4), ...bytes('fram'), ...list];
    const ani = new Uint8Array([...bytes('RIFF'), ...u32(list.length + 4), ...bytes('ACON'), ...list]);
    await expect(convertCursors(single('deep.ani', ani), fakeDecoder())).rejects.toThrow(DAMAGED);
  });
});

describe('XCursor', () => {
  it('refuses an image chunk that points past the file', async () => {
    const file = new Uint8Array([...bytes('Xcur'), ...u32(16), ...u32(0x10000), ...u32(1), ...u32(0xfffd0002), ...u32(32), ...u32(1_000_000)]);
    await expect(
      convertCursors({ name: 't', entries: [{ path: 't/cursors/left_ptr', data: file }] }, fakeDecoder()),
    ).rejects.toThrow(DAMAGED);
  });
});
