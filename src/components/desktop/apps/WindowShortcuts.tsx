import { useState, type KeyboardEvent } from 'react';
import { ChevronRight, Eraser, RotateCcw } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { ContextMenu, ContextMenuContent, ContextMenuItem, ContextMenuTrigger } from '@/components/ui/context-menu';
import { useAppContext } from '@/hooks/useAppContext';
import {
  bindWmShortcut, formatWmShortcut, isWmFamily, replaceWmShortcut, resetWmAction, unbindWmAction,
  wmBindings, wmResetError, wmShortcutError, wmShortcutKeys, wmShortcutOf, wmShortcutOwner, WM_FIXED_HELP, WM_GROUPS,
  type WmAction, type WmOverrides,
} from '@/lib/wmBindings';
import { settingsGroup } from '@/shared/settingsChromeStyles';
import { SettingsSubHeading } from '@/shared/settingsSection';

function Keycaps({ keys }: { keys: string[] }) {
  return (
    <span className="inline-flex flex-wrap items-center gap-1">
      {keys.map((key) => (
        <kbd key={key} className="rounded-md bg-foreground/[0.07] px-1.5 py-0.5 font-sans text-xs">
          {key}
        </kbd>
      ))}
    </span>
  );
}

function ShortcutRow({
  action, keys, overrides, change,
}: {
  action: WmAction;
  keys: string[];
  overrides: WmOverrides;
  change: (update: (current: WmOverrides | undefined) => WmOverrides) => void;
}) {
  const [recording, setRecording] = useState(false);
  const [error, setError] = useState<string | null>(null);
  /** A shortcut pressed that another action has, offered to take from it. */
  const [conflict, setConflict] = useState<{ chord: string; owner: WmAction } | null>(null);
  const customized = Object.hasOwn(overrides, action.id);

  function show(problem: string | null) {
    setError(problem);
    setConflict(null);
  }

  function clear() {
    show(null);
    change((current) => unbindWmAction(current, action.id));
  }

  function capture(event: KeyboardEvent<HTMLButtonElement>) {
    if (!recording || (event.key === 'Tab' && !event.metaKey)) return;
    event.preventDefault();
    event.stopPropagation();
    if (event.repeat) return;
    if (event.key === 'Escape' && !event.metaKey) {
      setRecording(false);
      show(null);
      return;
    }
    if ((event.key === 'Backspace' || event.key === 'Delete') && !event.metaKey) {
      clear();
      setRecording(false);
      return;
    }
    if (['Meta', 'Control', 'Alt', 'Shift'].includes(event.key)) return;
    const chord = wmShortcutOf({ code: event.code, shift: event.shiftKey, ctrl: event.ctrlKey, alt: event.altKey });
    if (!event.metaKey) return show('Hold Super and press another key.');
    if (!chord) return show('That key cannot be used in a shortcut.');
    const owner = wmShortcutOwner(chord, action.id, overrides);
    const problem = wmShortcutError(chord, action.id, overrides);
    if (owner) {
      setError(problem);
      setConflict({ chord, owner });
      return;
    }
    if (problem) return show(problem);
    change((current) => bindWmShortcut(current, action.id, chord));
    show(null);
    setRecording(false);
  }

  function replace() {
    if (!conflict) return;
    const { chord } = conflict;
    change((current) => replaceWmShortcut(current, action.id, chord));
    show(null);
    setRecording(false);
  }

  function reset() {
    const problem = wmResetError(action, overrides);
    show(problem);
    if (!problem) change((current) => resetWmAction(current, action.id));
  }

  return (
    <ContextMenu>
      <ContextMenuTrigger asChild disabled={recording}>
        <div className="flex flex-col gap-1 px-4 py-2">
          <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1">
            <span className="text-sm">{action.label}</span>
            <div className="flex flex-wrap items-center gap-1">
              <Button
                type="button"
                variant="outline"
                size="sm"
                aria-label={`Change shortcut for ${action.label}: ${keys.map(formatWmShortcut).join(' or ') || 'Not set'}`}
                data-recording-wm-shortcut={recording ? '' : undefined}
                onClick={(event) => {
                  event.currentTarget.focus();
                  show(null);
                  setRecording(!recording);
                }}
                onBlur={() => setRecording(false)}
                onKeyDown={capture}
              >
                {recording ? 'Press shortcut…' : keys.length === 0 ? 'Not set' : keys.map((key, i) => (
                  <span key={key} className="inline-flex items-center gap-1">
                    {i > 0 && <span className="text-muted-foreground">/</span>}
                    <Keycaps keys={wmShortcutKeys(key)} />
                  </span>
                ))}
              </Button>
              {customized && <Button variant="ghost" size="sm" aria-label={`Reset shortcut for ${action.label}`} onClick={reset}>Reset</Button>}
            </div>
          </div>
          {recording && !error && (
            <p role="status" className="text-xs text-muted-foreground">
              Hold Super and press a key. Backspace clears the shortcut; Esc cancels.
            </p>
          )}
          {error && (
            <div role="alert" className="flex flex-wrap items-center gap-x-2 gap-y-1">
              <p className="text-xs text-destructive">{error}</p>
              {conflict && (
                <Button variant="outline" size="sm" onMouseDown={(event) => event.preventDefault()} onClick={replace}>
                  Use {formatWmShortcut(conflict.chord)} here instead
                </Button>
              )}
            </div>
          )}
        </div>
      </ContextMenuTrigger>
      <ContextMenuContent>
        <ContextMenuItem disabled={!keys.length} onSelect={clear}>
          <Eraser />
          Clear shortcut
        </ContextMenuItem>
        <ContextMenuItem disabled={!customized} onSelect={reset}>
          <RotateCcw />
          Restore default
        </ContextMenuItem>
      </ContextMenuContent>
    </ContextMenu>
  );
}

export function WindowShortcuts() {
  const { config, updateConfig } = useAppContext();
  const overrides = config.wmBindings;
  const bindings = wmBindings(overrides);
  const change = (update: (current: WmOverrides | undefined) => WmOverrides) =>
    updateConfig((current) => ({ ...current, wmBindings: update(current.wmBindings) }));
  const renderRow = (action: WmAction) =>
    <ShortcutRow key={action.id} action={action} keys={bindings[action.id]} overrides={overrides} change={change} />;

  return (
    <>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <SettingsSubHeading>Keyboard shortcuts</SettingsSubHeading>
        {Object.keys(overrides).length > 0 && <Button variant="outline" size="sm" onClick={() => change(() => ({}))}>Reset all shortcuts</Button>}
      </div>
      <p className="text-sm text-muted-foreground">
        Select a shortcut to change it. Use Super (the Windows or Command key), with Shift, Ctrl, or Alt if you like.
        Backspace clears it while it’s waiting for keys, or right-click a row.
      </p>
      {WM_GROUPS.map(({ group, rows }) => (
        <div key={group} className="flex flex-col gap-2">
          <SettingsSubHeading>{group}</SettingsSubHeading>
          <div className={settingsGroup}>
            {rows.map((row) => isWmFamily(row) ? (
              <details key={row.label} className="group">
                <summary className="flex cursor-pointer list-none flex-wrap items-center gap-2 px-4 py-2 text-sm hover:bg-foreground/5">
                  <ChevronRight className="size-4 shrink-0 group-open:rotate-90" aria-hidden />
                  <span className="mr-auto">{row.label}</span>
                  {row.actions.some(({ id }) => Object.hasOwn(overrides, id))
                    ? <span className="text-xs text-muted-foreground">Customized</span>
                    : <Keycaps keys={row.keys} />}
                </summary>
                <div className="border-t border-border/70 [&>*+*]:border-t [&>*+*]:border-border/70">{row.actions.map(renderRow)}</div>
              </details>
            ) : renderRow(row))}
          </div>
        </div>
      ))}
      {WM_FIXED_HELP.map(({ group, bindings }) => (
        <div key={group} className="flex flex-col gap-2">
          <SettingsSubHeading>{group}</SettingsSubHeading>
          <div className={settingsGroup}>
            {bindings.map(({ keys, label }) => (
              <div key={label} className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1 px-4 py-2">
                <span className="text-sm">{label}</span>
                <Keycaps keys={keys} />
              </div>
            ))}
          </div>
        </div>
      ))}
    </>
  );
}
