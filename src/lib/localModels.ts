/**
 * AI models on this computer, for the assistant: Ollama, run by Din
 * (`window.dinos.localModels`, electron/local-models.mts), where OpenCode's
 * own Ollama provider finds it and lists its models with the rest.
 *
 * Which models to offer is ours to say, as Ollama's library has no way to
 * ask what suits a computer: CATALOG is a short list of ones that can work
 * as an agent (they call tools), from small to large, and fitLocalModel
 * says how each would run here, from what the GPU has (what Ollama found)
 * and the computer's memory. Settings → Assistant shows the best few that
 * run well (recommendLocalModels), the first marked best, and the rest
 * with a word about why not.
 */

export interface LocalGpu {
  name: string;
  kind: 'integrated' | 'discrete';
  /** What it has for models, in bytes. */
  memory: number;
}

export interface LocalModel {
  name: string;
  size: number;
  modifiedAt: string;
  parameters: string | null;
  quantization: string | null;
  /** Whether it can call tools, which the assistant needs; null when unknown. */
  tools: boolean | null;
  loaded: boolean;
}

export interface LocalPull {
  model: string;
  status: string;
  completed: number;
  total: number;
  error: string | null;
}

export interface LocalModelsState {
  available: boolean;
  running: boolean;
  external: boolean;
  /** Ollama's version ("0.40.3"), null when it isn't known. */
  version: string | null;
  memory: number;
  gpu: LocalGpu | null;
  context: number;
  models: LocalModel[];
  pulls: LocalPull[];
  error: string | null;
}

export interface LocalModelsBridge {
  state(): Promise<LocalModelsState>;
  pull(model: string): Promise<void>;
  cancel(model: string): Promise<void>;
  remove(model: string): Promise<void>;
  onChanged(callback: (state: LocalModelsState) => void): () => void;
}

declare global {
  interface Dinos {
    /** Present only inside the Electron shell. */
    localModels?: LocalModelsBridge;
  }
}

export function getLocalModelsBridge(): LocalModelsBridge | undefined {
  if (typeof window === 'undefined') return undefined;
  return window.dinos?.localModels;
}

/** The optional feature that is Ollama on DinOS. */
export const LOCAL_AI_FEATURE = 'local-ai';
/** OpenCode's provider for them: models are `ollama/<name>`. */
export const LOCAL_PROVIDER = 'ollama';

export interface CatalogModel {
  /** Ollama's name for it, tag and all. */
  name: string;
  /** What people call it. */
  title: string;
  maker: string;
  /** A line about what it is. */
  blurb: string;
  /** Parameters, in billions. */
  parameters: number;
  /** Those working on each token, in billions: fewer than all in a mixture of experts. */
  active: number;
  /** The download, in bytes (its layers in Ollama's registry). */
  size: number;
  /** How capable an agent it is, against the others here; higher is better. */
  quality: number;
  /** The oldest Ollama that runs it (its config's `requires`). */
  requires: string;
}

/**
 * The models offered, best first. Each can call tools, and has a context
 * window well past what Din gives it. Sizes are the default tag's layers
 * in registry.ollama.ai, at 4-bit.
 */
export const CATALOG: CatalogModel[] = [
  {
    name: 'gpt-oss:120b',
    title: 'gpt-oss 120B',
    maker: 'OpenAI',
    blurb: 'OpenAI’s large open model: a strong agent, for computers with a lot of memory.',
    parameters: 117,
    active: 5.1,
    size: 65_369_819_443,
    quality: 90,
    requires: '0.30.0',
  },
  {
    name: 'qwen3.8:27b',
    title: 'Qwen3.8 27B',
    maker: 'Alibaba',
    blurb: 'Qwen’s newest: the most capable here for coding and long tasks, and it sees images.',
    parameters: 27,
    active: 27,
    size: 17_741_871_939,
    quality: 85,
    requires: '0.32.12',
  },
  {
    name: 'qwen3.6:35b-a3b',
    title: 'Qwen3.6 35B-A3B',
    maker: 'Alibaba',
    blurb: 'A mixture of experts that works only 3B of its 35B parameters at a time: fast, and good at agentic coding.',
    parameters: 35,
    active: 3,
    size: 22_621_314_161,
    quality: 80,
    requires: '0.30.0',
  },
  {
    name: 'inkling-2-mini:26b-a5b',
    title: 'Inkling 2 Mini',
    maker: 'Thinking Machines',
    blurb: 'A 26B mixture of experts with 5B at work at a time, built to run on a laptop.',
    parameters: 26,
    active: 5.4,
    size: 18_269_758_110,
    quality: 78,
    requires: '0.40.18',
  },
  {
    name: 'flint:40b-a2b',
    title: 'Flint 40B',
    maker: 'Recursive',
    blurb: 'A mixture of experts built for coding agents, with only 2B parameters at work at a time.',
    parameters: 40,
    active: 2,
    size: 22_863_095_573,
    quality: 74,
    requires: '0.40.9',
  },
  {
    name: 'nemotron-3.5-lightning:30b-a3b',
    title: 'Nemotron 3.5 Lightning',
    maker: 'NVIDIA',
    blurb: 'A mixture of experts built for agents that run all day, with 3B parameters at work at a time.',
    parameters: 33,
    active: 3,
    size: 25_430_749_137,
    quality: 73,
    requires: '0.32.9',
  },
  {
    name: 'gemma4:26b',
    title: 'Gemma 4 26B',
    maker: 'Google',
    blurb: 'A mixture of experts with 4B parameters at work at a time, good at reasoning and code, and it sees images.',
    parameters: 25.2,
    active: 3.8,
    size: 18_731_025_387,
    quality: 72,
    requires: '0.30.9',
  },
  {
    name: 'gpt-oss:20b',
    title: 'gpt-oss 20B',
    maker: 'OpenAI',
    blurb: 'OpenAI’s smaller open model: a dependable agent that fits in 16 GB.',
    parameters: 21,
    active: 3.6,
    size: 13_793_441_427,
    quality: 70,
    requires: '0.30.0',
  },
  {
    name: 'mimo-v2.6:9b',
    title: 'MiMo V2.6 9B',
    maker: 'Xiaomi',
    blurb: 'A small model for code and agents, for computers with 8 to 16 GB.',
    parameters: 9,
    active: 9,
    size: 6_550_810_853,
    quality: 56,
    requires: '0.40.15',
  },
  {
    name: 'qwen3.5:9b',
    title: 'Qwen3.5 9B',
    maker: 'Alibaba',
    blurb: 'A small all-rounder that sees images, for computers with 8 to 16 GB.',
    parameters: 9,
    active: 9,
    size: 6_550_825_373,
    quality: 54,
    requires: '0.30.0',
  },
  {
    name: 'gemma4:e4b',
    title: 'Gemma 4 E4B',
    maker: 'Google',
    blurb: 'Made for laptops and phones: small and quick, for computers with 8 to 16 GB.',
    parameters: 8,
    active: 4,
    size: 6_583_656_264,
    quality: 45,
    requires: '0.30.9',
  },
  {
    name: 'qwen3.5:4b',
    title: 'Qwen3.5 4B',
    maker: 'Alibaba',
    blurb: 'The smallest that still calls tools well enough to help, for computers with little memory.',
    parameters: 4,
    active: 4,
    size: 3_324_173_757,
    quality: 40,
    requires: '0.30.0',
  },
];

const GB = 1024 ** 3;

/**
 * About how fast memory is read, in bytes a second, which is what limits
 * how fast a model writes: each token reads every active parameter once.
 * Rough figures for each kind of hardware (discrete GPUs run from about
 * 250 to 1000 GB/s), of which a model gets about EFFICIENCY: measured on a
 * Radeon 890M with LPDDR5X, Qwen3.6 35B-A3B wrote 31 tokens a second.
 */
const BANDWIDTH = { discrete: 600e9, integrated: 100e9, cpu: 50e9 } as const;
const EFFICIENCY = 0.6;

/** What the desktop and its apps keep of the computer's memory while a model runs: a quarter, from 3 to 8 GB. */
function desktopReserve(memory: number): number {
  return Math.min(8 * GB, Math.max(3 * GB, memory / 4));
}

export type LocalFit = 'good' | 'slow' | 'too-big' | 'unsupported';

export interface LocalModelFit {
  fit: LocalFit;
  /** On the GPU, or on the computer's processor. */
  where: 'gpu' | 'cpu';
  /** About how many tokens a second it would write here. */
  speed: number;
  /** Memory it would take, its context included, in bytes. */
  memory: number;
  /** Why it isn't a good fit, in a few words; null when it is. */
  reason: string | null;
}

/** How fast a model must write to work as an agent: about a line of text a second. */
const GOOD_SPEED = 12;

/** Whether version a is at least b ("0.40.3" against "0.32.12"). */
export function versionAtLeast(a: string, b: string): boolean {
  const pa = a.split(/[.-]/).map((n) => parseInt(n, 10) || 0);
  const pb = b.split(/[.-]/).map((n) => parseInt(n, 10) || 0);
  for (let i = 0; i < 3; i++) {
    if ((pa[i] ?? 0) !== (pb[i] ?? 0)) return (pa[i] ?? 0) > (pb[i] ?? 0);
  }
  return true;
}

/** How a model would run here, from what Ollama found and the computer's memory. */
export function fitLocalModel(
  model: Pick<CatalogModel, 'size' | 'parameters' | 'active'> & { requires?: string },
  hardware: Pick<LocalModelsState, 'gpu' | 'memory'> & { version?: string | null },
): LocalModelFit {
  // Its weights, its context's cache (a few GB at 32K tokens), and the runtime.
  const memory = model.size * 1.1 + 1.5 * GB;
  if (model.requires && hardware.version && !versionAtLeast(hardware.version, model.requires)) {
    return { fit: 'unsupported', where: 'gpu', speed: 0, memory, reason: `Needs a newer Ollama (${model.requires}; this computer has ${hardware.version})` };
  }
  const active = model.size * (model.active / model.parameters);
  const gpu = hardware.gpu;
  // An integrated GPU's memory is the computer's: the desktop needs its share.
  const reserve = desktopReserve(hardware.memory);
  const gpuRoom = gpu ? (gpu.kind === 'integrated' ? Math.min(gpu.memory, hardware.memory - reserve) : gpu.memory) : 0;
  const ramRoom = hardware.memory - reserve;
  if (gpu && memory <= gpuRoom) {
    const speed = (BANDWIDTH[gpu.kind] * EFFICIENCY) / active;
    return speed >= GOOD_SPEED
      ? { fit: 'good', where: 'gpu', speed, memory, reason: null }
      : { fit: 'slow', where: 'gpu', speed, memory, reason: 'Slow on this GPU: it works all its parameters for every word' };
  }
  if (memory <= ramRoom) {
    const speed = (BANDWIDTH.cpu * EFFICIENCY) / active;
    return {
      fit: speed >= GOOD_SPEED ? 'good' : 'slow',
      where: 'cpu',
      speed,
      memory,
      reason: speed >= GOOD_SPEED ? null : gpu ? 'Slow here: too big for the GPU' : 'Slow here: runs on the processor',
    };
  }
  return { fit: 'too-big', where: 'cpu', speed: 0, memory, reason: `Too big for this computer: needs about ${Math.ceil(memory / GB)} GB` };
}

export interface LocalModelPick extends CatalogModel {
  fit: LocalModelFit;
  /** The one to choose. */
  best: boolean;
}

/** How many models Settings recommends. */
const PICKS = 3;

/**
 * The catalog for this computer: the best few that run well first (the
 * first of them best), then the rest, slow ones before ones too big.
 */
export function rankLocalModels(hardware: Pick<LocalModelsState, 'gpu' | 'memory'> & { version?: string | null }): { picks: LocalModelPick[]; others: LocalModelPick[] } {
  const all = CATALOG.map((model) => ({ ...model, fit: fitLocalModel(model, hardware), best: false }));
  const order: Record<LocalFit, number> = { good: 0, slow: 1, 'too-big': 2, unsupported: 3 };
  // Among those that run well, a GPU's before the processor's, then the most capable.
  const good = all
    .filter((m) => m.fit.fit === 'good')
    .sort((a, b) => (a.fit.where === b.fit.where ? b.quality - a.quality : a.fit.where === 'gpu' ? -1 : 1));
  const picks = good.slice(0, PICKS);
  if (picks[0]) picks[0].best = true;
  const others = all
    .filter((m) => !picks.includes(m))
    .sort((a, b) => order[a.fit.fit] - order[b.fit.fit] || b.quality - a.quality);
  return { picks, others };
}

/** "Fast", "Quick" or "Slow", for how many tokens a second it writes. */
export function describeSpeed(speed: number): string {
  if (speed >= 40) return 'Fast';
  if (speed >= GOOD_SPEED) return 'Quick';
  return 'Slow';
}

/** A size in bytes, as Settings shows it: "23 GB", "6.6 GB", "850 MB". */
export function formatModelSize(bytes: number): string {
  if (bytes >= 10e9) return `${Math.round(bytes / 1e9)} GB`;
  if (bytes >= 1e9) return `${(bytes / 1e9).toFixed(1)} GB`;
  return `${Math.max(1, Math.round(bytes / 1e6))} MB`;
}

/** The catalog's entry for an installed model: by name, "qwen3.6:35b-a3b" and "qwen3.6:35b-a3b" alike. */
export function catalogEntry(name: string): CatalogModel | undefined {
  const full = name.includes(':') ? name : `${name}:latest`;
  return CATALOG.find((m) => m.name === full);
}

/** What people call an installed model: the catalog's title, or Ollama's name. */
export function localModelTitle(name: string): string {
  return catalogEntry(name)?.title ?? name.replace(/:latest$/, '');
}

/**
 * How far a download has got, 0 to 1, or null before Ollama knows its size.
 * Ollama tells each layer's size as it gets to it, so its total grows; the
 * catalog's `size`, where it's known, keeps the figure from going back.
 */
export function pullProgress(pull: LocalPull, size?: number): number | null {
  const total = Math.max(pull.total, size ?? catalogEntry(pull.model)?.size ?? 0);
  return total > 0 && pull.total > 0 ? Math.min(1, pull.completed / total) : null;
}

/** A download's state in a few words: "Downloading… 42%", "Verifying…". */
export function describePull(pull: LocalPull, size?: number): string {
  if (pull.error) return pull.error;
  if (/verifying/i.test(pull.status)) return 'Verifying…';
  if (/writing|success/i.test(pull.status)) return 'Finishing…';
  const progress = pullProgress(pull, size);
  return progress !== null ? `Downloading… ${Math.floor(progress * 100)}%` : 'Starting…';
}

/** Strip Electron's IPC error prefix. */
export function cleanLocalModelsError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.replace(/^Error invoking remote method '[^']*':\s*(?:Error:\s*)?/, '');
}

/** What the GPU is, for a line in Settings: "AMD Radeon 890M · 35 GB for models". */
export function describeHardware(state: Pick<LocalModelsState, 'gpu' | 'memory' | 'external'>): string {
  const memory = `${Math.round(state.memory / GB)} GB of memory`;
  if (state.external) return `${memory} · Ollama is the system’s, so Din can’t tell which GPU it uses`;
  if (!state.gpu) return `No GPU found for models · ${memory}`;
  const name = state.gpu.name.replace(/\s*\((RADV|NVIDIA|Intel)[^)]*\)\s*$/i, '');
  return `${name} · ${Math.round(state.gpu.memory / GB)} GB for models · ${memory}`;
}
