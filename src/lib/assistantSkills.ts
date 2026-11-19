import { tildify, type SkillInfo, type SkillSource } from '@/lib/assistant';

/**
 * How Settings → Assistant and `din assistant skills` word the assistant's
 * skills (electron/assistant-skills.mts keeps them).
 */

/** The query both read, and changes refresh. */
export const SKILLS_QUERY_KEY = ['assistant', 'skills'] as const;

/** What a source of skills is called: its folder, or who it came with. */
export function skillSourceName(source: SkillSource, home: string | undefined): string {
  if (source.kind === 'din') return 'Came with Din';
  if (source.kind === 'opencode') return 'Built into OpenCode';
  if (source.kind === 'other') return 'Elsewhere';
  if (source.kind === 'catalog') return source.entry ?? '';
  return tildify(source.path ?? source.entry ?? '', home);
}

/** "22 skills · 2 off", or why there are none. */
export function skillSourceDetail(source: SkillSource): string {
  if (source.missing) return 'This folder isn’t there';
  const count = source.skills.length;
  if (count === 0) return source.kind === 'catalog' ? 'No skills from this catalog' : 'No skills in this folder yet';
  const off = source.skills.filter((skill) => !skill.enabled).length;
  return `${count} ${count === 1 ? 'skill' : 'skills'}${off === 0 ? '' : off === count ? ' · all off' : ` · ${off} off`}`;
}

/** Whether the user put a source there, so can take it away. */
export function isRemovableSource(source: SkillSource): boolean {
  return source.kind === 'folder' || source.kind === 'catalog';
}

/**
 * What to show in Files for a skill: the folder it's in and its name there
 * (a skill's own folder, or its lone Markdown file). Null for one built
 * into OpenCode, which isn't a file.
 */
export function skillLocation(skill: SkillInfo): { folder: string; name: string } | null {
  if (!skill.path.startsWith('/')) return null;
  const parts = skill.path.split('/');
  if (parts.at(-1) === 'SKILL.md') parts.pop();
  const name = parts.pop();
  return name ? { folder: parts.join('/') || '/', name } : null;
}
