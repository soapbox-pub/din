/** How big a tile is: the shape of its box and its width for a size. */
import { boxShape, DEFAULT_BOX_SHAPE } from './colors';
import type { TileContext, TileSize } from './GameGrid';

/** The shape of the tiles in a list: its system's box, or a common one where it mixes systems. */
export function tileShape(system: string | undefined, ctx: TileContext): number {
  return ctx.mixed || !system ? DEFAULT_BOX_SHAPE : boxShape(system);
}

/** A tile's width for its size and shape: wider for a wide box, so each box is about as big as a 3:4 one would be. */
export function tileWidth(size: TileSize, shape: number): number {
  return Math.round((size === 'lg' ? 200 : 148) * Math.sqrt(shape / DEFAULT_BOX_SHAPE));
}
