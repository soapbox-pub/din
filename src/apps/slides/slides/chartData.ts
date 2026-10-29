import { at, attr, kid, kids, numAttr, type OpcPackage } from '@/shared/office/ooxml';
import type { Color } from './model';
import { parseColor } from './read';

/** A chart's data as its part caches it: what ChartView draws. */
export interface ChartSeries {
  name: string;
  values: number[];
  color?: Color;
  points: (Color | undefined)[];
}

export interface ChartData {
  type: 'col' | 'bar' | 'line' | 'area' | 'pie' | 'doughnut' | 'scatter';
  grouping: string;
  title: string | null;
  cats: string[];
  series: ChartSeries[];
  legend: string | null;
  varyColors: boolean;
  /** Base text size in hundredths of a point. */
  sz: number;
}

const cacheVals = (el: Element | null): string[] => {
  const cache = el ? Array.from(el.getElementsByTagName('*')).find((e) => e.localName === 'strCache' || e.localName === 'numCache') : null;
  const out: string[] = [];
  const count = numAttr(kid(cache ?? null, 'ptCount'), 'val') ?? 0;
  for (let i = 0; i < count; i++) out.push('');
  for (const pt of kids(cache ?? null, 'pt')) out[numAttr(pt, 'idx') ?? out.length] = kid(pt, 'v')?.textContent ?? '';
  return out;
};

const solidOf = (spPr: Element | null): Color | undefined => parseColor(kid(spPr, 'solidFill')?.firstElementChild);

function richText(el: Element | null): string {
  if (!el) return '';
  return Array.from(el.getElementsByTagName('*'))
    .filter((e) => e.localName === 'p')
    .map((p) => Array.from(p.getElementsByTagName('*')).filter((e) => e.localName === 't').map((t) => t.textContent ?? '').join(''))
    .join('\n');
}

const chartCache = new WeakMap<OpcPackage, Map<string, ChartData | null>>();

export function readChart(pkg: OpcPackage, part: string): ChartData | null {
  let m = chartCache.get(pkg);
  if (!m) chartCache.set(pkg, (m = new Map()));
  if (m.has(part)) return m.get(part)!;
  let data: ChartData | null;
  try {
    data = parseChart(pkg, part);
  } catch {
    data = null;
  }
  m.set(part, data);
  return data;
}

function parseChart(pkg: OpcPackage, part: string): ChartData | null {
  const doc = pkg.xml(part);
  if (!doc) return null;
  const chart = kid(doc.documentElement, 'chart');
  const plot = kid(chart, 'plotArea');
  const kinds = kids(plot).filter((e) => /Chart$/.test(e.localName));
  const main = kinds[0];
  if (!main) return null;
  const local = main.localName;
  let type: ChartData['type'] = 'col';
  if (local === 'barChart' || local === 'bar3DChart') type = attr(kid(main, 'barDir'), 'val') === 'bar' ? 'bar' : 'col';
  else if (/^line/.test(local)) type = 'line';
  else if (/^area/.test(local)) type = 'area';
  else if (/^pie|ofPie/.test(local)) type = 'pie';
  else if (local === 'doughnutChart') type = 'doughnut';
  else if (local === 'scatterChart' || local === 'bubbleChart') type = 'scatter';
  const series: ChartSeries[] = kids(main, 'ser').map((ser) => {
    const name = cacheVals(kid(ser, 'tx'))[0] ?? kid(kid(ser, 'tx'), 'v')?.textContent ?? '';
    const vals = cacheVals(kid(ser, 'val') ?? kid(ser, 'yVal')).map((v) => Number(v) || 0);
    const points: (Color | undefined)[] = [];
    for (const dPt of kids(ser, 'dPt')) points[numAttr(kid(dPt, 'idx'), 'val') ?? 0] = solidOf(kid(dPt, 'spPr'));
    const spPr = kid(ser, 'spPr');
    const color = solidOf(spPr) ?? (type === 'line' ? solidOf(kid(spPr, 'ln')) : undefined);
    return { name, values: vals, ...(color ? { color } : {}), points };
  });
  const firstSer = kids(main, 'ser')[0] ?? null;
  const cats = cacheVals(kid(firstSer, 'cat') ?? kid(firstSer, 'xVal'));
  const titleEl = kid(chart, 'title');
  const deleted = attr(kid(chart, 'autoTitleDeleted'), 'val') === '1';
  let title: string | null = null;
  if (titleEl) title = richText(kid(titleEl, 'tx')) || (series.length === 1 ? series[0].name : 'Chart Title');
  else if (!deleted && series.length === 1 && (type === 'pie' || type === 'doughnut')) title = series[0].name;
  const legend = kid(chart, 'legend');
  const sz = at(doc.documentElement, 'txPr', 'p', 'pPr', 'defRPr');
  return {
    type,
    grouping: attr(kid(main, 'grouping'), 'val') ?? 'clustered',
    title,
    cats: cats.length ? cats : (series[0]?.values.map((_, i) => String(i + 1)) ?? []),
    series,
    legend: legend ? (attr(kid(legend, 'legendPos'), 'val') ?? 'r') : null,
    varyColors: attr(kid(main, 'varyColors'), 'val') === '1',
    sz: numAttr(sz ?? null, 'sz') ?? 1000,
  };
}

