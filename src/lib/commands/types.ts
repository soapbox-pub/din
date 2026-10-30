import type { AppConfig } from '@/contexts/AppContext';
import type { InstalledAppsManager } from '@/contexts/InstalledAppsContext';
import type { WidgetsContextValue } from '@/contexts/WidgetsContext';
import type { WindowActions, WindowState } from '@/hooks/useWindows';

/**
 * The `din` command's commands (docs/din-command.md): everything a user can
 * do on the desktop, as `din <area> <verb> [arguments]`. They run in the
 * desktop, calling what its own UI calls, so the command, the Assistant's
 * tools and Settings can't come apart.
 */

export type ParamType = 'string' | 'number' | 'integer' | 'boolean' | 'path';

export interface Param {
  name: string;
  type: ParamType;
  help: string;
  /** Taken in order, without its name; otherwise it's `--name value` (or `--name` / `--no-name` for a boolean). */
  positional?: boolean;
  /** May be left out. */
  optional?: boolean;
  /** Takes every positional argument left (a string list). */
  rest?: boolean;
  choices?: readonly string[];
  min?: number;
  max?: number;
}

/** A command's arguments, parsed and checked against its params. */
export class Args {
  readonly values: Record<string, unknown>;
  constructor(values: Record<string, unknown>) {
    this.values = values;
  }
  has(name: string): boolean {
    return this.values[name] !== undefined;
  }
  string(name: string): string {
    const value = this.values[name];
    if (typeof value !== 'string') throw new CommandError(`Missing ${name}`, 'usage');
    return value;
  }
  optString(name: string): string | undefined {
    const value = this.values[name];
    return typeof value === 'string' ? value : undefined;
  }
  number(name: string): number {
    const value = this.values[name];
    if (typeof value !== 'number') throw new CommandError(`Missing ${name}`, 'usage');
    return value;
  }
  optNumber(name: string): number | undefined {
    const value = this.values[name];
    return typeof value === 'number' ? value : undefined;
  }
  bool(name: string): boolean {
    const value = this.values[name];
    if (typeof value !== 'boolean') throw new CommandError(`Missing ${name}`, 'usage');
    return value;
  }
  optBool(name: string): boolean | undefined {
    const value = this.values[name];
    return typeof value === 'boolean' ? value : undefined;
  }
  list(name: string): string[] {
    const value = this.values[name];
    return Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string') : [];
  }
}

/** What a command answers: data for `--json` and the Assistant, and text for people. */
export interface CommandResult {
  data?: unknown;
  /** Printed instead of the data, when given. */
  text?: string;
}

/** A failure to report: `usage` for a command used wrongly (exit 2), else it failed (exit 1). */
export class CommandError extends Error {
  readonly kind: 'usage' | 'failed';
  constructor(message: string, kind: 'usage' | 'failed' = 'failed') {
    super(message);
    this.kind = kind;
  }
}

/** The desktop as commands see it, always as it is now. */
export interface CommandContext {
  readonly config: AppConfig;
  updateConfig: (updater: (current: Partial<AppConfig>) => Partial<AppConfig>) => void;
  readonly windows: readonly WindowState[];
  readonly actions: WindowActions;
  readonly apps: InstalledAppsManager;
  readonly widgets: WidgetsContextValue;
  /** The workspace each monitor shows, by work area id. */
  readonly workspaces: Readonly<Record<string, number>>;
  /** The monitors' work area ids. */
  readonly monitors: readonly string[];
  /** The signed-in account's pubkey (hex). */
  readonly pubkey: string | undefined;
  /** Sign and publish an event as the signed-in account. */
  publish(template: { kind: number; content: string; tags: string[][] }): Promise<unknown>;
  /** Open a link as the desktop routes clicked ones (an installed app, the Web Browser, Mail…). */
  openUrl(url: string): void;
  /** Ask the user on screen; resolves with their answer. For what gives trust away or can't be undone. */
  confirm(request: { title: string; description: string; action: string; destructive?: boolean }): Promise<boolean>;
  /** Where the command was run, for relative paths; empty when unknown. */
  readonly cwd: string;
}

export interface Command {
  /** The area and verb, e.g. `['wifi', 'connect']`. */
  path: readonly [string, string];
  summary: string;
  params: readonly Param[];
  run(args: Args, ctx: CommandContext): Promise<CommandResult | void> | CommandResult | void;
  /**
   * Run by the `din` command itself rather than the desktop (it streams, or
   * holds a window open); listed here for help.
   */
  client?: boolean;
  /** The area's own command: `din <area> [arguments]` runs it too. */
  bare?: boolean;
}

export interface Area {
  name: string;
  summary: string;
  commands: Command[];
}

/** A command as `din help --json` and the Assistant's tools describe it. */
export interface CommandSpec {
  path: readonly [string, string];
  summary: string;
  params: readonly Param[];
  client?: boolean;
  bare?: boolean;
}
