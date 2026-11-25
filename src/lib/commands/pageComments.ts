import { nip19 } from 'nostr-tools';
import { hasTabConsumer, publishTabCommand } from '@/lib/browserTabBus';
import {
  canonicalPageUrl,
  draftPageComment,
  pageCommentsFilter,
  setCommentCountsShown,
  threadOf,
} from '@/lib/pageComments';
import { CommandError, type Command, type CommandContext, type Param } from './types';
import { command } from './util';

/**
 * `din browser` comment commands: the NIP-22 comments on a web page, as the
 * Web Browser's comments pane shows them (src/lib/pageComments.ts).
 */

const URL_PARAM: Param = { name: 'url', type: 'string', positional: true, help: 'The page’s address, e.g. https://example.com/article' };

function pageOf(url: string): string {
  const page = canonicalPageUrl(url);
  if (!page) throw new CommandError(`Not a web page’s address: ${url}`, 'usage');
  return page;
}

function eTag(tags: string[][]): string | undefined {
  return tags.find(([n]) => n === 'e')?.[1];
}

export const pageCommentCommands: Command[] = [
  command('browser', 'comments', 'The comments people posted on Nostr about a web page, as the Web Browser’s comments pane shows them, newest first', [URL_PARAM], async (args, ctx: CommandContext) => {
    const page = pageOf(args.string('url'));
    const thread = threadOf(await ctx.query([pageCommentsFilter(page)]), page);
    const rows = [...thread.all]
      .sort((a, b) => b.created_at - a.created_at)
      .map((c) => ({
        id: c.id,
        nevent: nip19.neventEncode({ id: c.id, author: c.pubkey, kind: c.kind }),
        author: nip19.npubEncode(c.pubkey),
        created: new Date(c.created_at * 1000).toISOString(),
        replyTo: thread.all.some((p) => p.id === eTag(c.tags)) ? eTag(c.tags)! : null,
        content: c.content,
      }));
    return {
      data: { page, comments: rows },
      text: rows.length
        ? rows.map((r) => `${r.created} ${r.author}${r.replyTo ? ` (reply to ${r.replyTo.slice(0, 8)})` : ''}\n  ${r.content.replace(/\n/g, '\n  ')}`).join('\n')
        : `No comments on ${page}`,
    };
  }),
  command('browser', 'comment', 'Comment on a web page: opens it in the Web Browser with its comments pane showing the comment in the composer, which posts it when you press Post', [
    URL_PARAM,
    { name: 'text', type: 'string', positional: true, help: 'The comment' },
  ], (args, ctx) => {
    if (!ctx.pubkey) throw new CommandError('No one is signed in');
    const url = args.string('url');
    const page = pageOf(url);
    const text = args.string('text').trim();
    if (!text) throw new CommandError('The comment is empty', 'usage');
    draftPageComment(page, text);
    if (!hasTabConsumer()) ctx.actions.open('web-browser');
    publishTabCommand({ type: 'open', url: page });
    return { data: { page }, text: 'The comment is in the Web Browser’s composer; it posts when you press Post' };
  }),
  command('browser', 'comment-counts', 'Show how many comments each page has on the toolbar’s comments button, which asks your relays about every page you visit (never in private windows or Tor tabs)', [
    { name: 'shown', type: 'string', positional: true, choices: ['on', 'off'], help: 'on: count every page’s; off: only when the comments pane is open' },
  ], (args) => {
    const on = args.string('shown') === 'on';
    setCommentCountsShown(on);
    return { text: on ? 'Pages’ comment counts show on the comments button' : 'Comment counts show only while the comments pane is open' };
  }),
];
