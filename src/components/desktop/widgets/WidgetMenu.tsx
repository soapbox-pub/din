import { Info, LayoutGrid, Maximize2, RotateCw, Trash2 } from 'lucide-react';
import {
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuRadioGroup,
  ContextMenuRadioItem,
  ContextMenuSeparator,
  ContextMenuSub,
  ContextMenuSubContent,
  ContextMenuSubTrigger,
} from '@/components/ui/context-menu';
import { WIDGET_SIZES, widgetSizes, type PlacedWidget, type WidgetSize } from '@/lib/widgets';

export interface WidgetMenuActions {
  editing: boolean;
  setEditing(editing: boolean): void;
  resize(size: WidgetSize): void;
  reload(): void;
  about(): void;
  remove(): void;
}

/** A widget's right-click menu. */
export function WidgetMenuContent({ widget, actions }: { widget: PlacedWidget; actions: WidgetMenuActions }) {
  const sizes = widgetSizes(widget.source);
  const current = sizes.find((size) => WIDGET_SIZES[size].cols === widget.cols && WIDGET_SIZES[size].rows === widget.rows) ?? '';
  return (
    <ContextMenuContent className="w-56">
      <ContextMenuItem onSelect={() => actions.setEditing(!actions.editing)}>
        <LayoutGrid aria-hidden /> {actions.editing ? 'Done Editing' : 'Edit Widgets'}
      </ContextMenuItem>
      {sizes.length > 1 && (
        <ContextMenuSub>
          <ContextMenuSubTrigger className="gap-2">
            <Maximize2 aria-hidden /> Size
          </ContextMenuSubTrigger>
          <ContextMenuSubContent className="w-40">
            <ContextMenuRadioGroup value={current} onValueChange={(size) => actions.resize(size as WidgetSize)}>
              {sizes.map((size) => (
                <ContextMenuRadioItem key={size} value={size}>
                  {WIDGET_SIZES[size].label}
                </ContextMenuRadioItem>
              ))}
            </ContextMenuRadioGroup>
          </ContextMenuSubContent>
        </ContextMenuSub>
      )}
      <ContextMenuItem onSelect={actions.reload}>
        <RotateCw aria-hidden /> Reload
      </ContextMenuItem>
      <ContextMenuItem onSelect={actions.about}>
        <Info aria-hidden /> About This Widget…
      </ContextMenuItem>
      <ContextMenuSeparator />
      <ContextMenuItem variant="destructive" onSelect={actions.remove}>
        <Trash2 aria-hidden /> Remove Widget
      </ContextMenuItem>
    </ContextMenuContent>
  );
}
