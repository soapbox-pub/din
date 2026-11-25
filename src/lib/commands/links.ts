import { isClaimableScheme } from '@/lib/schemeLinks';
import { CommandError, type Area, type CommandContext, type SchemeLinksControl } from './types';
import { command, need, pick } from './util';

/**
 * `din links`: where links of the schemes apps claim (`bitcoin:`, `monero:`,
 * `xmpp:`, …, src/lib/schemeLinks.ts) open, as Settings → Nostr & Storage →
 * Other links has it. `nostr:` links, which open by event kind, are `din
 * nostr links`.
 */

/** A scheme as typed (`monero`, `monero:`), lowercased, or a usage error. */
function schemeArg(text: string): string {
  const scheme = text.trim().replace(/:$/, '').toLowerCase();
  if (!isClaimableScheme(scheme)) throw new CommandError(`Apps can’t open “${scheme}:” links on Din`, 'usage');
  return scheme;
}

/** What `din links list` says about one scheme. */
export function describeSchemeLinks(links: SchemeLinksControl, scheme: string) {
  const apps = links.handlersFor(scheme).map((app) => ({ id: app.id, name: app.name }));
  const chosen = links.defaultFor(scheme);
  return {
    data: { scheme, default: chosen?.id ?? null, apps },
    text: `${scheme}: ${
      chosen
        ? `${chosen.name}${apps.length > 1 ? ` (of ${apps.map((a) => a.name).join(', ')})` : ''}`
        : apps.length === 0
          ? 'no app opens them'
          : apps.length === 1
            ? `${apps[0].name}, the only app that opens them`
            : `ask which of ${apps.map((a) => a.name).join(', ')}`
    }`,
  };
}

/** What `din links default` does, for one scheme. */
export function setSchemeDefault(ctx: CommandContext, scheme: string, query: string | undefined) {
  const links = need(ctx.schemeLinks, 'Links');
  if (query === undefined) {
    links.setDefault(scheme, null);
    return { text: `${scheme}: links ask again when more than one app opens them` };
  }
  const app = pick(links.handlersFor(scheme), query, (a) => [a.id, a.name], `app that opens ${scheme}: links`);
  links.setDefault(scheme, app.id);
  return { text: `${scheme}: links open in ${app.name}` };
}

export const linksArea: Area = {
  name: 'links',
  summary: 'Where bitcoin:, monero: and other schemes’ links open: the apps that say they open them, and the one chosen for each',
  commands: [
    command('links', 'list', 'The schemes apps open, the apps that open each, and the one each opens in without asking', [
      { name: 'scheme', type: 'string', positional: true, optional: true, help: 'Just this scheme (monero)' },
    ], (args, ctx) => {
      const links = need(ctx.schemeLinks, 'Links');
      const only = args.optString('scheme');
      const schemes = only !== undefined ? [schemeArg(only)] : links.schemes;
      const each = schemes.map((scheme) => describeSchemeLinks(links, scheme));
      return { data: each.map((e) => e.data), text: each.map((e) => e.text).join('\n') || 'No app opens any' };
    }),
    command('links', 'default', 'Open a scheme’s links in an app without asking, as Always does; without an app, ask again', [
      { name: 'scheme', type: 'string', positional: true, help: 'The scheme (bitcoin, monero)' },
      { name: 'app', type: 'string', positional: true, optional: true, help: 'Its id or name, from din links list' },
    ], (args, ctx) => setSchemeDefault(ctx, schemeArg(args.string('scheme')), args.optString('app'))),
  ],
};
