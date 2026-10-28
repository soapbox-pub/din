import { z } from 'zod';

/** What a calculator keeps between sessions, like a TI-89 does when switched off. */

export const STORAGE_KEY = 'din:calculator:state';

const ModeSchema = z.object({
  angle: z.enum(['rad', 'deg']),
  /** Exact/Approx: AUTO keeps exact answers unless the entry has a decimal. */
  exact: z.enum(['auto', 'exact', 'approx']),
  digits: z.object({ mode: z.enum(['float', 'fix']), digits: z.number().int().min(0).max(12) }),
  complex: z.enum(['real', 'rectangular']),
  graph: z.enum(['function', 'parametric', 'polar', 'de', 'surface']),
});
export type Mode = z.infer<typeof ModeSchema>;

const HistoryEntrySchema = z.object({
  id: z.number(),
  input: z.string(),
  approx: z.boolean(),
  /** giac's printed result. */
  result: z.string().optional(),
  decimal: z.string().optional(),
  error: z.string().optional(),
  notes: z.array(z.string()).optional(),
  done: z.boolean().optional(),
});
export type HistoryEntry = z.infer<typeof HistoryEntrySchema>;

const PlotSchema = z.object({
  id: z.number(),
  /** One expression; x and y for parametric; y' and its initial condition for differential equations. */
  exprs: z.array(z.string()),
  enabled: z.boolean(),
  color: z.string(),
});
export type Plot = z.infer<typeof PlotSchema>;

const WindowSchema = z.object({
  xmin: z.number(),
  xmax: z.number(),
  xscl: z.number(),
  ymin: z.number(),
  ymax: z.number(),
  yscl: z.number(),
  tmin: z.number(),
  tmax: z.number(),
  tstep: z.number(),
  θmin: z.number(),
  θmax: z.number(),
  θstep: z.number(),
});
export type GraphWindow = z.infer<typeof WindowSchema>;

const StateSchema = z.object({
  mode: ModeSchema,
  history: z.array(HistoryEntrySchema),
  nextId: z.number(),
  /** User variables as giac source, restored into a fresh session. */
  vars: z.record(z.string(), z.string()),
  plots: z.object({
    function: z.array(PlotSchema),
    parametric: z.array(PlotSchema),
    polar: z.array(PlotSchema),
    de: z.array(PlotSchema),
    surface: z.array(PlotSchema),
  }),
  window: WindowSchema,
  grid: z.boolean(),
  table: z.object({ start: z.number(), step: z.number() }),
  keypad: z.boolean(),
  /** The data editor's scatter plot on the graph. */
  scatter: z.object({ enabled: z.boolean(), x: z.string(), y: z.string() }),
});
export type CalculatorState = z.infer<typeof StateSchema>;

/** Plot colors, distinct in light and dark themes. */
export const PLOT_COLORS = ['#2563eb', '#dc2626', '#16a34a', '#9333ea', '#ea580c', '#0891b2', '#db2777', '#65a30d'];

export const STANDARD_WINDOW: GraphWindow = {
  xmin: -10,
  xmax: 10,
  xscl: 1,
  ymin: -10,
  ymax: 10,
  yscl: 1,
  tmin: 0,
  tmax: 2 * Math.PI,
  tstep: Math.PI / 48,
  θmin: 0,
  θmax: 2 * Math.PI,
  θstep: Math.PI / 48,
};

const emptyPlots = (count: number, start: number): Plot[] =>
  Array.from({ length: count }, (_, i) => ({ id: start + i, exprs: [''], enabled: true, color: PLOT_COLORS[i % PLOT_COLORS.length] }));

export const DEFAULT_STATE: CalculatorState = {
  mode: { angle: 'rad', exact: 'auto', digits: { mode: 'float', digits: 6 }, complex: 'real', graph: 'function' },
  history: [],
  nextId: 1,
  vars: {},
  plots: {
    function: emptyPlots(8, 1),
    parametric: emptyPlots(4, 101).map((p) => ({ ...p, exprs: ['', ''] })),
    polar: emptyPlots(4, 201),
    de: emptyPlots(4, 301).map((p) => ({ ...p, exprs: ['', ''] })),
    surface: emptyPlots(2, 401),
  },
  window: STANDARD_WINDOW,
  grid: false,
  table: { start: 0, step: 1 },
  keypad: true,
  scatter: { enabled: false, x: 'L1', y: 'L2' },
};

/** How many history entries are kept. */
export const HISTORY_LIMIT = 200;

export function loadState(): CalculatorState {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return DEFAULT_STATE;
    const saved = JSON.parse(raw) as Partial<CalculatorState>;
    // Graph types added later start empty rather than discarding the rest.
    const plots = { ...DEFAULT_STATE.plots, ...saved.plots };
    const parsed = StateSchema.safeParse({ ...DEFAULT_STATE, ...saved, plots });
    return parsed.success ? parsed.data : DEFAULT_STATE;
  } catch {
    return DEFAULT_STATE;
  }
}

export function saveState(state: CalculatorState) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  } catch (error) {
    console.warn('Failed to save the calculator:', error);
  }
}

/**
 * The basic calculator, kept apart from the advanced one's state: only one of
 * them is mounted at a time, and each saves its own.
 */
export const BASIC_STORAGE_KEY = 'din:calculator:basic';

const BasicStateSchema = z.object({
  /** Which calculator the window shows. Basic until the user asks for more. */
  view: z.enum(['basic', 'advanced']),
  /** Past calculations, oldest first. */
  tape: z.array(z.object({ expr: z.string(), result: z.string() })),
});
export type BasicState = z.infer<typeof BasicStateSchema>;
export type CalculatorView = BasicState['view'];

export const TAPE_LIMIT = 100;

const DEFAULT_BASIC_STATE: BasicState = { view: 'basic', tape: [] };

export function loadBasicState(): BasicState {
  try {
    const raw = localStorage.getItem(BASIC_STORAGE_KEY);
    if (!raw) return DEFAULT_BASIC_STATE;
    const parsed = BasicStateSchema.safeParse({ ...DEFAULT_BASIC_STATE, ...(JSON.parse(raw) as Partial<BasicState>) });
    return parsed.success ? parsed.data : DEFAULT_BASIC_STATE;
  } catch {
    return DEFAULT_BASIC_STATE;
  }
}

export function saveBasicState(state: BasicState) {
  try {
    localStorage.setItem(BASIC_STORAGE_KEY, JSON.stringify(state));
  } catch (error) {
    console.warn('Failed to save the calculator:', error);
  }
}
