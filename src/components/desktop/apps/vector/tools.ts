import { Brush, Hand, Pencil, Pentagon, Pipette, RotateCw, Scaling, Scissors, Square, Star, Type, ZoomIn } from 'lucide-react';
import {
  AddAnchorIcon,
  AnchorPointIcon,
  ArtboardIcon,
  DeleteAnchorIcon,
  DirectSelectionIcon,
  EllipseIcon,
  FreeTransformIcon,
  GradientToolIcon,
  GroupSelectionIcon,
  LineIcon,
  PenIcon,
  ReflectIcon,
  RoundedRectIcon,
  SelectionIcon,
  ShearIcon,
} from './icons';

/** Illustrator's tools, with its letters, grouped as its toolbar groups them. */

export type ToolId =
  | 'selection'
  | 'direct'
  | 'group-select'
  | 'pen'
  | 'add-anchor'
  | 'delete-anchor'
  | 'anchor'
  | 'type'
  | 'line'
  | 'rectangle'
  | 'rounded-rectangle'
  | 'ellipse'
  | 'polygon'
  | 'star'
  | 'paintbrush'
  | 'pencil'
  | 'scissors'
  | 'rotate'
  | 'reflect'
  | 'scale'
  | 'shear'
  | 'free-transform'
  | 'gradient'
  | 'eyedropper'
  | 'artboard'
  | 'hand'
  | 'zoom';

export interface ToolInfo {
  id: ToolId;
  name: string;
  /** Shortcut as Illustrator shows it, e.g. "Shift+C". */
  key: string;
  icon: React.ComponentType<{ className?: string }>;
}

export const TOOL_GROUPS: ToolInfo[][] = [
  [{ id: 'selection', name: 'Selection Tool', key: 'V', icon: SelectionIcon }],
  [
    { id: 'direct', name: 'Direct Selection Tool', key: 'A', icon: DirectSelectionIcon },
    { id: 'group-select', name: 'Group Selection Tool', key: '', icon: GroupSelectionIcon },
  ],
  [
    { id: 'pen', name: 'Pen Tool', key: 'P', icon: PenIcon },
    { id: 'add-anchor', name: 'Add Anchor Point Tool', key: '+', icon: AddAnchorIcon },
    { id: 'delete-anchor', name: 'Delete Anchor Point Tool', key: '-', icon: DeleteAnchorIcon },
    { id: 'anchor', name: 'Anchor Point Tool', key: 'Shift+C', icon: AnchorPointIcon },
  ],
  [{ id: 'type', name: 'Type Tool', key: 'T', icon: Type }],
  [{ id: 'line', name: 'Line Segment Tool', key: '\\', icon: LineIcon }],
  [
    { id: 'rectangle', name: 'Rectangle Tool', key: 'M', icon: Square },
    { id: 'rounded-rectangle', name: 'Rounded Rectangle Tool', key: '', icon: RoundedRectIcon },
    { id: 'ellipse', name: 'Ellipse Tool', key: 'L', icon: EllipseIcon },
    { id: 'polygon', name: 'Polygon Tool', key: '', icon: Pentagon },
    { id: 'star', name: 'Star Tool', key: '', icon: Star },
  ],
  [
    { id: 'paintbrush', name: 'Paintbrush Tool', key: 'B', icon: Brush },
    { id: 'pencil', name: 'Pencil Tool', key: 'N', icon: Pencil },
  ],
  [{ id: 'scissors', name: 'Scissors Tool', key: 'C', icon: Scissors }],
  [
    { id: 'rotate', name: 'Rotate Tool', key: 'R', icon: RotateCw },
    { id: 'reflect', name: 'Reflect Tool', key: 'O', icon: ReflectIcon },
  ],
  [
    { id: 'scale', name: 'Scale Tool', key: 'S', icon: Scaling },
    { id: 'shear', name: 'Shear Tool', key: '', icon: ShearIcon },
  ],
  [{ id: 'free-transform', name: 'Free Transform Tool', key: 'E', icon: FreeTransformIcon }],
  [{ id: 'gradient', name: 'Gradient Tool', key: 'G', icon: GradientToolIcon }],
  [{ id: 'eyedropper', name: 'Eyedropper Tool', key: 'I', icon: Pipette }],
  [{ id: 'artboard', name: 'Artboard Tool', key: 'Shift+O', icon: ArtboardIcon }],
  [{ id: 'hand', name: 'Hand Tool', key: 'H', icon: Hand }],
  [{ id: 'zoom', name: 'Zoom Tool', key: 'Z', icon: ZoomIn }],
];

export const TOOLS: ToolInfo[] = TOOL_GROUPS.flat();

export const toolInfo = (id: ToolId) => TOOLS.find((t) => t.id === id)!;

export const groupOf = (id: ToolId) => TOOL_GROUPS.findIndex((g) => g.some((t) => t.id === id));

/** Shape tools draw by dragging a box. */
export const SHAPES = new Set<ToolId>(['rectangle', 'rounded-rectangle', 'ellipse', 'polygon', 'star', 'line']);

export interface ShapeOptions {
  /** Rounded rectangles' corner radius, points. */
  radius: number;
  sides: number;
  points: number;
  /** Star: inner radius as a fraction of the outer. */
  inner: number;
}

export const DEFAULT_SHAPE: ShapeOptions = { radius: 12, sides: 6, points: 5, inner: 0.5 };
