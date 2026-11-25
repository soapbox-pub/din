import type { NostrEvent } from '@nostrify/nostrify';
import { nip19 } from 'nostr-tools';
import { hasTabConsumer, publishTabCommand } from '@/lib/browserTabBus';
import { canonicalPageUrl, draftPageComment, fetchCommentsPage, threadOf } from '@/lib/pageComments';
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

export const pageCommentCommands: Command[] = [
  command('browser', 'comments', 'The comments people posted on Nostr about a web page, as the Web Browser’s comments pane shows them: a page of the newest, each followed by its replies; --until for older ones', [
    URL_PARAM,
    { name: 'until', type: 'integer', optional: true, help: 'Only comments posted at or before this Unix time (the “until” the last page gave)' },
  ], async (args, ctx: CommandContext) => {
    const page = pageOf(args.string('url'));
    const fetched = await fetchCommentsPage((filters) => ctx.query(filters), page, args.optNumber('until'));
    const thread = threadOf([fetched], page);
    const row = (c: NostrEvent) => ({
      id: c.id,
      nevent: nip19.neventEncode({ id: c.id, author: c.pubkey, kind: c.kind }),
      author: nip19.npubEncode(c.pubkey),
      created: new Date(c.created_at * 1000).toISOString(),
      replyTo: thread.parent(c.id)?.id ?? null,
      content: c.content,
    });
    const rows = thread.top.flatMap((c) => [row(c), ...thread.replies(c.id).map(row)]);
    const lines = rows.map(
      (r) => `${r.replyTo ? '    ' : ''}${r.created} ${r.author}\n${r.replyTo ? '      ' : '  '}${r.content.replace(/\n/g, `\n${r.replyTo ? '      ' : '  '}`)}`,
    );
    if (fetched.until !== null) lines.push(`Older: din browser comments ${page} --until ${fetched.until}`);
    return {
      data: { page, comments: rows, until: fetched.until },
      text: rows.length ? lines.join('\n') : `No comments on ${page}`,
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
];
