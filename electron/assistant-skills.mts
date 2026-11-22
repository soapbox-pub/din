// The assistant's skills, for Settings → Assistant and `din assistant`:
// which folders OpenCode looks for them in, and which of them are on.
//
// Both are OpenCode's own configuration, in the user's global config file
// (~/.config/opencode/opencode.jsonc, or opencode.json), so what's set here
// holds in a Terminal's `opencode` too, and what was written there by hand
// shows here. Folders are its `skills` list. A skill that's off is a
// `permissions` rule denying it by its id, which hides it from the model and
// refuses loading it; the files stay where they are. OpenCode's API reads
// the config but changes none of this, so the file is edited in place with
// Microsoft's jsonc-parser (VS Code's), its comments and layout kept, and
// replaced whole (written beside it, then renamed over it) so a crash never
// leaves half a config. OpenCode watches it and takes the change without
// restarting.
//
// The skills themselves are asked of OpenCode's server (/api/skill), which
// knows what it found and which of two with the same id it took.
//
// Runs as TypeScript directly via Node's native type stripping - erasable
// syntax only, like the rest of electron/.

import fs from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import type { FormattingOptions, JSONPath, ParseError } from 'jsonc-parser';

const require = createRequire(import.meta.url);

const HOME = os.homedir();
const CONFIG_DIR = path.join(process.env.XDG_CONFIG_HOME || path.join(HOME, '.config'), 'opencode');
/** The global config's names, the later over the earlier where both exist. */
const CONFIG_FILES = ['opencode.json', 'opencode.jsonc'];
const SCHEMA = 'https://opencode.ai/config.json';
/** The skills DinOS comes with (os/configuration.nix). */
const DIN_SKILLS = '/etc/opencode/skills';
/** Where OpenCode looks without being told. */
const DEFAULT_FOLDERS = [path.join(CONFIG_DIR, 'skills'), path.join(HOME, '.claude/skills'), path.join(HOME, '.agents/skills')];

/** How long OpenCode has to take a change of folders in. */
const RELOAD_MS = 2_500;
const MAX_CONFIG_BYTES = 4 * 1024 * 1024;

export interface SkillInfo {
  id: string;
  name: string;
  description: string;
  /** Its SKILL.md, or `skill://…` for one built into OpenCode. */
  path: string;
  enabled: boolean;
}

export interface SkillSource {
  /**
   * `folder` and `catalog` are the user's, from the config; `default` is a
   * folder OpenCode looks in anyway; `din` and `opencode` come with them;
   * `other` is anything found elsewhere.
   */
  kind: 'folder' | 'catalog' | 'default' | 'din' | 'opencode' | 'other';
  /** As the config has it ("~/Documents/skills", a catalog's URL), for the user's. */
  entry: string | null;
  /** The folder, where it is one. */
  path: string | null;
  /** The folder isn't there. */
  missing: boolean;
  skills: SkillInfo[];
}

export interface SkillSettings {
  /** The config file changes are written to. */
  file: string;
  /** Why the config can't be read, when it can't; nothing can be changed until it's mended. */
  error: string | null;
  sources: SkillSource[];
}

export type SkillChange =
  | { op: 'addFolder'; path: string }
  | { op: 'removeFolder'; entry: string }
  | { op: 'setEnabled'; ids: string[]; enabled: boolean };

type Reply = { ok: true; status: number; data: unknown } | { ok: false; status: number; message: string };
/** A GET of OpenCode's API (assistant.mts). */
type Get = (apiPath: string) => Promise<Reply>;

type Config = Record<string, unknown>;

/** A config file: its text, and what it says. */
interface Doc {
  file: string;
  text: string;
  config: Config;
}

interface Rule {
  resource: string;
  effect: string;
}

let jsoncModule: typeof import('jsonc-parser') | null = null;

/**
 * The JSONC library, loaded the first time the skills are asked for: a
 * computer that never opens Settings → Assistant doesn't hold it.
 */
function jsonc(): typeof import('jsonc-parser') {
  jsoncModule ??= require('jsonc-parser') as typeof import('jsonc-parser');
  return jsoncModule;
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isObject(value: unknown): value is Config {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function parseDoc(file: string, text: string): Doc {
  const { parse, printParseErrorCode } = jsonc();
  const errors: ParseError[] = [];
  const config: unknown = parse(text, errors, { allowTrailingComma: true, disallowComments: false });
  if (errors.length > 0) {
    const [first] = errors;
    const line = text.slice(0, first.offset).split('\n').length;
    throw new Error(`${tildify(file)} can’t be read: ${printParseErrorCode(first.error)} on line ${line}`);
  }
  if (!isObject(config)) throw new Error(`${tildify(file)} isn’t a config`);
  return { file, text, config };
}

/** The global config files there are, the one that wins last. */
function readDocs(): Doc[] {
  const docs: Doc[] = [];
  for (const name of CONFIG_FILES) {
    const file = path.join(CONFIG_DIR, name);
    let text: string;
    try {
      if (fs.statSync(file).size > MAX_CONFIG_BYTES) throw new Error(`${tildify(file)} is too large`);
      text = fs.readFileSync(file, 'utf8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue;
      throw error;
    }
    docs.push(parseDoc(file, text));
  }
  return docs;
}

/** The file changes go to: the one that wins, or a new opencode.json. */
function primaryFile(docs: Doc[]): string {
  return docs.at(-1)?.file ?? path.join(CONFIG_DIR, CONFIG_FILES[0]);
}

function tildify(file: string): string {
  return file === HOME ? '~' : file.startsWith(`${HOME}/`) ? `~${file.slice(HOME.length)}` : file;
}

function isUrl(entry: string): boolean {
  return /^https?:\/\//i.test(entry);
}

/** Where a `skills` entry is: `~/` from home, and a relative one too (OpenCode takes it from wherever it's working). */
function resolveEntry(entry: string): string {
  if (entry === '~') return HOME;
  if (entry.startsWith('~/')) return path.join(HOME, entry.slice(2));
  return path.resolve(HOME, entry);
}

/** Where a config's `skills` lists are: the list itself, or an older config's `paths` and `urls`. */
function folderLists(config: Config): JSONPath[] {
  const skills = config.skills;
  if (Array.isArray(skills)) return [['skills']];
  if (!isObject(skills)) return [];
  return ['paths', 'urls'].filter((key) => Array.isArray(skills[key])).map((key) => ['skills', key]);
}

/** The value at a path of a config. */
function at(config: Config, where: JSONPath): unknown {
  let value: unknown = config;
  for (const key of where) value = (value as Record<string | number, unknown> | undefined)?.[key];
  return value;
}

function folderEntries(docs: Doc[]): string[] {
  const entries: string[] = [];
  for (const doc of docs) {
    for (const list of folderLists(doc.config)) {
      for (const item of at(doc.config, list) as unknown[]) {
        if (typeof item === 'string' && item && !entries.includes(item)) entries.push(item);
      }
    }
  }
  return entries;
}

/** A `permissions` entry that's about one skill, or skills by a pattern. */
function skillRule(item: unknown): Rule | null {
  if (!isObject(item)) return null;
  const { action, resource, effect } = item;
  if (typeof action !== 'string' || !matches(action, 'skill')) return null;
  if (typeof resource !== 'string' || (effect !== 'allow' && effect !== 'ask' && effect !== 'deny')) return null;
  return { resource, effect };
}

/**
 * The rules about skills, in the order OpenCode applies them (the last that
 * matches wins): each file's older `permission` object, then its
 * `permissions` list.
 */
function skillRules(docs: Doc[]): Rule[] {
  const rules: Rule[] = [];
  for (const doc of docs) {
    const legacy = doc.config.permission;
    const skill = isObject(legacy) ? legacy.skill : undefined;
    if (typeof skill === 'string') rules.push({ resource: '*', effect: skill });
    else if (isObject(skill)) {
      for (const [resource, effect] of Object.entries(skill)) {
        if (typeof effect === 'string') rules.push({ resource, effect });
      }
    }
    const list = doc.config.permissions;
    if (Array.isArray(list)) {
      for (const item of list) {
        const rule = skillRule(item);
        if (rule) rules.push(rule);
      }
    }
  }
  return rules;
}

function matches(pattern: string, id: string): boolean {
  if (pattern === id) return true;
  const expression = pattern.split(/([*?])/).map((part) =>
    part === '*' ? '.*' : part === '?' ? '.' : part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'),
  ).join('');
  return new RegExp(`^(?:${expression})$`, 's').test(id);
}

function isDenied(rules: Rule[], id: string): boolean {
  return rules.findLast((rule) => matches(rule.resource, id))?.effect === 'deny';
}

/** How a file is laid out, for what's added to it: its indent (two spaces where it doesn't say) and line ends. */
function formatting(text: string): FormattingOptions {
  const indent = /\n([ \t]+)"/.exec(text)?.[1] ?? '  ';
  const tabs = indent.startsWith('\t');
  return { insertSpaces: !tabs, tabSize: tabs ? 1 : indent.length, eol: text.includes('\r\n') ? '\r\n' : '\n' };
}

/**
 * Where a path really is, following links (to a file in the user's
 * dotfiles, say), even to one that isn't there yet.
 */
function realFile(file: string): string {
  let target = file;
  for (let hops = 0; hops < 40; hops++) {
    let link: string;
    try {
      link = fs.readlinkSync(target);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === 'EINVAL' || code === 'ENOENT') {
        // Not a link: its folder may be one, though.
        try {
          return path.join(fs.realpathSync(path.dirname(target)), path.basename(target));
        } catch {
          return target;
        }
      }
      throw error;
    }
    target = path.resolve(path.dirname(target), link);
  }
  throw new Error(`${tildify(file)} links in a circle`);
}

/**
 * Replace a config file whole: written beside where it really is (through
 * any link), then renamed over it, so a crash leaves the old one or the
 * new, never half of either, and a link stays a link. It keeps its mode.
 */
function write(file: string, text: string): void {
  const target = realFile(file);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  let mode: number | undefined;
  try {
    mode = fs.statSync(target).mode & 0o7777;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  const temp = path.join(path.dirname(target), `.${path.basename(target)}.${process.pid}.${Date.now()}.tmp`);
  try {
    const fd = fs.openSync(temp, 'wx', mode ?? 0o644);
    try {
      fs.writeFileSync(fd, text);
      if (mode !== undefined) fs.fchmodSync(fd, mode);
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    fs.renameSync(temp, target);
  } catch (error) {
    fs.rmSync(temp, { force: true });
    throw error;
  }
}

/**
 * The changes to make to config files, each file read once and written
 * once whatever is changed in it: so turning 22 skills off is one write,
 * and one reload of OpenCode's, not 22.
 */
class Edits {
  readonly docs = new Map<string, Doc>();
  private readonly changed = new Set<string>();

  constructor(docs: Doc[]) {
    for (const doc of docs) this.docs.set(doc.file, doc);
  }

  /** A file as it stands with the changes so far, a new config where there's no file. */
  doc(file: string): Doc {
    let doc = this.docs.get(file);
    if (!doc) {
      let text: string;
      try {
        text = fs.readFileSync(file, 'utf8');
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
        text = `{\n  "$schema": ${JSON.stringify(SCHEMA)}\n}\n`;
      }
      doc = parseDoc(file, text);
      this.docs.set(file, doc);
    }
    return doc;
  }

  /** Set (or with `undefined`, take out) what's at a path, or with `insert` add it to a list there. */
  private modify(file: string, where: JSONPath, value: unknown, insert = false): void {
    const { applyEdits, modify } = jsonc();
    const doc = this.doc(file);
    const text = applyEdits(doc.text, modify(doc.text, where, value, { formattingOptions: formatting(doc.text), isArrayInsertion: insert }));
    this.docs.set(file, parseDoc(file, text));
    this.changed.add(file);
  }

  /** Put text in a file, then check it still reads. */
  private splice(file: string, offset: number, length: number, content: string): void {
    const { text } = this.doc(file);
    this.docs.set(file, parseDoc(file, text.slice(0, offset) + content + text.slice(offset + length)));
    this.changed.add(file);
  }

  /**
   * Add an entry after the last in the list or object at `where`: on a line
   * of its own, indented as the last is, after the last's comma and any
   * comment on its line (which stays with it), and no other line touched.
   * False where the last shares its line with something else; jsonc-parser
   * lays that one out.
   */
  private appendAfterLast(file: string, where: JSONPath, entry: (indent: string, unit: string) => string): boolean {
    const { findNodeAtLocation, parseTree } = jsonc();
    const { text } = this.doc(file);
    const root = parseTree(text, [], { allowTrailingComma: true });
    const container = root && (where.length ? findNodeAtLocation(root, where) : root);
    const last = container?.children?.at(-1);
    if (!last) return false;
    const lineStart = text.lastIndexOf('\n', last.offset - 1) + 1;
    const indent = text.slice(lineStart, last.offset);
    if (!/^[ \t]*$/.test(indent)) return false;
    const end = last.offset + last.length;
    const rest = /^[ \t]*(,?)[ \t]*(?:\/\/[^\r\n]*)?(?=\r?\n)/.exec(text.slice(end));
    if (!rest) return false;
    const { eol, insertSpaces, tabSize } = formatting(text);
    const unit = insertSpaces ? ' '.repeat(tabSize ?? 2) : '\t';
    const comma = rest[1] === ',';
    // A comma after the last where it had none, then the new line, ending in
    // a comma where the last's did (a trailing one).
    if (!comma) this.splice(file, end, 0, ',');
    const lineEnd = end + rest[0].length + (comma ? 0 : 1);
    this.splice(file, lineEnd, 0, `${eol}${indent}${entry(indent, unit)}${comma ? ',' : ''}`);
    return true;
  }

  /** Add `value` to the end of the list at `where`, making the list where there's none. */
  append(file: string, where: JSONPath, value: unknown): void {
    const list = at(this.doc(file).config, where);
    if (list !== undefined && !Array.isArray(list)) throw new Error(`“${where.join('.')}” in ${tildify(file)} isn’t a list`);
    if (list === undefined) {
      const key = where.at(-1)!;
      const { eol } = formatting(this.doc(file).text);
      const made = this.appendAfterLast(file, where.slice(0, -1), (indent, unit) =>
        `${JSON.stringify(key)}: [${eol}${indent}${unit}${oneLine(value)}${eol}${indent}]`,
      );
      if (!made) this.modify(file, where, [value]);
    } else if (!this.appendAfterLast(file, where, () => oneLine(value))) {
      this.modify(file, [...where, -1], value, true);
    }
  }

  /**
   * Take out a list's item that has a line of its own, with the line (and a
   * comment on it, which was about it), no other line touched: the comma
   * before it goes too where it was the last and had none. False where it
   * shares its line; jsonc-parser takes that one out.
   */
  private removeLine(file: string, where: JSONPath, index: number): boolean {
    const { findNodeAtLocation, parseTree } = jsonc();
    const { text } = this.doc(file);
    const root = parseTree(text, [], { allowTrailingComma: true });
    const items = root && findNodeAtLocation(root, where)?.children;
    const item = items?.[index];
    if (!items || !item) return false;
    const lineStart = text.lastIndexOf('\n', item.offset - 1) + 1;
    if (!/^[ \t]*$/.test(text.slice(lineStart, item.offset))) return false;
    const end = item.offset + item.length;
    const rest = /^[ \t]*(,?)[ \t]*(?:\/\/[^\r\n]*)?\r?\n/.exec(text.slice(end));
    if (!rest) return false;
    this.splice(file, lineStart, end + rest[0].length - lineStart, '');
    const previous = items[index - 1];
    if (index === items.length - 1 && !rest[1] && previous) {
      const after = previous.offset + previous.length;
      const comma = /^[ \t]*,/.exec(text.slice(after, lineStart));
      if (comma) this.splice(file, after + comma[0].length - 1, 1, '');
    }
    return true;
  }

  /** Take out of the list at `where` every item `match` picks. */
  remove(file: string, where: JSONPath, match: (item: unknown) => boolean): void {
    const list = at(this.doc(file).config, where);
    if (!Array.isArray(list)) return;
    // The last first, so taking one out doesn't move the rest.
    for (let index = list.length - 1; index >= 0; index--) {
      if (match(list[index]) && !this.removeLine(file, where, index)) this.modify(file, [...where, index], undefined);
    }
  }

  /** Write every file that was changed. */
  save(): void {
    for (const file of this.changed) write(file, this.docs.get(file)!.text);
    this.changed.clear();
  }
}

/** A value as JSON on one line, an object's properties spaced as people write them: `{ "a": 1, "b": 2 }`. */
function oneLine(value: unknown): string {
  if (!isObject(value)) return JSON.stringify(value);
  return `{ ${Object.entries(value).map(([key, item]) => `${JSON.stringify(key)}: ${JSON.stringify(item)}`).join(', ')} }`;
}

function setEnabled(ids: string[], enabled: boolean): void {
  const docs = readDocs();
  const edits = new Edits(docs);
  const primary = primaryFile(docs);
  if (enabled) {
    const wanted = new Set(ids);
    const exactDeny = (item: unknown) =>
      isObject(item) && item.action === 'skill' && typeof item.resource === 'string' && wanted.has(item.resource) && item.effect === 'deny';
    for (const doc of docs) edits.remove(doc.file, ['permissions'], exactDeny);
    // Still off by a rule for more than these (or an older config's): ask
    // before loading them.
    const rules = skillRules([...edits.docs.values()]);
    for (const id of ids) {
      if (isDenied(rules, id)) edits.append(primary, ['permissions'], rule(id, 'ask'));
    }
  } else {
    const rules = skillRules(docs);
    for (const id of ids) {
      if (!isDenied(rules, id)) edits.append(primary, ['permissions'], rule(id, 'deny'));
    }
  }
  edits.save();
}

function rule(id: string, effect: 'ask' | 'deny'): Rule & { action: 'skill' } {
  return { action: 'skill', resource: id, effect };
}

function sameFolder(a: string, b: string): boolean {
  return path.resolve(a) === path.resolve(b);
}

function addFolder(folder: string): void {
  if (!path.isAbsolute(folder)) throw new Error('That isn’t a folder’s whole path');
  const target = path.resolve(folder);
  let stat: fs.Stats;
  try {
    stat = fs.statSync(target);
  } catch {
    throw new Error(`${tildify(target)} isn’t there`);
  }
  if (!stat.isDirectory()) throw new Error(`${tildify(target)} isn’t a folder`);
  const docs = readDocs();
  if ([DIN_SKILLS, ...DEFAULT_FOLDERS].some((known) => sameFolder(known, target))) {
    throw new Error(`OpenCode looks in ${tildify(target)} already`);
  }
  if (folderEntries(docs).some((entry) => !isUrl(entry) && sameFolder(resolveEntry(entry), target))) {
    throw new Error(`${tildify(target)} is one of the folders already`);
  }
  const edits = new Edits(docs);
  const file = primaryFile(docs);
  // An older config's `skills` is an object, its folders under `paths`.
  edits.append(file, isObject(edits.doc(file).config.skills) ? ['skills', 'paths'] : ['skills'], tildify(target));
  edits.save();
}

function removeFolder(entry: string): void {
  const docs = readDocs();
  if (!folderEntries(docs).includes(entry)) throw new Error(`${entry} isn’t one of the folders`);
  const edits = new Edits(docs);
  for (const doc of docs) {
    for (const list of folderLists(doc.config)) edits.remove(doc.file, list, (item) => item === entry);
  }
  edits.save();
}

interface ServerSkill {
  id: string;
  name: string;
  description: string;
  path: string;
}

async function serverSkills(get: Get): Promise<ServerSkill[]> {
  const reply = await get(`/api/skill?location%5Bdirectory%5D=${encodeURIComponent(HOME)}`);
  if (!reply.ok) throw new Error(reply.message);
  const data = (reply.data as { data?: unknown } | null)?.data;
  if (!Array.isArray(data)) throw new Error('OpenCode didn’t list its skills');
  const skills: ServerSkill[] = [];
  for (const item of data as Record<string, unknown>[]) {
    if (typeof item?.id !== 'string' || typeof item.path !== 'string') continue;
    skills.push({
      id: item.id,
      name: typeof item.name === 'string' && item.name ? item.name : item.id,
      description: typeof item.description === 'string' ? item.description : '',
      path: item.path,
    });
  }
  return skills;
}

function isUnder(file: string, folder: string): boolean {
  return file.startsWith(folder.endsWith('/') ? folder : `${folder}/`);
}

function exists(folder: string): boolean {
  try {
    return fs.statSync(folder).isDirectory();
  } catch {
    return false;
  }
}

/** The folders and the skills in each, and whether each is on. */
export async function skillSettings(get: Get): Promise<SkillSettings> {
  let docs: Doc[] = [];
  let error: string | null = null;
  try {
    docs = readDocs();
  } catch (e) {
    error = messageOf(e);
  }
  const rules = skillRules(docs);
  const sources: SkillSource[] = folderEntries(docs).map((entry) => {
    const folder = isUrl(entry) ? null : resolveEntry(entry);
    return { kind: folder ? 'folder' : 'catalog', entry, path: folder, missing: folder !== null && !exists(folder), skills: [] };
  });
  const fixed = (kind: SkillSource['kind'], folder: string | null): SkillSource => ({ kind, entry: null, path: folder, missing: false, skills: [] });
  const defaults = DEFAULT_FOLDERS.map((folder) => fixed('default', folder));
  const other = fixed('other', null);
  const din = fixed('din', DIN_SKILLS);
  const opencode = fixed('opencode', null);

  for (const skill of await serverSkills(get)) {
    const info: SkillInfo = { ...skill, enabled: !isDenied(rules, skill.id) };
    const source = skill.path.startsWith('skill://')
      ? opencode
      : isUnder(skill.path, DIN_SKILLS)
        ? din
        : // The deepest folder that holds it, where one is inside another.
          ([...sources, ...defaults]
            .filter((s) => s.path !== null && isUnder(skill.path, s.path))
            .sort((a, b) => (b.path?.length ?? 0) - (a.path?.length ?? 0))[0] ?? other);
    source.skills.push(info);
  }
  const all = [...sources, ...[...defaults, other, din, opencode].filter((source) => source.skills.length > 0)];
  for (const source of all) source.skills.sort((a, b) => a.name.localeCompare(b.name));
  return { file: primaryFile(docs), error, sources: all };
}

let queue: Promise<unknown> = Promise.resolve();

/** Make a change to the config, one at a time, and answer with how things stand after. */
export function changeSkills(get: Get, change: unknown): Promise<SkillSettings> {
  const run = queue.then(async () => {
    const c = change as SkillChange | null;
    if (c?.op === 'setEnabled' && typeof c.enabled === 'boolean' && Array.isArray(c.ids) && c.ids.length > 0 &&
      c.ids.every((id) => typeof id === 'string' && id.length > 0 && !/[*?\\]/.test(id))) {
      const known = new Set((await serverSkills(get)).map((skill) => skill.id));
      if (c.ids.some((id) => !known.has(id))) throw new Error('OpenCode no longer lists one of these skills');
      setEnabled([...new Set(c.ids)], c.enabled);
      return skillSettings(get);
    }
    if (c?.op !== 'addFolder' && c?.op !== 'removeFolder') throw new Error('Not a change to the skills');
    // OpenCode notices the file change in its own time: wait for its list to
    // say something else, though it won't for a folder with no skills in it.
    const before = JSON.stringify((await serverSkills(get)).map((skill) => skill.path));
    if (c.op === 'addFolder' && typeof c.path === 'string') addFolder(c.path);
    else if (c.op === 'removeFolder' && typeof c.entry === 'string') removeFolder(c.entry);
    else throw new Error('Not a change to the skills');
    const until = Date.now() + RELOAD_MS;
    for (;;) {
      await new Promise((resolve) => setTimeout(resolve, 250));
      const now = await serverSkills(get).catch(() => null);
      if ((now && JSON.stringify(now.map((skill) => skill.path)) !== before) || Date.now() > until) break;
    }
    return skillSettings(get);
  });
  queue = run.catch(() => {});
  return run;
}
