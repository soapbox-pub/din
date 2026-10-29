/**
 * Din Classic: a Winamp 2.x skin drawn from code, sheet by sheet, at the
 * classic layout's exact sprite positions. It's what Winamp mode wears
 * without a skin file, and it fills in the sheets old skins leave out.
 */

type Ctx = CanvasRenderingContext2D;

const PANEL_TOP = '#3a4150';
const PANEL_BOTTOM = '#232833';
const FACE = '#323946';
const HI = '#5b6678';
const LO = '#141820';
const LCD_BG = '#05080d';
const LCD_DOT = '#0f1722';
const LCD_TEXT = '#5fd3ff';
const LCD_DIM = '#1d4357';
const ACCENT = '#3d8bff';

/** A 3×5 pixel font in 5×6 cells (TEXT.BMP's grid). */
const GLYPHS: Record<string, string> = {
  A: '.#.#.#####.##.#',
  B: '##.#.###.#.###.',
  C: '.###..#..#...##',
  D: '##.#.##.##.###.',
  E: '####..##.#..###',
  F: '####..##.#..#..',
  G: '.###..#.##.#.##',
  H: '#.##.#####.##.#',
  I: '###.#..#..#.###',
  J: '..#..#..##.#.#.',
  K: '#.##.###.#.##.#',
  L: '#..#..#..#..###',
  M: '#.########.##.#',
  N: '##.#.##.##.##.#',
  O: '.#.#.##.##.#.#.',
  P: '##.#.###.#..#..',
  Q: '.#.#.##.###..##',
  R: '##.#.###.#.##.#',
  S: '.###...#...###.',
  T: '###.#..#..#..#.',
  U: '#.##.##.##.####',
  V: '#.##.##.##.#.#.',
  W: '#.##.########.#',
  X: '#.##.#.#.#.##.#',
  Y: '#.##.#.#..#..#.',
  Z: '###..#.#.#..###',
  '0': '####.##.##.####',
  '1': '.#.##..#..#.###',
  '2': '##...#.#.#..###',
  '3': '##...#.#...###.',
  '4': '#.##.####..#..#',
  '5': '####..##...###.',
  '6': '.###..####.####',
  '7': '###..#.#..#..#.',
  '8': '####.#####.####',
  '9': '####.####..###.',
  '"': '#.##.#.........',
  '@': '.#.#.#####...##',
  '…': '............#.#',
  '.': '.............#.',
  ':': '....#.....#....',
  '(': '.#.#..#..#...#.',
  ')': '.#...#..#..#.#.',
  '-': '......###......',
  "'": '.#..#..........',
  '!': '.#..#..#.....#.',
  '_': '............###',
  '+': '....#.###.#....',
  '\\': '#..#...#...#..#',
  '/': '..#..#.#.#..#..',
  '[': '##.#..#..#..##.',
  ']': '.##..#..#..#.##',
  '^': '.#.#.#.........',
  '&': '.#.#.#.#.#.#.##',
  '%': '#.#..#.#.#..#.#',
  ',': '..........#.#..',
  '=': '...###...###...',
  '$': '.####..#..####.',
  '#': '#.#####.#####.#',
  'Å': '.#....####.##.#',
  'Ö': '#.#.#.#.##.#.#.',
  'Ä': '#.#.#.#.#####.#',
  '?': '##...#.#.....#.',
  '*': '...#.#.#.#.#...',
};

/** Where TEXT.BMP keeps each character (row, column), as Winamp lays it out. */
const TEXT_LAYOUT: [string, number, number][] = [
  ...'ABCDEFGHIJKLMNOPQRSTUVWXYZ'.split('').map((c, i): [string, number, number] => [c, 0, i]),
  ['"', 0, 26], ['@', 0, 27],
  ...'0123456789'.split('').map((c, i): [string, number, number] => [c, 1, i]),
  ['…', 1, 10], ['.', 1, 11], [':', 1, 12], ['(', 1, 13], [')', 1, 14], ['-', 1, 15], ["'", 1, 16], ['!', 1, 17], ['_', 1, 18],
  ['+', 1, 19], ['\\', 1, 20], ['/', 1, 21], ['[', 1, 22], [']', 1, 23], ['^', 1, 24], ['&', 1, 25], ['%', 1, 26], [',', 1, 27],
  ['=', 1, 28], ['$', 1, 29], ['#', 1, 30], ['Å', 2, 0], ['Ö', 2, 1], ['Ä', 2, 2], ['?', 2, 3], ['*', 2, 4],
];

function glyph(ctx: Ctx, ch: string, x: number, y: number, color: string) {
  const g = GLYPHS[ch.toUpperCase()];
  if (!g) return;
  ctx.fillStyle = color;
  for (let i = 0; i < 15; i++) if (g[i] === '#') ctx.fillRect(x + (i % 3), y + Math.floor(i / 3), 1, 1);
}

/** Write with the pixel font (4px advance), for labels on the bitmaps. */
function tiny(ctx: Ctx, text: string, x: number, y: number, color: string) {
  [...text].forEach((ch, i) => glyph(ctx, ch, x + i * 4, y, color));
}

function sheet(w: number, h: number, fill = '#ff00ff'): [HTMLCanvasElement, Ctx] {
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  const ctx = c.getContext('2d')!;
  ctx.fillStyle = fill;
  ctx.fillRect(0, 0, w, h);
  ctx.imageSmoothingEnabled = false;
  return [c, ctx];
}

function bevel(ctx: Ctx, x: number, y: number, w: number, h: number, raised = true, face = FACE) {
  ctx.fillStyle = face;
  ctx.fillRect(x, y, w, h);
  ctx.fillStyle = raised ? HI : LO;
  ctx.fillRect(x, y, w, 1);
  ctx.fillRect(x, y, 1, h);
  ctx.fillStyle = raised ? LO : HI;
  ctx.fillRect(x, y + h - 1, w, 1);
  ctx.fillRect(x + w - 1, y, 1, h);
}

function gradient(ctx: Ctx, x: number, y: number, w: number, h: number, stops: string[]) {
  const g = ctx.createLinearGradient(0, y, 0, y + h);
  stops.forEach((s, i) => g.addColorStop(i / (stops.length - 1), s));
  ctx.fillStyle = g;
  ctx.fillRect(x, y, w, h);
}

function lcd(ctx: Ctx, x: number, y: number, w: number, h: number) {
  ctx.fillStyle = LO;
  ctx.fillRect(x - 1, y - 1, w + 2, h + 2);
  ctx.fillStyle = HI;
  ctx.fillRect(x - 1, y + h, w + 2, 1);
  ctx.fillRect(x + w, y - 1, 1, h + 2);
  ctx.fillStyle = LCD_BG;
  ctx.fillRect(x, y, w, h);
}

function titleBar(ctx: Ctx, x: number, y: number, w: number, active: boolean, label: string) {
  gradient(ctx, x, y, w, 14, active ? ['#4b5a74', '#2b3446'] : ['#363c48', '#262b34']);
  ctx.fillStyle = active ? '#6f7f9c' : '#454c5a';
  ctx.fillRect(x, y, w, 1);
  // Ridges either side of the title, as Winamp's grip lines.
  const tw = label.length * 4 + 8;
  const tx = x + Math.floor((w - tw) / 2);
  for (let ry = y + 4; ry <= y + 9; ry += 2) {
    ctx.fillStyle = active ? '#7d8cab' : '#4d5462';
    ctx.fillRect(x + 4, ry, tx - x - 6, 1);
    ctx.fillRect(tx + tw + 2, ry, x + w - (tx + tw) - 6, 1);
  }
  tiny(ctx, label, tx + 4, y + 5, active ? '#e8f0ff' : '#9aa3b4');
}

function smallButton(ctx: Ctx, x: number, y: number, pressed: boolean, draw: (cx: number, cy: number) => void) {
  bevel(ctx, x, y, 9, 9, !pressed, pressed ? '#262c36' : '#3b4352');
  draw(x + (pressed ? 1 : 0), y + (pressed ? 1 : 0));
}

const ICON = '#d8e2f2';

function drawTitlebar(): HTMLCanvasElement {
  const [c, ctx] = sheet(344, 87);
  titleBar(ctx, 27, 0, 275, true, 'DIN CLASSIC');
  titleBar(ctx, 27, 15, 275, false, 'DIN CLASSIC');
  titleBar(ctx, 27, 57, 275, true, 'DIN CLASSIC');
  titleBar(ctx, 27, 72, 275, false, 'DIN CLASSIC');
  for (const pressed of [false, true]) {
    const y = pressed ? 9 : 0;
    smallButton(ctx, 0, y, pressed, (x, yy) => {
      ctx.fillStyle = ICON;
      ctx.fillRect(x + 2, yy + 2, 4, 1);
      ctx.fillRect(x + 2, yy + 4, 4, 1);
    });
    smallButton(ctx, 9, y, pressed, (x, yy) => {
      ctx.fillStyle = ICON;
      ctx.fillRect(x + 2, yy + 5, 4, 2);
    });
    smallButton(ctx, 18, y, pressed, (x, yy) => {
      ctx.fillStyle = ICON;
      for (let i = 0; i < 5; i++) {
        ctx.fillRect(x + 2 + i, yy + 2 + i, 1, 1);
        ctx.fillRect(x + 6 - i, yy + 2 + i, 1, 1);
      }
    });
  }
  // Shade buttons (normal and in shade mode).
  for (const [x, y, pressed, up] of [[0, 18, false, false], [9, 18, true, false], [0, 27, false, true], [9, 27, true, true]] as const) {
    smallButton(ctx, x, y, pressed, (bx, by) => {
      ctx.fillStyle = ICON;
      ctx.fillRect(bx + 2, by + (up ? 5 : 2), 4, 1);
      ctx.fillRect(bx + 2, by + (up ? 2 : 5), 4, 2);
    });
  }
  // Clutter bar: O A I D V.
  for (const [x, disabled] of [[304, false], [312, true]] as const) {
    bevel(ctx, x, 0, 8, 43, true, '#2a303b');
    'OAIDV'.split('').forEach((ch, i) => glyph(ctx, ch, x + 3, 3 + [0, 8, 15, 22, 30][i] + 1, disabled ? '#4d5462' : '#a8b4c8'));
  }
  'OAIDV'.split('').forEach((ch, i) => {
    const x = 304 + i * 8;
    const y = [47, 55, 62, 69, 77][i];
    const h = i === 0 || i === 3 ? 8 : 7;
    ctx.fillStyle = '#1b2029';
    ctx.fillRect(x, y, 8, h);
    glyph(ctx, ch, x + 3, y + 1, ACCENT);
  });
  // Shade-mode backgrounds and the tiny position bar.
  for (const [y, active] of [[29, true], [42, false]] as const) {
    titleBar(ctx, 27, y, 275, active, '');
    lcd(ctx, 27 + 79, y + 4, 38, 6);
    lcd(ctx, 27 + 125, y + 4, 25, 6);
  }
  lcd(ctx, 0, 36, 17, 7);
  for (const x of [17, 20, 23]) {
    ctx.fillStyle = x === 20 ? '#c9d6ea' : '#8f9cb2';
    ctx.fillRect(x, 36, 3, 7);
  }
  return c;
}

function drawMain(): HTMLCanvasElement {
  const [c, ctx] = sheet(275, 116);
  gradient(ctx, 0, 0, 275, 116, [PANEL_TOP, PANEL_BOTTOM]);
  ctx.fillStyle = '#4a5466';
  ctx.fillRect(0, 0, 275, 1);
  ctx.fillRect(0, 0, 1, 116);
  ctx.fillStyle = '#12161d';
  ctx.fillRect(0, 115, 275, 1);
  ctx.fillRect(274, 0, 1, 116);
  // The display: timer and visualizer on the left, info on the right.
  lcd(ctx, 9, 21, 96, 43);
  for (let y = 43; y < 59; y += 2) for (let x = 24; x < 100; x += 2) {
    ctx.fillStyle = LCD_DOT;
    ctx.fillRect(x, y, 1, 1);
  }
  lcd(ctx, 109, 23, 158, 10);
  lcd(ctx, 109, 41, 20, 10);
  lcd(ctx, 153, 41, 15, 10);
  tiny(ctx, 'KBPS', 131, 43, '#8c97aa');
  tiny(ctx, 'KHZ', 170, 43, '#8c97aa');
  // Grooves under the sliders.
  lcd(ctx, 16, 72, 248, 10);
  // A little Din logo where Winamp's lightning bolt sat.
  ctx.fillStyle = ACCENT;
  ctx.beginPath();
  ctx.arc(259.5, 98.5, 6, 0, Math.PI * 2);
  ctx.fill();
  ctx.fillStyle = '#e8f0ff';
  ctx.beginPath();
  ctx.moveTo(257, 95);
  ctx.lineTo(263, 98.5);
  ctx.lineTo(257, 102);
  ctx.fill();
  return c;
}

function transportGlyph(ctx: Ctx, kind: number, x: number, y: number) {
  ctx.fillStyle = ICON;
  const cx = x + 11;
  const cy = y + 9;
  const tri = (tx: number, dir = 1, h = 4) => {
    for (let i = 0; i <= h; i++) ctx.fillRect(dir > 0 ? tx + i : tx - i, cy - (h - i), 1, (h - i) * 2 + 1);
  };
  if (kind === 0) {
    ctx.fillRect(cx - 5, cy - 4, 2, 9);
    tri(cx + 3, -1);
    tri(cx + 7, -1);
  } else if (kind === 1) tri(cx - 2, 1, 5);
  else if (kind === 2) {
    ctx.fillRect(cx - 4, cy - 4, 3, 9);
    ctx.fillRect(cx + 1, cy - 4, 3, 9);
  } else if (kind === 3) ctx.fillRect(cx - 4, cy - 4, 8, 8);
  else if (kind === 4) {
    tri(cx - 6);
    tri(cx - 2);
    ctx.fillRect(cx + 3, cy - 4, 2, 9);
  }
}

function drawCbuttons(): HTMLCanvasElement {
  const [c, ctx] = sheet(136, 36);
  for (let i = 0; i < 5; i++) {
    for (const pressed of [false, true]) {
      const x = i * 23;
      const y = pressed ? 18 : 0;
      const w = i === 4 ? 22 : 23;
      bevel(ctx, x, y, w, 18, !pressed, pressed ? '#232934' : '#3b4352');
      transportGlyph(ctx, i, x + (pressed ? 1 : 0) - (i === 4 ? 1 : 0), y + (pressed ? 1 : 0));
    }
  }
  for (const pressed of [false, true]) {
    const y = pressed ? 16 : 0;
    bevel(ctx, 114, y, 22, 16, !pressed, pressed ? '#232934' : '#3b4352');
    ctx.fillStyle = ICON;
    // Eject: a triangle over a bar.
    for (let i = 0; i < 4; i++) ctx.fillRect(125 - i, y + 4 + i, 1 + i * 2, 1);
    ctx.fillRect(121, y + 10, 9, 2);
  }
  return c;
}

function led(ctx: Ctx, x: number, y: number, on: boolean) {
  ctx.fillStyle = on ? '#7cc4ff' : '#1a2230';
  ctx.fillRect(x, y, 3, 3);
  if (on) {
    ctx.fillStyle = '#d6efff';
    ctx.fillRect(x + 1, y + 1, 1, 1);
  }
}

function drawShufrep(): HTMLCanvasElement {
  const [c, ctx] = sheet(92, 85);
  for (let row = 0; row < 4; row++) {
    const y = row * 15;
    const pressed = row % 2 === 1;
    const on = row >= 2;
    bevel(ctx, 0, y, 28, 15, !pressed, pressed ? '#232934' : '#3b4352');
    led(ctx, 4, y + 6, on);
    tiny(ctx, 'REP', 10, y + 5, on ? '#e8f0ff' : '#a8b4c8');
    bevel(ctx, 28, y, 47, 15, !pressed, pressed ? '#232934' : '#3b4352');
    led(ctx, 32, y + 6, on);
    tiny(ctx, 'SHUFFLE', 38, y + 5, on ? '#e8f0ff' : '#a8b4c8');
  }
  // EQ and PL toggles: [normal, selected] at y 61/73; depressed copies at +46.
  for (const [x0, label] of [[0, 'EQ'], [23, 'PL']] as const) {
    for (const [dx, pressed] of [[0, false], [46, true]] as const) {
      for (const [y, on] of [[61, false], [73, true]] as const) {
        bevel(ctx, x0 + dx, y, 23, 12, !pressed, pressed ? '#232934' : '#3b4352');
        led(ctx, x0 + dx + 4, y + 5, on);
        tiny(ctx, label, x0 + dx + 10, y + 4, on ? '#e8f0ff' : '#a8b4c8');
      }
    }
  }
  return c;
}

function drawText(): HTMLCanvasElement {
  const [c, ctx] = sheet(155, 18, LCD_BG);
  for (const [ch, row, col] of TEXT_LAYOUT) glyph(ctx, ch, col * 5 + 1, row * 6, LCD_TEXT);
  return c;
}

/** Seven-segment digit in a 9×13 cell. */
function digit(ctx: Ctx, d: number, x: number, y: number) {
  const SEG = ['abcdef', 'bc', 'abged', 'abgcd', 'fgbc', 'afgcd', 'afgedc', 'abc', 'abcdefg', 'abcdfg'][d];
  const on = (s: string) => SEG.includes(s);
  const paint = (s: string, rx: number, ry: number, w: number, h: number) => {
    ctx.fillStyle = on(s) ? LCD_TEXT : LCD_DIM;
    ctx.fillRect(x + rx, y + ry, w, h);
  };
  paint('a', 2, 0, 5, 1);
  paint('f', 1, 1, 1, 5);
  paint('b', 7, 1, 1, 5);
  paint('g', 2, 6, 5, 1);
  paint('e', 1, 7, 1, 5);
  paint('c', 7, 7, 1, 5);
  paint('d', 2, 12, 5, 1);
}

function drawNumbers(): HTMLCanvasElement {
  const [c, ctx] = sheet(99, 13, LCD_BG);
  for (let d = 0; d < 10; d++) digit(ctx, d, d * 9, 0);
  // NO_MINUS_SIGN (9,6) and MINUS_SIGN (20,6) fall inside digits 1 and 2.
  ctx.fillStyle = LCD_BG;
  ctx.fillRect(9, 6, 5, 1);
  ctx.fillStyle = LCD_TEXT;
  ctx.fillRect(20, 6, 5, 1);
  return c;
}

function sliderFrames(width: number, x0: number, frameColor: (i: number) => string): HTMLCanvasElement {
  const [c, ctx] = sheet(x0 + width, 433, '#000000');
  for (let i = 0; i < 28; i++) {
    const y = i * 15;
    ctx.fillStyle = LO;
    ctx.fillRect(x0, y, width, 13);
    ctx.fillStyle = '#0b0e13';
    ctx.fillRect(x0 + 1, y + 1, width - 2, 11);
    ctx.fillStyle = frameColor(i);
    ctx.fillRect(x0 + 2, y + 5, width - 4, 3);
  }
  for (const [x, active] of [[15, false], [0, true]] as const) {
    bevel(ctx, x, 422, 14, 11, true, active ? '#56637a' : '#46505f');
    ctx.fillStyle = active ? '#c9d6ea' : '#9aa6ba';
    for (const gx of [4, 6, 8]) ctx.fillRect(x + gx, 425, 1, 5);
  }
  return c;
}

function drawMonoster(): HTMLCanvasElement {
  const [c, ctx] = sheet(56, 24, LCD_BG);
  tiny(ctx, 'STEREO', 3, 3, LCD_TEXT);
  tiny(ctx, 'STEREO', 3, 15, LCD_DIM);
  tiny(ctx, 'MONO', 34, 3, LCD_TEXT);
  tiny(ctx, 'MONO', 34, 15, LCD_DIM);
  return c;
}

function drawPlaypaus(): HTMLCanvasElement {
  const [c, ctx] = sheet(42, 9, LCD_BG);
  ctx.fillStyle = LCD_TEXT;
  for (let i = 0; i < 4; i++) ctx.fillRect(3 + i, 1 + i, 1, 7 - i * 2);
  ctx.fillRect(11, 1, 2, 7);
  ctx.fillRect(14, 1, 2, 7);
  ctx.fillRect(20, 2, 5, 5);
  ctx.fillStyle = '#c03030';
  ctx.fillRect(36, 0, 3, 9);
  ctx.fillStyle = '#30c050';
  ctx.fillRect(39, 0, 3, 9);
  return c;
}

function drawPosbar(): HTMLCanvasElement {
  const [c, ctx] = sheet(307, 10, LCD_BG);
  ctx.fillStyle = '#121822';
  ctx.fillRect(0, 4, 248, 2);
  bevel(ctx, 248, 0, 29, 10, true, '#4a5568');
  bevel(ctx, 278, 0, 29, 10, true, '#5d6d88');
  for (const x of [248, 278]) {
    ctx.fillStyle = '#c9d6ea';
    for (const gx of [11, 14, 17]) ctx.fillRect(x + gx, 3, 1, 4);
  }
  return c;
}

function drawEqmain(): HTMLCanvasElement {
  const [c, ctx] = sheet(275, 315);
  // Window.
  gradient(ctx, 0, 0, 275, 116, [PANEL_TOP, PANEL_BOTTOM]);
  ctx.fillStyle = '#12161d';
  ctx.fillRect(0, 115, 275, 1);
  ctx.fillRect(274, 0, 1, 116);
  tiny(ctx, '+12DB', 46, 37, '#8c97aa');
  tiny(ctx, '+0DB', 48, 65, '#8c97aa');
  tiny(ctx, '-12DB', 46, 96, '#8c97aa');
  tiny(ctx, 'PREAMP', 14, 106, '#8c97aa');
  ['60', '170', '310', '600', '1K', '3K', '6K', '12K', '14K', '16K'].forEach((l, i) => tiny(ctx, l, 78 + i * 18 + Math.floor((14 - l.length * 4) / 2), 106, '#8c97aa'));
  lcd(ctx, 86, 17, 113, 19);
  // Title bars and close buttons.
  titleBar(ctx, 0, 134, 275, true, 'EQUALIZER');
  titleBar(ctx, 0, 149, 275, false, 'EQUALIZER');
  for (const [y, pressed] of [[116, false], [125, true]] as const) {
    smallButton(ctx, 0, y, pressed, (x, yy) => {
      ctx.fillStyle = ICON;
      for (let i = 0; i < 5; i++) {
        ctx.fillRect(x + 2 + i, yy + 2 + i, 1, 1);
        ctx.fillRect(x + 6 - i, yy + 2 + i, 1, 1);
      }
    });
  }
  // ON and AUTO: off, on, and pressed of each.
  const toggle = (x: number, w: number, label: string, on: boolean, pressed: boolean) => {
    bevel(ctx, x, 119, w, 12, !pressed, pressed ? '#232934' : '#3b4352');
    led(ctx, x + 4, 123, on);
    tiny(ctx, label, x + 10, 122, on ? '#e8f0ff' : '#a8b4c8');
  };
  toggle(10, 26, 'ON', false, false);
  toggle(36, 32, 'AUTO', false, false);
  toggle(69, 26, 'ON', true, false);
  toggle(95, 32, 'AUTO', true, false);
  toggle(128, 26, 'ON', false, true);
  toggle(154, 32, 'AUTO', false, true);
  toggle(187, 26, 'ON', true, true);
  toggle(213, 32, 'AUTO', true, true);
  // Slider frames: 28 fills from empty to full, 14 to a row.
  for (let i = 0; i < 28; i++) {
    const x = 13 + (i % 14) * 15;
    const y = 164 + Math.floor(i / 14) * 65;
    ctx.fillStyle = '#0b0e13';
    ctx.fillRect(x, y, 14, 63);
    ctx.fillStyle = LO;
    ctx.fillRect(x + 5, y + 2, 4, 59);
    const fill = Math.round((i / 27) * 57);
    const hue = 200 - (i / 27) * 160;
    ctx.fillStyle = `hsl(${hue} 80% 55%)`;
    ctx.fillRect(x + 6, y + 60 - fill, 2, fill);
  }
  for (const [y, active] of [[164, false], [176, true]] as const) {
    bevel(ctx, 0, y, 11, 11, true, active ? '#56637a' : '#46505f');
    ctx.fillStyle = active ? '#c9d6ea' : '#9aa6ba';
    ctx.fillRect(3, y + 5, 5, 1);
  }
  for (const [y, pressed] of [[164, false], [176, true]] as const) {
    bevel(ctx, 224, y, 44, 12, !pressed, pressed ? '#232934' : '#3b4352');
    tiny(ctx, 'PRESETS', 232, y + 4, '#d8e2f2');
  }
  // Graph background, line colors, preamp line.
  ctx.fillStyle = LCD_BG;
  ctx.fillRect(0, 294, 113, 19);
  ctx.fillStyle = LCD_DIM;
  ctx.fillRect(0, 303, 113, 1);
  for (let i = 0; i < 19; i++) {
    ctx.fillStyle = `hsl(${(i / 18) * 200} 85% 58%)`;
    ctx.fillRect(115, 294 + i, 1, 1);
  }
  ctx.fillStyle = '#8f9cb2';
  ctx.fillRect(0, 314, 113, 1);
  return c;
}

function drawPledit(): HTMLCanvasElement {
  const [c, ctx] = sheet(280, 186);
  const frame = (x: number, y: number, w: number, h: number, active: boolean) => gradient(ctx, x, y, w, h, active ? ['#4b5a74', '#2b3446'] : ['#363c48', '#262b34']);
  for (const [y, active] of [[0, true], [21, false]] as const) {
    frame(0, y, 25, 20, active);
    frame(26, y, 100, 20, active);
    tiny(ctx, 'PLAYLIST', 26 + 34, y + 7, active ? '#e8f0ff' : '#9aa3b4');
    frame(127, y, 25, 20, active);
    frame(153, y, 25, 20, active);
    for (const x of [0, 127, 153]) {
      ctx.fillStyle = active ? '#7d8cab' : '#4d5462';
      for (let ry = y + 6; ry <= y + 11; ry += 2) ctx.fillRect(x + 2, ry, 21, 1);
    }
  }
  // Close/shade on the top-right corners.
  for (const y of [0, 21]) {
    smallButton(ctx, 153 + 14, y + 3, false, (x, yy) => {
      ctx.fillStyle = ICON;
      for (let i = 0; i < 5; i++) {
        ctx.fillRect(x + 2 + i, yy + 2 + i, 1, 1);
        ctx.fillRect(x + 6 - i, yy + 2 + i, 1, 1);
      }
    });
    smallButton(ctx, 153 + 4, y + 3, false, (x, yy) => {
      ctx.fillStyle = ICON;
      ctx.fillRect(x + 2, yy + 2, 4, 1);
      ctx.fillRect(x + 2, yy + 4, 4, 2);
    });
  }
  // Sides: left 12, right 20 with the scrollbar groove.
  gradient(ctx, 0, 42, 12, 29, ['#2d3441', '#2d3441']);
  ctx.fillStyle = HI;
  ctx.fillRect(0, 42, 1, 29);
  gradient(ctx, 31, 42, 20, 29, ['#2d3441', '#2d3441']);
  ctx.fillStyle = '#12161d';
  ctx.fillRect(36, 42, 8, 29);
  // Scroll handles.
  bevel(ctx, 52, 53, 8, 18, true, '#4a5568');
  bevel(ctx, 61, 53, 8, 18, true, '#5d6d88');
  // Pressed close/collapse/expand.
  for (const x of [52, 62, 150]) smallButton(ctx, x, 42, true, () => {});
  // Shade backgrounds.
  for (const [x, y, w] of [[72, 42, 25], [72, 57, 25], [99, 42, 50], [99, 57, 50]] as const) frame(x, y, w, 14, y === 42);
  // Bottom pieces.
  gradient(ctx, 0, 72, 125, 38, [PANEL_TOP, PANEL_BOTTOM]);
  gradient(ctx, 126, 72, 150, 38, [PANEL_TOP, PANEL_BOTTOM]);
  gradient(ctx, 179, 0, 25, 38, [PANEL_TOP, PANEL_BOTTOM]);
  gradient(ctx, 205, 0, 75, 38, [PANEL_TOP, PANEL_BOTTOM]);
  lcd(ctx, 207, 12, 72, 16);
  for (const [x, label] of [[14, 'ADD'], [43, 'REM'], [72, 'SEL'], [101, 'MISC']] as const) {
    bevel(ctx, x, 72 + 8, 22, 18, true, '#3b4352');
    tiny(ctx, label, x + Math.floor((22 - label.length * 4) / 2) + 1, 72 + 15, '#d8e2f2');
  }
  bevel(ctx, 126 + 104, 72 + 8, 22, 18, true, '#3b4352');
  tiny(ctx, 'LIST', 126 + 104 + 3, 72 + 15, '#d8e2f2');
  lcd(ctx, 126 + 7, 72 + 10, 60, 7);
  lcd(ctx, 126 + 66, 72 + 23, 30, 7);
  // Bottom-right mini transport.
  ctx.fillStyle = ICON;
  [3, 11, 20, 28, 37, 47].forEach((x, i) => {
    const bx = 126 + x;
    const by = 72 + 23;
    if (i === 1) for (let k = 0; k < 3; k++) ctx.fillRect(bx + 2 + k, by + 1 + k, 1, 6 - k * 2 + 0);
    else if (i === 2) {
      ctx.fillRect(bx + 2, by + 1, 2, 6);
      ctx.fillRect(bx + 5, by + 1, 2, 6);
    } else if (i === 3) ctx.fillRect(bx + 2, by + 2, 5, 5);
    else if (i === 5) ctx.fillRect(bx + 1, by + 5, 7, 2);
    else ctx.fillRect(bx + 2, by + 2, 2, 5);
  });
  // Menu buttons (normal and selected), 22×18.
  const items: [number, number, string][] = [
    [0, 111, 'URL'], [0, 130, 'DIR'], [0, 149, 'FILE'],
    [54, 111, 'ALL'], [54, 130, 'CROP'], [54, 149, 'SEL'], [54, 168, 'MISC'],
    [104, 111, 'INV'], [104, 130, 'NONE'], [104, 149, 'ALL'],
    [154, 111, 'SORT'], [154, 130, 'INFO'], [154, 149, 'OPTS'],
    [204, 111, 'NEW'], [204, 130, 'SAVE'], [204, 149, 'LOAD'],
  ];
  for (const [x, y, label] of items) {
    for (const [dx, sel] of [[0, false], [23, true]] as const) {
      bevel(ctx, x + dx, y, 22, 18, true, sel ? '#4f6a96' : '#3b4352');
      tiny(ctx, label, x + dx + Math.floor((22 - label.length * 4) / 2) + 1, y + 7, sel ? '#ffffff' : '#c8d2e2');
    }
  }
  for (const [x, h] of [[48, 54], [100, 72], [150, 54], [200, 54], [250, 54]] as const) {
    ctx.fillStyle = ACCENT;
    ctx.fillRect(x, 111, 3, h);
  }
  return c;
}

let cached: Partial<Record<string, HTMLCanvasElement>> | null = null;

/** Every sheet of Din Classic, drawn once. */
export function makeDefaultSheets(): Partial<Record<string, HTMLCanvasElement>> {
  cached ??= {
    main: drawMain(),
    titlebar: drawTitlebar(),
    cbuttons: drawCbuttons(),
    shufrep: drawShufrep(),
    text: drawText(),
    numbers: drawNumbers(),
    volume: sliderFrames(68, 0, (i) => `hsl(${140 - (i / 27) * 140} 75% 50%)`),
    balance: sliderFrames(38, 9, (i) => `hsl(${140 - (i / 27) * 140} 75% 50%)`),
    monoster: drawMonoster(),
    playpaus: drawPlaypaus(),
    posbar: drawPosbar(),
    eqmain: drawEqmain(),
    pledit: drawPledit(),
  };
  return cached;
}

/** Playlist colors that suit Din Classic. */
export const DIN_CLASSIC_PLAYLIST = {
  normal: '#8fd8ff',
  current: '#ffffff',
  normalBg: '#05080d',
  selectedBg: '#1d3b66',
  font: 'Arial',
};
