/*
 * Shakespeare AI (https://ai.shakespeare.diy) for OpenCode: an
 * OpenAI-compatible provider paid for with prepaid credits, whose accounts
 * are Nostr pubkeys. Installed beside Din's own plugin, from OpenCode's
 * system directory (/etc/opencode/plugins, by os/configuration.nix), with no
 * dependencies.
 *
 * It registers the `shakespeare` integration, connected with an API key
 * (`sk-shakespeare-…`), and the `shakespeare` provider with the models
 * Shakespeare lists at /v1/models, their context windows and prices. The
 * key is usually made by Din, which signs a NIP-98 request for one as the
 * signed-in account (src/lib/shakespeareProvider.ts), so this plugin never
 * touches a signer. The last list is kept in the plugin's storage, so the
 * models are there when OpenCode starts offline.
 */

const ID = 'shakespeare';
const NAME = 'Shakespeare AI';
const BASE_URL = 'https://ai.shakespeare.diy/v1';
const STORAGE_KEY = 'models';
/** How often the list is fetched again while OpenCode runs. */
const REFRESH_MS = 6 * 60 * 60 * 1000;
const FETCH_TIMEOUT_MS = 15_000;
/** Most a reply may be, in tokens: what Claude's models all allow. */
const MAX_OUTPUT = 32_000;

/** A chat model as /v1/models describes it (src/api/models.rs in shakespeare-ai). */
interface RemoteModel {
  id: string;
  name: string;
  context_window: number;
  /** USD per token, as decimal strings. */
  prompt: string;
  completion: string;
  cache_read: string;
  cache_write: string;
}

interface Registration {
  dispose(): Promise<void>;
}

interface IntegrationEditor {
  update(id: string, update: (integration: { id: string; name: string }) => void): void;
  method: { update(input: { integrationID: string; method: { type: 'key'; label?: string } }): void };
}

interface ProviderEditor {
  add(input: { info: Record<string, unknown>; models: readonly Record<string, unknown>[] }): void;
}

interface PluginContext {
  integration: {
    transform(callback: (editor: IntegrationEditor) => void): Promise<Registration>;
  };
  provider: {
    transform(callback: (editor: ProviderEditor) => void): Promise<Registration>;
    reload(): Promise<void>;
  };
  storage: {
    get(key: string): Promise<unknown>;
    set(key: string, value: unknown): Promise<void>;
  };
}

/** The chat models in a /v1/models answer (or what was stored of one); image models aren't for chat. */
function parseModels(value: unknown): RemoteModel[] {
  const data = (value as { data?: unknown } | null)?.data;
  if (!Array.isArray(data)) return [];
  const models: RemoteModel[] = [];
  for (const item of data as Record<string, unknown>[]) {
    if (!item || typeof item.id !== 'string' || item.type !== 'chat') continue;
    const pricing = (item.pricing ?? {}) as Record<string, unknown>;
    const price = (key: string) => (typeof pricing[key] === 'string' ? (pricing[key] as string) : '0');
    models.push({
      id: item.id,
      name: typeof item.name === 'string' && item.name ? item.name : item.id,
      context_window: typeof item.context_window === 'number' && item.context_window > 0 ? item.context_window : 200_000,
      prompt: price('prompt'),
      completion: price('completion'),
      cache_read: price('input_cache_read'),
      cache_write: price('input_cache_write'),
    });
  }
  return models;
}

/** USD per token, as Shakespeare says it, in USD per million tokens, as OpenCode wants it. */
function perMillion(value: string): number {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? Math.round(n * 1e6 * 1e6) / 1e6 : 0;
}

function modelInfo(model: RemoteModel): Record<string, unknown> {
  return {
    id: model.id,
    modelID: model.id,
    providerID: ID,
    family: model.id.startsWith('claude') ? 'claude' : undefined,
    name: model.name,
    capabilities: { tools: true, input: ['text', 'image'], output: ['text'] },
    variants: [],
    time: { released: 0 },
    cost: [
      {
        input: perMillion(model.prompt),
        output: perMillion(model.completion),
        cache: { read: perMillion(model.cache_read), write: perMillion(model.cache_write) },
      },
    ],
    status: 'active',
    enabled: true,
    limit: { context: model.context_window, output: Math.min(MAX_OUTPUT, model.context_window) },
  };
}

export default {
  id: 'shakespeare',
  async setup(ctx: PluginContext) {
    const source = { models: parseModels(await ctx.storage.get(STORAGE_KEY).catch(() => undefined)) };

    await ctx.integration.transform((editor) => {
      editor.method.update({ integrationID: ID, method: { type: 'key', label: 'API key' } });
      editor.update(ID, (integration) => {
        integration.name = NAME;
      });
    });

    await ctx.provider.transform((editor) => {
      if (source.models.length === 0) return;
      editor.add({
        info: {
          id: ID,
          integrationID: ID,
          name: NAME,
          activation: 'auto',
          package: '@opencode/ai/providers/openai-compatible',
          settings: { baseURL: BASE_URL },
        },
        models: source.models.map(modelInfo),
      });
    });

    let stored = JSON.stringify(source.models);
    const refresh = async () => {
      const response = await fetch(`${BASE_URL}/models`, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
      if (!response.ok) return;
      const body: unknown = await response.json();
      const models = parseModels(body);
      if (models.length === 0 || JSON.stringify(models) === stored) return;
      stored = JSON.stringify(models);
      source.models = models;
      await ctx.storage.set(STORAGE_KEY, body).catch(() => {});
      await ctx.provider.reload();
    };
    // Offline, the stored list stays; the next try is a refresh away.
    void refresh().catch(() => {});
    const timer = setInterval(() => void refresh().catch(() => {}), REFRESH_MS);
    return () => clearInterval(timer);
  },
};
