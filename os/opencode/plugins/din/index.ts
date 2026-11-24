/*
 * Din's OpenCode plugin: what Din gives the agent behind its Assistant
 * (electron/assistant.mts), for every session on the computer. Installed
 * from OpenCode's system directory (/etc/opencode/plugins, by
 * os/configuration.nix), with no dependencies: a plain object is all a
 * plugin's default export needs, and ./types.ts writes out the parts of
 * OpenCode's plugin API it uses.
 *
 * - `preview` (./preview.ts): shows a page beside the conversation.
 * - Secrets (./secrets.ts): values the user hands a conversation as
 *   environment variables of its commands, hidden from the model, and the
 *   `ask_secret` tool to ask for one.
 */
import { addPreview } from './preview.ts';
import { addAskSecret, setupSecrets } from './secrets.ts';
import type { PluginContext } from './types.ts';

export default {
  id: 'din',
  async setup(ctx: PluginContext) {
    await ctx.tool.transform((editor) => {
      addPreview(editor);
      addAskSecret(editor);
    });
    return await setupSecrets(ctx);
  },
};
