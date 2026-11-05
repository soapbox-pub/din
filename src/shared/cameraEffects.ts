/**
 * Camera's effects (src/apps/camera), shared with `din camera`: each one's
 * id, its name, and the number its shader knows it by. They come in pages
 * of nine, Normal in the middle of each, as the effects grid shows them.
 */

export interface CameraEffect {
  id: string;
  name: string;
  /** The shader's number for it (src/apps/camera/renderer.ts). */
  code: number;
}

const NORMAL: CameraEffect = { id: 'normal', name: 'Normal', code: 0 };

export const EFFECT_PAGES: readonly (readonly CameraEffect[])[] = [
  [
    { id: 'sepia', name: 'Sepia', code: 1 },
    { id: 'mono', name: 'Black & White', code: 2 },
    { id: 'glow', name: 'Glow', code: 3 },
    { id: 'comic', name: 'Comic', code: 4 },
    NORMAL,
    { id: 'vintage', name: 'Vintage', code: 5 },
    { id: 'thermal', name: 'Thermal', code: 6 },
    { id: 'x-ray', name: 'X-Ray', code: 7 },
    { id: 'pop-art', name: 'Pop Art', code: 8 },
  ],
  [
    { id: 'bulge', name: 'Bulge', code: 10 },
    { id: 'pinch', name: 'Pinch', code: 11 },
    { id: 'twirl', name: 'Twirl', code: 12 },
    { id: 'squeeze', name: 'Squeeze', code: 13 },
    NORMAL,
    { id: 'mirror', name: 'Mirror', code: 14 },
    { id: 'tunnel', name: 'Light Tunnel', code: 15 },
    { id: 'fisheye', name: 'Fish Eye', code: 16 },
    { id: 'stretch', name: 'Stretch', code: 17 },
  ],
  [
    { id: 'kaleidoscope', name: 'Kaleidoscope', code: 20 },
    { id: 'pixels', name: 'Pixels', code: 21 },
    { id: 'neon', name: 'Neon', code: 22 },
    { id: 'duotone', name: 'Duotone', code: 23 },
    NORMAL,
    { id: 'halftone', name: 'Halftone', code: 24 },
    { id: 'ripple', name: 'Ripple', code: 25 },
    { id: 'sketch', name: 'Sketch', code: 26 },
    { id: 'psychedelic', name: 'Psychedelic', code: 27 },
  ],
];

/** Every effect once, Normal first. */
export const EFFECTS: readonly CameraEffect[] = [NORMAL, ...EFFECT_PAGES.flat().filter((e) => e !== NORMAL)];

/** Effects that bend the picture around a point the user can move by dragging. */
export const CENTERED_EFFECTS: ReadonlySet<string> = new Set(['bulge', 'pinch', 'twirl', 'squeeze', 'mirror', 'tunnel', 'fisheye', 'stretch', 'kaleidoscope', 'ripple']);

export function effectById(id: string | null | undefined): CameraEffect {
  return EFFECTS.find((e) => e.id === id) ?? NORMAL;
}

/** The page an effect is on (Normal's is the first). */
export function pageOf(id: string): number {
  const page = EFFECT_PAGES.findIndex((p) => p.some((e) => e.id === id));
  return page < 0 ? 0 : page;
}

/** Where Camera keeps what it takes, under home. */
export const CAMERA_FOLDER = 'Pictures/Camera';

/** What Camera saves: photos (and four-up sheets) as JPEG, videos as WebM. */
export function cameraItemKind(name: string): 'photo' | 'video' | null {
  if (name.startsWith('.')) return null;
  if (/\.(jpe?g|png|webp)$/i.test(name)) return 'photo';
  if (/\.(webm|mp4|mov|mkv)$/i.test(name)) return 'video';
  return null;
}
