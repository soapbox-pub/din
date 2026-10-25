import { ContextMenu as CM } from 'radix-ui';
import { ChevronRight } from 'lucide-react';
import { portalContainer } from '@/lib/portalContainer';
import { cn } from '@/lib/utils';
import type { Commands, MenuState } from './menus';

/** The canvas's right-click menu, as Illustrator's: undo, grouping, transform, arrange, select. */

const CONTENT = 'z-50 min-w-52 rounded-md border border-[#1c1c1c] bg-[#3a3a3a] p-1 text-xs text-[#e0e0e0] shadow-xl shadow-black/40';
const ITEM = cn(
  'relative flex h-6 cursor-default items-center rounded-[3px] pr-2 pl-6 outline-none select-none',
  'data-[highlighted]:bg-[#2d8ceb] data-[highlighted]:text-white data-[disabled]:text-[#7a7a7a]',
);

function Item({ children, onSelect, disabled }: { children: React.ReactNode; onSelect: () => void; disabled?: boolean }) {
  return (
    <CM.Item className={ITEM} onSelect={onSelect} disabled={disabled}>
      {children}
    </CM.Item>
  );
}

function Sub({ label, children, disabled }: { label: string; children: React.ReactNode; disabled?: boolean }) {
  return (
    <CM.Sub>
      <CM.SubTrigger disabled={disabled} className={cn(ITEM, 'data-[state=open]:bg-[#4a4a4a]')}>
        {label}
        <ChevronRight className="ml-auto size-3.5" />
      </CM.SubTrigger>
      <CM.Portal container={portalContainer()}>
        <CM.SubContent className={CONTENT}>{children}</CM.SubContent>
      </CM.Portal>
    </CM.Sub>
  );
}

const Sep = () => <CM.Separator className="mx-1 my-1 h-px bg-[#2a2a2a]" />;

export function CanvasMenu({ cmd, st, children }: { cmd: Commands; st: MenuState; children: React.ReactNode }) {
  const ns = !st.hasSelection;
  return (
    <CM.Root>
      <CM.Trigger asChild>{children}</CM.Trigger>
      <CM.Portal container={portalContainer()}>
        <CM.Content className={CONTENT}>
          <Item onSelect={cmd.undo} disabled={!st.canUndo}>
            Undo{st.undoLabel ? ` ${st.undoLabel}` : ''}
          </Item>
          <Item onSelect={cmd.redo} disabled={!st.canRedo}>
            Redo{st.redoLabel ? ` ${st.redoLabel}` : ''}
          </Item>
          <Sep />
          {st.groupSelected && <Item onSelect={cmd.ungroup}>Ungroup</Item>}
          {st.multiple && <Item onSelect={cmd.group}>Group</Item>}
          {st.multiple && <Item onSelect={cmd.join}>Join</Item>}
          {st.multiple && <Item onSelect={cmd.makeClip}>Make Clipping Mask</Item>}
          {st.clipSelected && <Item onSelect={cmd.releaseClip}>Release Clipping Mask</Item>}
          {st.compoundSelected && <Item onSelect={cmd.releaseCompound}>Release Compound Path</Item>}
          {st.textSelected && <Item onSelect={cmd.createOutlines}>Create Outlines</Item>}
          <Sub label="Transform" disabled={ns}>
            <Item onSelect={cmd.transformAgain} disabled={!st.canTransformAgain}>
              Transform Again
            </Item>
            <Sep />
            <Item onSelect={() => cmd.transformDialog('move')}>Move…</Item>
            <Item onSelect={() => cmd.transformDialog('rotate')}>Rotate…</Item>
            <Item onSelect={() => cmd.transformDialog('reflect')}>Reflect…</Item>
            <Item onSelect={() => cmd.transformDialog('scale')}>Scale…</Item>
            <Item onSelect={() => cmd.transformDialog('shear')}>Shear…</Item>
          </Sub>
          <Sub label="Arrange" disabled={ns}>
            <Item onSelect={() => cmd.arrange('front')}>Bring to Front</Item>
            <Item onSelect={() => cmd.arrange('forward')}>Bring Forward</Item>
            <Item onSelect={() => cmd.arrange('backward')}>Send Backward</Item>
            <Item onSelect={() => cmd.arrange('back')}>Send to Back</Item>
          </Sub>
          <Sub label="Select" disabled={!st.hasDoc}>
            <Item onSelect={() => cmd.nextObject(1)} disabled={ns}>
              Next Object Above
            </Item>
            <Item onSelect={() => cmd.nextObject(-1)} disabled={ns}>
              Next Object Below
            </Item>
          </Sub>
          <Sep />
          <Item onSelect={cmd.cut} disabled={ns}>
            Cut
          </Item>
          <Item onSelect={cmd.copy} disabled={ns}>
            Copy
          </Item>
          <Item onSelect={() => cmd.paste('normal')} disabled={!st.hasDoc}>
            Paste
          </Item>
        </CM.Content>
      </CM.Portal>
    </CM.Root>
  );
}
