/**
 * Wi-Fi with a cross — the radio is on but no network is joined.
 *
 * Lucide has no such glyph (`WifiOff`'s slash means the radio is off, and
 * `WifiZero` is a lone dot that all but disappears in the menu bar). The
 * arcs are Lucide's `Wifi`, with a small cross in the bottom-right corner.
 * Stroked and sized by `className` like a Lucide icon.
 */
export function WifiXIcon({
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
      <path d="M12 20h.01" />
      <path d="M2 8.82a15 15 0 0 1 20 0" />
      <path d="M5 12.86a10 10 0 0 1 14 0" />
      <path d="M8.5 16.43a5 5 0 0 1 7 0" />
      <path d="m18 16 4 4" />
      <path d="m22 16-4 4" />
    </svg>
  );
}
