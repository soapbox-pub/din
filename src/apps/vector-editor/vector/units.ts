import { UNIT_PT, type Blend, type Units } from './model';

/** Units and lists the Control bar and panels share. */

export const BLEND_OPTIONS: [Blend, string][] = [
  ['normal', 'Normal'],
  ['darken', 'Darken'],
  ['multiply', 'Multiply'],
  ['color-burn', 'Color Burn'],
  ['lighten', 'Lighten'],
  ['screen', 'Screen'],
  ['color-dodge', 'Color Dodge'],
  ['overlay', 'Overlay'],
  ['soft-light', 'Soft Light'],
  ['hard-light', 'Hard Light'],
  ['difference', 'Difference'],
  ['exclusion', 'Exclusion'],
  ['hue', 'Hue'],
  ['saturation', 'Saturation'],
  ['color', 'Color'],
  ['luminosity', 'Luminosity'],
];

export const STROKE_WEIGHTS = [0.25, 0.5, 0.75, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 20, 30, 40, 50, 60, 70, 80, 90, 100];

export function unitLabel(u: Units) {
  return u === 'pc' ? 'p' : u;
}

/** A length in points, shown in the document's units ("12.5 mm"). */
export function fmtLen(pt: number, units: Units): string {
  const v = pt / UNIT_PT[units];
  const k = units === 'in' ? 1000 : 100;
  return `${Math.round(v * k) / k} ${unitLabel(units)}`;
}
