/** Ribbon icons Excel has and lucide doesn't, drawn in Fluent's thin-line style. */

type P = { className?: string };

const G = '#9e9e9e';

/** A 3×3 cell grid with some edges drawn dark (the Borders gallery). */
export function BorderIcon({ sides, className, thick, double }: P & { sides: string; thick?: boolean; double?: boolean }) {
  const has = (s: string) => sides.includes(s);
  const dark = '#242424';
  return (
    <svg viewBox="0 0 16 16" className={className ?? 'size-4'} fill="none" strokeWidth="1">
      <g stroke={G} strokeDasharray="1 1">
        <path d="M1.5 1.5h13v13h-13zM8 1.5v13M1.5 8h13" />
      </g>
      <g stroke={dark} strokeWidth={thick ? 2 : 1}>
        {has('t') && <path d="M1 1.5h14" />}
        {has('b') && !double && <path d={thick ? 'M1 14h14' : 'M1 14.5h14'} />}
        {has('b') && double && <path d="M1 12.5h14M1 14.5h14" strokeWidth="1" />}
        {has('l') && <path d="M1.5 1v14" />}
        {has('r') && <path d="M14.5 1v14" />}
        {has('h') && <path d="M1 8h14" />}
        {has('v') && <path d="M8 1v14" />}
      </g>
    </svg>
  );
}

export function MergeIcon({ className }: P) {
  return (
    <svg viewBox="0 0 16 16" className={className ?? 'size-4'} fill="none" stroke="#424242">
      <rect x="1.5" y="3.5" width="13" height="9" rx="0.5" />
      <path d="M3.5 8h3M5 6.5 6.5 8 5 9.5M12.5 8h-3M11 6.5 9.5 8 11 9.5" stroke="#107c41" />
    </svg>
  );
}

export function OrientationIcon({ className }: P) {
  return (
    <svg viewBox="0 0 16 16" className={className ?? 'size-4'} fill="none" stroke="#424242">
      <path d="M3 12 7.5 3 12 12M4.8 8.5h5.4" transform="rotate(-35 8 8)" />
      <path d="M11 14.5h3.5V11" stroke="#107c41" />
    </svg>
  );
}

export function CommaIcon({ className }: P) {
  return (
    <svg viewBox="0 0 16 16" className={className ?? 'size-4'}>
      <text x="8" y="12" textAnchor="middle" fontSize="11" fontWeight="700" fill="#424242" fontFamily="Inter, sans-serif">
        ,
      </text>
      <text x="3" y="12" fontSize="7" fill="#424242" fontFamily="Inter, sans-serif">
        0
      </text>
      <text x="10" y="12" fontSize="7" fill="#424242" fontFamily="Inter, sans-serif">
        0
      </text>
    </svg>
  );
}

export function AccountingIcon({ className }: P) {
  return (
    <svg viewBox="0 0 16 16" className={className ?? 'size-4'} fill="none">
      <rect x="1.5" y="3.5" width="13" height="9" rx="1" stroke="#107c41" />
      <text x="8" y="11" textAnchor="middle" fontSize="8" fontWeight="700" fill="#107c41" fontFamily="Inter, sans-serif">
        $
      </text>
    </svg>
  );
}

function Sheet32({ children, className }: P & { children?: React.ReactNode }) {
  return (
    <svg viewBox="0 0 32 32" className={className ?? 'size-7'} fill="none">
      {children}
    </svg>
  );
}

export function FreezeIcon({ className, kind = 'panes' }: P & { kind?: 'panes' | 'row' | 'col' }) {
  return (
    <Sheet32 className={className}>
      <rect x="3.5" y="5.5" width="25" height="21" rx="1" stroke="#616161" />
      <path d="M3.5 11.5h25M10.5 5.5v21M3.5 16.5h25M3.5 21.5h25M17.5 5.5v21M23.5 5.5v21" stroke="#c8c8c8" />
      {kind !== 'col' && <rect x="4" y="6" width="24" height="5" fill="#cfe4fa" />}
      {kind !== 'row' && <rect x="4" y="6" width="6" height="20" fill="#cfe4fa" />}
      <path d={kind === 'row' ? 'M3.5 11.5h25' : kind === 'col' ? 'M10.5 5.5v21' : 'M3.5 11.5h25M10.5 5.5v21'} stroke="#185abd" strokeWidth="1.5" />
    </Sheet32>
  );
}

export function InsertCellsIcon({ className }: P) {
  return (
    <Sheet32 className={className}>
      <rect x="4.5" y="6.5" width="20" height="19" rx="1" stroke="#616161" />
      <path d="M4.5 13h20M4.5 19.5h20M11.5 6.5v19M18 6.5v19" stroke="#c8c8c8" />
      <rect x="11.5" y="13" width="6.5" height="6.5" fill="#d3eadb" stroke="#107c41" />
      <circle cx="24" cy="23" r="5.5" fill="#107c41" />
      <path d="M24 20v6M21 23h6" stroke="#fff" strokeWidth="1.5" />
    </Sheet32>
  );
}

export function DeleteCellsIcon({ className }: P) {
  return (
    <Sheet32 className={className}>
      <rect x="4.5" y="6.5" width="20" height="19" rx="1" stroke="#616161" />
      <path d="M4.5 13h20M4.5 19.5h20M11.5 6.5v19M18 6.5v19" stroke="#c8c8c8" />
      <rect x="11.5" y="13" width="6.5" height="6.5" fill="#fde7e9" stroke="#c42b1c" />
      <circle cx="24" cy="23" r="5.5" fill="#c42b1c" />
      <path d="m21.8 20.8 4.4 4.4m0-4.4-4.4 4.4" stroke="#fff" strokeWidth="1.5" />
    </Sheet32>
  );
}

export function FormatCellsIcon({ className }: P) {
  return (
    <Sheet32 className={className}>
      <rect x="4.5" y="6.5" width="20" height="19" rx="1" stroke="#616161" />
      <path d="M4.5 13h20M4.5 19.5h20M11.5 6.5v19M18 6.5v19" stroke="#c8c8c8" />
      <path d="M20 27.5 27.5 20l2 2-7.5 7.5h-2z" fill="#fff" stroke="#424242" />
      <path d="m26 21.5 2 2" stroke="#424242" />
    </Sheet32>
  );
}

export function CellStylesIcon({ className }: P) {
  return (
    <Sheet32 className={className}>
      <rect x="4.5" y="7.5" width="11" height="7" fill="#c6efce" stroke="#4e9a5f" />
      <rect x="16.5" y="7.5" width="11" height="7" fill="#ffc7ce" stroke="#c0504d" />
      <rect x="4.5" y="17.5" width="11" height="7" fill="#ffeb9c" stroke="#b8860b" />
      <rect x="16.5" y="17.5" width="11" height="7" fill="#fff" stroke="#616161" />
    </Sheet32>
  );
}

export function SortFilterIcon({ className }: P) {
  return (
    <Sheet32 className={className}>
      <text x="4" y="13" fontSize="9" fontWeight="700" fill="#185abd" fontFamily="Inter, sans-serif">
        A
      </text>
      <text x="4" y="26" fontSize="9" fontWeight="700" fill="#185abd" fontFamily="Inter, sans-serif">
        Z
      </text>
      <path d="M13 6v18m-3-3 3 3 3-3" stroke="#424242" strokeWidth="1.5" />
      <path d="M18 8h11l-4.5 6v7l-2 1.5V14z" fill="#fff" stroke="#424242" strokeLinejoin="round" />
    </Sheet32>
  );
}

export function FindIcon({ className }: P) {
  return (
    <Sheet32 className={className}>
      <circle cx="13" cy="13" r="7.5" stroke="#424242" strokeWidth="1.6" />
      <path d="m18.5 18.5 8 8" stroke="#424242" strokeWidth="2.4" strokeLinecap="round" />
    </Sheet32>
  );
}

export function FunctionIcon({ className }: P) {
  return (
    <Sheet32 className={className}>
      <text x="16" y="23" textAnchor="middle" fontSize="18" fontStyle="italic" fontWeight="600" fill="#107c41" fontFamily="Georgia, serif">
        fx
      </text>
    </Sheet32>
  );
}

export function SigmaIcon({ className }: P) {
  return (
    <svg viewBox="0 0 16 16" className={className ?? 'size-4'} fill="none">
      <path d="M12.5 3.5h-9l5 4.5-5 4.5h9" stroke="#424242" strokeWidth="1.4" strokeLinejoin="round" />
    </svg>
  );
}

export function FillDownIcon({ className }: P) {
  return (
    <svg viewBox="0 0 16 16" className={className ?? 'size-4'} fill="none">
      <rect x="2.5" y="1.5" width="11" height="4" fill="#d3eadb" stroke="#107c41" />
      <path d="M8 6.5v7m-3-3 3 3 3-3" stroke="#185abd" strokeWidth="1.3" />
    </svg>
  );
}

export function GridlinesIcon({ className }: P) {
  return (
    <svg viewBox="0 0 16 16" className={className ?? 'size-4'} fill="none" stroke="#616161">
      <path d="M1.5 1.5h13v13h-13zM1.5 6h13M1.5 10.5h13M6 1.5v13M10.5 1.5v13" />
    </svg>
  );
}
