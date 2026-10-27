/**
 * Onion icon — Tor's mark: a bulb with its layers.
 *
 * Lucide has no onion glyph. Stroked and sized by `className` (`size-4`) like
 * a Lucide icon, so it drops in wherever one of those would.
 */
export function OnionIcon({
  className,
  ...props
}: React.ComponentProps<'svg'>) {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
      data-slot="icon"
      className={className}
      {...props}
    >
      <path d="M12 21a7 7 0 0 0 7-7c0-3-2.2-5-4.5-6.3C13 6.8 12 5.5 12 3c0 2.5-1 3.8-2.5 4.7C7.2 9 5 11 5 14a7 7 0 0 0 7 7z" />
      <path d="M12 17.5a3.5 3.5 0 0 0 3.5-3.5c0-1.8-1.3-3.1-3.5-4.5-2.2 1.4-3.5 2.7-3.5 4.5a3.5 3.5 0 0 0 3.5 3.5z" />
    </svg>
  );
}
