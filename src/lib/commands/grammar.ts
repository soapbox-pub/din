import { GRAMMAR_DIALECTS, getGrammarBridge, ruleName, type GrammarDialect, type GrammarState } from '@/lib/grammar';
import { CommandError, type Area, type Param } from './types';
import { call, command, pick } from './util';

/**
 * `din grammar`: checking grammar as you type in every text field
 * (electron/grammar.mts), as Settings → Keyboard has it: on or off, style
 * suggestions, the dialect, the rules turned off from right-click menus,
 * and the issues ignored; and checking some text here.
 */

const grammar = () => {
  const bridge = getGrammarBridge();
  if (!bridge) throw new CommandError('Grammar checking isn’t available here');
  return bridge;
};

const ON: Param = { name: 'on', type: 'boolean', positional: true, help: 'on or off' };

function describe(state: GrammarState): string {
  const dialect = GRAMMAR_DIALECTS.find((d) => d.value === state.dialect)?.name ?? state.dialect;
  return [
    `Check as you type\t${state.enabled ? 'on' : 'off'}`,
    `Style suggestions\t${state.style ? 'on' : 'off'}`,
    `English\t${dialect}`,
    `Rules turned off\t${state.disabledRules.length ? state.disabledRules.join(', ') : 'none'}`,
    `Ignored issues\t${state.ignored}`,
  ].join('\n');
}

export const grammarArea: Area = {
  name: 'grammar',
  summary: 'Checking grammar as you type in every text field, as Settings → Keyboard has it, and checking some text',
  commands: [
    command('grammar', 'status', 'Whether it’s on, style suggestions, the dialect, and the rules turned off', [], async () => {
      const state = await call(grammar().state());
      return { data: state, text: describe(state) };
    }),
    command('grammar', 'check-as-you-type', 'Underline grammar problems in every text field as you type', [ON], async (args) => {
      const state = await call(grammar().configure({ enabled: args.bool('on') }));
      return { data: state, text: `Checking grammar as you type is ${state.enabled ? 'on' : 'off'}` };
    }),
    command('grammar', 'style', 'Suggest style improvements too: wordiness, redundancy, readability', [ON], async (args) => {
      const state = await call(grammar().configure({ style: args.bool('on') }));
      return { data: state, text: `Style suggestions are ${state.style ? 'on' : 'off'}` };
    }),
    command(
      'grammar',
      'dialect',
      'The English to check against',
      [{ name: 'dialect', type: 'string', positional: true, choices: GRAMMAR_DIALECTS.map((d) => d.value), help: 'Which English' }],
      async (args) => {
        const wanted = args.string('dialect').toLowerCase();
        const dialect = GRAMMAR_DIALECTS.find((d) => d.value === wanted || d.name.toLowerCase() === wanted);
        if (!dialect) throw new CommandError(`Pick one of ${GRAMMAR_DIALECTS.map((d) => d.value).join(', ')}`, 'usage');
        const state = await call(grammar().configure({ dialect: dialect.value as GrammarDialect }));
        return { data: state, text: `Checking ${dialect.name} English` };
      },
    ),
    command(
      'grammar',
      'rules',
      'The rules it checks, with what each looks for (only the ones turned off with --off)',
      [{ name: 'off', type: 'boolean', optional: true, help: 'Only the rules turned off' }],
      async (args) => {
        const [rules, state] = await Promise.all([call(grammar().rules()), call(grammar().state())]);
        const off = new Set(state.disabledRules);
        const shown = rules
          .filter((rule) => !args.optBool('off') || off.has(rule.name))
          .map((rule) => ({ ...rule, on: !off.has(rule.name) }));
        return {
          data: shown,
          text: shown.length
            ? shown.map((rule) => `${rule.name}\t${rule.on ? 'on' : 'off'}\t${rule.description}`).join('\n')
            : 'No rules are turned off',
        };
      },
    ),
    command(
      'grammar',
      'rule',
      'Turn one rule off, as a right-click menu’s Turn Off This Rule does, or back on',
      [{ name: 'rule', type: 'string', positional: true, help: 'The rule, by name (din grammar rules lists them)' }, ON],
      async (args) => {
        const rules = await call(grammar().rules());
        const rule = pick(rules, args.string('rule'), (r) => [r.name, ruleName(r.name)], 'rule');
        const on = args.bool('on');
        const state = await call(grammar().setRule(rule.name, on));
        return { data: state, text: `${ruleName(rule.name)} is ${on ? 'on' : 'off'}` };
      },
    ),
    command('grammar', 'forget-ignored', 'Underline again the issues you chose to ignore', [], async () => {
      const state = await call(grammar().forgetIgnored());
      return { data: state, text: 'Nothing is ignored now' };
    }),
    command(
      'grammar',
      'check',
      'Check some text, as text fields are checked, and say what’s wrong in it',
      [{ name: 'text', type: 'string', positional: true, rest: true, help: 'The text to check' }],
      async (args) => {
        const text = args.list('text').join(' ');
        if (!text.trim()) throw new CommandError('Missing text', 'usage');
        const issues = await call(grammar().check(text));
        return {
          data: issues,
          text: issues.length
            ? issues
                .map((i) => {
                  const fixes = i.suggestions.map((s) => s.label).join(' / ');
                  return `${i.start}-${i.end}\t“${i.text}”\t${i.message.replace(/`([^`]*)`/g, '“$1”')}${fixes ? `\t→ ${fixes}` : ''}`;
                })
                .join('\n')
            : 'Nothing to fix',
        };
      },
    ),
  ],
};
