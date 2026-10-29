/** Tool icons lucide has nothing like, drawn after Illustrator's own. */

type P = { className?: string };

export function SelectionIcon({ className }: P) {
  return (
    <svg viewBox="0 0 24 24" className={className} aria-hidden>
      <path d="M6 3.5v15.5l4.2-4.1 2.7 6.1 2.6-1.1-2.7-6h5.7z" fill="currentColor" stroke="currentColor" strokeWidth="1" strokeLinejoin="round" />
    </svg>
  );
}

export function DirectSelectionIcon({ className }: P) {
  return (
    <svg viewBox="0 0 24 24" className={className} aria-hidden>
      <path d="M6 3.5v15.5l4.2-4.1 2.7 6.1 2.6-1.1-2.7-6h5.7z" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinejoin="round" />
    </svg>
  );
}

export function GroupSelectionIcon({ className }: P) {
  return (
    <svg viewBox="0 0 24 24" className={className} aria-hidden>
      <path d="M4 3.5v13.5l3.6-3.6 2.4 5.3 2.2-1-2.4-5.2h5z" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinejoin="round" />
      <path d="M18 13v7M14.5 16.5h7" stroke="currentColor" strokeWidth="1.5" />
    </svg>
  );
}

function PenNib({ extra, className }: P & { extra?: React.ReactNode }) {
  return (
    <svg viewBox="0 0 24 24" className={className} aria-hidden fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinejoin="round">
      <path d="M9 21l-1-6 4-11 4 11-1 6z" />
      <path d="M12 4v8" />
      <circle cx="12" cy="13.5" r="1.2" fill="currentColor" />
      {extra}
    </svg>
  );
}

export function PenIcon({ className }: P) {
  return <PenNib className={className} />;
}

export function AddAnchorIcon({ className }: P) {
  return <PenNib className={className} extra={<path d="M19 3v6M16 6h6" />} />;
}

export function DeleteAnchorIcon({ className }: P) {
  return <PenNib className={className} extra={<path d="M16 6h6" />} />;
}

export function AnchorPointIcon({ className }: P) {
  return (
    <svg viewBox="0 0 24 24" className={className} aria-hidden fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinejoin="round">
      <path d="M4 19l8-14 8 14" />
      <rect x="10.2" y="3.2" width="3.6" height="3.6" fill="currentColor" />
    </svg>
  );
}

export function LineIcon({ className }: P) {
  return (
    <svg viewBox="0 0 24 24" className={className} aria-hidden>
      <path d="M5 19L19 5" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
    </svg>
  );
}

export function ReflectIcon({ className }: P) {
  return (
    <svg viewBox="0 0 24 24" className={className} aria-hidden fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinejoin="round">
      <path d="M12 3v18" strokeDasharray="2 2" />
      <path d="M9 7L3 18h6zM15 7l6 11h-6z" />
    </svg>
  );
}

export function ShearIcon({ className }: P) {
  return (
    <svg viewBox="0 0 24 24" className={className} aria-hidden fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinejoin="round">
      <path d="M8 6h12l-4 12H4z" />
    </svg>
  );
}

export function FreeTransformIcon({ className }: P) {
  return (
    <svg viewBox="0 0 24 24" className={className} aria-hidden fill="none" stroke="currentColor" strokeWidth="1.5">
      <rect x="5" y="5" width="14" height="14" strokeDasharray="2.5 2" />
      <rect x="3" y="3" width="4" height="4" fill="currentColor" />
      <rect x="17" y="17" width="4" height="4" fill="currentColor" />
      <rect x="17" y="3" width="4" height="4" fill="currentColor" />
      <rect x="3" y="17" width="4" height="4" fill="currentColor" />
    </svg>
  );
}

export function GradientToolIcon({ className }: P) {
  return (
    <svg viewBox="0 0 24 24" className={className} aria-hidden>
      <defs>
        <linearGradient id="vector-gradient-icon" x1="0" x2="1">
          <stop offset="0" stopColor="currentColor" stopOpacity="1" />
          <stop offset="1" stopColor="currentColor" stopOpacity="0.05" />
        </linearGradient>
      </defs>
      <rect x="3.5" y="5.5" width="17" height="13" rx="1" fill="url(#vector-gradient-icon)" stroke="currentColor" strokeWidth="1.5" />
    </svg>
  );
}

export function ArtboardIcon({ className }: P) {
  return (
    <svg viewBox="0 0 24 24" className={className} aria-hidden fill="none" stroke="currentColor" strokeWidth="1.5">
      <path d="M7 2v20M17 2v20M2 7h20M2 17h20" />
    </svg>
  );
}

export function RoundedRectIcon({ className }: P) {
  return (
    <svg viewBox="0 0 24 24" className={className} aria-hidden fill="none" stroke="currentColor" strokeWidth="1.6">
      <rect x="4" y="6" width="16" height="12" rx="4" />
    </svg>
  );
}

export function EllipseIcon({ className }: P) {
  return (
    <svg viewBox="0 0 24 24" className={className} aria-hidden fill="none" stroke="currentColor" strokeWidth="1.6">
      <ellipse cx="12" cy="12" rx="8.5" ry="7" />
    </svg>
  );
}

export function SwapIcon({ className }: P) {
  return (
    <svg viewBox="0 0 12 12" className={className} aria-hidden fill="none" stroke="currentColor" strokeWidth="1.1">
      <path d="M2.5 9.5V4.5a2 2 0 012-2h5M7.5 0.8l2 1.7-2 1.7M0.8 7.5l1.7 2 1.7-2" />
    </svg>
  );
}
