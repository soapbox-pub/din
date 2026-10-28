import type { IconName } from './iconData';

export type Tool = IconName;
export type FillMode = 'outline' | 'both' | 'fill';

export const TOOLS: { id: Tool; name: string; key?: string; hint: string }[] = [
  { id: 'select', name: 'Select', key: 's', hint: 'Drag to select. Drag the selection to move it; Ctrl+drag leaves a copy behind.' },
  { id: 'eraser', name: 'Eraser', key: 'e', hint: 'Erases to the background color. Right-drag swaps only the foreground color.' },
  { id: 'fill', name: 'Fill With Color', key: 'k', hint: 'Fills an area. Pick a pattern down below for something wilder.' },
  { id: 'picker', name: 'Pick Color', key: 'i', hint: 'Click a color in the picture to paint with it.' },
  { id: 'magnifier', name: 'Magnifier', key: 'z', hint: 'Click to zoom in, right-click to zoom out.' },
  { id: 'pencil', name: 'Pencil', key: 'p', hint: 'Draws one pixel at a time. Perfect for sprites.' },
  { id: 'brush', name: 'Brush', key: 'b', hint: 'Paints with the brush shape chosen below.' },
  { id: 'airbrush', name: 'Airbrush', key: 'a', hint: 'Sprays paint. Hold still for more.' },
  { id: 'text', name: 'Text', key: 't', hint: 'Click where the words go, then type. Click outside to put them down.' },
  { id: 'line', name: 'Line', key: 'l', hint: 'Drag to draw a straight line. Shift keeps it level or at 45°.' },
  { id: 'curve', name: 'Curve', key: 'c', hint: 'Drag a line, then click or drag twice to bend it.' },
  { id: 'rect', name: 'Rectangle', key: 'r', hint: 'Drag to draw a rectangle. Shift makes a square.' },
  { id: 'polygon', name: 'Polygon', key: 'g', hint: 'Click corner after corner. Double-click, or click the first corner, to close it.' },
  { id: 'ellipse', name: 'Ellipse', key: 'o', hint: 'Drag to draw an ellipse. Shift makes a circle.' },
  { id: 'roundrect', name: 'Rounded Rectangle', key: 'u', hint: 'Drag to draw a rectangle with round corners.' },
  { id: 'wacky', name: 'Wacky Brush', key: 'w', hint: 'Brushes that do silly things. Pick one down below!' },
  { id: 'stamp', name: 'Stamps', key: 'm', hint: 'Click to stamp. Right-click stamps it facing the other way.' },
  { id: 'mixer', name: 'Mixer', key: 'x', hint: 'Shake up the picture (or just the selection). Pick a trick below.' },
  { id: 'dynamite', name: 'Dynamite', key: 'd', hint: 'Click the picture to blow it all away. Undo puts it back!' },
];
