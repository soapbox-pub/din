import { useEffect } from 'react';
import { createPortal } from 'react-dom';
import { setDragPoint, useCurrentDinDrag, useDragPoint, useTabDragLabel } from '@/lib/dinDrag';

/**
 * The label that follows the pointer while something dragged from an app
 * is on its way ("3 items", a tab torn off a strip). An app's own drag image never
 * reaches the screen from its webview, so the desktop draws one instead:
 * apps report where the drag is over them (`drag.over`), and over the
 * desktop's own surfaces this listens itself.
 */
export function DinDragOverlay() {
  const drag = useCurrentDinDrag();
  const tabLabel = useTabDragLabel();
  const label = drag?.label || tabLabel;
  const at = useDragPoint();

  // A native drag's position over the desktop's own surfaces (a torn-off
  // tab's comes from its app, which keeps the pointer).
  useEffect(() => {
    if (!drag?.label) return;
    const onDragOver = (e: DragEvent) => setDragPoint({ x: e.clientX, y: e.clientY });
    document.addEventListener('dragover', onDragOver, true);
    return () => document.removeEventListener('dragover', onDragOver, true);
  }, [drag?.label]);

  if (!label || !at) return null;
  return createPortal(
    <div
      aria-hidden
      className="pointer-events-none fixed left-0 top-0 z-[2147483647] max-w-72 truncate whitespace-nowrap rounded-lg bg-primary px-2.5 py-1 text-[13px] font-medium text-primary-foreground shadow-lg"
      style={{ transform: `translate(${at.x + 12}px, ${at.y + 12}px)` }}
    >
      {label}
    </div>,
    document.getElementById('shell') ?? document.body,
  );
}
