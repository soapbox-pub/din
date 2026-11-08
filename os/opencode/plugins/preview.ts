/*
 * The `preview` tool: shows a web page beside the conversation in Din's
 * Assistant, in the pane where its Git panel is, a tab for each page.
 *
 * The tool itself only checks the page is one the pane can show and says
 * so; the Assistant sees the call in the conversation and opens the tab
 * (src/shared/assistant/previews.ts), framing a server on this computer as
 * it is and a file through a URL that serves its folder alone
 * (din.files.pageUrl). Installed for every session from OpenCode's system
 * directory (/etc/opencode/plugins, os/configuration.nix), with no
 * dependencies: a plain object is all a plugin's default export needs.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

interface ToolEditor {
  add(tool: {
    name: string;
    description: string;
    input: Record<string, unknown>;
    options?: { codemode?: boolean };
    execute(input: Record<string, unknown>): Promise<{ content: string }>;
  }): void;
}

const LOOPBACK = new Set(['localhost', '127.0.0.1', '[::1]']);

/** The page `uri` names, as the pane will show it, or why it can't. */
function check(uri: string): string {
  const raw = uri.trim();
  if (raw.startsWith('/')) return check(`file://${raw}`);
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error(`Not a URI: ${raw}. Give a file:// URI or an http://localhost URL.`);
  }
  if (url.protocol === 'http:' || url.protocol === 'https:') {
    if (url.protocol === 'http:' && LOOPBACK.has(url.hostname)) return url.href;
    throw new Error('Only a server on this computer can be previewed (http://localhost, 127.0.0.1 or [::1], any port). Open other sites in the Web Browser instead.');
  }
  if (url.protocol !== 'file:') throw new Error(`Can’t preview ${url.protocol} URIs: give a file:// URI or an http://localhost URL.`);
  const file = fileURLToPath(url);
  let stats: fs.Stats;
  try {
    stats = fs.statSync(file);
  } catch {
    throw new Error(`${file} doesn’t exist.`);
  }
  if (!stats.isFile()) throw new Error(`${file} is a folder: preview a file in it, such as its index.html.`);
  const folder = path.dirname(fs.realpathSync(file));
  const home = fs.realpathSync(os.homedir());
  if (folder === home || home.startsWith(folder === path.sep ? folder : folder + path.sep)) {
    throw new Error('The page’s whole folder is shown with it, so it can’t be directly in the home folder or above it. Put it in a folder of its own.');
  }
  return url.href;
}

export default {
  id: 'din.preview',
  async setup(ctx: { tool: { transform(callback: (editor: ToolEditor) => void): Promise<unknown> } }) {
    await ctx.tool.transform((editor) => {
      editor.add({
        name: 'preview',
        description: [
          'Show the user a web page in a pane beside this conversation, in Din’s Assistant: a page you made or the app you’re working on.',
          'Give a file:// URI for an HTML file (its scripts, styles and pictures load by relative path from its folder, so keep a page in a folder of its own),',
          'or the http://localhost URL of a development server you started (any port; 127.0.0.1 and [::1] too).',
          'Each page gets a tab in the pane; calling it again with the same URI reloads that tab. Use it after building or changing something the user would want to see.',
          'Nothing else can be previewed, and only Din’s Assistant shows the pane.',
        ].join(' '),
        input: {
          type: 'object',
          properties: {
            uri: { type: 'string', description: 'file:///absolute/path/to/index.html, or http://localhost:<port>/<path>' },
            title: { type: 'string', description: 'A short name for the tab, such as the app’s name' },
          },
          required: ['uri'],
          additionalProperties: false,
        },
        // A call of its own, so the Assistant sees it and opens the tab.
        options: { codemode: false },
        execute: async (input) => {
          const uri = check(String(input.uri ?? ''));
          return { content: `Showing ${uri} in the preview pane beside the conversation.` };
        },
      });
    });
  },
};
