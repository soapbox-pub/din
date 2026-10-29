import type { ReactNode } from 'react';
import type { SlideCtx } from './model';
import type { ChartData, ChartSeries } from './chartData';
import { colorCss } from './resolve';

/**
 * Charts, drawn from the values cached in their chart part (c:numCache,
 * c:strCache) so a deck shows its charts without the embedded workbook.
 * Column, bar, line, area, pie and doughnut charts, with a title and legend,
 * in the theme's accent colors as Office draws them.
 */

function niceStep(range: number): number {
  const raw = range / 5;
  const mag = Math.pow(10, Math.floor(Math.log10(raw || 1)));
  const n = raw / mag;
  return (n <= 1 ? 1 : n <= 2 ? 2 : n <= 5 ? 5 : 10) * mag;
}

const fmt = (v: number) => (Math.abs(v) >= 1000 ? v.toLocaleString('en-US') : String(Math.round(v * 100) / 100));

export function ChartView({ chart, ctx, w, h }: { chart: ChartData; ctx: SlideCtx; w: number; h: number }) {
  const base = (chart.sz / 100) * (4 / 3);
  const accent = (i: number) => colorCss({ scheme: `accent${(i % 6) + 1}`, ...(i >= 6 ? { mods: [['lumMod', 60000]] } : {}) }, ctx) ?? '#4472C4';
  const seriesColor = (s: ChartSeries, i: number) => (s.color ? (colorCss(s.color, ctx) ?? accent(i)) : accent(i));
  const textColor = '#595959';
  const font = 'Carlito, Calibri, sans-serif';
  const pad = Math.min(w, h) * 0.04;
  let top = pad;
  const parts: ReactNode[] = [];
  if (chart.title) {
    const ts = base * 1.4;
    parts.push(
      <text key="title" x={w / 2} y={top + ts} textAnchor="middle" fontSize={ts} fontWeight={700} fill={textColor} fontFamily={font}>
        {chart.title}
      </text>,
    );
    top += ts * 1.6;
  }
  const pie = chart.type === 'pie' || chart.type === 'doughnut';
  const legendItems = pie ? chart.cats.map((c, i) => ({ label: c, color: chart.series[0]?.points[i] ? colorCss(chart.series[0].points[i], ctx)! : accent(i) })) : chart.series.map((s, i) => ({ label: s.name, color: seriesColor(s, i) }));
  let right = w - pad;
  let bottom = h - pad;
  if (chart.legend && legendItems.length) {
    const ls = base;
    if (chart.legend === 'r' || chart.legend === 'l') {
      const lw = Math.min(w * 0.3, Math.max(...legendItems.map((l) => l.label.length)) * ls * 0.55 + ls * 2);
      const lh = legendItems.length * ls * 1.5;
      const ly = top + (bottom - top - lh) / 2;
      legendItems.forEach((l, i) => {
        parts.push(
          <g key={`lg${i}`}>
            <rect x={right - lw} y={ly + i * ls * 1.5 + ls * 0.2} width={ls * 0.7} height={ls * 0.7} fill={l.color} />
            <text x={right - lw + ls} y={ly + i * ls * 1.5 + ls * 0.85} fontSize={ls} fill={textColor} fontFamily={font}>
              {l.label}
            </text>
          </g>,
        );
      });
      right -= lw + pad;
    } else {
      const each = legendItems.map((l) => l.label.length * ls * 0.55 + ls * 2);
      const total = each.reduce((a, b) => a + b, 0);
      let lx = (w - total) / 2;
      const ly = chart.legend === 't' ? top : bottom - ls * 1.2;
      legendItems.forEach((l, i) => {
        parts.push(
          <g key={`lg${i}`}>
            <rect x={lx} y={ly + ls * 0.15} width={ls * 0.7} height={ls * 0.7} fill={l.color} />
            <text x={lx + ls} y={ly + ls * 0.8} fontSize={ls} fill={textColor} fontFamily={font}>
              {l.label}
            </text>
          </g>,
        );
        lx += each[i];
      });
      if (chart.legend === 't') top += ls * 2;
      else bottom -= ls * 2;
    }
  }
  if (pie) {
    const s = chart.series[0];
    const total = s ? s.values.reduce((a, b) => a + Math.max(0, b), 0) : 0;
    const r = Math.max(0, Math.min(right - pad, bottom - top) / 2);
    const cx = pad + (right - pad) / 2;
    const cy = top + (bottom - top) / 2;
    let a = -Math.PI / 2;
    s?.values.forEach((v, i) => {
      const sweep = total ? (Math.max(0, v) / total) * Math.PI * 2 : 0;
      const a2 = a + sweep;
      const large = sweep > Math.PI ? 1 : 0;
      const p = (ang: number, rad: number) => `${cx + rad * Math.cos(ang)} ${cy + rad * Math.sin(ang)}`;
      const ir = chart.type === 'doughnut' ? r * 0.5 : 0;
      const d = sweep >= Math.PI * 2 - 1e-6
        ? `M${p(0, r)}A${r} ${r} 0 1 1 ${p(Math.PI, r)}A${r} ${r} 0 1 1 ${p(0, r)}Z`
        : ir
          ? `M${p(a, r)}A${r} ${r} 0 ${large} 1 ${p(a2, r)}L${p(a2, ir)}A${ir} ${ir} 0 ${large} 0 ${p(a, ir)}Z`
          : `M${cx} ${cy}L${p(a, r)}A${r} ${r} 0 ${large} 1 ${p(a2, r)}Z`;
      parts.push(<path key={`p${i}`} d={d} fill={s.points[i] ? colorCss(s.points[i], ctx) : accent(i)} stroke="#fff" strokeWidth={Math.max(1, r / 100)} />);
      a = a2;
    });
    return (
      <svg width={w} height={h} style={{ position: 'absolute', inset: 0, overflow: 'visible' }}>
        {parts}
      </svg>
    );
  }
  // Axes: values up the side (or along the bottom for bar charts), categories across.
  const stacked = chart.grouping === 'stacked' || chart.grouping === 'percentStacked';
  const percent = chart.grouping === 'percentStacked';
  const n = chart.cats.length || 1;
  let min = 0;
  let max = 0;
  for (let c = 0; c < n; c++) {
    if (stacked) {
      let pos = 0;
      let neg = 0;
      for (const s of chart.series) {
        if (s.values[c] >= 0) pos += s.values[c] || 0;
        else neg += s.values[c];
      }
      max = Math.max(max, percent ? 1 : pos);
      min = Math.min(min, percent ? 0 : neg);
    } else for (const s of chart.series) {
      max = Math.max(max, s.values[c] ?? 0);
      min = Math.min(min, s.values[c] ?? 0);
    }
  }
  if (max === min) max = min + 1;
  const step = niceStep(max - min);
  max = Math.ceil(max / step) * step;
  min = Math.floor(min / step) * step;
  const ls = base;
  const labelW = Math.max(fmt(max).length, fmt(min).length) * ls * 0.55 + ls * 0.5;
  const horizontal = chart.type === 'bar';
  const left = pad + (horizontal ? Math.min(w * 0.25, Math.max(...chart.cats.map((c) => c.length)) * ls * 0.55 + ls) : labelW);
  const plotB = bottom - ls * 1.6;
  const plotW = right - left;
  const plotH = plotB - top;
  const valPos = (v: number) => (horizontal ? left + ((v - min) / (max - min)) * plotW : plotB - ((v - min) / (max - min)) * plotH);
  for (let v = min; v <= max + step / 2; v += step) {
    const p = valPos(v);
    parts.push(
      horizontal ? (
        <g key={`g${v}`}>
          <line x1={p} x2={p} y1={top} y2={plotB} stroke="#d9d9d9" strokeWidth={0.75} />
          <text x={p} y={plotB + ls * 1.2} textAnchor="middle" fontSize={ls} fill={textColor} fontFamily={font}>{percent ? `${Math.round(v * 100)}%` : fmt(v)}</text>
        </g>
      ) : (
        <g key={`g${v}`}>
          <line x1={left} x2={right} y1={p} y2={p} stroke="#d9d9d9" strokeWidth={0.75} />
          <text x={left - ls * 0.4} y={p + ls * 0.35} textAnchor="end" fontSize={ls} fill={textColor} fontFamily={font}>{percent ? `${Math.round(v * 100)}%` : fmt(v)}</text>
        </g>
      ),
    );
  }
  const band = (horizontal ? plotH : plotW) / n;
  chart.cats.forEach((c, i) => {
    const mid = (horizontal ? top : left) + band * (i + 0.5);
    parts.push(
      horizontal ? (
        <text key={`c${i}`} x={left - ls * 0.4} y={top + band * (n - i - 0.5) + ls * 0.35} textAnchor="end" fontSize={ls} fill={textColor} fontFamily={font}>{c}</text>
      ) : (
        <text key={`c${i}`} x={mid} y={plotB + ls * 1.2} textAnchor="middle" fontSize={ls} fill={textColor} fontFamily={font}>{c}</text>
      ),
    );
  });
  const zero = valPos(Math.max(min, 0));
  if (chart.type === 'col' || chart.type === 'bar') {
    const groups = stacked ? 1 : chart.series.length;
    const gap = band * 0.18;
    const bw = (band - gap * 2) / Math.max(1, groups);
    for (let c = 0; c < n; c++) {
      let pos = 0;
      let neg = 0;
      const total = percent ? chart.series.reduce((a, s) => a + Math.abs(s.values[c] || 0), 0) || 1 : 1;
      chart.series.forEach((s, i) => {
        let v = s.values[c] || 0;
        if (percent) v /= total;
        let from = 0;
        if (stacked) {
          from = v >= 0 ? pos : neg;
          if (v >= 0) pos += v;
          else neg += v;
        }
        const a = valPos(from);
        const b = valPos(from + v);
        const slot = horizontal ? top + band * (n - c - 1) + gap + (stacked ? 0 : bw * (groups - 1 - i)) : left + band * c + gap + (stacked ? 0 : bw * i);
        const color = s.points[c] ? colorCss(s.points[c], ctx) : chart.varyColors && chart.series.length === 1 ? accent(c) : seriesColor(s, i);
        parts.push(
          horizontal ? (
            <rect key={`b${c}-${i}`} x={Math.min(a, b)} y={slot} width={Math.abs(b - a)} height={bw * 0.98} fill={color} />
          ) : (
            <rect key={`b${c}-${i}`} x={slot} y={Math.min(a, b)} width={bw * 0.98} height={Math.abs(b - a)} fill={color} />
          ),
        );
      });
    }
  } else {
    const acc = new Array<number>(n).fill(0);
    chart.series.forEach((s, i) => {
      const pts = chart.cats.map((_, c) => {
        let v = s.values[c] || 0;
        if (stacked) {
          acc[c] += v;
          v = acc[c];
        }
        return [left + band * (c + 0.5), valPos(v)] as const;
      });
      const color = seriesColor(s, i);
      const d = pts.map(([px, py], k) => `${k ? 'L' : 'M'}${px} ${py}`).join('');
      if (chart.type === 'area') parts.push(<path key={`a${i}`} d={`${d}L${pts[pts.length - 1]?.[0] ?? left} ${zero}L${pts[0]?.[0] ?? left} ${zero}Z`} fill={color} opacity={0.85} />);
      else parts.push(<path key={`l${i}`} d={d} fill="none" stroke={color} strokeWidth={Math.max(1.5, ls / 5)} strokeLinejoin="round" strokeLinecap="round" />);
    });
  }
  parts.push(horizontal ? <line key="axis" x1={zero} x2={zero} y1={top} y2={plotB} stroke="#bfbfbf" /> : <line key="axis" x1={left} x2={right} y1={zero} y2={zero} stroke="#bfbfbf" />);
  return (
    <svg width={w} height={h} style={{ position: 'absolute', inset: 0, overflow: 'visible' }}>
      {parts}
    </svg>
  );
}
