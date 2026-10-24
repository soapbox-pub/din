/** The Gradient tool's icon: lucide has none that reads as Photoshop's. */
export function GradientIcon({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" className={className} aria-hidden>
      <defs>
        <linearGradient id="photo-gradient-icon" x1="0" x2="1">
          <stop offset="0" stopColor="currentColor" stopOpacity="1" />
          <stop offset="1" stopColor="currentColor" stopOpacity="0.05" />
        </linearGradient>
      </defs>
      <rect x="3.5" y="5.5" width="17" height="13" rx="2" fill="url(#photo-gradient-icon)" stroke="currentColor" strokeWidth="1.5" />
    </svg>
  );
}
