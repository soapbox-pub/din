import { VISUALIZATIONS } from '../visualizations';

/**
 * Din's visualizations, grouped the way WMP lists effects and their
 * presets ("Bars and Waves: Fire Storm"), with album art first.
 */
const GROUPS = [...new Set(VISUALIZATIONS.map((v) => v.group))];

export const WMP_EFFECTS = [
  { type: 'AlbumArt', title: 'Album Art', presets: ['Album Art'], ids: ['art'] },
  ...GROUPS.map((g) => {
    const vis = VISUALIZATIONS.filter((v) => v.group === g);
    return { type: g.replace(/\W/g, ''), title: g, presets: vis.map((v) => v.name), ids: vis.map((v) => v.id) };
  }),
];

/** The visualization (or 'art') for an effect and preset index. */
export function visForEffect(effect: number, preset: number): string {
  const e = WMP_EFFECTS[effect] ?? WMP_EFFECTS[1];
  return e.ids[preset] ?? e.ids[0];
}
