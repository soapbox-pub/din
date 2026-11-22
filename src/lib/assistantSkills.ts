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
 * The tag beside a source that can't be taken away, saying why: a folder
 * OpenCode always looks in, or skills that came with Din or OpenCode.
 */
export function skillSourceBadge(source: SkillSource): { label: string; title: string } | null {
  if (source.kind === 'default') return { label: 'Default', title: 'OpenCode always looks for skills here' };
  if (source.kind === 'din' || source.kind === 'opencode') return { label: 'Built in', title: 'These come with it and can’t be removed, only turned off' };
  return null;
}

/** How taking a folder or catalog away is put, in its menus, the question before it, and `din assistant`. */
export function removeSourceWording(source: SkillSource, home?: string): { menu: string; title: string; description: string; action: string } {
  const catalog = source.kind === 'catalog';
  const name = skillSourceName(source, home);
  return {
    menu: catalog ? 'Stop Using This Catalog' : 'Stop Using This Folder',
    title: catalog ? 'Stop using this catalog?' : 'Stop using this folder?',
    description: catalog
      ? `The assistant won’t get skills from ${name} any more, here or in a Terminal’s opencode, until you add it again.`
      : `The assistant won’t find the skills in ${name} any more, here or in a Terminal’s opencode, until you add the folder again. The folder and its files stay where they are.`,
    action: catalog ? 'Stop Using It' : 'Stop Using Folder',
  };
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
