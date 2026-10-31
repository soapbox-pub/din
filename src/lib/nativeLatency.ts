/**
 * Input-to-screen latency of native apps, split where Din can see it.
 *
 * PROFILING BUILDS ONLY: every call site is behind
 * `import.meta.env.VITE_PROFILE === '1'`, so normal builds drop them.
 *
 * One input at a time is followed (the first after the last one was
 * answered), through three stages:
 *
 * - `queue`: from the input's own timestamp to Din forwarding it. Time the
 *   event spent waiting in Chromium (pointermove waits for the next frame).
 * - `app`: from forwarding it to the next frame of the app's arriving. The
 *   round trip through the worker and compositor, and the app's own drawing.
 *   Only meaningful for an app that draws nothing but answers (a terminal
 *   echoing a key, a test app); a blinking caret can answer early.
 * - `display`: from the frame arriving to the start of the shell frame that
 *   shows it (requestAnimationFrame's timestamp). The screen adds about one
 *   more refresh after that, which isn't counted.
 *
 * Console: `__dinPerf.native(reset?)`.
 */

export type NativeInputKind = 'key' | 'button' | 'motion';

interface Pending {
  kind: NativeInputKind;
  /** The DOM event's timestamp. */
  at: number;
  sent: number;
}

interface Measured {
  queue: number;
  app: number;
  display: number;
  total: number;
}

const MAX_SAMPLES = 500;

let pending: Pending | null = null;
/** Answered, waiting for the shell frame that shows it. */
let arrived: (Pending & { frame: number }) | null = null;
const samples = new Map<NativeInputKind, Measured[]>();

/** An input was forwarded to the app; `at` is its DOM event's timeStamp. */
export function noteNativeInput(kind: NativeInputKind, at: number): void {
  if (pending || arrived) return;
  pending = { kind, at, sent: performance.now() };
}

/** A frame from an app arrived (and was drawn). */
export function noteNativeFrame(): void {
  if (!pending) return;
  arrived = { ...pending, frame: performance.now() };
  pending = null;
  requestAnimationFrame((shown) => {
    const a = arrived;
    arrived = null;
    if (!a) return;
    const list = samples.get(a.kind) ?? [];
    list.push({
      queue: a.sent - a.at,
      app: a.frame - a.sent,
      display: Math.max(0, shown - a.frame),
      total: Math.max(shown, a.frame) - a.at,
    });
    if (list.length > MAX_SAMPLES) list.splice(0, list.length - MAX_SAMPLES);
    samples.set(a.kind, list);
  });
}

function percentile(values: number[], p: number): number {
  const sorted = [...values].sort((a, b) => a - b);
  const value = sorted[Math.min(sorted.length - 1, Math.floor((sorted.length * p) / 100))] ?? 0;
  return Math.round(value * 10) / 10;
}

export interface NativeLatencyRow {
  input: NativeInputKind;
  samples: number;
  stage: keyof Measured;
  p50: number;
  p90: number;
  max: number;
}

export function nativeLatencyReport(): NativeLatencyRow[] {
  const rows: NativeLatencyRow[] = [];
  for (const [input, list] of samples) {
    for (const stage of ['queue', 'app', 'display', 'total'] as const) {
      const values = list.map((m) => m[stage]);
      rows.push({
        input,
        samples: list.length,
        stage,
        p50: percentile(values, 50),
        p90: percentile(values, 90),
        max: percentile(values, 100),
      });
    }
  }
  return rows;
}

/** How often startNativeLatencyLog reports. */
const LOG_MS = 10_000;
/** A shell frame this long is a hitch worth naming. */
const LONG_FRAME_MS = 50;
/** Long frames kept per report. */
const MAX_LONG_FRAMES = 20;

/**
 * Every LOG_MS, one `[din perf]` line on the console: the latencies above
 * (p50/p90/max per input and stage, then reset) and the shell's own frame
 * intervals. A profiling session's main process sends those lines to the
 * journal (electron/main.mts), where they can be read while an app runs.
 */
export function startNativeLatencyLog(): void {
  const gaps: number[] = [];
  let last = 0;
  const tick = (time: number) => {
    if (last) gaps.push(time - last);
    last = time;
    requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
  // The shell's long frames, and what ran in them: where its hitches go.
  const long: { ms: number; blocking: number; render: number; scripts: string[] }[] = [];
  if (PerformanceObserver.supportedEntryTypes?.includes('long-animation-frame')) {
    new PerformanceObserver((list) => {
      for (const entry of list.getEntries()) {
        if (entry.duration < LONG_FRAME_MS || long.length >= MAX_LONG_FRAMES) continue;
        const frame = entry as PerformanceEntry & {
          blockingDuration?: number;
          renderStart?: number;
          scripts?: { duration: number; invoker?: string; sourceURL?: string; sourceFunctionName?: string }[];
        };
        const scripts = [...(frame.scripts ?? [])]
          .sort((a, b) => b.duration - a.duration)
          .slice(0, 3)
          .map((s) => {
            let where = '';
            try {
              where = s.sourceURL ? new URL(s.sourceURL).pathname.split('/').pop() ?? '' : '';
            } catch {
              // An unparseable source is left out.
            }
            return `${Math.round(s.duration)}ms ${s.invoker?.split('?')[0] ?? ''} ${s.sourceFunctionName ?? ''} ${where}`.trim();
          });
        long.push({
          ms: Math.round(frame.duration),
          blocking: Math.round(frame.blockingDuration ?? 0),
          // From the frame's start to its rendering (style, layout, paint) starting.
          render: frame.renderStart ? Math.round(frame.startTime + frame.duration - frame.renderStart) : 0,
          scripts,
        });
      }
    }).observe({ type: 'long-animation-frame' });
  }
  window.setInterval(() => {
    const native: Record<string, [number, number, number]> = {};
    for (const row of nativeLatencyReport()) native[`${row.input}.${row.stage}`] = [row.p50, row.p90, row.max];
    const counts = Object.fromEntries([...samples].map(([input, list]) => [input, list.length]));
    const frames = gaps.splice(0);
    const shellFrames = {
      count: frames.length,
      p50: percentile(frames, 50),
      p99: percentile(frames, 99),
      max: percentile(frames, 100),
    };
    const longFrames = long.splice(0);
    console.info(`[din perf] ${JSON.stringify({ native, samples: counts, shellFrames, longFrames })}`);
    samples.clear();
  }, LOG_MS);
}

export function printNativeLatency(reset = false): NativeLatencyRow[] {
  const rows = nativeLatencyReport();
  console.log('%c[din perf: native input latency, ms]', 'color:#c586ff;font-weight:bold');
  console.table(rows);
  if (reset) {
    samples.clear();
    pending = null;
    arrived = null;
  }
  return rows;
}
