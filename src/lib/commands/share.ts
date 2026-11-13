import { getFsBridge } from '@/lib/fs';
import { mimeOf } from '@/lib/mime';
import { deliverShare, requestShare, shareTargets, type ShareData } from '@/lib/share';
import { resolvePath } from './parse';
import { CommandError, type Area, type Args, type CommandContext, type Param } from './types';
import { bare, call, command, need, pick } from './util';

/**
 * `din share`: Din's share sheet (src/lib/share.ts), as the Web Browser's
 * Share and Files' Share… show it, or straight to one of the apps it offers.
 */

const WHAT: Param[] = [
  { name: 'files', type: 'string', positional: true, rest: true, optional: true, help: 'Files to share' },
  { name: 'text', type: 'string', optional: true, help: 'Text to share' },
  { name: 'url', type: 'string', optional: true, help: 'A link to share' },
  { name: 'title', type: 'string', optional: true, help: 'Its title (an email’s subject)' },
];

/** What the arguments share: their files (which must be files), text, link and title. */
async function shareOf(args: Args, ctx: CommandContext): Promise<ShareData> {
  const paths = args.list('files').map((p) => resolvePath(p, ctx.cwd));
  if (paths.length > 0) {
    const fs = need(getFsBridge(), 'Files');
    for (const path of paths) {
      const stat = await call(fs.stat(path));
      if (stat.kind !== 'file') throw new CommandError(`${path} isn’t a file`, 'usage');
    }
  }
  const url = args.optString('url');
  if (url !== undefined) {
    try {
      new URL(url);
    } catch {
      throw new CommandError(`Not a URL: ${url}`, 'usage');
    }
  }
  const data: ShareData = {
    title: args.optString('title'),
    text: args.optString('text'),
    url,
    files: paths.map((path) => {
      const name = path.split('/').pop() || path;
      return { path, name, type: mimeOf(name) };
    }),
  };
  if (!data.title && !data.text && !data.url && data.files.length === 0) throw new CommandError('Name files, or give --text, --url or --title', 'usage');
  return data;
}

export const shareArea: Area = {
  name: 'share',
  summary: 'Share files, text or a link to an app, as the share sheet does',
  commands: [
    bare(command('share', 'share', 'Show the share sheet for files, text or a link, or share them straight to an app with --to', [
      ...WHAT,
      { name: 'to', type: 'string', optional: true, help: 'The app to share to (an id or name `din share targets` lists); without it, the share sheet asks' },
    ], async (args, ctx) => {
      const data = await shareOf(args, ctx);
      const to = args.optString('to');
      if (to !== undefined) {
        const targets = shareTargets(data, ctx.apps.getApp);
        if (targets.length === 0) throw new CommandError('No app here takes that');
        const target = pick(targets, to, (t) => [t.id, t.name], 'app that takes it');
        deliverShare(target, data, null, ctx.actions.open);
        return { data: { to: target.id }, text: `Shared to ${target.name}` };
      }
      const result = await requestShare(data);
      if (result === null) return { data: { to: null }, text: 'Not shared' };
      const app = ctx.apps.getApp(result);
      return { data: { to: result }, text: app ? `Shared to ${app.name}` : result === 'copy' ? 'Copied' : 'Saved to Downloads' };
    })),
    command('share', 'targets', 'The apps that take files, text or a link', WHAT, async (args, ctx) => {
      const targets = shareTargets(await shareOf(args, ctx), ctx.apps.getApp);
      return {
        data: targets.map((t) => ({ id: t.id, name: t.name })),
        text: targets.length === 0 ? 'No app here takes that' : targets.map((t) => `${t.id}\t${t.name}`).join('\n'),
      };
    }),
  ],
};
