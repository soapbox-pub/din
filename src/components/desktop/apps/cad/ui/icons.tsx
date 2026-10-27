/**
 * Ribbon and status bar icons drawn after AutoCAD's: light line work with
 * the drawn object picked out in color, readable on the dark ribbon.
 */
type P = { className?: string };

const svg = (children: React.ReactNode, className = 'size-4', vb = '0 0 24 24') => (
  <svg viewBox={vb} className={className} fill="none" stroke="currentColor" strokeWidth={1.5} strokeLinecap="round" strokeLinejoin="round" aria-hidden>
    {children}
  </svg>
);

const BLUE = '#5cb6ff';
const YEL = '#f5c542';
const RED = '#ff6b6b';
const GRN = '#6fdc8c';
const grip = (x: number, y: number, c = BLUE) => <rect x={x - 1.6} y={y - 1.6} width={3.2} height={3.2} fill={c} stroke="none" />;

export const Icons = {
  line: ({ className }: P) => svg(<><path d="M4 19 20 5" stroke={BLUE} strokeWidth={2} />{grip(4, 19, '#fff')}{grip(20, 5, '#fff')}</>, className),
  pline: ({ className }: P) => svg(<><path d="M3 19 9 9h6c3 0 5 2 5 5s-2 5-5 5" stroke={BLUE} strokeWidth={2} />{grip(3, 19, '#fff')}{grip(9, 9, '#fff')}{grip(15, 9, '#fff')}</>, className),
  circle: ({ className }: P) => svg(<><circle cx={12} cy={12} r={8} stroke={BLUE} strokeWidth={2} /><path d="M12 12h8" strokeDasharray="2 2" />{grip(12, 12, '#fff')}</>, className),
  arc: ({ className }: P) => svg(<><path d="M4 18a9 9 0 0 1 16 0" stroke={BLUE} strokeWidth={2} />{grip(4, 18, '#fff')}{grip(12, 9, '#fff')}{grip(20, 18, '#fff')}</>, className),
  rect: ({ className }: P) => svg(<><rect x={3.5} y={6} width={17} height={12} stroke={BLUE} strokeWidth={2} />{grip(3.5, 6, '#fff')}{grip(20.5, 18, '#fff')}</>, className),
  polygon: ({ className }: P) => svg(<path d="M12 3.5 19.5 8v8L12 20.5 4.5 16V8z" stroke={BLUE} strokeWidth={2} />, className),
  ellipse: ({ className }: P) => svg(<><ellipse cx={12} cy={12} rx={9} ry={5.5} stroke={BLUE} strokeWidth={2} />{grip(12, 12, '#fff')}</>, className),
  hatch: ({ className }: P) => svg(<><rect x={4} y={4} width={16} height={16} /><path d="M4 10 10 4M4 16 16 4M4 20 20 4M10 20l10-10M16 20l4-4" stroke={YEL} /></>, className),
  spline: ({ className }: P) => svg(<><path d="M3 17c4-12 7 2 10-4s5-8 8-6" stroke={BLUE} strokeWidth={2} />{grip(3, 17, '#fff')}{grip(21, 7, '#fff')}</>, className),
  point: ({ className }: P) => svg(<><path d="M12 5v14M5 12h14" strokeWidth={1} /><circle cx={12} cy={12} r={2.5} fill={BLUE} stroke="none" /></>, className),
  xline: ({ className }: P) => svg(<><path d="M2 20 22 4" stroke={BLUE} strokeWidth={2} />{grip(12, 12, '#fff')}</>, className),
  ray: ({ className }: P) => svg(<><path d="M4 20 22 4" stroke={BLUE} strokeWidth={2} />{grip(4, 20, '#fff')}</>, className),
  donut: ({ className }: P) => svg(<circle cx={12} cy={12} r={6} stroke={BLUE} strokeWidth={4} />, className),
  boundary: ({ className }: P) => svg(<><path d="M4 18 6 6l7 3 7-3-2 12z" stroke={BLUE} strokeWidth={2} />{grip(12, 13, YEL)}</>, className),
  move: ({ className }: P) => svg(<><path d="M12 3v18M3 12h18M12 3l-3 3m3-3 3 3M12 21l-3-3m3 3 3-3M3 12l3-3m-3 3 3 3M21 12l-3-3m3 3-3 3" stroke={YEL} /></>, className),
  copy: ({ className }: P) => svg(<><rect x={3} y={9} width={11} height={11} /><rect x={10} y={4} width={11} height={11} stroke={BLUE} strokeWidth={2} /></>, className),
  rotate: ({ className }: P) => svg(<><path d="M5 12a7 7 0 1 0 2-5" stroke={YEL} /><path d="M7 3v4h4" stroke={YEL} /><rect x={9} y={9} width={6} height={6} stroke={BLUE} strokeWidth={2} /></>, className),
  scale: ({ className }: P) => svg(<><rect x={3} y={13} width={7} height={7} /><rect x={8} y={4} width={12} height={12} stroke={BLUE} strokeWidth={2} /><path d="M10 13 15 8" stroke={YEL} /></>, className),
  mirror: ({ className }: P) => svg(<><path d="M12 2v20" strokeDasharray="2 2" stroke={YEL} /><path d="M10 6 3 18h7z" /><path d="M14 6l7 12h-7z" stroke={BLUE} strokeWidth={2} /></>, className),
  stretch: ({ className }: P) => svg(<><path d="M3 8h8l3 8H3z" /><path d="M11 8h9v8h-6" stroke={BLUE} strokeWidth={2} /><path d="M14 12h6m0 0-2-2m2 2-2 2" stroke={YEL} /></>, className),
  trim: ({ className }: P) => svg(<><path d="M12 3v18" stroke={YEL} /><path d="M3 12h9" stroke={BLUE} strokeWidth={2} /><path d="M14 12h7" strokeDasharray="2 2" stroke={RED} /></>, className),
  extend: ({ className }: P) => svg(<><path d="M20 3v18" stroke={YEL} /><path d="M3 12h8" stroke={BLUE} strokeWidth={2} /><path d="M11 12h9" strokeDasharray="2 2" stroke={BLUE} /><path d="m17 9 3 3-3 3" stroke={BLUE} /></>, className),
  fillet: ({ className }: P) => svg(<><path d="M4 20V11a7 7 0 0 1 7-7h9" stroke={BLUE} strokeWidth={2} /><path d="M4 11V4h7" strokeDasharray="2 2" /></>, className),
  chamfer: ({ className }: P) => svg(<><path d="M4 20v-9l7-7h9" stroke={BLUE} strokeWidth={2} /><path d="M4 11V4h7" strokeDasharray="2 2" /></>, className),
  erase: ({ className }: P) => svg(<><path d="m14 4 6 6-9 9H6l-3-3z" stroke={RED} /><path d="m9 9 6 6" stroke={RED} /><path d="M11 19h9" /></>, className),
  explode: ({ className }: P) => svg(<><rect x={8} y={8} width={8} height={8} stroke={BLUE} strokeWidth={2} /><path d="M3 3l3 3M21 3l-3 3M3 21l3-3M21 21l-3-3M12 2v3M12 19v3M2 12h3M19 12h3" stroke={YEL} /></>, className),
  offset: ({ className }: P) => svg(<><path d="M4 20V9a5 5 0 0 1 5-5h11" /><path d="M8 20v-9a3 3 0 0 1 3-3h9" stroke={BLUE} strokeWidth={2} /></>, className),
  array: ({ className }: P) => svg(<>{[4, 10.5, 17].flatMap((x) => [4, 10.5, 17].map((y) => <rect key={`${x}${y}`} x={x} y={y} width={4} height={4} stroke={x === 4 && y === 4 ? BLUE : 'currentColor'} />))}</>, className),
  break: ({ className }: P) => svg(<><path d="M3 12h7M14 12h7" stroke={BLUE} strokeWidth={2} />{grip(10, 12, YEL)}{grip(14, 12, YEL)}</>, className),
  join: ({ className }: P) => svg(<><path d="M3 16 12 8l9 8" stroke={BLUE} strokeWidth={2} /><circle cx={12} cy={8} r={2} stroke={YEL} /></>, className),
  text: ({ className }: P) => svg(<path d="M5 20 11.5 4h1L19 20M8 14h8" stroke="#fff" strokeWidth={2} />, className),
  mtext: ({ className }: P) => svg(<><path d="M3 15 7 4h1l4 11M4.5 11h6" strokeWidth={1.8} /><path d="M14 8h7M14 12h7M3 19h18" stroke={BLUE} /></>, className),
  dimlinear: ({ className }: P) => svg(<><path d="M4 20V7M20 20V7" /><path d="M4 10h16" stroke={BLUE} /><path d="m4 10 3-1.6v3.2zM20 10l-3-1.6v3.2z" fill={BLUE} stroke={BLUE} /><path d="M10 6h4" stroke={YEL} /></>, className),
  dimaligned: ({ className }: P) => svg(<><path d="M3 15l9-9M10 21l9-9" /><path d="M6 18 15 9" stroke={BLUE} /><path d="m6 18 1-3 2 2zM15 9l-1 3-2-2z" fill={BLUE} stroke={BLUE} /></>, className),
  dimangular: ({ className }: P) => svg(<><path d="M4 20 20 20M4 20 15 6" /><path d="M14 20a10 10 0 0 0-3.8-7.9" stroke={BLUE} /><path d="m14 20-1.5-3h3zM10.2 12.1l3.3.4-1.8 2.4z" fill={BLUE} stroke={BLUE} /></>, className),
  dimradius: ({ className }: P) => svg(<><circle cx={10} cy={13} r={7} /><path d="M10 13 15 8" stroke={BLUE} /><path d="m15 8-3 .6 2.4 2.4z" fill={BLUE} stroke={BLUE} /><path d="M17 5h4" stroke={YEL} /></>, className),
  dimdiameter: ({ className }: P) => svg(<><circle cx={12} cy={12} r={8} /><path d="M6.3 17.7 17.7 6.3" stroke={BLUE} /><path d="m17.7 6.3-3 .9 2.1 2.1zM6.3 17.7l3-.9-2.1-2.1z" fill={BLUE} stroke={BLUE} /></>, className),
  dimordinate: ({ className }: P) => svg(<><path d="M4 20V4" /><path d="M4 9h7l3 3h6" stroke={BLUE} /><path d="M4 17h7l3-2h6" stroke={BLUE} /></>, className),
  leader: ({ className }: P) => svg(<><path d="M4 20 12 9h8" stroke={BLUE} /><path d="m4 20 1-3.6 2.4 1.8z" fill={BLUE} stroke={BLUE} /><path d="M13 6h7M13 4h5" stroke="#fff" /></>, className),
  layers: ({ className }: P) => svg(<><path d="m12 3 9 5-9 5-9-5z" stroke={YEL} /><path d="m3 12 9 5 9-5" /><path d="m3 16 9 5 9-5" /></>, className),
  matchprop: ({ className }: P) => svg(<><path d="M14 3h6v5h-6z" stroke={YEL} /><path d="M17 8v3h-6v3" /><path d="M9 14h4v7H9z" stroke={BLUE} /></>, className),
  insert: ({ className }: P) => svg(<><rect x={9} y={3} width={12} height={12} stroke={BLUE} strokeWidth={2} /><path d="M3 21 11 13m0 0H6m5 0v5" stroke={YEL} /></>, className),
  block: ({ className }: P) => svg(<><rect x={4} y={4} width={13} height={13} stroke={BLUE} strokeWidth={2} /><path d="M19 15v6M16 18h6" stroke={YEL} strokeWidth={2} /></>, className),
  measure: ({ className }: P) => svg(<><path d="M3 15 15 3l6 6L9 21z" stroke={YEL} /><path d="m7 11 2 2M10 8l2 2M13 5l2 2" /></>, className),
  id: ({ className }: P) => svg(<><path d="M12 3v18M3 12h18" /><circle cx={12} cy={12} r={4} stroke={BLUE} /></>, className),
  area: ({ className }: P) => svg(<path d="M4 18 6 6l8 3 6-4-2 13z" stroke={BLUE} fill="rgba(92,182,255,0.25)" />, className),
  list: ({ className }: P) => svg(<path d="M8 6h12M8 12h12M8 18h12M4 6h.01M4 12h.01M4 18h.01" strokeWidth={2} />, className),
  paste: ({ className }: P) => svg(<><rect x={5} y={5} width={14} height={16} rx={1.5} /><path d="M9 3h6v4H9z" stroke={YEL} /></>, className),
  copyclip: ({ className }: P) => svg(<><rect x={8} y={8} width={12} height={12} rx={1.5} /><path d="M16 8V5a1 1 0 0 0-1-1H5a1 1 0 0 0-1 1v10a1 1 0 0 0 1 1h3" stroke={BLUE} /></>, className),
  cut: ({ className }: P) => svg(<><circle cx={6} cy={18} r={3} /><circle cx={18} cy={18} r={3} /><path d="M8 16 19 4M16 16 5 4" stroke={YEL} /></>, className),
  zoomExtents: ({ className }: P) => svg(<><circle cx={10.5} cy={10.5} r={6.5} /><path d="m20 20-4.5-4.5" strokeWidth={2} /><path d="M7.5 10.5h6M10.5 7.5v6" stroke={BLUE} /></>, className),
  zoomWindow: ({ className }: P) => svg(<><rect x={3} y={3} width={11} height={11} strokeDasharray="2 2" stroke={BLUE} /><circle cx={14} cy={14} r={4} /><path d="m21 21-4-4" strokeWidth={2} /></>, className),
  zoomPrevious: ({ className }: P) => svg(<><circle cx={12} cy={12} r={6.5} /><path d="M19 19 17 17" strokeWidth={2} /><path d="m10 12 4-3v6z" fill={BLUE} stroke={BLUE} /></>, className),
  pan: ({ className }: P) => svg(<path d="M8 13V5.5a1.5 1.5 0 0 1 3 0V12m0-7.5a1.5 1.5 0 0 1 3 0V12m0-6a1.5 1.5 0 0 1 3 0V14a7 7 0 0 1-7 7 6 6 0 0 1-5-3l-2.6-4.5a1.5 1.5 0 0 1 2.6-1.5L8 15" />, className),
  assistant: ({ className }: P) => svg(<><path d="M10 3.5 11.6 8.4 16.5 10l-4.9 1.6L10 16.5l-1.6-4.9L3.5 10l4.9-1.6z" stroke={BLUE} /><path d="M17.5 14v6M14.5 17h6" stroke={YEL} /></>, className),
  properties: ({ className }: P) => svg(<><rect x={4} y={3} width={16} height={18} rx={1.5} /><path d="M8 8h8M8 12h8M8 16h5" stroke={BLUE} /></>, className),
  units: ({ className }: P) => svg(<><path d="M3 17h18M5 17v-3M9 17v-5M13 17v-3M17 17v-5" /><path d="M5 7h14" stroke={BLUE} /></>, className),
  layerOff: ({ className }: P) => svg(<><path d="M9 18h6M10 21h4M12 3a6 6 0 0 0-3.5 10.9c.6.5 1 1.2 1 2.1h5c0-.9.4-1.6 1-2.1A6 6 0 0 0 12 3z" /><path d="M4 4l16 16" stroke={RED} /></>, className),
  layerFreeze: ({ className }: P) => svg(<path d="M12 2v20M4 7l16 10M4 17 20 7M9 3l3 3 3-3M9 21l3-3 3 3" stroke={BLUE} />, className),
  layerLock: ({ className }: P) => svg(<><rect x={5} y={11} width={14} height={10} rx={1.5} stroke={YEL} /><path d="M8 11V7a4 4 0 0 1 8 0v4" /></>, className),
  layerCurrent: ({ className }: P) => svg(<><path d="m12 3 9 5-9 5-9-5z" stroke={YEL} /><path d="m3 13 9 5 9-5" /><path d="m15 18 2 2 4-4" stroke={GRN} strokeWidth={2} /></>, className),
  layerIso: ({ className }: P) => svg(<><path d="m12 3 9 5-9 5-9-5z" stroke={YEL} /><path d="m3 13 9 5 9-5" strokeDasharray="2 2" /></>, className),
  // Status bar.
  grid: ({ className }: P) => svg(<path d="M3 3h18v18H3zM9 3v18M15 3v18M3 9h18M3 15h18" strokeWidth={1.2} />, className),
  snap: ({ className }: P) => svg(<><path d="M3 3h18v18H3z" strokeWidth={1.2} strokeDasharray="1 3" /><circle cx={12} cy={12} r={2} fill="currentColor" /></>, className),
  ortho: ({ className }: P) => svg(<path d="M5 4v16h15" strokeWidth={2} />, className),
  polar: ({ className }: P) => svg(<><path d="M4 20h16" strokeWidth={1.5} /><path d="M4 20 18 6" strokeDasharray="2 2" /><path d="M10 20a6 6 0 0 0-1.8-4.2" /></>, className),
  osnap: ({ className }: P) => svg(<><rect x={8} y={8} width={8} height={8} strokeWidth={1.8} /><path d="M3 12h5M16 12h5M12 3v5M12 16v5" strokeWidth={1} /></>, className),
  otrack: ({ className }: P) => svg(<><path d="M3 12h18M12 3v18" strokeDasharray="2 2" /><rect x={9} y={9} width={6} height={6} /></>, className),
  lineweight: ({ className }: P) => svg(<><path d="M3 6h18" strokeWidth={1} /><path d="M3 12h18" strokeWidth={2.2} /><path d="M3 18h18" strokeWidth={3.6} /></>, className),
  dyn: ({ className }: P) => svg(<><path d="M4 18 18 4" /><rect x={11} y={13} width={10} height={6} rx={1} /></>, className),
  gear: ({ className }: P) => svg(<><circle cx={12} cy={12} r={3} /><path d="M12 2v3M12 19v3M2 12h3M19 12h3M4.9 4.9l2.1 2.1M17 17l2.1 2.1M4.9 19.1 7 17M17 7l2.1-2.1" /></>, className),
  model: ({ className }: P) => svg(<><path d="m12 3 8 4.5v9L12 21l-8-4.5v-9z" /><path d="m4 7.5 8 4.5 8-4.5M12 12v9" /></>, className),
  // File.
  newFile: ({ className }: P) => svg(<><path d="M6 3h8l4 4v14H6z" /><path d="M14 3v4h4" /><path d="M12 11v6M9 14h6" stroke={GRN} /></>, className),
  openFile: ({ className }: P) => svg(<path d="M3 19V6a1 1 0 0 1 1-1h5l2 2h8a1 1 0 0 1 1 1v2M3 19l3-8h16l-3 8z" stroke={YEL} />, className),
  save: ({ className }: P) => svg(<><path d="M5 3h11l3 3v15H5z" /><path d="M8 3v5h7V3M8 21v-7h8v7" stroke={BLUE} /></>, className),
  saveAs: ({ className }: P) => svg(<><path d="M5 3h11l3 3v7M5 3v18h7" /><path d="M8 3v5h7V3" stroke={BLUE} /><path d="m15 20 6-6-2-2-6 6v2z" stroke={YEL} /></>, className),
  undo: ({ className }: P) => svg(<path d="M9 14 4 9l5-5M4 9h10.5a5.5 5.5 0 0 1 0 11H11" />, className),
  redo: ({ className }: P) => svg(<path d="m15 14 5-5-5-5M20 9H9.5a5.5 5.5 0 0 0 0 11H13" />, className),
  plot: ({ className }: P) => svg(<><path d="M6 9V3h12v6M6 18H4V9h16v9h-2" /><path d="M6 14h12v7H6z" stroke={BLUE} /></>, className),
  exportFile: ({ className }: P) => svg(<><path d="M6 3h8l4 4v6M6 3v18h8" /><path d="M14 3v4h4M15 18h7m0 0-3-3m3 3-3 3" stroke={GRN} /></>, className),
  close: ({ className }: P) => svg(<path d="M6 6l12 12M18 6 6 18" />, className),
};

export type IconName = keyof typeof Icons;
