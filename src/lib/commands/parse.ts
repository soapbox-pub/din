import { Args, CommandError, type Area, type Command, type CommandSpec, type Param } from './types';

/**
 * The command line, desktop side: which command `din …` names, its
 * arguments checked against its params, its help, and its answer as text.
 * The `din` client only carries argv here and the answer back.
 */

const TRUE = new Set(['on', 'true', 'yes', '1', 'enable', 'enabled']);
const FALSE = new Set(['off', 'false', 'no', '0', 'disable', 'disabled']);

/** A path made absolute against where the command ran. */
export function resolvePath(path: string, cwd: string): string {
  if (path.startsWith('/') || path.startsWith('~') || !cwd) return path;
  const parts = `${cwd}/${path}`.split('/');
  const out: string[] = [];
  for (const part of parts) {
    if (part === '' || part === '.') continue;
    if (part === '..') out.pop();
    else out.push(part);
  }
  return `/${out.join('/')}`;
}

/** An argument as its param takes it, or a usage error saying why not. */
export function coerce(param: Param, raw: string, cwd: string): unknown {
  const label = param.positional ? `<${param.name}>` : `--${param.name}`;
  if (param.type === 'boolean') {
    const word = raw.toLowerCase();
    if (TRUE.has(word)) return true;
    if (FALSE.has(word)) return false;
    throw new CommandError(`${label} takes on or off, not ${raw}`, 'usage');
  }
  if (param.type === 'number' || param.type === 'integer') {
    const value = Number(raw.replace(/%$/, ''));
    if (raw.trim() === '' || !Number.isFinite(value)) throw new CommandError(`${label} takes a number, not ${raw}`, 'usage');
    if (param.type === 'integer' && !Number.isInteger(value)) throw new CommandError(`${label} takes a whole number, not ${raw}`, 'usage');
    if (param.min !== undefined && value < param.min) throw new CommandError(`${label} is at least ${param.min}`, 'usage');
    if (param.max !== undefined && value > param.max) throw new CommandError(`${label} is at most ${param.max}`, 'usage');
    return value;
  }
  if (param.choices && !param.choices.includes(raw)) {
    throw new CommandError(`${label} is one of ${param.choices.join(', ')}; not ${raw}`, 'usage');
  }
  return param.type === 'path' ? resolvePath(raw, cwd) : raw;
}

/** Check structured arguments (the Assistant's tools send these) against a command's params. */
export function checkArgs(command: Command, input: Record<string, unknown>, cwd: string): Args {
  const values: Record<string, unknown> = {};
  for (const param of command.params) {
    const value = input[param.name];
    if (value === undefined || value === null) continue;
    if (param.rest) {
      if (!Array.isArray(value)) throw new CommandError(`${param.name} takes a list`, 'usage');
      values[param.name] = value.map((v) => coerce(param, String(v), cwd));
    } else {
      values[param.name] = coerce(param, String(value), cwd);
    }
  }
  for (const name of Object.keys(input)) {
    if (!command.params.some((p) => p.name === name)) throw new CommandError(`Unknown argument: ${name}`, 'usage');
  }
  return required(command, values);
}

function required(command: Command, values: Record<string, unknown>): Args {
  for (const param of command.params) {
    if (!param.optional && !param.rest && values[param.name] === undefined) {
      throw new CommandError(`Missing ${param.positional ? `<${param.name}>` : `--${param.name}`}\nUsage: ${usage(command)}`, 'usage');
    }
  }
  return new Args(values);
}

/** Parse a command's argv: positionals in order, `--name value`, `--name=value`, `--flag`, `--no-flag`. */
export function parseArgv(command: Command, argv: readonly string[], cwd: string): Args {
  const values: Record<string, unknown> = {};
  const positionals = command.params.filter((p) => p.positional);
  const rest: string[] = [];
  let next = 0;
  let flags = true;
  const named = (name: string) => command.params.find((p) => !p.positional && p.name === name);

  for (let i = 0; i < argv.length; i++) {
    const token = argv[i];
    if (flags && token === '--') {
      flags = false;
      continue;
    }
    // A flag, but not a negative number.
    if (flags && token.startsWith('--')) {
      const [rawName, inline] = token.slice(2).split(/=(.*)/s, 2) as [string, string | undefined];
      const param = named(rawName);
      if (!param && rawName.startsWith('no-')) {
        const negated = named(rawName.slice(3));
        if (negated?.type === 'boolean' && inline === undefined) {
          values[negated.name] = false;
          continue;
        }
      }
      if (!param) throw new CommandError(`Unknown option: --${rawName}\nUsage: ${usage(command)}`, 'usage');
      if (param.type === 'boolean' && inline === undefined) {
        values[param.name] = true;
        continue;
      }
      const raw = inline ?? argv[++i];
      if (raw === undefined) throw new CommandError(`--${param.name} needs a value`, 'usage');
      values[param.name] = coerce(param, raw, cwd);
      continue;
    }
    if (flags && /^-[A-Za-z]/.test(token)) throw new CommandError(`Unknown option: ${token}\nUsage: ${usage(command)}`, 'usage');
    const param = positionals[next];
    if (!param) throw new CommandError(`Too many arguments: ${token}\nUsage: ${usage(command)}`, 'usage');
    if (param.rest) {
      rest.push(coerce(param, token, cwd) as string);
      continue;
    }
    values[param.name] = coerce(param, token, cwd);
    next++;
  }
  const restParam = positionals.find((p) => p.rest);
  if (restParam) values[restParam.name] = rest;
  return required(command, values);
}

// ---------------------------------------------------------------------------
// Help
// ---------------------------------------------------------------------------

function placeholder(param: Param): string {
  if (param.choices && param.choices.length <= 4) return param.choices.join('|');
  if (param.type === 'boolean') return 'on|off';
  return param.name;
}

export function usage(command: Command): string {
  const parts = [command.bare ? `din ${command.path[0]}` : `din ${command.path.join(' ')}`];
  for (const param of command.params) {
    if (param.positional) {
      const shown = `<${placeholder(param)}>${param.rest ? '…' : ''}`;
      parts.push(param.optional || param.rest ? `[${shown}]` : shown);
    } else {
      const shown = param.type === 'boolean' ? `--${param.name}` : `--${param.name} <${placeholder(param)}>`;
      parts.push(param.optional ? `[${shown}]` : shown);
    }
  }
  return parts.join(' ');
}

function columns(rows: [string, string][], indent = '  '): string {
  const width = Math.min(32, Math.max(0, ...rows.map(([left]) => left.length)));
  return rows.map(([left, right]) => (right ? `${indent}${left.padEnd(width)}  ${right}` : `${indent}${left}`)).join('\n');
}

export function overviewHelp(areas: readonly Area[]): string {
  return [
    'Usage: din <area> <command> [arguments]   (din <area> lists its commands)',
    '',
    'Everything you can do on Din, from a shell. Add --json for structured output.',
    '',
    'Areas:',
    columns(areas.map((area) => [area.name, area.summary])),
    '',
    'din help <area> [<command>] tells more.',
  ].join('\n');
}

export function areaHelp(area: Area): string {
  return [
    `din ${area.name}: ${area.summary}`,
    '',
    columns(area.commands.map((command) => [command.bare ? `${command.path[1]} (or din ${area.name})` : command.path[1], command.summary])),
    '',
    `din help ${area.name} <command> shows its arguments.`,
  ].join('\n');
}

export function commandHelp(command: Command): string {
  const lines = [`Usage: ${usage(command)}`, '', command.summary];
  if (command.params.length > 0) {
    lines.push('', columns(command.params.map((param) => {
      const label = param.positional ? `<${param.name}>` : `--${param.name}`;
      const extra = [
        param.choices && param.choices.length > 4 ? `one of ${param.choices.join(', ')}` : '',
        param.min !== undefined && param.max !== undefined ? `${param.min} to ${param.max}` : '',
      ].filter(Boolean).join('; ');
      return [label, extra ? `${param.help} (${extra})` : param.help];
    })));
  }
  return lines.join('\n');
}

export function specOf(command: Command): CommandSpec {
  return {
    path: command.path, summary: command.summary, params: command.params,
    ...(command.client ? { client: true } : {}), ...(command.bare ? { bare: true } : {}),
  };
}

// ---------------------------------------------------------------------------
// Output
// ---------------------------------------------------------------------------

function cell(value: unknown): string {
  if (value === null || value === undefined) return '';
  if (typeof value === 'boolean') return value ? 'yes' : 'no';
  if (typeof value === 'object') return JSON.stringify(value);
  return String(value);
}

/** Data as text: a list of records as a table, a record as `key: value` lines. */
export function formatData(data: unknown): string {
  if (data === undefined || data === null) return '';
  if (Array.isArray(data)) {
    if (data.length === 0) return '(none)';
    if (data.every((row) => typeof row === 'object' && row !== null && !Array.isArray(row))) {
      const keys = [...new Set(data.flatMap((row) => Object.keys(row as object)))];
      const rows = data.map((row) => keys.map((key) => cell((row as Record<string, unknown>)[key])));
      const widths = keys.map((key, i) => Math.max(key.length, ...rows.map((row) => row[i].length)));
      const line = (values: string[]) => values.map((v, i) => (i === values.length - 1 ? v : v.padEnd(widths[i]))).join('  ').trimEnd();
      return [line(keys.map((k) => k.toUpperCase())), ...rows.map(line)].join('\n');
    }
    return data.map(cell).join('\n');
  }
  if (typeof data === 'object') {
    const entries = Object.entries(data as Record<string, unknown>).filter(([, v]) => v !== undefined);
    const width = Math.max(0, ...entries.map(([k]) => k.length));
    return entries.map(([k, v]) => `${`${k}:`.padEnd(width + 1)} ${cell(v)}`).join('\n');
  }
  return cell(data);
}
