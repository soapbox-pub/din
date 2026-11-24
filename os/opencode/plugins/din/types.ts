/*
 * The parts of OpenCode's plugin context (@opencode/plugin, V2) that Din's
 * plugin uses, written out so it needs no dependencies. Shapes are from
 * OpenCode's plugin guide (https://opencode.ai/docs/build/plugins/server)
 * and its source.
 */

export type JsonSchema = Record<string, unknown>;

export interface ToolCallContext {
  readonly sessionID: string;
  readonly messageID: string;
  /** The call's ID: the tool part's in the conversation. */
  readonly id: string;
  readonly signal: AbortSignal;
}

export interface ToolResult {
  content: string | readonly unknown[];
  output?: unknown;
  metadata?: unknown;
}

export interface ToolEditor {
  add(tool: {
    name: string;
    description: string;
    input: JsonSchema;
    options?: { codemode?: boolean };
    execute(input: Record<string, unknown>, context: ToolCallContext): Promise<ToolResult>;
  }): void;
}

export interface Registration {
  dispose(): Promise<void>;
}

type Hook<Event> = (event: Event) => Promise<void> | void;

export interface ToolExecuteBefore {
  tool: string;
  readonly sessionID: string;
  readonly id: string;
  input: unknown;
}

export type ToolExecuteAfter = {
  readonly tool: string;
  readonly sessionID: string;
  readonly id: string;
  readonly input: unknown;
} & ({ readonly status: 'completed'; result: ToolResult } | { readonly status: 'error'; error: unknown });

export interface ShellCreateBefore {
  command: string;
  cwd: string;
  timeout: number;
  shell: string;
  env: Record<string, string | undefined>;
}

export interface SessionPromptHook {
  readonly sessionID: string;
  prompt: { text: string };
}

export interface SessionContextHook {
  readonly sessionID: string;
  system: unknown[];
  messages: unknown[];
}

export interface RpcMethod {
  input?: JsonSchema;
  output?: JsonSchema;
}

export interface PluginContext {
  tool: {
    transform(callback: (editor: ToolEditor) => void): Promise<Registration>;
    hook(name: 'execute.before', callback: Hook<ToolExecuteBefore>): Promise<Registration>;
    hook(name: 'execute.after', callback: Hook<ToolExecuteAfter>): Promise<Registration>;
  };
  shell: {
    hook(name: 'create.before', callback: Hook<ShellCreateBefore>): Promise<Registration>;
  };
  session: {
    get(input: { sessionID: string }): Promise<{ id: string; parentID?: string | null }>;
    hook(name: 'prompt', callback: Hook<SessionPromptHook>): Promise<Registration>;
    hook(name: 'context' | 'compaction' | 'generate' | 'title', callback: Hook<SessionContextHook>): Promise<Registration>;
  };
  rpc: {
    register(
      definition: { id: string; methods: Record<string, RpcMethod>; events: Record<string, { schema: JsonSchema }> },
      handlers: Record<string, (input: unknown) => Promise<unknown>>,
    ): Promise<Registration>;
  };
  event: {
    subscribe(options: { types: string[]; signal?: AbortSignal }): AsyncIterable<{ type: string; data?: { sessionID?: string } }>;
  };
}
