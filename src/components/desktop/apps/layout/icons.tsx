/** Tool icons lucide has no match for, drawn after InDesign's. */

type P = { className?: string };

const svg = (className: string | undefined, children: React.ReactNode) => (
  <svg viewBox="0 0 24 24" className={className} fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinejoin="round" strokeLinecap="round" aria-hidden>
    {children}
  </svg>
);

export function SelectionIcon({ className }: P) {
  return svg(className, <path d="M6 3v15.5l4.2-4 2.9 6.5 2.4-1-2.8-6.4 5.8-.3Z" fill="currentColor" />);
}

export function DirectSelectionIcon({ className }: P) {
  return svg(className, <path d="M6 3v15.5l4.2-4 2.9 6.5 2.4-1-2.8-6.4 5.8-.3Z" />);
}

export function FrameRectIcon({ className }: P) {
  return svg(
    className,
    <>
      <rect x="4" y="5" width="16" height="14" />
      <path d="M4 5l16 14M20 5 4 19" strokeWidth="1" />
    </>,
  );
}

export function FrameEllipseIcon({ className }: P) {
  return svg(
    className,
    <>
      <ellipse cx="12" cy="12" rx="8.5" ry="7" />
      <path d="M6 7l12 10M18 7 6 17" strokeWidth="1" />
    </>,
  );
}

export function FramePolygonIcon({ className }: P) {
  return svg(
    className,
    <>
      <path d="M12 3.5 20 9l-3 10H7L4 9Z" />
      <path d="M5.5 8.5 17.5 18.5M18.5 8.5 6.5 18.5" strokeWidth="1" />
    </>,
  );
}

export function RectIcon({ className }: P) {
  return svg(className, <rect x="4" y="5" width="16" height="14" />);
}

export function EllipseIcon({ className }: P) {
  return svg(className, <ellipse cx="12" cy="12" rx="8.5" ry="7" />);
}

export function PolygonIcon({ className }: P) {
  return svg(className, <path d="M12 3.5 20 9l-3 10H7L4 9Z" />);
}

export function LineIcon({ className }: P) {
  return svg(className, <path d="M5 19 19 5" />);
}

export function FreeTransformIcon({ className }: P) {
  return svg(
    className,
    <>
      <rect x="5" y="5" width="11" height="11" strokeDasharray="2 2" />
      <path d="M9 9v12l3-3 2 4 1.6-.8-2-3.9 4-.3Z" fill="currentColor" strokeWidth="1" />
    </>,
  );
}

export function ShearIcon({ className }: P) {
  return svg(
    className,
    <>
      <path d="M8 5h12l-4 14H4Z" />
      <path d="M4 5h4M4 5v4" strokeWidth="1" />
    </>,
  );
}

export function ScaleIcon({ className }: P) {
  return svg(
    className,
    <>
      <rect x="3.5" y="10.5" width="10" height="10" />
      <path d="M10 3.5h10.5V14M20.5 3.5 12 12M15 12h-3V9" />
    </>,
  );
}

export function GradientSwatchIcon({ className }: P) {
  return (
    <svg viewBox="0 0 24 24" className={className} aria-hidden>
      <defs>
        <linearGradient id="layout-gradient-icon" x1="0" x2="1">
          <stop offset="0" stopColor="currentColor" stopOpacity="1" />
          <stop offset="1" stopColor="currentColor" stopOpacity="0.05" />
        </linearGradient>
      </defs>
      <rect x="3.5" y="5.5" width="17" height="13" fill="url(#layout-gradient-icon)" stroke="currentColor" strokeWidth="1.5" />
    </svg>
  );
}

/** The reference point proxy's dot grid (Control and Transform panels). */
export function ProxyIcon({ value, onChange }: { value: [number, number]; onChange: (v: [number, number]) => void }) {
  const pts: [number, number][] = [];
  for (const y of [-1, 0, 1]) for (const x of [-1, 0, 1]) pts.push([x, y]);
  return (
    <div className="relative grid size-[26px] shrink-0 grid-cols-3 grid-rows-3 place-items-center" role="radiogroup" aria-label="Reference point">
      <div className="pointer-events-none absolute inset-[4px] border border-[#8a8a8a]" />
      {pts.map(([x, y]) => {
        const on = value[0] === x && value[1] === y;
        return (
          <button
            key={`${x},${y}`}
            type="button"
            role="radio"
            aria-checked={on}
            aria-label={`Reference point ${['top', 'middle', 'bottom'][y + 1]} ${['left', 'center', 'right'][x + 1]}`}
            onClick={() => onChange([x, y])}
            className="relative z-10 grid size-2 place-items-center"
          >
            <span className={on ? 'size-[6px] bg-[#e6e6e6]' : 'size-[5px] border border-[#b5b5b5] bg-[#323232]'} />
          </button>
        );
      })}
    </div>
  );
}
