import {
  bindWmShortcut, formatWmShortcut, parseWmShortcut, resetWmAction, unbindWmAction,
  wmAction, wmBindings, wmResetError, wmShortcutError, WM_ACTIONS,
} from '@/lib/wmBindings';
import { CommandError, type Area, type Param } from './types';
import { command } from './util';

const ACTION: Param = {
  name: 'action', type: 'string', positional: true, help: 'An action ID from din shortcuts list',
};

function findAction(id: string) {
  const action = wmAction(id);
  if (!action) throw new CommandError(`Unknown shortcut action: ${id}. See din shortcuts list.`, 'usage');
  return action;
}

export const shortcutsArea: Area = {
  name: 'shortcuts',
  summary: 'Customize Super shortcuts for tiling, windows and workspaces',
  commands: [
    command('shortcuts', 'list', 'List actions and their current shortcuts', [], (_args, ctx) => {
      const bindings = wmBindings(ctx.config.wmBindings);
      const rows = WM_ACTIONS.map(({ id, label }) => ({ id, label, shortcuts: bindings[id].map(formatWmShortcut) }));
      return { data: rows, text: rows.map(({ id, shortcuts }) => `${id}\t${shortcuts.join(' or ') || 'Not set'}`).join('\n') };
    }),
    command('shortcuts', 'bind', 'Change an action’s shortcut', [
      ACTION,
      { name: 'shortcut', type: 'string', positional: true, help: 'A chord such as Super+Shift+Y' },
    ], (args, ctx) => {
      const { id } = findAction(args.string('action'));
      const chord = parseWmShortcut(args.string('shortcut'));
      if (!chord) throw new CommandError('Enter a shortcut like Super+Shift+Y.', 'usage');
      const error = wmShortcutError(chord, id, ctx.config.wmBindings);
      if (error) throw new CommandError(error);
      ctx.updateConfig((current) => ({ ...current, wmBindings: bindWmShortcut(current.wmBindings, id, chord) }));
      return { text: `${id} = ${formatWmShortcut(chord)}` };
    }),
    command('shortcuts', 'clear', 'Leave an action without a shortcut', [ACTION], (args, ctx) => {
      const { id } = findAction(args.string('action'));
      ctx.updateConfig((current) => ({ ...current, wmBindings: unbindWmAction(current.wmBindings, id) }));
    }),
    command('shortcuts', 'reset', 'Restore the default for an action, or for all actions', [
      { ...ACTION, optional: true },
    ], (args, ctx) => {
      const id = args.optString('action');
      if (!id) {
        ctx.updateConfig((current) => ({ ...current, wmBindings: {} }));
        return;
      }
      const action = findAction(id);
      const error = wmResetError(action, ctx.config.wmBindings);
      if (error) throw new CommandError(error);
      ctx.updateConfig((current) => ({ ...current, wmBindings: resetWmAction(current.wmBindings, id) }));
    }),
  ],
};
