/**
 * Boot/runtime profiler. {@link perfMark} records one-shot milestones as a
 * timeline; {@link perfTime}/{@link perfCount} aggregate repeated operations by
 * label (count / total / max / work units). Always on (it's a Map lookup);
 * only the report is opt-in: `__dinPerf()` / `__dinPerf(true)` to reset.
 */

/** Page-load origin, so every mark reads as an offset a pasted log can be diffed on. */
const t0 = now();

function now(): number {
  return typeof performance !== 'undefined' && typeof performance.now === 'function'
    ? performance.now()
    : Date.now();
}

/** One-shot boot milestones, in the order they were reached. */
const marks: { label: string; at: number; detail?: string }[] = [];
/**
 * Always on, and some milestones repeat (one per window opened): keep the
 * boot timeline at the front and count the rest rather than grow for the
 * session.
 */
const MAX_MARKS = 300;
let droppedMarks = 0;

/** Aggregate per label. `unit` is a caller-defined work count (rows, files, …). */
interface Bucket {
  count: number;
  total: number;
  max: number;
  units: number;
  unitName?: string;
}

const buckets = new Map<string, Bucket>();

function bucket(label: string): Bucket {
  let b = buckets.get(label);
  if (!b) {
    b = { count: 0, total: 0, max: 0, units: 0 };
    buckets.set(label, b);
  }
  return b;
}

/** Record a one-shot milestone. Repeats are kept (a repeat is itself a finding). */
export function perfMark(label: string, detail?: string): void {
  if (marks.length >= MAX_MARKS) {
    droppedMarks += 1;
    return;
  }
  marks.push({ label, at: now() - t0, detail });
}

/** Add `ms` (and optional work count) to `label`, for callers that already measured. */
export function perfCount(label: string, ms: number, units?: number, unitName?: string): void {
  const b = bucket(label);
  b.count += 1;
  b.total += ms;
  if (ms > b.max) b.max = ms;
  if (units !== undefined) {
    b.units += units;
    b.unitName ??= unitName;
  }
}

/**
 * Time an async operation into `label`, including rejections. `units` derives a
 * work count from the result, so many small calls differ from one big one.
 */
export async function perfTime<T>(
  label: string,
  fn: () => Promise<T>,
  units?: (result: T) => number,
  unitName = 'rows',
): Promise<T> {
  const start = now();
  try {
    const result = await fn();
    perfCount(label, now() - start, units?.(result), unitName);
    return result;
  } catch (error) {
    perfCount(label, now() - start);
    throw error;
  }
}

/** The collected profile, for a report or a test. */
export interface PerfReport {
  elapsed: number;
  timeline: { label: string; at: number; detail?: string }[];
  /** Milestones past the timeline's cap, not recorded. */
  droppedMarks: number;
  aggregates: {
    label: string;
    count: number;
    total: number;
    mean: number;
    max: number;
    units?: number;
    unitName?: string;
  }[];
}

/** Snapshot the profile, sorted by total cost descending. */
export function perfReport(): PerfReport {
  return {
    elapsed: now() - t0,
    timeline: marks.map((m) => ({ ...m })),
    droppedMarks,
    aggregates: [...buckets.entries()]
      .map(([label, b]) => ({
        label,
        count: b.count,
        total: b.total,
        mean: b.count > 0 ? b.total / b.count : 0,
        max: b.max,
        ...(b.unitName ? { units: b.units, unitName: b.unitName } : {}),
      }))
      .sort((a, b) => b.total - a.total),
  };
}

/** Drop the aggregates (keeps the boot timeline, which is not repeatable). */
export function perfReset(): void {
  buckets.clear();
}

function round(ms: number): number {
  return Math.round(ms * 10) / 10;
}

/** Print the profile. Installed on `window` as `__dinPerf`. */
function printReport(reset = false): PerfReport {
  const report = perfReport();
  console.log(
    `%c[din perf]%c ${round(report.elapsed)}ms since page load`,
    'color:#c586ff;font-weight:bold',
    'color:inherit',
  );
  console.log('— boot timeline —');
  console.table(
    report.timeline.map((m) => ({ '+ms': round(m.at), milestone: m.label, detail: m.detail ?? '' })),
  );
  console.log('— cost by label (sorted by total) —');
  console.table(
    report.aggregates.map((a) => ({
      label: a.label,
      calls: a.count,
      'total ms': round(a.total),
      'mean ms': round(a.mean),
      'max ms': round(a.max),
      [a.unitName ?? 'units']: a.units ?? '',
    })),
  );
  if (reset) perfReset();
  return report;
}

// Installed by the first importer, so this isn't a side-effect-only module.
if (typeof window !== 'undefined') {
  (window as unknown as { __dinPerf?: (reset?: boolean) => PerfReport }).__dinPerf = printReport;
}
