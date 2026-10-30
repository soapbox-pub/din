export function WindowsGlyph({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 16 16" className={className} aria-hidden fill="currentColor">
      <rect x="1" y="1" width="6.5" height="6.5" rx="0.6" />
      <rect x="8.5" y="1" width="6.5" height="6.5" rx="0.6" />
      <rect x="1" y="8.5" width="6.5" height="6.5" rx="0.6" />
      <rect x="8.5" y="8.5" width="6.5" height="6.5" rx="0.6" />
    </svg>
  );
}

/** Ubuntu's circle of friends, simplified. */
export function UbuntuGlyph({ className }: { className?: string }) {
  const dots = [0, 120, 240].map((deg) => {
    const a = ((deg - 90) * Math.PI) / 180;
    return { x: 8 + 5.6 * Math.cos(a), y: 8 + 5.6 * Math.sin(a) };
  });
  return (
    <svg viewBox="0 0 16 16" className={className} aria-hidden>
      <circle cx="8" cy="8" r="4.2" fill="none" stroke="currentColor" strokeWidth="1.6" />
      {dots.map((d, i) => (
        <circle key={i} cx={d.x} cy={d.y} r="1.7" fill="currentColor" />
      ))}
    </svg>
  );
}

/** Fedora's infinity-f, simplified. */
export function FedoraGlyph({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 16 16" className={className} aria-hidden fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round">
      <path d="M8 13V6.5A2.5 2.5 0 0 1 10.5 4" />
      <path d="M5.5 8.5h5" />
    </svg>
  );
}

export function AppleGlyph({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 16 16" className={className} aria-hidden fill="currentColor">
      <path d="M11.2 8.5c0-1.5 1.2-2.2 1.3-2.3-.7-1-1.8-1.2-2.2-1.2-.9-.1-1.8.6-2.3.6s-1.2-.5-2-.5C4.9 5.1 3.9 5.7 3.4 6.7c-1.1 1.9-.3 4.6.8 6.1.5.7 1.1 1.6 1.9 1.5.8 0 1-.5 2-.5s1.2.5 2 .5 1.3-.8 1.8-1.5c.6-.8.8-1.6.8-1.7 0 0-1.5-.6-1.5-2.6ZM9.7 4c.4-.5.7-1.2.6-1.9-.6 0-1.3.4-1.8.9-.4.4-.7 1.1-.6 1.8.7.1 1.3-.3 1.8-.8Z" />
    </svg>
  );
}
