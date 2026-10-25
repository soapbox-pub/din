import { Hand, PenTool, Pencil, Pipette, RotateCw, Type, ZoomIn } from 'lucide-react';
import {
  DirectSelectionIcon,
  EllipseIcon,
  FrameEllipseIcon,
  FramePolygonIcon,
  FrameRectIcon,
  FreeTransformIcon,
  GradientSwatchIcon,
  LineIcon,
  PolygonIcon,
  RectIcon,
  ScaleIcon,
  SelectionIcon,
  ShearIcon,
} from './icons';

/** InDesign's Tools panel: one column, related tools in flyouts, with InDesign's keys. */

export type ToolId =
  | 'select'
  | 'direct'
  | 'type'
  | 'line'
  | 'pen'
  | 'pencil'
  | 'frame-rect'
  | 'frame-ellipse'
  | 'frame-polygon'
  | 'rect'
  | 'ellipse'
  | 'polygon'
  | 'free'
  | 'rotate'
  | 'scale'
  | 'shear'
  | 'gradient'
  | 'eyedropper'
  | 'hand'
  | 'zoom';

export interface ToolInfo {
  id: ToolId;
  name: string;
  /** What the key reads as in tooltips; `code` is what's pressed. */
  key: string;
  code: string;
  shift?: boolean;
  icon: React.ComponentType<{ className?: string }>;
}

export const TOOL_GROUPS: ToolInfo[][] = [
  [{ id: 'select', name: 'Selection Tool', key: 'V', code: 'v', icon: SelectionIcon }],
  [{ id: 'direct', name: 'Direct Selection Tool', key: 'A', code: 'a', icon: DirectSelectionIcon }],
  [{ id: 'type', name: 'Type Tool', key: 'T', code: 't', icon: Type }],
  [{ id: 'line', name: 'Line Tool', key: '\\', code: '\\', icon: LineIcon }],
  [
    { id: 'pen', name: 'Pen Tool', key: 'P', code: 'p', icon: PenTool },
    { id: 'pencil', name: 'Pencil Tool', key: 'N', code: 'n', icon: Pencil },
  ],
  [
    { id: 'frame-rect', name: 'Rectangle Frame Tool', key: 'F', code: 'f', icon: FrameRectIcon },
    { id: 'frame-ellipse', name: 'Ellipse Frame Tool', key: '', code: '', icon: FrameEllipseIcon },
    { id: 'frame-polygon', name: 'Polygon Frame Tool', key: '', code: '', icon: FramePolygonIcon },
  ],
  [
    { id: 'rect', name: 'Rectangle Tool', key: 'M', code: 'm', icon: RectIcon },
    { id: 'ellipse', name: 'Ellipse Tool', key: 'L', code: 'l', icon: EllipseIcon },
    { id: 'polygon', name: 'Polygon Tool', key: '', code: '', icon: PolygonIcon },
  ],
  [
    { id: 'free', name: 'Free Transform Tool', key: 'E', code: 'e', icon: FreeTransformIcon },
    { id: 'rotate', name: 'Rotate Tool', key: 'R', code: 'r', icon: RotateCw },
    { id: 'scale', name: 'Scale Tool', key: 'S', code: 's', icon: ScaleIcon },
    { id: 'shear', name: 'Shear Tool', key: 'O', code: 'o', icon: ShearIcon },
  ],
  [{ id: 'gradient', name: 'Gradient Swatch Tool', key: 'G', code: 'g', icon: GradientSwatchIcon }],
  [{ id: 'eyedropper', name: 'Eyedropper Tool', key: 'I', code: 'i', icon: Pipette }],
  [{ id: 'hand', name: 'Hand Tool', key: 'H', code: 'h', icon: Hand }],
  [{ id: 'zoom', name: 'Zoom Tool', key: 'Z', code: 'z', icon: ZoomIn }],
];

export const TOOLS: ToolInfo[] = TOOL_GROUPS.flat();
export const toolInfo = (id: ToolId) => TOOLS.find((t) => t.id === id)!;
export const toolByCode = (code: string) => TOOLS.find((t) => t.code && t.code === code);

/** Tools that draw a shape by dragging. */
export const SHAPE_TOOLS = new Set<ToolId>(['frame-rect', 'frame-ellipse', 'frame-polygon', 'rect', 'ellipse', 'polygon', 'line']);
