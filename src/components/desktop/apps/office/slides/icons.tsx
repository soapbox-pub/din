import { shapePath } from './geometry';

/**
 * Ribbon pictures in Office's style (outlined in gray, with a touch of the
 * app's color), and shape gallery glyphs drawn by the same geometry engine
 * that draws the shapes on slides.
 */

const ORANGE = '#c43e1c';
const BLUE = '#2b6cb0';
const GRAY = '#424242';

type IconProps = { className?: string };

export function ShapeGlyph({ prst, size = 20 }: { prst: string; size?: number }) {
  if (prst === 'textbox') return <TextBoxIcon className="size-5" />;
  const pad = 2;
  const s = size - pad * 2;
  const line = prst === 'line' || prst.includes('Connector');
  const w = s;
  const h = line ? s : prst.includes('Arrow') && /left|right|notched|homePlate|chevron/i.test(prst) ? s * 0.7 : /up|down/i.test(prst) && prst.includes('Arrow') ? s : s * (/Rect|rect|parallelogram|trapezoid|flowChartProcess|frame|plaque|Callout|flowChart(Alternate|Document|InputOutput|Predefined|Terminator|Preparation|ManualInput)/.test(prst) ? 0.72 : 1);
  const path = shapePath({ prst }, w, h);
  return (
    <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} aria-hidden>
      <g transform={`translate(${pad + (s - w) / 2} ${pad + (s - h) / 2})`}>
        {path.paths.map((p, i) => (
          <path
            key={i}
            d={p.d}
            fill={line || p.fill === 'none' ? 'none' : p.fill === 'norm' ? '#dbe6f4' : '#b6c7de'}
            stroke={p.stroke ? '#3b5f8f' : 'none'}
            strokeWidth={1}
            strokeLinejoin="round"
            markerEnd={prst === 'straightConnector1' ? 'url(#sl-arrowhead)' : undefined}
          />
        ))}
      </g>
      {prst === 'straightConnector1' && (
        <defs>
          <marker id="sl-arrowhead" viewBox="0 0 6 6" refX={5} refY={3} markerWidth={5} markerHeight={5} orient="auto">
            <path d="M0 0L6 3L0 6Z" fill="#3b5f8f" />
          </marker>
        </defs>
      )}
    </svg>
  );
}

export function NewSlideIcon({ className }: IconProps) {
  return (
    <svg viewBox="0 0 32 32" className={className} aria-hidden>
      <rect x="3" y="6" width="22" height="16" rx="1" fill="#fff" stroke={GRAY} strokeWidth="1.3" />
      <rect x="6" y="9" width="12" height="2" fill="#9a9a9a" />
      <rect x="6" y="13" width="16" height="1.5" fill="#c8c8c8" />
      <rect x="6" y="16" width="14" height="1.5" fill="#c8c8c8" />
      <circle cx="24" cy="23" r="6.5" fill={ORANGE} />
      <path d="M24 19.5v7M20.5 23h7" stroke="#fff" strokeWidth="1.8" />
    </svg>
  );
}

export function LayoutIcon({ className }: IconProps) {
  return (
    <svg viewBox="0 0 16 16" className={className} aria-hidden fill="none" stroke={GRAY} strokeWidth="1">
      <rect x="1.5" y="2.5" width="13" height="11" rx="0.5" />
      <path d="M1.5 5.5h13M7.5 5.5v8" />
    </svg>
  );
}

export function ResetIcon({ className }: IconProps) {
  return (
    <svg viewBox="0 0 16 16" className={className} aria-hidden fill="none" stroke={GRAY} strokeWidth="1">
      <rect x="1.5" y="3.5" width="10" height="8" rx="0.5" />
      <path d="M10 13.5a3.5 3.5 0 1 0 3.2-5" stroke={BLUE} />
      <path d="M13.5 6.5v2.2h-2.2" stroke={BLUE} />
    </svg>
  );
}

export function SectionIcon({ className }: IconProps) {
  return (
    <svg viewBox="0 0 16 16" className={className} aria-hidden fill="none" stroke={GRAY} strokeWidth="1">
      <rect x="4.5" y="1.5" width="10" height="5" rx="0.5" />
      <rect x="4.5" y="9.5" width="10" height="5" rx="0.5" />
      <path d="M1.5 4h2M1.5 12h2" stroke={ORANGE} />
    </svg>
  );
}

export function TextBoxIcon({ className }: IconProps) {
  return (
    <svg viewBox="0 0 32 32" className={className} aria-hidden>
      <rect x="4" y="5" width="24" height="22" fill="#fff" stroke={GRAY} strokeWidth="1.3" strokeDasharray="2.5 1.5" />
      <path d="M11 22l5-13 5 13M12.7 18h6.6" fill="none" stroke={BLUE} strokeWidth="2" strokeLinejoin="round" />
    </svg>
  );
}

export function PictureIcon({ className }: IconProps) {
  return (
    <svg viewBox="0 0 32 32" className={className} aria-hidden>
      <rect x="3" y="6" width="26" height="20" rx="1.5" fill="#fff" stroke={GRAY} strokeWidth="1.3" />
      <circle cx="10" cy="12" r="2.5" fill="#f2b33d" />
      <path d="M5 24l8-8 5 5 3-3 6 6z" fill="#3a8fd8" />
    </svg>
  );
}

export function TableIcon({ className }: IconProps) {
  return (
    <svg viewBox="0 0 32 32" className={className} aria-hidden>
      <rect x="4" y="6" width="24" height="20" fill="#fff" stroke={GRAY} strokeWidth="1.3" />
      <rect x="4" y="6" width="24" height="5" fill={BLUE} />
      <path d="M4 16h24M4 21h24M12 6v20M20 6v20" stroke={GRAY} strokeWidth="1" />
    </svg>
  );
}

export function ShapesIcon({ className }: IconProps) {
  return (
    <svg viewBox="0 0 32 32" className={className} aria-hidden>
      <rect x="4" y="13" width="13" height="13" fill="#fff" stroke={GRAY} strokeWidth="1.3" />
      <circle cx="21" cy="11" r="7" fill="#9cc3ea" stroke={BLUE} strokeWidth="1.3" />
      <path d="M17 27l6-10 6 10z" fill="#f4c7b8" stroke={ORANGE} strokeWidth="1.3" strokeLinejoin="round" />
    </svg>
  );
}

export function ArrangeIcon({ className }: IconProps) {
  return (
    <svg viewBox="0 0 32 32" className={className} aria-hidden>
      <rect x="4" y="4" width="15" height="15" fill="#fff" stroke={GRAY} strokeWidth="1.3" />
      <rect x="13" y="13" width="15" height="15" fill="#9cc3ea" stroke={BLUE} strokeWidth="1.3" />
    </svg>
  );
}

export function QuickStylesIcon({ className }: IconProps) {
  return (
    <svg viewBox="0 0 32 32" className={className} aria-hidden>
      <rect x="4" y="5" width="11" height="10" rx="1" fill="#4472c4" />
      <rect x="17" y="5" width="11" height="10" rx="1" fill="#ed7d31" />
      <rect x="4" y="17" width="11" height="10" rx="1" fill="#fff" stroke="#70ad47" strokeWidth="1.6" />
      <rect x="17" y="17" width="11" height="10" rx="1" fill="#ffc000" />
    </svg>
  );
}

export function SlideSizeIcon({ className }: IconProps) {
  return (
    <svg viewBox="0 0 32 32" className={className} aria-hidden fill="none">
      <rect x="3" y="8" width="20" height="14" fill="#fff" stroke={GRAY} strokeWidth="1.3" />
      <rect x="10" y="12" width="19" height="13" stroke={BLUE} strokeWidth="1.3" strokeDasharray="2 1.5" />
    </svg>
  );
}

export function BackgroundIcon({ className }: IconProps) {
  return (
    <svg viewBox="0 0 32 32" className={className} aria-hidden>
      <rect x="3" y="6" width="26" height="20" fill="#dbe6f4" stroke={GRAY} strokeWidth="1.3" />
      <path d="M17 11l6 6-5 5-6-6z" fill="#fff" stroke={GRAY} strokeWidth="1.2" />
      <path d="M23 17c1.5 2 1.5 3.5 0 3.5s-1.5-1.5 0-3.5z" fill={BLUE} />
    </svg>
  );
}

export function ShowIcon({ className, current }: IconProps & { current?: boolean }) {
  return (
    <svg viewBox="0 0 32 32" className={className} aria-hidden>
      <rect x="3" y="5" width="26" height="17" rx="1" fill="#fff" stroke={GRAY} strokeWidth="1.3" />
      <path d="M16 22v5M11 28h10" stroke={GRAY} strokeWidth="1.3" />
      {current && <rect x="5" y="7" width="7" height="5" fill="#c8c8c8" />}
      <path d="M13.5 9.5l7 4-7 4z" fill={ORANGE} />
    </svg>
  );
}

export function HideSlideIcon({ className }: IconProps) {
  return (
    <svg viewBox="0 0 32 32" className={className} aria-hidden fill="none">
      <rect x="4" y="7" width="24" height="18" fill="#fff" stroke={GRAY} strokeWidth="1.3" strokeDasharray="3 2" />
      <path d="M6 26L26 6" stroke={ORANGE} strokeWidth="1.6" />
    </svg>
  );
}

export function NormalViewIcon({ className }: IconProps) {
  return (
    <svg viewBox="0 0 16 16" className={className} aria-hidden fill="none" stroke="currentColor" strokeWidth="1">
      <rect x="1.5" y="2.5" width="13" height="11" />
      <path d="M5.5 2.5v11M5.5 10.5h9" />
    </svg>
  );
}

export function SorterIcon({ className }: IconProps) {
  return (
    <svg viewBox="0 0 16 16" className={className} aria-hidden fill="none" stroke="currentColor" strokeWidth="1">
      <rect x="1.5" y="2.5" width="5" height="4" />
      <rect x="9.5" y="2.5" width="5" height="4" />
      <rect x="1.5" y="9.5" width="5" height="4" />
      <rect x="9.5" y="9.5" width="5" height="4" />
    </svg>
  );
}

export function PlayIcon({ className }: IconProps) {
  return (
    <svg viewBox="0 0 16 16" className={className} aria-hidden fill="none" stroke="currentColor" strokeWidth="1">
      <rect x="1.5" y="2.5" width="13" height="9" />
      <path d="M8 11.5v2.5M5.5 14h5" />
      <path d="M6.5 5l3.5 2-3.5 2z" fill="currentColor" />
    </svg>
  );
}

export function NotesIcon({ className }: IconProps) {
  return (
    <svg viewBox="0 0 16 16" className={className} aria-hidden fill="none" stroke="currentColor" strokeWidth="1">
      <rect x="2.5" y="1.5" width="11" height="13" />
      <path d="M4.5 5h7M4.5 7.5h7M4.5 10h5" />
    </svg>
  );
}

export function FitIcon({ className }: IconProps) {
  return (
    <svg viewBox="0 0 16 16" className={className} aria-hidden fill="none" stroke="currentColor" strokeWidth="1">
      <rect x="3.5" y="4.5" width="9" height="7" />
      <path d="M1 3.5V1h2.5M12.5 1H15v2.5M15 12.5V15h-2.5M3.5 15H1v-2.5" />
    </svg>
  );
}

export function TransitionIcon({ type, className }: IconProps & { type: string }) {
  const body = {
    none: <path d="M8 24L24 8" stroke={GRAY} strokeWidth="1.3" />,
    cut: <path d="M16 8v16" stroke={GRAY} strokeWidth="1.5" strokeDasharray="2 2" />,
    fade: (
      <>
        <defs>
          <linearGradient id="sl-tr-fade" x1="0" x2="1">
            <stop offset="0" stopColor="#fff" />
            <stop offset="1" stopColor={BLUE} />
          </linearGradient>
        </defs>
        <rect x="5" y="9" width="22" height="14" fill="url(#sl-tr-fade)" />
      </>
    ),
    push: (
      <>
        <rect x="5" y="9" width="11" height="14" fill="#dbe6f4" />
        <rect x="16" y="9" width="11" height="14" fill={BLUE} />
        <path d="M11 16h9M17 13l3 3-3 3" stroke="#fff" strokeWidth="1.4" fill="none" />
      </>
    ),
    wipe: (
      <>
        <rect x="5" y="9" width="22" height="14" fill="#dbe6f4" />
        <rect x="5" y="9" width="12" height="14" fill={BLUE} />
      </>
    ),
    cover: (
      <>
        <rect x="5" y="9" width="22" height="14" fill="#dbe6f4" />
        <rect x="12" y="9" width="15" height="14" fill={BLUE} />
        <path d="M14 16h-6M10 13.5l-2.5 2.5 2.5 2.5" stroke={GRAY} fill="none" />
      </>
    ),
  }[type] ?? null;
  return (
    <svg viewBox="0 0 32 32" className={className} aria-hidden fill="none">
      <rect x="5" y="9" width="22" height="14" fill="#fff" stroke={GRAY} strokeWidth="1.2" />
      {body}
    </svg>
  );
}

