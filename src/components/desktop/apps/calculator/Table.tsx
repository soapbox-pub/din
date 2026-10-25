import { useMemo, useState } from 'react';
import { formatNumberText, type NumberFormat } from './latex';
import { plotNames, type CompiledPlot, type GraphKind } from './plots';
import { NumberField } from './YEditor';

const PAGE = 50;

/** The TI-89's TABLE: each graphed expression at TblStart, TblStart+ΔTbl, … */
export function Table({
  kind,
  compiled,
  enabledIds,
  start,
  step,
  format,
  onSettings,
}: {
  kind: GraphKind;
  compiled: CompiledPlot[];
  enabledIds: Set<number>;
  start: number;
  step: number;
  format: NumberFormat;
  onSettings: (settings: { start: number; step: number }) => void;
}) {
  const [rows, setRows] = useState(PAGE);
  const variable = kind === 'function' ? 'x' : kind === 'parametric' ? 't' : 'θ';

  const columns = useMemo(
    () =>
      compiled
        .filter((c) => enabledIds.has(c.id) && !c.error && c.fns.length > 0)
        .flatMap((c) => plotNames(kind, c.index).map((name, i) => ({ key: `${c.id}:${i}`, name, color: c.color, f: c.fns[i] }))),
    [compiled, enabledIds, kind],
  );

  const values = useMemo(
    () =>
      Array.from({ length: rows }, (_, i) => {
        // Multiply rather than accumulate, so 0.1 steps don't drift.
        const v = start + i * step;
        return { v, cells: columns.map((c) => (c.f ? c.f(v) : NaN)) };
      }),
    [rows, start, step, columns],
  );

  const fmt = (v: number) => formatNumberText(v, format);

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex shrink-0 items-end gap-3 border-b border-border/60 px-3 py-2">
        <div className="w-28">
          <NumberField key={`start:${start}`} label="tblStart" value={start} onCommit={(v) => onSettings({ start: v, step })} />
        </div>
        <div className="w-28">
          <NumberField key={`step:${step}`} label="ΔTbl" value={step} onCommit={(v) => v !== 0 && onSettings({ start, step: v })} />
        </div>
      </div>
      {columns.length === 0 ? (
        <p className="p-6 text-center text-sm text-muted-foreground">Enter a function in the Graph tab to see its table.</p>
      ) : (
        <div
          className="min-h-0 flex-1 overflow-auto"
          onScroll={(e) => {
            const el = e.currentTarget;
            if (el.scrollTop + el.clientHeight > el.scrollHeight - 200 && rows < 2000) setRows((r) => r + PAGE);
          }}
        >
          <table className="w-full max-w-4xl border-separate border-spacing-0 font-mono text-sm tabular-nums">
            <thead className="sticky top-0 z-10 bg-muted/90 backdrop-blur">
              <tr>
                <th scope="col" className="border-b border-border/60 px-3 py-1.5 text-left font-semibold">
                  {variable}
                </th>
                {columns.map((c) => (
                  <th key={c.key} scope="col" className="border-b border-border/60 px-3 py-1.5 text-right font-semibold">
                    <span className="mr-1.5 inline-block size-2 rounded-full align-middle" style={{ backgroundColor: c.color }} />
                    {c.name}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {values.map((row, i) => (
                <tr key={i} className="odd:bg-foreground/[0.02]">
                  <th scope="row" className="border-b border-border/30 px-3 py-1 text-left font-medium">
                    {fmt(row.v)}
                  </th>
                  {row.cells.map((value, j) => (
                    <td key={columns[j].key} className="border-b border-border/30 px-3 py-1 text-right">
                      {fmt(value)}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
