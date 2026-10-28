/**
 * The profile theme's web fonts, as ProfileThemeApplier loaded them, so
 * built-in apps can load them too (they're other documents).
 */
let fontFaces: { family: string; url: string }[] = [];

export function setThemeFontFaces(faces: { family: string; url: string }[]): void {
  fontFaces = faces;
}

export function themeFontFaces(): { family: string; url: string }[] {
  return fontFaces;
}
