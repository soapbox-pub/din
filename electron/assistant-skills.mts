// The assistant's skills, for Settings → Assistant and `din assistant`:
// which folders OpenCode looks for them in, and which of them are on.
//
// Both are OpenCode's own configuration, in the user's global config file
// (~/.config/opencode/opencode.jsonc, or opencode.json), so what's set here
// holds in a Terminal's `opencode` too, and what was written there by hand
// shows here. Folders are its `skills` list. A skill that's off is a
// `permissions` rule denying it by its id, which hides it from the model and
// refuses loading it; the files stay where they are. OpenCode's API reads
// the config but changes none of this, so the file is edited in place
// (jsonc.mts), its comments and layout kept. OpenCode watches it and takes
// the change without restarting.
//
// The skills themselves are asked of OpenCode's server (/api/skill), which
// knows what it found and which of two with the same id it took.
//
// Runs as TypeScript directly via Node's native type stripping - erasable
// syntax only, like the rest of electron/.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { appendJsoncItem, jsoncProp, jsoncValue, parseJsonc, removeJsoncItem, setJsoncProp, type JsoncNode } from './jsonc.mts';

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

type ObjectNode = JsoncNode & { type: 'object' };
type ArrayNode = JsoncNode & { type: 'array' };

interface Doc {
  file: string;
  text: string;
  root: ObjectNode;
}

interface Rule {
  resource: string;
  effect: string;
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function parseDoc(file: string, text: string): Doc {
  let root: JsoncNode;
  try {
    root = parseJsonc(text);
  } catch (error) {
    throw new Error(`${tildify(file)} can’t be read: ${messageOf(error)}`, { cause: error });
  }
  if (root.type !== 'object') throw new Error(`${tildify(file)} isn’t a config`);
  return { file, text, root };
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

/** The lists of a config's `skills`: the list itself, or an older config's `paths` and `urls`. */
function folderLists(root: ObjectNode): ArrayNode[] {
  const skills = jsoncProp(root, 'skills');
  if (skills?.type === 'array') return [skills];
  if (skills?.type !== 'object') return [];
  return ['paths', 'urls'].map((key) => jsoncProp(skills, key)).filter((node): node is ArrayNode => node?.type === 'array');
}

function folderEntries(docs: Doc[]): string[] {
  const entries: string[] = [];
  for (const doc of docs) {
    for (const list of folderLists(doc.root)) {
      for (const item of list.items) {
        if (item.type === 'value' && typeof item.value === 'string' && item.value && !entries.includes(item.value)) entries.push(item.value);
      }
    }
  }
  return entries;
}

/** A `permissions` entry that's about one skill, or skills by a pattern. */
function skillRule(node: JsoncNode): Rule | null {
  if (node.type !== 'object') return null;
  const { action, resource, effect } = jsoncValue(node) as Record<string, unknown>;
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
    const legacy = jsoncProp(doc.root, 'permission');
    const skill = legacy ? jsoncProp(legacy, 'skill') : null;
    if (skill?.type === 'value' && typeof skill.value === 'string') rules.push({ resource: '*', effect: skill.value });
    else if (skill?.type === 'object') {
      for (const prop of skill.props) {
        if (prop.value.type === 'value' && typeof prop.value.value === 'string') rules.push({ resource: prop.key, effect: prop.value.value });
      }
    }
    const list = jsoncProp(doc.root, 'permissions');
    if (list?.type === 'array') {
      for (const item of list.items) {
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

/** The indent a file's properties have, two spaces where it doesn't say. */
function indentUnit(text: string): string {
  return /\n([ \t]+)"/.exec(text)?.[1] ?? '  ';
}

function write(file: string, text: string): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  // Written through, not renamed over: the file may be a link into the
  // user's dotfiles.
  fs.writeFileSync(file, text);
}

/** A file's text and what it parses to, a new config where there's no file. */
function open(file: string): Doc {
  let text: string;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    text = `{\n  "$schema": ${JSON.stringify(SCHEMA)}\n}\n`;
  }
  return parseDoc(file, text);
}

/** Add `json` to the list at `key` of a file's config, making the list where there's none. */
function appendTo(file: string, key: string, json: string, into?: (root: ObjectNode) => { object: ObjectNode; key: string } | null): void {
  const doc = open(file);
  const target = into?.(doc.root) ?? { object: doc.root, key };
  const list = jsoncProp(target.object, target.key);
  if (list && list.type !== 'array') throw new Error(`“${target.key}” in ${tildify(file)} isn’t a list`);
  const unit = indentUnit(doc.text);
  const depth = target.object === doc.root ? 1 : 2;
  const text = list
    ? appendJsoncItem(doc.text, list, json)
    : setJsoncProp(doc.text, target.object, target.key, `[\n${unit.repeat(depth + 1)}${json}\n${unit.repeat(depth)}]`);
  parseDoc(file, text);
  write(file, text);
}

/** Take out of a file's lists every item `match` picks, one at a time since each moves the rest. */
function removeFrom(file: string, lists: (root: ObjectNode) => ArrayNode[], match: (node: JsoncNode) => boolean): void {
  let doc = open(file);
  let changed = false;
  for (;;) {
    let next: string | null = null;
    for (const list of lists(doc.root)) {
      const index = list.items.findIndex(match);
      if (index >= 0) {
        next = removeJsoncItem(doc.text, list, index);
        break;
      }
    }
    if (next === null) break;
    doc = parseDoc(file, next);
    changed = true;
  }
  if (changed) write(file, doc.text);
}

function permissionLists(root: ObjectNode): ArrayNode[] {
  const list = jsoncProp(root, 'permissions');
  return list?.type === 'array' ? [list] : [];
}

function setEnabled(ids: string[], enabled: boolean): void {
  for (const id of ids) {
    const docs = readDocs();
    const primary = primaryFile(docs);
    const exactDeny = (node: JsoncNode) => {
      if (node.type !== 'object') return false;
      const rule = jsoncValue(node) as Record<string, unknown>;
      return rule.action === 'skill' && rule.resource === id && rule.effect === 'deny';
    };
    if (enabled) {
      for (const doc of docs) removeFrom(doc.file, permissionLists, exactDeny);
      // Still off by a rule for more than this one skill (or an older
      // config's): ask before loading this one.
      if (isDenied(skillRules(readDocs()), id)) appendTo(primary, 'permissions', ruleJson(id, 'ask'));
    } else if (!isDenied(skillRules(docs), id)) {
      appendTo(primary, 'permissions', ruleJson(id, 'deny'));
    }
  }
}

function ruleJson(id: string, effect: 'ask' | 'deny'): string {
  return `{ "action": "skill", "resource": ${JSON.stringify(id)}, "effect": "${effect}" }`;
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
  appendTo(primaryFile(docs), 'skills', JSON.stringify(tildify(target)), (root) => {
    // An older config's `skills` is an object, its folders under `paths`.
    const skills = jsoncProp(root, 'skills');
    return skills?.type === 'object' ? { object: skills, key: 'paths' } : null;
  });
}

function removeFolder(entry: string): void {
  const docs = readDocs();
  if (!folderEntries(docs).includes(entry)) throw new Error(`${entry} isn’t one of the folders`);
  for (const doc of docs) removeFrom(doc.file, folderLists, (node) => node.type === 'value' && node.value === entry);
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
