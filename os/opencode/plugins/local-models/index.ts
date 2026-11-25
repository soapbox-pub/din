/*
 * Models on this computer, for OpenCode: what Din's Ollama server gives
 * them, told to OpenCode's own Ollama provider. Installed beside Din's
 * other plugins, from OpenCode's system directory (/etc/opencode/plugins,
 * by os/configuration.nix), with no dependencies.
 *
 * OpenCode finds Ollama's models by itself, at 127.0.0.1:11434, and takes
 * each one's context window from its metadata: the most it was trained for
 * (Qwen3.6's 262K tokens). But Ollama gives a model only the context it
 * was started with (OLLAMA_CONTEXT_LENGTH, electron/local-models.mts), and
 * quietly drops the start of a longer conversation, the agent's
 * instructions first. So here each one's limit comes down to that, and
 * OpenCode compacts the conversation before it gets there. Models that
 * can't call tools are hidden: the agent can't work without them.
 */

const PROVIDER = 'ollama';
/** What Din's server gives each model (electron/local-models.mts's CONTEXT). */
const CONTEXT = 32_768;
/** Most a reply may be, in tokens: a quarter of the window, so the conversation has the rest. */
const MAX_OUTPUT = Math.floor(CONTEXT / 4);

interface Registration {
  dispose(): Promise<void>;
}

interface ModelDraft {
  id: string;
  providerID: string;
  enabled: boolean;
  capabilities: { tools: boolean };
  limit: { context: number; output: number; input?: number };
}

interface ModelEditor {
  list(providerID?: string): readonly ModelDraft[];
  update(providerID: string, modelID: string, update: (model: ModelDraft) => void): void;
}

interface PluginContext {
  model: {
    transform(callback: (editor: ModelEditor) => void): Promise<Registration>;
  };
}

export default {
  id: 'local-models',
  async setup(ctx: PluginContext) {
    await ctx.model.transform((editor) => {
      for (const model of editor.list(PROVIDER)) {
        editor.update(model.providerID, model.id, (draft) => {
          if (!draft.capabilities.tools) draft.enabled = false;
          draft.limit.context = Math.min(draft.limit.context || CONTEXT, CONTEXT);
          draft.limit.output = Math.min(draft.limit.output || MAX_OUTPUT, MAX_OUTPUT);
          if (draft.limit.input) draft.limit.input = Math.min(draft.limit.input, CONTEXT - draft.limit.output);
        });
      }
    });
  },
};
