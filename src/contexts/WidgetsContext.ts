import { createContext, useContext } from 'react';
import type { PermissionDomain, PlacedWidget, WidgetSize, WidgetSource } from '@/lib/widgets';

export interface WidgetsContextValue {
  /** The widgets on the desktop, oldest first. */
  widgets: PlacedWidget[];
  /** Put a widget on the desktop, in the first free spot. */
  add(source: WidgetSource, options?: { size?: WidgetSize; denied?: PermissionDomain[] }): void;
  /** Take one off, with what that copy kept. */
  remove(id: string): void;
  move(id: string, monitor: string, x: number, y: number): void;
  resize(id: string, size: WidgetSize): void;
  /** Turn a copy's permissions off (or back on); it reloads with the new set. */
  setDenied(id: string, denied: PermissionDomain[]): void;
  /** Arranging widgets: dragged by anywhere, with Remove buttons, and their pages not taking input. */
  editing: boolean;
  setEditing(editing: boolean): void;
  /** The widget gallery ("Add Widgets…"). */
  galleryOpen: boolean;
  setGalleryOpen(open: boolean): void;
}

export const WidgetsContext = createContext<WidgetsContextValue | undefined>(undefined);

/** The desktop's widgets. Must be used within the Desktop. */
export function useWidgets(): WidgetsContextValue {
  const ctx = useContext(WidgetsContext);
  if (!ctx) throw new Error('useWidgets must be used within a Desktop');
  return ctx;
}
