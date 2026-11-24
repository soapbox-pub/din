/*
 * Secrets: values the user hands a conversation (a token, a password) that
 * the agent uses without seeing. Each is an environment variable of that
 * conversation's shell commands (and its subagents'), held in this server's
 * memory alone: never written to disk, never in the conversation, gone when
 * the conversation is deleted or the server stops.
 *
 * - The user gives one with the `din-secrets` RPC's `set` (Din's Assistant
 *   does, for a secret attached with + → Secret…), or when the agent asks
 *   for one with the `ask_secret` tool, which waits for the RPC's `answer`
 *   (the Assistant shows a card for the running call).
 * - A shell command gets them by a tag: `execute.before` puts a line naming
 *   a one-time nonce ahead of a command of a conversation that has secrets,
 *   and `shell.create.before`, which knows the command but not whose it is,
 *   takes the line off and adds the conversation's variables. OpenCode's
 *   permission rules see the command without it.
 * - Every value (and its base64 and URL-encoded forms) is replaced with
 *   `[secret $NAME]` in what tools return, in the user's messages as they
 *   come in, and in everything sent to the model, which also covers output
 *   that reaches it other ways (a background command's).
 *
 * There's no way to read a value back. The agent can still use one as it
 * likes in its commands; what this keeps it from is seeing, printing or
 * repeating it by accident.
 */
import type { PluginContext, ShellCreateBefore, ToolEditor, ToolExecuteBefore } from './types.ts';

/** A conversation's secrets, by variable name. */
type Secrets = Map<string, string>;

interface Ask {
  sessionID: string;
  name: string;
  resolve: (value: string | null) => void;
}

interface Store {
  bySession: Map<string, Secrets>;
  /** Tagged commands not yet started: nonce → conversation, and when. */
  tags: Map<string, { sessionID: string; at: number }>;
  /** `ask_secret` calls waiting on the user, by call ID. */
  asks: Map<string, Ask>;
  /** Each conversation's parent (null for none), once looked up. */
  parents: Map<string, string | null>;
  /** Secrets removed from a conversation, still hidden: they may be in it already. */
  retired: Map<string, Secrets>;
  /**
   * Each value to hide (and its encodings), longest first, with what
   * replaces it; null until worked out again after a change. Here, not in
   * the module, which each folder's copy of the plugin has its own of.
   */
  hidden?: { find: string; put: string }[] | null;
}

// OpenCode loads the plugin once for each folder conversations work in, and
// a conversation can move between them: one store for the whole server.
const KEY = Symbol.for('din.opencode.secrets');
const holder = globalThis as typeof globalThis & { [KEY]?: Store };
const store: Store = (holder[KEY] ??= { bySession: new Map(), tags: new Map(), asks: new Map(), parents: new Map(), retired: new Map() });

const TAG = '#din-secrets:';
const TAG_LINE = /^#din-secrets:([0-9a-f-]{36})\n/;
/** How long a tag waits for its command to start before it's dropped. */
const TAG_TTL_MS = 60_000;
const NAME = /^[A-Za-z_][A-Za-z0-9_]{0,63}$/;
/** Names a secret can't have: the shell's own, and what OpenCode sets. */
const RESERVED = /^(PATH|HOME|USER|LOGNAME|SHELL|PWD|OLDPWD|TERM|LANG|TMPDIR|IFS|PS[1-4]|LD_.*|LC_.*|XDG_.*|DBUS_.*|OPENCODE.*|AGENT|AI_AGENT|BASH_.*|ZDOTDIR|ENV)$/;
const MAX_VALUE = 64 * 1024;
/** Values shorter than this aren't hidden, or every "a" would be. */
const MIN_HIDDEN = 4;

/** `name` as a variable a secret can be, or an Error saying why not. */
function checkName(name: unknown): string {
  const value = typeof name === 'string' ? name.trim() : '';
  if (!NAME.test(value)) throw new Error('A secret’s name is an environment variable’s: letters, digits and _, not starting with a digit (GITHUB_TOKEN).');
  if (RESERVED.test(value.toUpperCase())) throw new Error(`${value} is the shell’s own variable; give the secret another name.`);
  return value;
}

function checkValue(value: unknown): string {
  if (typeof value !== 'string' || value.length === 0) throw new Error('The secret is empty.');
  if (value.length > MAX_VALUE) throw new Error('The secret is too long (64 KB at most).');
  if (value.includes('\0')) throw new Error('A secret can’t contain a NUL character.');
  return value;
}

function checkSession(sessionID: unknown): string {
  if (typeof sessionID !== 'string' || !/^ses_[A-Za-z0-9]+$/.test(sessionID)) throw new Error('Not a conversation’s ID.');
  return sessionID;
}

function setSecret(sessionID: string, name: string, value: string): void {
  let secrets = store.bySession.get(sessionID);
  if (!secrets) store.bySession.set(sessionID, (secrets = new Map()));
  secrets.set(name, value);
  store.hidden = null;
}

function forget(sessionID: string): void {
  store.bySession.delete(sessionID);
  store.retired.delete(sessionID);
  store.parents.delete(sessionID);
  for (const [id, ask] of store.asks) {
    if (ask.sessionID !== sessionID) continue;
    store.asks.delete(id);
    ask.resolve(null);
  }
  store.hidden = null;
}

/** A conversation's secrets with its parents' (a subagent's are its conversation's), its own winning. */
async function secretsOf(ctx: PluginContext, sessionID: string): Promise<Secrets> {
  const chain: string[] = [];
  for (let id: string | null = sessionID; id && chain.length < 16; ) {
    chain.push(id);
    let parent = store.parents.get(id);
    if (parent === undefined) {
      try {
        parent = (await ctx.session.get({ sessionID: id })).parentID ?? null;
      } catch {
        parent = null;
      }
      store.parents.set(id, parent);
    }
    id = parent;
  }
  const merged: Secrets = new Map();
  for (const id of chain.reverse()) for (const [name, value] of store.bySession.get(id) ?? []) merged.set(name, value);
  return merged;
}

// ---------------------------------------------------------------------------
// Hiding values
// ---------------------------------------------------------------------------

function hiddenValues(): { find: string; put: string }[] {
  if (store.hidden) return store.hidden;
  const all = new Map<string, string>();
  for (const secrets of [...store.bySession.values(), ...store.retired.values()]) {
    for (const [name, value] of secrets) {
      if (value.length < MIN_HIDDEN) continue;
      const put = `[secret $${name}]`;
      for (const form of [value, value.trim(), encodeURIComponent(value), Buffer.from(value).toString('base64'), Buffer.from(value).toString('base64url')]) {
        if (form.length >= MIN_HIDDEN && !all.has(form)) all.set(form, put);
      }
    }
  }
  store.hidden = [...all].map(([find, put]) => ({ find, put })).sort((a, b) => b.find.length - a.find.length);
  return store.hidden;
}

/** `text` with every secret in it hidden. */
export function hide(text: string): string {
  let out = text;
  for (const { find, put } of hiddenValues()) if (out.includes(find)) out = out.split(find).join(put);
  return out;
}

/** Hide secrets in every string in `value`, in place where it can; returns the result. */
function hideIn(value: unknown, depth = 0): unknown {
  if (typeof value === 'string') return hide(value);
  if (depth > 64 || value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) {
    for (let i = 0; i < value.length; i++) value[i] = hideIn(value[i], depth + 1);
    return value;
  }
  const record = value as Record<string, unknown>;
  for (const key of Object.keys(record)) {
    const before = record[key];
    const after = hideIn(before, depth + 1);
    if (after !== before) {
      try {
        record[key] = after;
      } catch {
        // Read-only: left as it is.
      }
    }
  }
  return value;
}

const anySecrets = () => store.bySession.size > 0 || store.retired.size > 0;

// ---------------------------------------------------------------------------
// The plugin
// ---------------------------------------------------------------------------

const RPC = {
  id: 'din-secrets',
  methods: {
    /** Give a conversation a secret (replacing one of the same name). */
    set: {
      input: {
        type: 'object',
        properties: { sessionID: { type: 'string' }, name: { type: 'string' }, value: { type: 'string' } },
        required: ['sessionID', 'name', 'value'],
        additionalProperties: false,
      },
      output: { type: 'object', properties: { name: { type: 'string' } }, required: ['name'], additionalProperties: false },
    },
    /** Answer an `ask_secret` call: with the value, or without it to decline. */
    answer: {
      input: {
        type: 'object',
        properties: { sessionID: { type: 'string' }, callID: { type: 'string' }, value: { type: 'string' } },
        required: ['sessionID', 'callID'],
        additionalProperties: false,
      },
      output: { type: 'object', properties: { ok: { type: 'boolean' } }, required: ['ok'], additionalProperties: false },
    },
    /** The names of a conversation's secrets (never their values). */
    list: {
      input: { type: 'object', properties: { sessionID: { type: 'string' } }, required: ['sessionID'], additionalProperties: false },
      output: {
        type: 'object',
        properties: { names: { type: 'array', items: { type: 'string' } } },
        required: ['names'],
        additionalProperties: false,
      },
    },
    /** Forget one of a conversation's secrets. */
    remove: {
      input: {
        type: 'object',
        properties: { sessionID: { type: 'string' }, name: { type: 'string' } },
        required: ['sessionID', 'name'],
        additionalProperties: false,
      },
      output: { type: 'object', properties: { ok: { type: 'boolean' } }, required: ['ok'], additionalProperties: false },
    },
  },
  events: {},
};

const USE = 'Use it by reference in commands ("$NAME"); never print, echo, log or write its value anywhere the user didn’t ask for, and don’t try to read it back. If output shows it, it reads [secret $NAME].';

/** Add the `ask_secret` tool. */
export function addAskSecret(editor: ToolEditor): void {
  editor.add({
    name: 'ask_secret',
    description: [
      'Ask the user for a secret (an API key, token or password) without it entering the conversation.',
      'Din’s Assistant shows them a field for it; once they give it, it’s an environment variable in every shell command of this conversation, named as you ask.',
      'Use this whenever you need a credential: never ask for one in the chat, and don’t ask again for one you were given.',
      USE.replaceAll('NAME', '<name>'),
      'It lasts until the conversation is deleted or OpenCode restarts.',
    ].join(' '),
    input: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'The environment variable to put it in, such as GITHUB_TOKEN' },
        description: { type: 'string', description: 'What it is and what you need it for, shown to the user: “A GitHub token with repo scope, to open the pull request”' },
      },
      required: ['name', 'description'],
      additionalProperties: false,
    },
    // A call of its own, so the Assistant sees it and shows the field.
    options: { codemode: false },
    execute: async (input, context) => {
      const name = checkName(input.name);
      const value = await new Promise<string | null>((resolve, reject) => {
        store.asks.set(context.id, { sessionID: context.sessionID, name, resolve });
        context.signal.addEventListener(
          'abort',
          () => {
            store.asks.delete(context.id);
            reject(new Error('Stopped before the user answered.'));
          },
          { once: true },
        );
      });
      if (value === null) return { content: `The user declined to give ${name}. Don’t ask for it again unless they say to.` };
      return { content: `The user gave ${name}: it’s set as $${name} in this conversation’s shell commands. ${USE.replaceAll('NAME', name)}` };
    },
  });
}

/** Wire secrets into the server: the RPC, the shell's environment, and hiding them. */
export async function setupSecrets(ctx: PluginContext): Promise<() => void> {
  await ctx.rpc.register(RPC, {
    set: async (raw) => {
      const input = raw as { sessionID?: unknown; name?: unknown; value?: unknown };
      const sessionID = checkSession(input.sessionID);
      const name = checkName(input.name);
      setSecret(sessionID, name, checkValue(input.value));
      return { name };
    },
    answer: async (raw) => {
      const input = raw as { sessionID?: unknown; callID?: unknown; value?: unknown };
      const sessionID = checkSession(input.sessionID);
      const ask = typeof input.callID === 'string' ? store.asks.get(input.callID) : undefined;
      if (!ask || ask.sessionID !== sessionID) return { ok: false };
      const value = input.value === undefined ? null : checkValue(input.value);
      store.asks.delete(input.callID as string);
      if (value !== null) setSecret(sessionID, ask.name, value);
      ask.resolve(value);
      return { ok: true };
    },
    list: async (raw) => {
      const sessionID = checkSession((raw as { sessionID?: unknown }).sessionID);
      return { names: [...(store.bySession.get(sessionID)?.keys() ?? [])] };
    },
    remove: async (raw) => {
      const input = raw as { sessionID?: unknown; name?: unknown };
      const sessionID = checkSession(input.sessionID);
      const secrets = store.bySession.get(sessionID);
      const name = typeof input.name === 'string' ? input.name : '';
      const value = secrets?.get(name);
      if (!secrets || value === undefined) return { ok: false };
      secrets.delete(name);
      if (secrets.size === 0) store.bySession.delete(sessionID);
      // Its value stays hidden: it may be in the conversation already.
      let retired = store.retired.get(sessionID);
      if (!retired) store.retired.set(sessionID, (retired = new Map()));
      retired.set(name, value);
      return { ok: true };
    },
  });

  // Tag a command of a conversation with secrets, for the shell's hook.
  await ctx.tool.hook('execute.before', async (event: ToolExecuteBefore) => {
    if (!anySecrets() || (event.tool !== 'shell' && event.tool !== 'bash')) return;
    const input = event.input as { command?: unknown } | null;
    if (!input || typeof input.command !== 'string') return;
    if ((await secretsOf(ctx, event.sessionID)).size === 0) return;
    const now = Date.now();
    for (const [nonce, tag] of store.tags) if (now - tag.at > TAG_TTL_MS) store.tags.delete(nonce);
    const nonce = crypto.randomUUID();
    store.tags.set(nonce, { sessionID: event.sessionID, at: now });
    event.input = { ...input, command: `${TAG}${nonce}\n${input.command}` };
  });

  await ctx.shell.hook('create.before', async (event: ShellCreateBefore) => {
    const match = TAG_LINE.exec(event.command);
    if (!match) return;
    event.command = event.command.slice(match[0].length);
    const tag = store.tags.get(match[1]);
    store.tags.delete(match[1]);
    if (!tag) return;
    for (const [name, value] of await secretsOf(ctx, tag.sessionID)) event.env[name] = value;
  });

  await ctx.tool.hook('execute.after', (event) => {
    if (!anySecrets() || event.status !== 'completed') return;
    event.result = hideIn(event.result) as typeof event.result;
  });

  await ctx.session.hook('prompt', (event) => {
    if (anySecrets() && typeof event.prompt.text === 'string') event.prompt.text = hide(event.prompt.text);
  });

  for (const kind of ['context', 'compaction', 'generate'] as const) {
    await ctx.session.hook(kind, (event) => {
      if (!anySecrets()) return;
      hideIn(event.messages);
      hideIn(event.system);
    });
  }

  // A deleted conversation's secrets go with it.
  const stop = new AbortController();
  void (async () => {
    try {
      for await (const event of ctx.event.subscribe({ types: ['session.deleted'], signal: stop.signal })) {
        if (event.data?.sessionID) forget(event.data.sessionID);
      }
    } catch {
      // Stopped with the plugin.
    }
  })();
  return () => stop.abort();
}
