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
} from '@/shared/photo/chrome';
import type { AlignHow, Arrange } from './ops';

export type PanelId = 'properties' | 'layers' | 'color' | 'swatches' | 'stroke' | 'gradient' | 'transparency' | 'character' | 'paragraph' | 'align' | 'artboards' | 'pathfinder';

const PANEL_NAMES: Record<PanelId, string> = {
  properties: 'Properties',
  layers: 'Layers',
  color: 'Color',
  swatches: 'Swatches',
  stroke: 'Stroke',
  gradient: 'Gradient',
  transparency: 'Transparency',
  character: 'Character',
  paragraph: 'Paragraph',
  align: 'Align',
  artboards: 'Artboards',
  pathfinder: 'Pathfinder',
};

export type TransformDialog = 'move' | 'rotate' | 'reflect' | 'scale' | 'shear';
export type SameHow = 'fill-stroke' | 'fill' | 'stroke' | 'stroke-weight' | 'opacity' | 'blend';
export type CaseHow = 'upper' | 'lower' | 'title' | 'sentence';

export interface Commands {
  newDoc(): void;
  open(): void;
  close(): void;
  save(): void;
  saveAs(): void;
  saveCopy(): void;
  place(): void;
  exportAs(): void;
  documentSetup(): void;
  colorMode(m: 'rgb' | 'cmyk'): void;
  undo(): void;
  redo(): void;
  cut(): void;
  copy(): void;
  paste(how: 'normal' | 'front' | 'back' | 'place'): void;
  clear(): void;
  transformAgain(): void;
  transformDialog(kind: TransformDialog): void;
  arrange(how: Arrange): void;
  align(how: AlignHow): void;
  group(): void;
  ungroup(): void;
  lock(): void;
  unlockAll(): void;
  hide(): void;
  showAll(): void;
  join(): void;
  average(): void;
  reversePath(): void;
  addAnchors(): void;
  offsetPath(): void;
  makeClip(): void;
  releaseClip(): void;
  makeCompound(): void;
  releaseCompound(): void;
  fitArtboard(): void;
  fitArtboardToSelection(): void;
  createOutlines(): void;
  changeCase(how: CaseHow): void;
  selectAll(): void;
  selectAllOnArtboard(): void;
  deselect(): void;
  reselect(): void;
  inverse(): void;
  nextObject(dir: 1 | -1): void;
  selectSame(how: SameHow): void;
  toggleOutline(): void;
  zoomIn(): void;
  zoomOut(): void;
  fitArtboardView(): void;
  fitAll(): void;
  actual(): void;
  toggleEdges(): void;
  toggleArtboards(): void;
  toggleRulers(): void;
  toggleBoundingBox(): void;
  toggleGrid(): void;
  toggleSmartGuides(): void;
  togglePanel(id: PanelId): void;
  shortcuts(): void;
}

export interface MenuState {
  hasDoc: boolean;
  canUndo: boolean;
  canRedo: boolean;
  undoLabel: string;
  redoLabel: string;
  hasSelection: boolean;
  multiple: boolean;
  groupSelected: boolean;
  clipSelected: boolean;
  compoundSelected: boolean;
  textSelected: boolean;
  pathSelected: boolean;
  hasClipboard: boolean;
  canReselect: boolean;
  canTransformAgain: boolean;
  outline: boolean;
  edges: boolean;
  artboards: boolean;
  rulers: boolean;
  boundingBox: boolean;
  grid: boolean;
  smartGuides: boolean;
  mode: 'rgb' | 'cmyk';
  panels: Record<PanelId, boolean>;
}

export function VectorMenus({ cmd, st }: { cmd: Commands; st: MenuState }) {
  const d = !st.hasDoc;
  const ns = !st.hasSelection;
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
          <MenubarSeparator />
          <MenubarItem shortcut="Ctrl+W" disabled={d} onSelect={cmd.close}>
            Close
          </MenubarItem>
          <MenubarItem shortcut="Ctrl+S" disabled={d} onSelect={cmd.save}>
            Save
          </MenubarItem>
          <MenubarItem shortcut="Shift+Ctrl+S" disabled={d} onSelect={cmd.saveAs}>
            Save As…
          </MenubarItem>
          <MenubarItem shortcut="Alt+Ctrl+S" disabled={d} onSelect={cmd.saveCopy}>
            Save a Copy…
          </MenubarItem>
          <MenubarSeparator />
          <MenubarItem shortcut="Shift+Ctrl+P" disabled={d} onSelect={cmd.place}>
            Place…
          </MenubarItem>
          <MenubarSeparator />
          <MenubarSub>
            <MenubarSubTrigger disabled={d}>Export</MenubarSubTrigger>
            <MenubarSubContent>
              <MenubarItem onSelect={cmd.exportAs}>Export As…</MenubarItem>
            </MenubarSubContent>
          </MenubarSub>
          <MenubarSeparator />
          <MenubarItem shortcut="Alt+Ctrl+P" disabled={d} onSelect={cmd.documentSetup}>
            Document Setup…
          </MenubarItem>
          <MenubarSub>
            <MenubarSubTrigger disabled={d}>Document Color Mode</MenubarSubTrigger>
            <MenubarSubContent>
              <MenubarCheckboxItem checked={st.mode === 'cmyk'} onSelect={() => cmd.colorMode('cmyk')}>
                CMYK Color
              </MenubarCheckboxItem>
              <MenubarCheckboxItem checked={st.mode === 'rgb'} onSelect={() => cmd.colorMode('rgb')}>
                RGB Color
              </MenubarCheckboxItem>
            </MenubarSubContent>
          </MenubarSub>
        </MenubarContent>
      </MenubarMenu>

      <MenubarMenu>
        <MenubarTrigger>Edit</MenubarTrigger>
        <MenubarContent>
          <MenubarItem shortcut="Ctrl+Z" disabled={!st.canUndo} onSelect={cmd.undo}>
            Undo{st.undoLabel ? ` ${st.undoLabel}` : ''}
          </MenubarItem>
          <MenubarItem shortcut="Shift+Ctrl+Z" disabled={!st.canRedo} onSelect={cmd.redo}>
            Redo{st.redoLabel ? ` ${st.redoLabel}` : ''}
          </MenubarItem>
          <MenubarSeparator />
          <MenubarItem shortcut="Ctrl+X" disabled={ns} onSelect={cmd.cut}>
            Cut
          </MenubarItem>
          <MenubarItem shortcut="Ctrl+C" disabled={ns} onSelect={cmd.copy}>
            Copy
          </MenubarItem>
          <MenubarItem shortcut="Ctrl+V" disabled={d} onSelect={() => cmd.paste('normal')}>
            Paste
          </MenubarItem>
          <MenubarItem shortcut="Ctrl+F" disabled={d || !st.hasClipboard} onSelect={() => cmd.paste('front')}>
            Paste in Front
          </MenubarItem>
          <MenubarItem shortcut="Ctrl+B" disabled={d || !st.hasClipboard} onSelect={() => cmd.paste('back')}>
            Paste in Back
          </MenubarItem>
          <MenubarItem shortcut="Shift+Ctrl+V" disabled={d || !st.hasClipboard} onSelect={() => cmd.paste('place')}>
            Paste in Place
          </MenubarItem>
          <MenubarItem disabled={ns} onSelect={cmd.clear}>
            Clear
          </MenubarItem>
          <MenubarSeparator />
          <MenubarItem onSelect={cmd.shortcuts}>Keyboard Shortcuts…</MenubarItem>
        </MenubarContent>
      </MenubarMenu>

      <MenubarMenu>
        <MenubarTrigger>Object</MenubarTrigger>
        <MenubarContent>
          <MenubarSub>
            <MenubarSubTrigger disabled={ns}>Transform</MenubarSubTrigger>
            <MenubarSubContent>
              <MenubarItem shortcut="Ctrl+D" disabled={!st.canTransformAgain} onSelect={cmd.transformAgain}>
                Transform Again
              </MenubarItem>
              <MenubarSeparator />
              <MenubarItem shortcut="Shift+Ctrl+M" onSelect={() => cmd.transformDialog('move')}>
                Move…
              </MenubarItem>
              <MenubarItem onSelect={() => cmd.transformDialog('rotate')}>Rotate…</MenubarItem>
              <MenubarItem onSelect={() => cmd.transformDialog('reflect')}>Reflect…</MenubarItem>
              <MenubarItem onSelect={() => cmd.transformDialog('scale')}>Scale…</MenubarItem>
              <MenubarItem onSelect={() => cmd.transformDialog('shear')}>Shear…</MenubarItem>
            </MenubarSubContent>
          </MenubarSub>
          <MenubarSub>
            <MenubarSubTrigger disabled={ns}>Arrange</MenubarSubTrigger>
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
          <MenubarSub>
            <MenubarSubTrigger disabled={ns}>Align</MenubarSubTrigger>
            <MenubarSubContent>
              <MenubarItem onSelect={() => cmd.align('left')}>Horizontal Left</MenubarItem>
              <MenubarItem onSelect={() => cmd.align('hcenter')}>Horizontal Center</MenubarItem>
              <MenubarItem onSelect={() => cmd.align('right')}>Horizontal Right</MenubarItem>
              <MenubarItem onSelect={() => cmd.align('top')}>Vertical Top</MenubarItem>
              <MenubarItem onSelect={() => cmd.align('vcenter')}>Vertical Center</MenubarItem>
              <MenubarItem onSelect={() => cmd.align('bottom')}>Vertical Bottom</MenubarItem>
            </MenubarSubContent>
          </MenubarSub>
          <MenubarSeparator />
          <MenubarItem shortcut="Ctrl+G" disabled={ns} onSelect={cmd.group}>
            Group
          </MenubarItem>
          <MenubarItem shortcut="Shift+Ctrl+G" disabled={!st.groupSelected} onSelect={cmd.ungroup}>
            Ungroup
          </MenubarItem>
          <MenubarSub>
            <MenubarSubTrigger disabled={d}>Lock</MenubarSubTrigger>
            <MenubarSubContent>
              <MenubarItem shortcut="Ctrl+2" disabled={ns} onSelect={cmd.lock}>
                Selection
              </MenubarItem>
            </MenubarSubContent>
          </MenubarSub>
          <MenubarItem shortcut="Alt+Ctrl+2" disabled={d} onSelect={cmd.unlockAll}>
            Unlock All
          </MenubarItem>
          <MenubarSub>
            <MenubarSubTrigger disabled={d}>Hide</MenubarSubTrigger>
            <MenubarSubContent>
              <MenubarItem shortcut="Ctrl+3" disabled={ns} onSelect={cmd.hide}>
                Selection
              </MenubarItem>
            </MenubarSubContent>
          </MenubarSub>
          <MenubarItem shortcut="Alt+Ctrl+3" disabled={d} onSelect={cmd.showAll}>
            Show All
          </MenubarItem>
          <MenubarSeparator />
          <MenubarSub>
            <MenubarSubTrigger disabled={!st.pathSelected}>Path</MenubarSubTrigger>
            <MenubarSubContent>
              <MenubarItem shortcut="Ctrl+J" onSelect={cmd.join}>
                Join
              </MenubarItem>
              <MenubarItem shortcut="Alt+Ctrl+J" onSelect={cmd.average}>
                Average…
              </MenubarItem>
              <MenubarItem onSelect={cmd.offsetPath}>Offset Path…</MenubarItem>
              <MenubarItem onSelect={cmd.reversePath}>Reverse Path Direction</MenubarItem>
              <MenubarItem onSelect={cmd.addAnchors}>Add Anchor Points</MenubarItem>
            </MenubarSubContent>
          </MenubarSub>
          <MenubarSub>
            <MenubarSubTrigger disabled={d}>Artboards</MenubarSubTrigger>
            <MenubarSubContent>
              <MenubarItem onSelect={cmd.fitArtboard}>Fit to Artwork Bounds</MenubarItem>
              <MenubarItem disabled={ns} onSelect={cmd.fitArtboardToSelection}>
                Fit to Selected Art
              </MenubarItem>
            </MenubarSubContent>
          </MenubarSub>
          <MenubarSeparator />
          <MenubarSub>
            <MenubarSubTrigger disabled={ns}>Clipping Mask</MenubarSubTrigger>
            <MenubarSubContent>
              <MenubarItem shortcut="Ctrl+7" disabled={!st.multiple} onSelect={cmd.makeClip}>
                Make
              </MenubarItem>
              <MenubarItem shortcut="Alt+Ctrl+7" disabled={!st.clipSelected} onSelect={cmd.releaseClip}>
                Release
              </MenubarItem>
            </MenubarSubContent>
          </MenubarSub>
          <MenubarSub>
            <MenubarSubTrigger disabled={ns}>Compound Path</MenubarSubTrigger>
            <MenubarSubContent>
              <MenubarItem shortcut="Ctrl+8" disabled={!st.multiple && !st.groupSelected} onSelect={cmd.makeCompound}>
                Make
              </MenubarItem>
              <MenubarItem shortcut="Alt+Shift+Ctrl+8" disabled={!st.compoundSelected} onSelect={cmd.releaseCompound}>
                Release
              </MenubarItem>
            </MenubarSubContent>
          </MenubarSub>
        </MenubarContent>
      </MenubarMenu>

      <MenubarMenu>
        <MenubarTrigger>Type</MenubarTrigger>
        <MenubarContent>
          <MenubarItem shortcut="Shift+Ctrl+O" disabled={!st.textSelected} onSelect={cmd.createOutlines}>
            Create Outlines
          </MenubarItem>
          <MenubarSub>
            <MenubarSubTrigger disabled={!st.textSelected}>Change Case</MenubarSubTrigger>
            <MenubarSubContent>
              <MenubarItem onSelect={() => cmd.changeCase('upper')}>UPPERCASE</MenubarItem>
              <MenubarItem onSelect={() => cmd.changeCase('lower')}>lowercase</MenubarItem>
              <MenubarItem onSelect={() => cmd.changeCase('title')}>Title Case</MenubarItem>
              <MenubarItem onSelect={() => cmd.changeCase('sentence')}>Sentence case</MenubarItem>
            </MenubarSubContent>
          </MenubarSub>
          <MenubarSeparator />
          <MenubarItem shortcut="Ctrl+T" onSelect={() => cmd.togglePanel('character')}>
            Character
          </MenubarItem>
          <MenubarItem shortcut="Alt+Ctrl+T" onSelect={() => cmd.togglePanel('paragraph')}>
            Paragraph
          </MenubarItem>
        </MenubarContent>
      </MenubarMenu>

      <MenubarMenu>
        <MenubarTrigger>Select</MenubarTrigger>
        <MenubarContent>
          <MenubarItem shortcut="Ctrl+A" disabled={d} onSelect={cmd.selectAll}>
            All
          </MenubarItem>
          <MenubarItem shortcut="Alt+Ctrl+A" disabled={d} onSelect={cmd.selectAllOnArtboard}>
            All on Active Artboard
          </MenubarItem>
          <MenubarItem shortcut="Shift+Ctrl+A" disabled={ns} onSelect={cmd.deselect}>
            Deselect
          </MenubarItem>
          <MenubarItem shortcut="Ctrl+6" disabled={!st.canReselect} onSelect={cmd.reselect}>
            Reselect
          </MenubarItem>
          <MenubarItem disabled={d} onSelect={cmd.inverse}>
            Inverse
          </MenubarItem>
          <MenubarSeparator />
          <MenubarItem shortcut="Alt+Ctrl+]" disabled={ns} onSelect={() => cmd.nextObject(1)}>
            Next Object Above
          </MenubarItem>
          <MenubarItem shortcut="Alt+Ctrl+[" disabled={ns} onSelect={() => cmd.nextObject(-1)}>
            Next Object Below
          </MenubarItem>
          <MenubarSeparator />
          <MenubarSub>
            <MenubarSubTrigger disabled={ns}>Same</MenubarSubTrigger>
            <MenubarSubContent>
              <MenubarItem onSelect={() => cmd.selectSame('fill-stroke')}>Fill &amp; Stroke</MenubarItem>
              <MenubarItem onSelect={() => cmd.selectSame('fill')}>Fill Color</MenubarItem>
              <MenubarItem onSelect={() => cmd.selectSame('opacity')}>Opacity</MenubarItem>
              <MenubarItem onSelect={() => cmd.selectSame('stroke')}>Stroke Color</MenubarItem>
              <MenubarItem onSelect={() => cmd.selectSame('stroke-weight')}>Stroke Weight</MenubarItem>
              <MenubarItem onSelect={() => cmd.selectSame('blend')}>Blending Mode</MenubarItem>
            </MenubarSubContent>
          </MenubarSub>
        </MenubarContent>
      </MenubarMenu>

      <MenubarMenu>
        <MenubarTrigger>View</MenubarTrigger>
        <MenubarContent>
          <MenubarItem shortcut="Ctrl+Y" disabled={d} onSelect={cmd.toggleOutline}>
            {st.outline ? 'GPU Preview' : 'Outline'}
          </MenubarItem>
          <MenubarSeparator />
          <MenubarItem shortcut="Ctrl+=" disabled={d} onSelect={cmd.zoomIn}>
            Zoom In
          </MenubarItem>
          <MenubarItem shortcut="Ctrl+-" disabled={d} onSelect={cmd.zoomOut}>
            Zoom Out
          </MenubarItem>
          <MenubarItem shortcut="Ctrl+0" disabled={d} onSelect={cmd.fitArtboardView}>
            Fit Artboard in Window
          </MenubarItem>
          <MenubarItem shortcut="Alt+Ctrl+0" disabled={d} onSelect={cmd.fitAll}>
            Fit All in Window
          </MenubarItem>
          <MenubarItem shortcut="Ctrl+1" disabled={d} onSelect={cmd.actual}>
            Actual Size
          </MenubarItem>
          <MenubarSeparator />
          <MenubarItem shortcut="Ctrl+H" disabled={d} onSelect={cmd.toggleEdges}>
            {st.edges ? 'Hide Edges' : 'Show Edges'}
          </MenubarItem>
          <MenubarItem shortcut="Shift+Ctrl+H" disabled={d} onSelect={cmd.toggleArtboards}>
            {st.artboards ? 'Hide Artboards' : 'Show Artboards'}
          </MenubarItem>
          <MenubarSeparator />
          <MenubarItem shortcut="Ctrl+R" disabled={d} onSelect={cmd.toggleRulers}>
            {st.rulers ? 'Hide Rulers' : 'Show Rulers'}
          </MenubarItem>
          <MenubarItem shortcut="Shift+Ctrl+B" disabled={d} onSelect={cmd.toggleBoundingBox}>
            {st.boundingBox ? 'Hide Bounding Box' : 'Show Bounding Box'}
          </MenubarItem>
          <MenubarItem shortcut="Shift+Ctrl+D" disabled={d} onSelect={cmd.toggleGrid}>
            {st.grid ? 'Hide Transparency Grid' : 'Show Transparency Grid'}
          </MenubarItem>
          <MenubarSeparator />
          <MenubarCheckboxItem shortcut="Ctrl+U" checked={st.smartGuides} onSelect={cmd.toggleSmartGuides}>
            Smart Guides
          </MenubarCheckboxItem>
        </MenubarContent>
      </MenubarMenu>

      <MenubarMenu>
        <MenubarTrigger>Window</MenubarTrigger>
        <MenubarContent>
          {(
            [
              ['align', 'Shift+F7'],
              ['artboards', ''],
              ['color', 'F6'],
              ['gradient', 'Ctrl+F9'],
              ['layers', 'F7'],
              ['pathfinder', 'Shift+Ctrl+F9'],
              ['properties', ''],
              ['stroke', 'Ctrl+F10'],
              ['swatches', ''],
              ['transparency', 'Shift+Ctrl+F10'],
            ] as [PanelId, string][]
          ).map(([id, key]) => (
            <MenubarCheckboxItem key={id} shortcut={key || undefined} checked={st.panels[id]} onSelect={() => cmd.togglePanel(id)}>
              {PANEL_NAMES[id]}
            </MenubarCheckboxItem>
          ))}
          <MenubarSub>
            <MenubarSubTrigger>Type</MenubarSubTrigger>
            <MenubarSubContent>
              <MenubarCheckboxItem shortcut="Ctrl+T" checked={st.panels.character} onSelect={() => cmd.togglePanel('character')}>
                Character
              </MenubarCheckboxItem>
              <MenubarCheckboxItem shortcut="Alt+Ctrl+T" checked={st.panels.paragraph} onSelect={() => cmd.togglePanel('paragraph')}>
                Paragraph
              </MenubarCheckboxItem>
            </MenubarSubContent>
          </MenubarSub>
        </MenubarContent>
      </MenubarMenu>

      <MenubarMenu>
        <MenubarTrigger>Help</MenubarTrigger>
        <MenubarContent>
          <MenubarItem onSelect={cmd.shortcuts}>Keyboard Shortcuts…</MenubarItem>
        </MenubarContent>
      </MenubarMenu>
    </Menubar>
  );
}
