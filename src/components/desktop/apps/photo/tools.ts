import {
  Brush,
  Circle,
  CircleDashed,
  Crop,
  Eraser,
  Hand,
  Lasso,
  LassoSelect,
  Move,
  PaintBucket,
  Pencil,
  Pipette,
  Square,
  SquareDashed,
  Stamp,
  Type,
  WandSparkles,
  ZoomIn,
} from 'lucide-react';
import { GradientIcon } from './icons';
import type { GradientKind } from './paint';
import type { SelectMode } from './selection';

export type ToolId =
  | 'move'
  | 'marquee'
  | 'ellipse-marquee'
  | 'lasso'
  | 'polygon-lasso'
  | 'wand'
  | 'crop'
  | 'eyedropper'
  | 'brush'
  | 'pencil'
  | 'clone'
  | 'eraser'
  | 'bucket'
  | 'gradient'
  | 'type'
  | 'rectangle'
  | 'ellipse'
  | 'hand'
  | 'zoom';

export interface ToolInfo {
  id: ToolId;
  name: string;
  key: string;
  icon: React.ComponentType<{ className?: string }>;
}

/** The toolbar, in groups: each slot shows its current tool; Shift+key cycles through it. */
export const TOOL_GROUPS: ToolInfo[][] = [
  [{ id: 'move', name: 'Move Tool', key: 'V', icon: Move }],
  [
    { id: 'marquee', name: 'Rectangular Marquee Tool', key: 'M', icon: SquareDashed },
    { id: 'ellipse-marquee', name: 'Elliptical Marquee Tool', key: 'M', icon: CircleDashed },
  ],
  [
    { id: 'lasso', name: 'Lasso Tool', key: 'L', icon: Lasso },
    { id: 'polygon-lasso', name: 'Polygonal Lasso Tool', key: 'L', icon: LassoSelect },
  ],
  [{ id: 'wand', name: 'Magic Wand Tool', key: 'W', icon: WandSparkles }],
  [{ id: 'crop', name: 'Crop Tool', key: 'C', icon: Crop }],
  [{ id: 'eyedropper', name: 'Eyedropper Tool', key: 'I', icon: Pipette }],
  [
    { id: 'brush', name: 'Brush Tool', key: 'B', icon: Brush },
    { id: 'pencil', name: 'Pencil Tool', key: 'B', icon: Pencil },
  ],
  [{ id: 'clone', name: 'Clone Stamp Tool', key: 'S', icon: Stamp }],
  [{ id: 'eraser', name: 'Eraser Tool', key: 'E', icon: Eraser }],
  [
    { id: 'gradient', name: 'Gradient Tool', key: 'G', icon: GradientIcon },
    { id: 'bucket', name: 'Paint Bucket Tool', key: 'G', icon: PaintBucket },
  ],
  [{ id: 'type', name: 'Horizontal Type Tool', key: 'T', icon: Type }],
  [
    { id: 'rectangle', name: 'Rectangle Tool', key: 'U', icon: Square },
    { id: 'ellipse', name: 'Ellipse Tool', key: 'U', icon: Circle },
  ],
  [{ id: 'hand', name: 'Hand Tool', key: 'H', icon: Hand }],
  [{ id: 'zoom', name: 'Zoom Tool', key: 'Z', icon: ZoomIn }],
];

export const TOOLS: ToolInfo[] = TOOL_GROUPS.flat();
export const toolInfo = (id: ToolId) => TOOLS.find((t) => t.id === id)!;

export const PAINTS = new Set<ToolId>(['brush', 'pencil', 'eraser', 'clone']);
export const SELECTS = new Set<ToolId>(['marquee', 'ellipse-marquee', 'lasso', 'polygon-lasso', 'wand']);

export interface BrushOptions {
  size: number;
  /** 0-100 */
  hardness: number;
  /** 0-100 */
  opacity: number;
  /** 0-100 */
  flow: number;
}

export interface ToolOptions {
  brush: BrushOptions;
  pencil: BrushOptions;
  eraser: BrushOptions;
  clone: BrushOptions & { aligned: boolean; sampleAll: boolean };
  selectMode: SelectMode;
  feather: number;
  wand: { tolerance: number; contiguous: boolean; sampleAll: boolean };
  bucket: { tolerance: number; contiguous: boolean; sampleAll: boolean; opacity: number };
  gradient: { kind: GradientKind; colors: 'fg-bg' | 'fg-transparent'; reverse: boolean; opacity: number };
  move: { autoSelect: boolean };
  crop: { deletePixels: boolean };
  type: { font: string; size: number; bold: boolean; italic: boolean; align: 'left' | 'center' | 'right' };
  eyedropper: { sampleAll: boolean };
}

export const DEFAULT_OPTIONS: ToolOptions = {
  brush: { size: 30, hardness: 0, opacity: 100, flow: 100 },
  pencil: { size: 1, hardness: 100, opacity: 100, flow: 100 },
  eraser: { size: 40, hardness: 0, opacity: 100, flow: 100 },
  clone: { size: 40, hardness: 0, opacity: 100, flow: 100, aligned: true, sampleAll: false },
  selectMode: 'replace',
  feather: 0,
  wand: { tolerance: 32, contiguous: true, sampleAll: false },
  bucket: { tolerance: 32, contiguous: true, sampleAll: false, opacity: 100 },
  gradient: { kind: 'linear', colors: 'fg-bg', reverse: false, opacity: 100 },
  move: { autoSelect: false },
  crop: { deletePixels: true },
  type: { font: 'Noto Sans', size: 48, bold: false, italic: false, align: 'left' },
  eyedropper: { sampleAll: true },
};

export const FONTS = ['Noto Sans', 'Noto Serif', 'Noto Sans Mono', 'DejaVu Sans', 'Inter Variable', 'Arial', 'Helvetica', 'Times New Roman', 'Georgia', 'Courier New', 'Verdana'];
