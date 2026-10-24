import type { AdjustmentLayer } from 'ag-psd';
import { ADJUSTMENT_NAMES, FILTER_NAMES, MENU_ADJUSTMENTS, type FilterSpec } from './adjust';
import {
  Menubar,
  MenubarCheckboxItem,
  MenubarContent,
  MenubarItem,
  MenubarMenu,
  MenubarSeparator,
  MenubarSub,
  MenubarSubContent,
  MenubarSubTrigger,
  MenubarTrigger,
} from './chrome';

export type PanelId = 'color' | 'swatches' | 'properties' | 'layers' | 'history';
export type Turn = 'cw' | 'ccw' | '180' | 'flipH' | 'flipV';
export type Arrange = 'front' | 'forward' | 'backward' | 'back';

export interface Commands {
  newDoc(): void;
  open(): void;
  place(): void;
  close(): void;
  save(): void;
  saveAs(): void;
  quickExport(): void;
  exportAs(): void;
  undo(): void;
  redo(): void;
  cut(): void;
  copy(): void;
  copyMerged(): void;
  paste(inPlace: boolean): void;
  clear(): void;
  fill(): void;
  freeTransform(): void;
  transformLayer(how: Turn): void;
  adjustment(type: AdjustmentLayer['type']): void;
  desaturate(): void;
  imageSize(): void;
  canvasSize(): void;
  rotateCanvas(how: Turn): void;
  cropToSelection(): void;
  trim(): void;
  newLayer(): void;
  newAdjustmentLayer(type: AdjustmentLayer['type']): void;
  duplicate(): void;
  deleteLayer(): void;
  layerVia(cut: boolean): void;
  group(): void;
  ungroup(): void;
  addMask(how: 'reveal' | 'hide' | 'selection'): void;
  deleteMask(apply: boolean): void;
  toggleMask(): void;
  clipping(): void;
  layerStyle(): void;
  clearStyle(): void;
  rasterize(): void;
  arrange(how: Arrange): void;
  mergeDown(): void;
  mergeVisible(): void;
  flatten(): void;
  selectAll(): void;
  deselect(): void;
  reselect(): void;
  inverse(): void;
  loadSelection(): void;
  modifySelection(how: 'feather' | 'expand' | 'contract'): void;
  filter(type: FilterSpec['type']): void;
  lastFilter(): void;
  zoomIn(): void;
  zoomOut(): void;
  fit(): void;
  actual(): void;
  togglePanel(id: PanelId): void;
}

export interface MenuState {
  hasDoc: boolean;
  canUndo: boolean;
  canRedo: boolean;
  undoLabel: string;
  redoLabel: string;
  hasSelection: boolean;
  canReselect: boolean;
  activeKind: string | null;
  hasMask: boolean;
  maskDisabled: boolean;
  clipped: boolean;
  multiple: boolean;
  hasClipboard: boolean;
  lastFilter: string | null;
  panels: Record<PanelId, boolean>;
}

const FILTERS: { label: string; items: FilterSpec['type'][] }[] = [
  { label: 'Blur', items: ['gaussian', 'motion'] },
  { label: 'Noise', items: ['noise'] },
  { label: 'Pixelate', items: ['mosaic'] },
  { label: 'Sharpen', items: ['sharpen', 'unsharp'] },
  { label: 'Stylize', items: ['emboss'] },
];

const ADJ_SHORTCUTS: Partial<Record<AdjustmentLayer['type'], string>> = {
  levels: 'Ctrl+L',
  curves: 'Ctrl+M',
  'hue/saturation': 'Ctrl+U',
  'black & white': 'Alt+Shift+Ctrl+B',
  invert: 'Ctrl+I',
};

export function PhotoMenus({ cmd, st }: { cmd: Commands; st: MenuState }) {
  const d = !st.hasDoc;
  const pixels = st.activeKind === 'pixel';
  const layerish = st.activeKind !== null;
  return (
    <Menubar className="h-7 shrink-0 gap-0.5 border-b border-[#232323] bg-[#323232] px-1">
      <MenubarMenu>
        <MenubarTrigger>File</MenubarTrigger>
        <MenubarContent>
          <MenubarItem shortcut="Ctrl+N" onSelect={cmd.newDoc}>
            New…
          </MenubarItem>
          <MenubarItem shortcut="Ctrl+O" onSelect={cmd.open}>
            Open…
          </MenubarItem>
          <MenubarItem disabled={d} onSelect={cmd.place}>
            Place Embedded…
          </MenubarItem>
          <MenubarSeparator />
          <MenubarItem shortcut="Ctrl+W" onSelect={cmd.close}>
            Close
          </MenubarItem>
          <MenubarItem shortcut="Ctrl+S" disabled={d} onSelect={cmd.save}>
            Save
          </MenubarItem>
          <MenubarItem shortcut="Shift+Ctrl+S" disabled={d} onSelect={cmd.saveAs}>
            Save As…
          </MenubarItem>
          <MenubarSeparator />
          <MenubarSub>
            <MenubarSubTrigger disabled={d}>Export</MenubarSubTrigger>
            <MenubarSubContent>
              <MenubarItem onSelect={cmd.quickExport}>Quick Export as PNG</MenubarItem>
              <MenubarItem shortcut="Alt+Shift+Ctrl+W" onSelect={cmd.exportAs}>
                Export As…
              </MenubarItem>
            </MenubarSubContent>
          </MenubarSub>
        </MenubarContent>
      </MenubarMenu>

      <MenubarMenu>
        <MenubarTrigger>Edit</MenubarTrigger>
        <MenubarContent>
          <MenubarItem shortcut="Ctrl+Z" disabled={!st.canUndo} onSelect={cmd.undo}>
            Undo {st.undoLabel}
          </MenubarItem>
          <MenubarItem shortcut="Shift+Ctrl+Z" disabled={!st.canRedo} onSelect={cmd.redo}>
            Redo {st.redoLabel}
          </MenubarItem>
          <MenubarSeparator />
          <MenubarItem shortcut="Ctrl+X" disabled={d || !pixels} onSelect={cmd.cut}>
            Cut
          </MenubarItem>
          <MenubarItem shortcut="Ctrl+C" disabled={d || !layerish} onSelect={cmd.copy}>
            Copy
          </MenubarItem>
          <MenubarItem shortcut="Shift+Ctrl+C" disabled={d} onSelect={cmd.copyMerged}>
            Copy Merged
          </MenubarItem>
          <MenubarItem shortcut="Ctrl+V" onSelect={() => cmd.paste(false)}>
            Paste
          </MenubarItem>
          <MenubarItem shortcut="Shift+Ctrl+V" disabled={d} onSelect={() => cmd.paste(true)}>
            Paste in Place
          </MenubarItem>
          <MenubarItem shortcut="Delete" disabled={d || !layerish} onSelect={cmd.clear}>
            Clear
          </MenubarItem>
          <MenubarSeparator />
          <MenubarItem shortcut="Shift+F5" disabled={d || !layerish} onSelect={cmd.fill}>
            Fill…
          </MenubarItem>
          <MenubarSeparator />
          <MenubarItem shortcut="Ctrl+T" disabled={d || !layerish || st.activeKind === 'adjustment'} onSelect={cmd.freeTransform}>
            Free Transform
          </MenubarItem>
          <MenubarSub>
            <MenubarSubTrigger disabled={d || !layerish}>Transform</MenubarSubTrigger>
            <MenubarSubContent>
              <MenubarItem onSelect={() => cmd.transformLayer('180')}>Rotate 180°</MenubarItem>
              <MenubarItem onSelect={() => cmd.transformLayer('cw')}>Rotate 90° Clockwise</MenubarItem>
              <MenubarItem onSelect={() => cmd.transformLayer('ccw')}>Rotate 90° Counter Clockwise</MenubarItem>
              <MenubarSeparator />
              <MenubarItem onSelect={() => cmd.transformLayer('flipH')}>Flip Horizontal</MenubarItem>
              <MenubarItem onSelect={() => cmd.transformLayer('flipV')}>Flip Vertical</MenubarItem>
            </MenubarSubContent>
          </MenubarSub>
        </MenubarContent>
      </MenubarMenu>

      <MenubarMenu>
        <MenubarTrigger>Image</MenubarTrigger>
        <MenubarContent>
          <MenubarSub>
            <MenubarSubTrigger disabled={d}>Adjustments</MenubarSubTrigger>
            <MenubarSubContent>
              {MENU_ADJUSTMENTS.map((t, i) => (
                <div key={t}>
                  {(i === 4 || i === 9) && <MenubarSeparator />}
                  <MenubarItem shortcut={ADJ_SHORTCUTS[t]} disabled={!pixels && st.activeKind !== 'adjustment'} onSelect={() => cmd.adjustment(t)}>
                    {ADJUSTMENT_NAMES[t]}
                    {t === 'invert' ? '' : '…'}
                  </MenubarItem>
                </div>
              ))}
              <MenubarSeparator />
              <MenubarItem shortcut="Shift+Ctrl+U" disabled={!pixels} onSelect={cmd.desaturate}>
                Desaturate
              </MenubarItem>
            </MenubarSubContent>
          </MenubarSub>
          <MenubarSeparator />
          <MenubarItem shortcut="Alt+Ctrl+I" disabled={d} onSelect={cmd.imageSize}>
            Image Size…
          </MenubarItem>
          <MenubarItem shortcut="Alt+Ctrl+C" disabled={d} onSelect={cmd.canvasSize}>
            Canvas Size…
          </MenubarItem>
          <MenubarSub>
            <MenubarSubTrigger disabled={d}>Image Rotation</MenubarSubTrigger>
            <MenubarSubContent>
              <MenubarItem onSelect={() => cmd.rotateCanvas('180')}>180°</MenubarItem>
              <MenubarItem onSelect={() => cmd.rotateCanvas('cw')}>90° Clockwise</MenubarItem>
              <MenubarItem onSelect={() => cmd.rotateCanvas('ccw')}>90° Counter Clockwise</MenubarItem>
              <MenubarSeparator />
              <MenubarItem onSelect={() => cmd.rotateCanvas('flipH')}>Flip Canvas Horizontal</MenubarItem>
              <MenubarItem onSelect={() => cmd.rotateCanvas('flipV')}>Flip Canvas Vertical</MenubarItem>
            </MenubarSubContent>
          </MenubarSub>
          <MenubarItem disabled={d || !st.hasSelection} onSelect={cmd.cropToSelection}>
            Crop
          </MenubarItem>
          <MenubarItem disabled={d} onSelect={cmd.trim}>
            Trim Transparent Pixels
          </MenubarItem>
        </MenubarContent>
      </MenubarMenu>

      <MenubarMenu>
        <MenubarTrigger>Layer</MenubarTrigger>
        <MenubarContent>
          <MenubarSub>
            <MenubarSubTrigger disabled={d}>New</MenubarSubTrigger>
            <MenubarSubContent>
              <MenubarItem shortcut="Shift+Ctrl+N" onSelect={cmd.newLayer}>
                Layer
              </MenubarItem>
              <MenubarItem onSelect={cmd.group}>Group from Layers</MenubarItem>
              <MenubarSeparator />
              <MenubarItem shortcut="Ctrl+J" disabled={!layerish} onSelect={() => cmd.layerVia(false)}>
                Layer via Copy
              </MenubarItem>
              <MenubarItem shortcut="Shift+Ctrl+J" disabled={!pixels || !st.hasSelection} onSelect={() => cmd.layerVia(true)}>
                Layer via Cut
              </MenubarItem>
            </MenubarSubContent>
          </MenubarSub>
          <MenubarSub>
            <MenubarSubTrigger disabled={d}>New Adjustment Layer</MenubarSubTrigger>
            <MenubarSubContent>
              {MENU_ADJUSTMENTS.map((t) => (
                <MenubarItem key={t} onSelect={() => cmd.newAdjustmentLayer(t)}>
                  {ADJUSTMENT_NAMES[t]}…
                </MenubarItem>
              ))}
            </MenubarSubContent>
          </MenubarSub>
          <MenubarItem disabled={d || !layerish} onSelect={cmd.duplicate}>
            Duplicate Layer
          </MenubarItem>
          <MenubarItem disabled={d || !layerish} onSelect={cmd.deleteLayer}>
            Delete Layer
          </MenubarItem>
          <MenubarSeparator />
          <MenubarSub>
            <MenubarSubTrigger disabled={d || !layerish}>Layer Style</MenubarSubTrigger>
            <MenubarSubContent>
              <MenubarItem disabled={st.activeKind === 'adjustment'} onSelect={cmd.layerStyle}>
                Blending Options…
              </MenubarItem>
              <MenubarItem onSelect={cmd.clearStyle}>Clear Layer Style</MenubarItem>
            </MenubarSubContent>
          </MenubarSub>
          <MenubarSub>
            <MenubarSubTrigger disabled={d || !layerish}>Layer Mask</MenubarSubTrigger>
            <MenubarSubContent>
              <MenubarItem disabled={st.hasMask} onSelect={() => cmd.addMask('reveal')}>
                Reveal All
              </MenubarItem>
              <MenubarItem disabled={st.hasMask} onSelect={() => cmd.addMask('hide')}>
                Hide All
              </MenubarItem>
              <MenubarItem disabled={st.hasMask || !st.hasSelection} onSelect={() => cmd.addMask('selection')}>
                Reveal Selection
              </MenubarItem>
              <MenubarSeparator />
              <MenubarItem disabled={!st.hasMask} onSelect={() => cmd.deleteMask(false)}>
                Delete
              </MenubarItem>
              <MenubarItem disabled={!st.hasMask || !pixels} onSelect={() => cmd.deleteMask(true)}>
                Apply
              </MenubarItem>
              <MenubarItem disabled={!st.hasMask} onSelect={cmd.toggleMask}>
                {st.maskDisabled ? 'Enable' : 'Disable'}
              </MenubarItem>
            </MenubarSubContent>
          </MenubarSub>
          <MenubarItem shortcut="Alt+Ctrl+G" disabled={d || !layerish} onSelect={cmd.clipping}>
            {st.clipped ? 'Release Clipping Mask' : 'Create Clipping Mask'}
          </MenubarItem>
          <MenubarSeparator />
          <MenubarItem disabled={d || !(st.activeKind === 'text' || st.activeKind === 'smart' || st.activeKind === 'shape')} onSelect={cmd.rasterize}>
            Rasterize Layer
          </MenubarItem>
          <MenubarSeparator />
          <MenubarItem shortcut="Ctrl+G" disabled={d || !layerish} onSelect={cmd.group}>
            Group Layers
          </MenubarItem>
          <MenubarItem shortcut="Shift+Ctrl+G" disabled={d || st.activeKind !== 'group'} onSelect={cmd.ungroup}>
            Ungroup Layers
          </MenubarItem>
          <MenubarSub>
            <MenubarSubTrigger disabled={d || !layerish}>Arrange</MenubarSubTrigger>
            <MenubarSubContent>
              <MenubarItem shortcut="Shift+Ctrl+]" onSelect={() => cmd.arrange('front')}>
                Bring to Front
              </MenubarItem>
              <MenubarItem shortcut="Ctrl+]" onSelect={() => cmd.arrange('forward')}>
                Bring Forward
              </MenubarItem>
              <MenubarItem shortcut="Ctrl+[" onSelect={() => cmd.arrange('backward')}>
                Send Backward
              </MenubarItem>
              <MenubarItem shortcut="Shift+Ctrl+[" onSelect={() => cmd.arrange('back')}>
                Send to Back
              </MenubarItem>
            </MenubarSubContent>
          </MenubarSub>
          <MenubarSeparator />
          <MenubarItem shortcut="Ctrl+E" disabled={d || !layerish} onSelect={cmd.mergeDown}>
            {st.multiple ? 'Merge Layers' : 'Merge Down'}
          </MenubarItem>
          <MenubarItem shortcut="Shift+Ctrl+E" disabled={d} onSelect={cmd.mergeVisible}>
            Merge Visible
          </MenubarItem>
          <MenubarItem disabled={d} onSelect={cmd.flatten}>
            Flatten Image
          </MenubarItem>
        </MenubarContent>
      </MenubarMenu>

      <MenubarMenu>
        <MenubarTrigger>Select</MenubarTrigger>
        <MenubarContent>
          <MenubarItem shortcut="Ctrl+A" disabled={d} onSelect={cmd.selectAll}>
            All
          </MenubarItem>
          <MenubarItem shortcut="Ctrl+D" disabled={d || !st.hasSelection} onSelect={cmd.deselect}>
            Deselect
          </MenubarItem>
          <MenubarItem shortcut="Shift+Ctrl+D" disabled={d || !st.canReselect} onSelect={cmd.reselect}>
            Reselect
          </MenubarItem>
          <MenubarItem shortcut="Shift+Ctrl+I" disabled={d} onSelect={cmd.inverse}>
            Inverse
          </MenubarItem>
          <MenubarSeparator />
          <MenubarItem disabled={d || !layerish} onSelect={cmd.loadSelection}>
            Load Layer Transparency
          </MenubarItem>
          <MenubarSub>
            <MenubarSubTrigger disabled={d || !st.hasSelection}>Modify</MenubarSubTrigger>
            <MenubarSubContent>
              <MenubarItem onSelect={() => cmd.modifySelection('expand')}>Expand…</MenubarItem>
              <MenubarItem onSelect={() => cmd.modifySelection('contract')}>Contract…</MenubarItem>
              <MenubarItem shortcut="Shift+F6" onSelect={() => cmd.modifySelection('feather')}>
                Feather…
              </MenubarItem>
            </MenubarSubContent>
          </MenubarSub>
        </MenubarContent>
      </MenubarMenu>

      <MenubarMenu>
        <MenubarTrigger>Filter</MenubarTrigger>
        <MenubarContent>
          <MenubarItem shortcut="Alt+Ctrl+F" disabled={d || !st.lastFilter || !pixels} onSelect={cmd.lastFilter}>
            {st.lastFilter ? `Last Filter (${st.lastFilter})` : 'Last Filter'}
          </MenubarItem>
          <MenubarSeparator />
          {FILTERS.map((g) => (
            <MenubarSub key={g.label}>
              <MenubarSubTrigger disabled={d || (!pixels && !st.hasMask)}>{g.label}</MenubarSubTrigger>
              <MenubarSubContent>
                {g.items.map((t) => (
                  <MenubarItem key={t} onSelect={() => cmd.filter(t)}>
                    {FILTER_NAMES[t]}
                    {t === 'sharpen' || t === 'emboss' ? '' : '…'}
                  </MenubarItem>
                ))}
              </MenubarSubContent>
            </MenubarSub>
          ))}
        </MenubarContent>
      </MenubarMenu>

      <MenubarMenu>
        <MenubarTrigger>View</MenubarTrigger>
        <MenubarContent>
          <MenubarItem shortcut="Ctrl++" disabled={d} onSelect={cmd.zoomIn}>
            Zoom In
          </MenubarItem>
          <MenubarItem shortcut="Ctrl+-" disabled={d} onSelect={cmd.zoomOut}>
            Zoom Out
          </MenubarItem>
          <MenubarItem shortcut="Ctrl+0" disabled={d} onSelect={cmd.fit}>
            Fit on Screen
          </MenubarItem>
          <MenubarItem shortcut="Ctrl+1" disabled={d} onSelect={cmd.actual}>
            100%
          </MenubarItem>
        </MenubarContent>
      </MenubarMenu>

      <MenubarMenu>
        <MenubarTrigger>Window</MenubarTrigger>
        <MenubarContent>
          <MenubarCheckboxItem checked={st.panels.color} onCheckedChange={() => cmd.togglePanel('color')} shortcut="F6">
            Color
          </MenubarCheckboxItem>
          <MenubarCheckboxItem checked={st.panels.history} onCheckedChange={() => cmd.togglePanel('history')}>
            History
          </MenubarCheckboxItem>
          <MenubarCheckboxItem checked={st.panels.layers} onCheckedChange={() => cmd.togglePanel('layers')} shortcut="F7">
            Layers
          </MenubarCheckboxItem>
          <MenubarCheckboxItem checked={st.panels.properties} onCheckedChange={() => cmd.togglePanel('properties')}>
            Properties
          </MenubarCheckboxItem>
          <MenubarCheckboxItem checked={st.panels.swatches} onCheckedChange={() => cmd.togglePanel('swatches')}>
            Swatches
          </MenubarCheckboxItem>
        </MenubarContent>
      </MenubarMenu>
    </Menubar>
  );
}
