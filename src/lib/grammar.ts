/**
 * Typed access to the Grammar bridge exposed by the Electron preload
 * (`window.dinos.grammar`, see electron/preload.cjs + electron/grammar.mts):
 * checking grammar as you type in every text field on Din, with Harper, on
 * this computer. Absent in a plain browser; callers feature-detect via
 * `getGrammarBridge()`.
 */

export type GrammarDialect = 'american' | 'british' | 'australian' | 'canadian' | 'indian';

export const GRAMMAR_DIALECTS: { value: GrammarDialect; name: string }[] = [
  { value: 'american', name: 'American' },
  { value: 'british', name: 'British' },
  { value: 'australian', name: 'Australian' },
  { value: 'canadian', name: 'Canadian' },
  { value: 'indian', name: 'Indian' },
];

export interface GrammarRule {
  /** Harper's name for it, in CamelCase. */
  name: string;
  description: string;
}

export interface GrammarSettings {
  /** Underline grammar as you type. */
  enabled: boolean;
  /** Style suggestions too: wordiness, redundancy, readability. */
  style: boolean;
  dialect: GrammarDialect;
  /** Rules turned off, by name. */
  disabledRules: string[];
}

export interface GrammarState extends GrammarSettings {
  /** How many issues are ignored. */
  ignored: number;
  disabledRuleInfo: GrammarRule[];
}

export interface GrammarIssue {
  start: number;
  end: number;
  text: string;
  message: string;
  kind: string;
  rule: string;
  suggestions: { label: string; replacement: string }[];
  hash: string;
}

export interface GrammarBridge {
  state(): Promise<GrammarState>;
  configure(change: Partial<Pick<GrammarSettings, 'enabled' | 'style' | 'dialect'>>): Promise<GrammarState>;
  setRule(name: string, on: boolean): Promise<GrammarState>;
  rules(): Promise<GrammarRule[]>;
  check(text: string): Promise<GrammarIssue[]>;
  forgetIgnored(): Promise<GrammarState>;
}

declare global {
  interface Dinos {
    /** Present only inside the Electron shell. */
    grammar?: GrammarBridge;
  }
}

/** The Grammar bridge, or undefined outside the Electron shell. */
export function getGrammarBridge(): GrammarBridge | undefined {
  if (typeof window === 'undefined') return undefined;
  return window.dinos?.grammar;
}

/** A rule's name for people: `TheirToTheyre` → “Their to theyre”. */
export function ruleName(name: string): string {
  const words = name
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')
    .toLowerCase();
  return words.charAt(0).toUpperCase() + words.slice(1);
}

/** Harper's descriptions quote with backticks; people read curly quotes. */
export function ruleDescription(description: string): string {
  return description.replace(/`([^`]*)`/g, '“$1”');
}
