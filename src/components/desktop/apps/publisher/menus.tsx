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
import type { Arrange, Fitting } from './ops';
import { PANEL_NAMES, type PanelId } from './state';

/** Publisher's menu bar, laid out as InDesign's is, with its shortcuts. */

export interface Commands {
  newDoc(): void;
  open(): void;
  place(): void;
  close(): void;
  save(): void;
  saveAs(): void;
  exportPng(): void;
  exportPdf(): void;
  print(): void;
  documentSetup(): void;
  undo(): void;
  redo(): void;
  cut(): void;
  copy(): void;
  paste(): void;
  pasteInPlace(): void;
  clear(): void;
  duplicate(): void;
  selectAll(): void;
  deselectAll(): void;
  addPage(): void;
  insertPages(): void;
  deletePage(): void;
  marginsColumns(): void;
  goPage(which: 'first' | 'prev' | 'next' | 'last'): void;
  fontSize(delta: number): void;
  insertPageNumber(): void;
  toggleHidden(): void;
  textFrameOptions(): void;
  transform(how: 'cw' | 'ccw' | '180' | 'flipH' | 'flipV'): void;
  arrange(how: Arrange): void;
  group(): void;
  ungroup(): void;
  lock(): void;
  unlockAll(): void;
  hide(): void;
  showAll(): void;
  fit(how: Fitting): void;
  cornerOptions(): void;
  zoomIn(): void;
  zoomOut(): void;
  fitPage(): void;
  fitSpread(): void;
  actualSize(): void;
  pasteboard(): void;
  togglePreview(): void;
  toggleFrameEdges(): void;
  toggleThreads(): void;
  toggleGuides(): void;
  toggleRulers(): void;
  toggleSnap(): void;
  togglePanel(id: PanelId): void;
  showControl(): void;
  shortcuts(): void;
  about(): void;
}

export interface MenuState {
  hasDoc: boolean;
  canUndo: boolean;
  canRedo: boolean;
  undoLabel: string;
  redoLabel: string;
  hasSelection: boolean;
  multiple: boolean;
  isGroup: boolean;
  hasContent: boolean;
  textFrame: boolean;
  typing: boolean;
  clipboard: boolean;
  preview: boolean;
  frameEdges: boolean;
  threads: boolean;
  guides: boolean;
  rulers: boolean;
  snap: boolean;
  hidden: boolean;
  panels: Record<PanelId, boolean>;
  control: boolean;
  pageCount: number;
}

export function PublisherMenus({ cmd, st }: { cmd: Commands; st: MenuState }) {
  const d = !st.hasDoc;
  const sel = !st.hasSelection;
  return (
    <Menubar className="h-7 shrink-0 gap-0.5 border-b border-[#232323] bg-[#323232] px-1">
      <MenubarMenu>
        <MenubarTrigger>File</MenubarTrigger>
        <MenubarContent>
          <MenubarSub>
            <MenubarSubTrigger>New</MenubarSubTrigger>
            <MenubarSubContent>
              <MenubarItem shortcut="Ctrl+N" onSelect={cmd.newDoc}>
                Document…
              </MenubarItem>
            </MenubarSubContent>
          </MenubarSub>
          <MenubarItem shortcut="Ctrl+O" onSelect={cmd.open}>
            Open…
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
          <MenubarItem shortcut="Ctrl+D" disabled={d} onSelect={cmd.place}>
            Place…
          </MenubarItem>
          <MenubarSub>
            <MenubarSubTrigger disabled={d}>Export</MenubarSubTrigger>
            <MenubarSubContent>
              <MenubarItem shortcut="Ctrl+E" onSelect={cmd.exportPng}>
                PNG…
              </MenubarItem>
              <MenubarItem onSelect={cmd.exportPdf}>Adobe PDF (Print)…</MenubarItem>
            </MenubarSubContent>
          </MenubarSub>
          <MenubarSeparator />
          <MenubarItem shortcut="Alt+Ctrl+P" disabled={d} onSelect={cmd.documentSetup}>
            Document Setup…
          </MenubarItem>
          <MenubarSeparator />
          <MenubarItem shortcut="Ctrl+P" disabled={d} onSelect={cmd.print}>
            Print…
          </MenubarItem>
        </MenubarContent>
      </MenubarMenu>

      <MenubarMenu>
        <MenubarTrigger>Edit</MenubarTrigger>
        <MenubarContent>
          <MenubarItem shortcut="Ctrl+Z" disabled={!st.canUndo} onSelect={cmd.undo}>
            {st.canUndo ? `Undo ${st.undoLabel}` : 'Can’t Undo'}
          </MenubarItem>
          <MenubarItem shortcut="Shift+Ctrl+Z" disabled={!st.canRedo} onSelect={cmd.redo}>
            {st.canRedo ? `Redo ${st.redoLabel}` : 'Can’t Redo'}
          </MenubarItem>
          <MenubarSeparator />
          <MenubarItem shortcut="Ctrl+X" disabled={sel && !st.typing} onSelect={cmd.cut}>
            Cut
          </MenubarItem>
          <MenubarItem shortcut="Ctrl+C" disabled={sel && !st.typing} onSelect={cmd.copy}>
            Copy
          </MenubarItem>
          <MenubarItem shortcut="Ctrl+V" disabled={d} onSelect={cmd.paste}>
            Paste
          </MenubarItem>
          <MenubarItem shortcut="Alt+Shift+Ctrl+V" disabled={d || !st.clipboard} onSelect={cmd.pasteInPlace}>
            Paste in Place
          </MenubarItem>
          <MenubarItem shortcut="Backspace" disabled={sel && !st.typing} onSelect={cmd.clear}>
            Clear
          </MenubarItem>
          <MenubarSeparator />
          <MenubarItem shortcut="Alt+Shift+Ctrl+D" disabled={sel} onSelect={cmd.duplicate}>
            Duplicate
          </MenubarItem>
          <MenubarSeparator />
          <MenubarItem shortcut="Ctrl+A" disabled={d} onSelect={cmd.selectAll}>
            Select All
          </MenubarItem>
          <MenubarItem shortcut="Shift+Ctrl+A" disabled={d} onSelect={cmd.deselectAll}>
            Deselect All
          </MenubarItem>
        </MenubarContent>
      </MenubarMenu>

      <MenubarMenu>
        <MenubarTrigger>Layout</MenubarTrigger>
        <MenubarContent>
          <MenubarSub>
            <MenubarSubTrigger disabled={d}>Pages</MenubarSubTrigger>
            <MenubarSubContent>
              <MenubarItem shortcut="Shift+Ctrl+P" onSelect={cmd.addPage}>
                Add Page
              </MenubarItem>
              <MenubarItem onSelect={cmd.insertPages}>Insert Pages…</MenubarItem>
              <MenubarItem disabled={st.pageCount < 2} onSelect={cmd.deletePage}>
                Delete Page
              </MenubarItem>
            </MenubarSubContent>
          </MenubarSub>
          <MenubarItem disabled={d} onSelect={cmd.marginsColumns}>
            Margins and Columns…
          </MenubarItem>
          <MenubarSeparator />
          <MenubarItem shortcut="Shift+Ctrl+PgUp" disabled={d} onSelect={() => cmd.goPage('first')}>
            First Page
          </MenubarItem>
          <MenubarItem shortcut="Shift+PgUp" disabled={d} onSelect={() => cmd.goPage('prev')}>
            Previous Page
          </MenubarItem>
          <MenubarItem shortcut="Shift+PgDn" disabled={d} onSelect={() => cmd.goPage('next')}>
            Next Page
          </MenubarItem>
          <MenubarItem shortcut="Shift+Ctrl+PgDn" disabled={d} onSelect={() => cmd.goPage('last')}>
            Last Page
          </MenubarItem>
        </MenubarContent>
      </MenubarMenu>

      <MenubarMenu>
        <MenubarTrigger>Type</MenubarTrigger>
        <MenubarContent>
          <MenubarItem shortcut="Shift+Ctrl+>" disabled={d} onSelect={() => cmd.fontSize(2)}>
            Increase Size
          </MenubarItem>
          <MenubarItem shortcut="Shift+Ctrl+<" disabled={d} onSelect={() => cmd.fontSize(-2)}>
            Decrease Size
          </MenubarItem>
          <MenubarSeparator />
          <MenubarItem shortcut="Ctrl+T" onSelect={() => cmd.togglePanel('character')}>
            Character
          </MenubarItem>
          <MenubarItem shortcut="Alt+Ctrl+T" onSelect={() => cmd.togglePanel('paragraph')}>
            Paragraph
          </MenubarItem>
          <MenubarItem shortcut="F11" onSelect={() => cmd.togglePanel('paraStyles')}>
            Paragraph Styles
          </MenubarItem>
          <MenubarItem shortcut="Shift+F11" onSelect={() => cmd.togglePanel('charStyles')}>
            Character Styles
          </MenubarItem>
          <MenubarSeparator />
          <MenubarSub>
            <MenubarSubTrigger disabled={!st.typing}>Insert Special Character</MenubarSubTrigger>
            <MenubarSubContent>
              <MenubarItem shortcut="Alt+Shift+Ctrl+N" onSelect={cmd.insertPageNumber}>
                Current Page Number
              </MenubarItem>
            </MenubarSubContent>
          </MenubarSub>
          <MenubarSeparator />
          <MenubarCheckboxItem shortcut="Alt+Ctrl+I" checked={st.hidden} disabled={d} onCheckedChange={cmd.toggleHidden}>
            Show Hidden Characters
          </MenubarCheckboxItem>
        </MenubarContent>
      </MenubarMenu>

      <MenubarMenu>
        <MenubarTrigger>Object</MenubarTrigger>
        <MenubarContent>
          <MenubarSub>
            <MenubarSubTrigger disabled={sel}>Transform</MenubarSubTrigger>
            <MenubarSubContent>
              <MenubarItem onSelect={() => cmd.transform('cw')}>Rotate 90° Clockwise</MenubarItem>
              <MenubarItem onSelect={() => cmd.transform('ccw')}>Rotate 90° Counter-clockwise</MenubarItem>
              <MenubarItem onSelect={() => cmd.transform('180')}>Rotate 180°</MenubarItem>
              <MenubarSeparator />
              <MenubarItem onSelect={() => cmd.transform('flipH')}>Flip Horizontal</MenubarItem>
              <MenubarItem onSelect={() => cmd.transform('flipV')}>Flip Vertical</MenubarItem>
            </MenubarSubContent>
          </MenubarSub>
          <MenubarSub>
            <MenubarSubTrigger disabled={sel}>Arrange</MenubarSubTrigger>
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
          <MenubarItem shortcut="Ctrl+G" disabled={!st.multiple} onSelect={cmd.group}>
            Group
          </MenubarItem>
          <MenubarItem shortcut="Shift+Ctrl+G" disabled={!st.isGroup} onSelect={cmd.ungroup}>
            Ungroup
          </MenubarItem>
          <MenubarItem shortcut="Ctrl+L" disabled={sel} onSelect={cmd.lock}>
            Lock
          </MenubarItem>
          <MenubarItem shortcut="Alt+Ctrl+L" disabled={d} onSelect={cmd.unlockAll}>
            Unlock All on Spread
          </MenubarItem>
          <MenubarItem shortcut="Ctrl+3" disabled={sel} onSelect={cmd.hide}>
            Hide
          </MenubarItem>
          <MenubarItem shortcut="Alt+Ctrl+3" disabled={d} onSelect={cmd.showAll}>
            Show All on Spread
          </MenubarItem>
          <MenubarSeparator />
          <MenubarSub>
            <MenubarSubTrigger disabled={!st.hasContent}>Fitting</MenubarSubTrigger>
            <MenubarSubContent>
              <MenubarItem shortcut="Alt+Shift+Ctrl+C" onSelect={() => cmd.fit('fill')}>
                Fill Frame Proportionally
              </MenubarItem>
              <MenubarItem shortcut="Alt+Shift+Ctrl+E" onSelect={() => cmd.fit('fit')}>
                Fit Content Proportionally
              </MenubarItem>
              <MenubarItem shortcut="Alt+Ctrl+C" onSelect={() => cmd.fit('frameToContent')}>
                Fit Frame to Content
              </MenubarItem>
              <MenubarItem shortcut="Alt+Ctrl+E" onSelect={() => cmd.fit('stretch')}>
                Fit Content to Frame
              </MenubarItem>
              <MenubarItem shortcut="Shift+Ctrl+E" onSelect={() => cmd.fit('center')}>
                Center Content
              </MenubarItem>
            </MenubarSubContent>
          </MenubarSub>
          <MenubarSeparator />
          <MenubarItem shortcut="Ctrl+B" disabled={!st.textFrame} onSelect={cmd.textFrameOptions}>
            Text Frame Options…
          </MenubarItem>
          <MenubarItem disabled={sel} onSelect={cmd.cornerOptions}>
            Corner Options…
          </MenubarItem>
        </MenubarContent>
      </MenubarMenu>

      <MenubarMenu>
        <MenubarTrigger>Table</MenubarTrigger>
        <MenubarContent>
          <MenubarItem disabled>Create Table…</MenubarItem>
          <MenubarItem disabled>Insert Table…</MenubarItem>
          <MenubarSeparator />
          <MenubarItem disabled>Tables show as a placeholder character for now.</MenubarItem>
        </MenubarContent>
      </MenubarMenu>

      <MenubarMenu>
        <MenubarTrigger>View</MenubarTrigger>
        <MenubarContent>
          <MenubarItem shortcut="Ctrl+=" disabled={d} onSelect={cmd.zoomIn}>
            Zoom In
          </MenubarItem>
          <MenubarItem shortcut="Ctrl+-" disabled={d} onSelect={cmd.zoomOut}>
            Zoom Out
          </MenubarItem>
          <MenubarItem shortcut="Ctrl+0" disabled={d} onSelect={cmd.fitPage}>
            Fit Page in Window
          </MenubarItem>
          <MenubarItem shortcut="Alt+Ctrl+0" disabled={d} onSelect={cmd.fitSpread}>
            Fit Spread in Window
          </MenubarItem>
          <MenubarItem shortcut="Ctrl+1" disabled={d} onSelect={cmd.actualSize}>
            Actual Size
          </MenubarItem>
          <MenubarItem shortcut="Alt+Shift+Ctrl+0" disabled={d} onSelect={cmd.pasteboard}>
            Entire Pasteboard
          </MenubarItem>
          <MenubarSeparator />
          <MenubarSub>
            <MenubarSubTrigger>Screen Mode</MenubarSubTrigger>
            <MenubarSubContent>
              <MenubarCheckboxItem checked={!st.preview} onCheckedChange={() => st.preview && cmd.togglePreview()}>
                Normal
              </MenubarCheckboxItem>
              <MenubarCheckboxItem shortcut="W" checked={st.preview} onCheckedChange={() => !st.preview && cmd.togglePreview()}>
                Preview
              </MenubarCheckboxItem>
            </MenubarSubContent>
          </MenubarSub>
          <MenubarSeparator />
          <MenubarSub>
            <MenubarSubTrigger>Extras</MenubarSubTrigger>
            <MenubarSubContent>
              <MenubarCheckboxItem shortcut="Ctrl+H" checked={st.frameEdges} onCheckedChange={cmd.toggleFrameEdges}>
                Show Frame Edges
              </MenubarCheckboxItem>
              <MenubarCheckboxItem shortcut="Alt+Ctrl+Y" checked={st.threads} onCheckedChange={cmd.toggleThreads}>
                Show Text Threads
              </MenubarCheckboxItem>
            </MenubarSubContent>
          </MenubarSub>
          <MenubarCheckboxItem shortcut="Ctrl+R" checked={st.rulers} onCheckedChange={cmd.toggleRulers}>
            Show Rulers
          </MenubarCheckboxItem>
          <MenubarSub>
            <MenubarSubTrigger>Grids &amp; Guides</MenubarSubTrigger>
            <MenubarSubContent>
              <MenubarCheckboxItem shortcut="Ctrl+;" checked={st.guides} onCheckedChange={cmd.toggleGuides}>
                Show Guides
              </MenubarCheckboxItem>
              <MenubarCheckboxItem shortcut="Shift+Ctrl+;" checked={st.snap} onCheckedChange={cmd.toggleSnap}>
                Snap to Guides
              </MenubarCheckboxItem>
            </MenubarSubContent>
          </MenubarSub>
        </MenubarContent>
      </MenubarMenu>

      <MenubarMenu>
        <MenubarTrigger>Window</MenubarTrigger>
        <MenubarContent>
          <MenubarCheckboxItem shortcut="Alt+Ctrl+6" checked={st.control} onCheckedChange={cmd.showControl}>
            Control
          </MenubarCheckboxItem>
          <MenubarSeparator />
          {(
            [
              ['character', 'Ctrl+T'],
              ['charStyles', 'Shift+F11'],
              ['color', 'F6'],
              ['layers', 'F7'],
              ['links', 'Shift+Ctrl+D'],
              ['pages', 'F12'],
              ['paragraph', 'Alt+Ctrl+T'],
              ['paraStyles', 'F11'],
              ['stroke', 'F10'],
              ['swatches', 'F5'],
              ['wrap', 'Alt+Ctrl+W'],
            ] as [PanelId, string][]
          ).map(([id, key]) => (
            <MenubarCheckboxItem key={id} shortcut={key} checked={st.panels[id]} onCheckedChange={() => cmd.togglePanel(id)}>
              {PANEL_NAMES[id]}
            </MenubarCheckboxItem>
          ))}
        </MenubarContent>
      </MenubarMenu>

      <MenubarMenu>
        <MenubarTrigger>Help</MenubarTrigger>
        <MenubarContent>
          <MenubarItem onSelect={cmd.shortcuts}>Keyboard Shortcuts…</MenubarItem>
          <MenubarItem onSelect={cmd.about}>About Publisher…</MenubarItem>
        </MenubarContent>
      </MenubarMenu>
    </Menubar>
  );
}
