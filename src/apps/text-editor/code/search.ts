import type { FsSearchOptions } from '@/lib/fs';

const escapeRegExp = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** A search as a global RegExp, exactly as electron/project.mts builds it; throws on a bad pattern. */
export function searchRegExp(options: Pick<FsSearchOptions, 'query' | 'regex' | 'caseSensitive' | 'wholeWord'>): RegExp {
  let source = options.regex ? options.query : escapeRegExp(options.query);
  if (options.wholeWord) source = `(?<![\\p{L}\\p{N}_])(?:${source})(?![\\p{L}\\p{N}_])`;
  return new RegExp(source, `gmu${options.caseSensitive ? '' : 'i'}`);
}

export interface SearchState extends FsSearchOptions {
  replace: string;
  showReplace: boolean;
  showFilters: boolean;
}

export const initialSearch: SearchState = {
  query: '',
  regex: false,
  caseSensitive: false,
  wholeWord: false,
  include: '',
  exclude: '',
  replace: '',
  showReplace: false,
  showFilters: false,
};
